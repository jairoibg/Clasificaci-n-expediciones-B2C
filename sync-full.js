/**
 * SYNC-FULL.JS
 * Script para pre-calcular coincidencias entre Odoo y Sendcloud
 * 
 * Uso: node sync-full.js
 * 
 * Descarga OUTs de Odoo + envíos de Sendcloud y cruza los datos
 * aplicando patrones de coincidencia para CTT, SPRING, ASENDIA, etc.
 * 
 * Resultado: tracking-index.json con todas las coincidencias pre-calculadas
 */

const fs = require('fs');
const path = require('path');
const xmlrpc = require('xmlrpc');

// ============================================
// CONFIGURACIÓN
// ============================================
const CONFIG = {
  odoo: {
    url: 'https://blackdivision.processcontrol.sh',
    db: 'blackdivision',
    user: 'j.bernabe@illice.com',
    apiKey: '98b68f64a4ee2fd5362f16f3b0427a629877f80f'
  },
  sendcloud: {
    publicKey: '462e735b-40fc-4fc5-9665-f606016cfb7f',
    secretKey: 'e2839e70192542ffaffbd01dd9693fe1',
    apiUrl: 'https://panel.sendcloud.sc/api/v2'
  }
};

// Mapeo de transportistas
const CARRIER_MAP = {
  'correos': 'CORREOS',
  'correos_express': 'CORREOS',
  'correos_de_espana': 'CORREOS',
  'ctt': 'CTT',
  'ctt_express': 'CTT',
  'ctt_expresso': 'CTT',
  'gls': 'GLS',
  'gls_spain': 'GLS',
  'gls_es': 'GLS',
  'spring': 'SPRING',
  'spring_gds': 'SPRING',
  'inpost': 'INPOST',
  'inpost_es': 'INPOST',
  'inpost_spain': 'INPOST',
  'asendia': 'ASENDIA',
  'asendia_spain': 'ASENDIA'
};

function normalizeCarrier(carrierCode) {
  if (!carrierCode) return null;
  const normalized = carrierCode.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
  return CARRIER_MAP[normalized] || carrierCode.toUpperCase();
}

// Archivos de salida - usar Volume si está disponible
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const INDEX_FILE = path.join(VOLUME_PATH, 'tracking-index.json');
const SENDCLOUD_CACHE = path.join(VOLUME_PATH, 'sendcloud-cache.json');

// ============================================
// CLIENTE ODOO
// ============================================
class OdooClient {
  constructor(config) {
    this.config = config;
    this.uid = null;
    const url = new URL(config.url);
    this.commonClient = xmlrpc.createSecureClient({ host: url.hostname, port: 443, path: '/xmlrpc/2/common' });
    this.objectClient = xmlrpc.createSecureClient({ host: url.hostname, port: 443, path: '/xmlrpc/2/object' });
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      this.commonClient.methodCall('authenticate', [this.config.db, this.config.user, this.config.apiKey, {}], (err, uid) => {
        if (err) reject(err);
        else { this.uid = uid; resolve(uid); }
      });
    });
  }

  async execute(model, method, args, kwargs = {}) {
    if (!this.uid) await this.authenticate();
    return new Promise((resolve, reject) => {
      this.objectClient.methodCall('execute_kw', [this.config.db, this.uid, this.config.apiKey, model, method, args, kwargs], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  async getRecentPickings(daysBack = 4) {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - daysBack);
    const dateFilter = dateFrom.toISOString().split('T')[0];

    console.log(`   📅 Buscando OUTs desde: ${dateFilter}`);

    // Dominio simplificado:
    // (name ilike 'out' OR origin ilike 'out')
    // AND state in ['done', 'assigned', 'confirmed', 'waiting']
    // AND sale_id.team_id ilike 'shopify'
    // AND location_dest_id ilike 'customer'
    // AND scheduled_date >= dateFilter
    // AND carrier_tracking_ref != false
    const domain = [
      "|", ["name", "ilike", "out"], ["origin", "ilike", "out"],
      ["state", "in", ["done", "assigned", "confirmed", "waiting"]],
      ["sale_id.team_id", "ilike", "shopify"],
      ["location_dest_id", "ilike", "customer"],
      ["scheduled_date", ">=", dateFilter],
      ["carrier_tracking_ref", "!=", false]
    ];

    console.log(`   🔍 Dominio: OUTs Shopify B2C con tracking, últimos ${daysBack} días`);

    const pickings = await this.execute('stock.picking', 'search_read', [domain], {
      fields: ['id', 'name', 'carrier_tracking_ref', 'partner_id', 'origin', 'scheduled_date', 'state'],
      order: 'scheduled_date desc',
      limit: 15000
    });

    return pickings;
  }
}

// ============================================
// CLIENTE SENDCLOUD
// ============================================
async function fetchSendcloudParcels(daysBack = 4) {
  const authHeader = 'Basic ' + Buffer.from(`${CONFIG.sendcloud.publicKey}:${CONFIG.sendcloud.secretKey}`).toString('base64');
  
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysBack);
  dateFrom.setHours(0, 0, 0, 0);
  const updatedAfter = dateFrom.toISOString();

  console.log(`   📅 Buscando envíos desde: ${updatedAfter}`);

  let allParcels = [];
  let nextUrl = `${CONFIG.sendcloud.apiUrl}/parcels?updated_after=${encodeURIComponent(updatedAfter)}&limit=500`;
  let page = 1;

  while (nextUrl && page <= 100) {
    console.log(`   📄 Página ${page}...`);

    try {
      const response = await fetch(nextUrl, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.parcels && data.parcels.length > 0) {
        allParcels = allParcels.concat(data.parcels);
      }

      nextUrl = data.next || null;
      page++;

      if (nextUrl) {
        await new Promise(r => setTimeout(r, 200));
      }

    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      break;
    }
  }

  return allParcels;
}

// ============================================
// PATRONES DE COINCIDENCIA
// ============================================

/**
 * Intenta hacer match entre un tracking de Sendcloud y un tracking de Odoo
 * según el transportista
 */
function matchTracking(sendcloudTracking, odooTracking, carrier) {
  if (!sendcloudTracking || !odooTracking) return false;

  const scTrack = sendcloudTracking.toUpperCase().trim();
  const odooTrack = odooTracking.toUpperCase().trim();

  // Coincidencia exacta (funciona para la mayoría)
  if (scTrack === odooTrack) return true;

  // CTT: Odoo tiene solo los últimos dígitos, Sendcloud tiene el tracking completo
  // Ejemplo: Odoo: "4347080" → Sendcloud: "00030100030197014347080"
  if (carrier === 'CTT') {
    if (scTrack.endsWith(odooTrack)) return true;
    if (odooTrack.length >= 7 && scTrack.includes(odooTrack)) return true;
  }

  // SPRING: Similar patrón
  if (carrier === 'SPRING') {
    if (scTrack.endsWith(odooTrack)) return true;
    if (scTrack.includes(odooTrack)) return true;
    if (odooTrack.length >= 10 && scTrack.includes(odooTrack)) return true;
  }

  // ASENDIA: El tracking de Odoo puede estar contenido en Sendcloud o viceversa
  // Ejemplo: Odoo: "6c20544233870" → Sendcloud podría ser diferente
  if (carrier === 'ASENDIA') {
    if (scTrack.includes(odooTrack)) return true;
    if (odooTrack.includes(scTrack)) return true;
    // Comparar ignorando case
    if (scTrack.toLowerCase().includes(odooTrack.toLowerCase())) return true;
    if (odooTrack.toLowerCase().includes(scTrack.toLowerCase())) return true;
  }

  return false;
}

// ============================================
// PROCESO PRINCIPAL
// ============================================
async function sync() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  🔄 SINCRONIZACIÓN COMPLETA - PRE-CÁLCULO DE COINCIDENCIAS    ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  const startTime = Date.now();
  const now = new Date();

  // ============================================
  // PASO 1: Descargar OUTs de Odoo
  // ============================================
  console.log('📦 PASO 1: Descargando OUTs de Odoo...');
  const odooClient = new OdooClient(CONFIG.odoo);
  
  try {
    await odooClient.authenticate();
    console.log('   ✅ Conectado a Odoo');
  } catch (err) {
    console.error('   ❌ Error conectando a Odoo:', err.message);
    process.exit(1);
  }

  const pickings = await odooClient.getRecentPickings(4);
  console.log(`   📦 ${pickings.length} OUTs descargados de Odoo`);
  console.log('');

  // ============================================
  // PASO 2: Descargar envíos de Sendcloud
  // ============================================
  console.log('📬 PASO 2: Descargando envíos de Sendcloud...');
  const parcels = await fetchSendcloudParcels(4);
  console.log(`   📬 ${parcels.length} envíos descargados de Sendcloud`);
  console.log('');

  // Procesar parcels de Sendcloud
  const sendcloudByTracking = {};
  const sendcloudByCarrier = {
    CTT: [],
    SPRING: [],
    CORREOS: [],
    GLS: [],
    INPOST: [],
    ASENDIA: [],
    OTHER: []
  };

  for (const parcel of parcels) {
    const tracking = parcel.tracking_number || parcel.carrier?.tracking_number;
    if (!tracking) continue;

    const carrier = normalizeCarrier(parcel.carrier?.code || parcel.shipment?.name);
    
    const parcelData = {
      tracking: tracking,
      carrier: carrier,
      carrierCode: parcel.carrier?.code || null,
      orderId: parcel.order_number || null,
      externalRef: parcel.external_reference || null,
      name: parcel.name || null,
      company: parcel.company_name || null,
      status: parcel.status?.message || null,
      createdAt: parcel.date_created || null
    };

    sendcloudByTracking[tracking] = parcelData;
    
    if (sendcloudByCarrier[carrier]) {
      sendcloudByCarrier[carrier].push(parcelData);
    } else {
      sendcloudByCarrier.OTHER.push(parcelData);
    }
  }

  // Guardar caché de Sendcloud (para compatibilidad)
  const sendcloudCache = {
    lastSync: now.toISOString(),
    totalParcels: parcels.length,
    parcels: sendcloudByTracking
  };
  fs.writeFileSync(SENDCLOUD_CACHE, JSON.stringify(sendcloudCache, null, 2));
  console.log(`   💾 Caché Sendcloud guardada: ${SENDCLOUD_CACHE}`);
  console.log('');

  // ============================================
  // PASO 3: Cruzar datos y pre-calcular coincidencias
  // ============================================
  console.log('🔗 PASO 3: Pre-calculando coincidencias...');
  
  const trackingIndex = {
    lastSync: now.toISOString(),
    totalOdoo: pickings.length,
    totalSendcloud: parcels.length,
    matched: 0,
    unmatched: 0,
    byTracking: {},      // Índice principal: tracking Sendcloud → datos completos
    byOdooTracking: {},  // Índice inverso: tracking Odoo → datos (para ASENDIA/CTT/SPRING)
    byCarrier: {         // Índice por transportista
      CTT: {},
      SPRING: {},
      CORREOS: {},
      GLS: {},
      INPOST: {},
      ASENDIA: {}
    }
  };

  let matched = 0;
  let unmatched = 0;

  // Transportistas que necesitan coincidencia por patrón (código barras ≠ tracking Odoo)
  const carriersNeedingPattern = ['CTT', 'SPRING', 'ASENDIA'];

  for (const picking of pickings) {
    const odooTracking = picking.carrier_tracking_ref;
    if (!odooTracking) continue;

    const pickingData = {
      pickingId: picking.id,
      pickingName: picking.name,
      orderRef: picking.origin || '',
      clientName: picking.partner_id ? picking.partner_id[1] : '',
      odooTracking: odooTracking,
      state: picking.state
    };

    // Primero intentar coincidencia exacta
    if (sendcloudByTracking[odooTracking]) {
      const scData = sendcloudByTracking[odooTracking];
      const fullData = {
        ...pickingData,
        tracking: scData.tracking,
        carrier: scData.carrier,
        sendcloudData: scData
      };

      trackingIndex.byTracking[scData.tracking] = fullData;
      trackingIndex.byOdooTracking[odooTracking.toUpperCase()] = fullData;
      
      if (trackingIndex.byCarrier[scData.carrier]) {
        trackingIndex.byCarrier[scData.carrier][scData.tracking] = fullData;
      }
      
      matched++;
      continue;
    }

    // Para CTT, SPRING y ASENDIA, buscar por patrón
    let foundMatch = false;
    
    for (const carrier of carriersNeedingPattern) {
      if (foundMatch) break;
      
      for (const scParcel of sendcloudByCarrier[carrier]) {
        if (matchTracking(scParcel.tracking, odooTracking, carrier)) {
          const fullData = {
            ...pickingData,
            tracking: scParcel.tracking,
            carrier: carrier,
            sendcloudData: scParcel,
            matchType: 'pattern'
          };

          trackingIndex.byTracking[scParcel.tracking] = fullData;
          trackingIndex.byOdooTracking[odooTracking.toUpperCase()] = fullData;
          trackingIndex.byCarrier[carrier][scParcel.tracking] = fullData;
          
          matched++;
          foundMatch = true;
          break;
        }
      }
    }

    if (!foundMatch) {
      unmatched++;
    }
  }

  trackingIndex.matched = matched;
  trackingIndex.unmatched = unmatched;

  // ============================================
  // PASO 4: Guardar índice
  // ============================================
  fs.writeFileSync(INDEX_FILE, JSON.stringify(trackingIndex, null, 2));
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  📊 RESUMEN                                                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`   📦 OUTs de Odoo:        ${pickings.length}`);
  console.log(`   📬 Envíos Sendcloud:    ${parcels.length}`);
  console.log(`   ✅ Coincidencias:       ${matched}`);
  console.log(`   ❌ Sin coincidencia:    ${unmatched}`);
  console.log('');
  console.log('   📈 Por transportista:');
  for (const [carrier, data] of Object.entries(trackingIndex.byCarrier)) {
    const count = Object.keys(data).length;
    if (count > 0) {
      console.log(`      • ${carrier}: ${count}`);
    }
  }
  console.log('');
  console.log(`   💾 Índice guardado: ${INDEX_FILE}`);
  console.log(`   ⏱️  Tiempo: ${elapsed}s`);
  console.log('');
  console.log('✅ Sincronización completada');
  console.log('');
}

// Ejecutar
sync().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});