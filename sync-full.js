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

function overrideCarrier(carrier, tracking) {
  if (!carrier || !tracking) return carrier;
  const t = tracking.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  // CORREOS EXPRESS: prefijo 9300500 característico
  if (/^9300500/.test(t)) return 'CORREOS EXPRESS';
  if (/^H103/.test(t) && carrier === 'SPRING') return 'ASENDIA';
  // 8 dígitos exactos = INPOST (formato estándar)
  if (/^\d{8}$/.test(t)) return 'INPOST';
  return carrier;
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

  async getRecentPickings(daysBack = 7) {
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
    // AND (carrier_tracking_ref != false OR carrier_id.name ilike 'mika')
    //   ↑ Incluye CRX (MIKA) aunque tenga tracking vacío, porque MIKA
    //     actualiza el carrier_tracking_ref con delay; así el operario al
    //     menos puede buscar el pedido por nº o cliente.
    const domain = [
      "|", ["name", "ilike", "out"], ["origin", "ilike", "out"],
      ["state", "in", ["done", "assigned", "confirmed", "waiting"]],
      ["sale_id.team_id", "ilike", "shopify"],
      ["location_dest_id", "ilike", "customer"],
      ["scheduled_date", ">=", dateFilter],
      // OR explícito en lógica Odoo: prefijo "|"
      "|", ["carrier_tracking_ref", "!=", false], ["carrier_id.name", "ilike", "mika"]
    ];

    console.log(`   🔍 Dominio: OUTs Shopify B2C con tracking, últimos ${daysBack} días`);

    const pickings = await this.execute('stock.picking', 'search_read', [domain], {
      fields: ['id', 'name', 'carrier_tracking_ref', 'partner_id', 'origin', 'scheduled_date', 'state', 'carrier_id', 'sale_id', 'weight', 'date_done'],
      order: 'scheduled_date desc',
      limit: 30000
    });

    return pickings;
  }
}

// ============================================
// CLIENTE SENDCLOUD
// ============================================
// IMPORTANTE: Sendcloud IGNORA el parámetro limit y siempre devuelve 100 envíos por página.
// Con ~3000 envíos/día * 7 días = ~21000 envíos -> necesitamos al menos 250 páginas.
// Subimos a 500 páginas máximo para tener margen (=50000 envíos posibles).
async function fetchSendcloudParcels(daysBack = 7) {
  const authHeader = 'Basic ' + Buffer.from(`${CONFIG.sendcloud.publicKey}:${CONFIG.sendcloud.secretKey}`).toString('base64');

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysBack);
  dateFrom.setHours(0, 0, 0, 0);
  const updatedAfter = dateFrom.toISOString();

  console.log(`   📅 Buscando envíos desde: ${updatedAfter}`);

  let allParcels = [];
  let nextUrl = `${CONFIG.sendcloud.apiUrl}/parcels?updated_after=${encodeURIComponent(updatedAfter)}&limit=500`;
  let page = 1;
  const MAX_PAGES = 500;
  let consecutiveErrors = 0;

  while (nextUrl && page <= MAX_PAGES) {
    // Log cada 25 páginas para no saturar
    if (page === 1 || page % 25 === 0) {
      console.log(`   📄 Página ${page} (${allParcels.length} envíos descargados)...`);
    }

    try {
      const response = await fetch(nextUrl, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        // Reintentar hasta 3 errores consecutivos antes de abortar
        consecutiveErrors++;
        console.warn(`   ⚠️ HTTP ${response.status} en página ${page} (intento ${consecutiveErrors}/3)`);
        if (consecutiveErrors >= 3) {
          console.error(`   ❌ 3 errores consecutivos, abortando paginación`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      consecutiveErrors = 0;
      const data = await response.json();

      if (data.parcels && data.parcels.length > 0) {
        allParcels = allParcels.concat(data.parcels);
      }

      nextUrl = data.next || null;
      page++;

      if (nextUrl) {
        await new Promise(r => setTimeout(r, 150));
      }

    } catch (err) {
      consecutiveErrors++;
      console.error(`   ❌ Error en página ${page}: ${err.message} (${consecutiveErrors}/3)`);
      if (consecutiveErrors >= 3) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`   ✅ Total descargado: ${allParcels.length} envíos en ${page - 1} páginas`);
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

  // ASENDIA: Solo match exacto - los trackings de Sendcloud y Odoo son diferentes identificadores
  // Barcodes físicos contienen el tracking de Odoo embebido (6C20XXXXXXXXX) pero
  // el tracking de Sendcloud es un identificador distinto. Substring matching causa falsos positivos.
  if (carrier === 'ASENDIA') {
    // Solo permitir match si los trackings son idénticos (ya chequeado arriba)
    return false;
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

  const pickings = await odooClient.getRecentPickings(7);
  console.log(`   📦 ${pickings.length} OUTs descargados de Odoo`);
  console.log('');

  // ============================================
  // PASO 2: Descargar envíos de Sendcloud
  // ============================================
  console.log('📬 PASO 2: Descargando envíos de Sendcloud...');
  const parcels = await fetchSendcloudParcels(7);
  console.log(`   📬 ${parcels.length} envíos descargados de Sendcloud`);
  console.log('');

  // Procesar parcels de Sendcloud
  const sendcloudByTracking = {};
  const sendcloudByCarrier = {
    CTT: [],
    SPRING: [],
    CORREOS: [],
    'CORREOS EXPRESS': [],
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
      createdAt: parcel.date_created || null,
      // Datos extra para validación cruzada
      country: parcel.country?.iso_2 || null,
      postalCode: parcel.postal_code || null,
      city: parcel.city || null,
      weight: parcel.weight ? parseFloat(parcel.weight) : null,
      shipmentName: parcel.shipment?.name || null
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
      'CORREOS EXPRESS': {},
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

    // Detectar CORREOS EXPRESS por carrier de Odoo (empieza por MI)
    const odooCarrierName = picking.carrier_id ? picking.carrier_id[1] : '';
    const isCorreosExpress = odooCarrierName.toUpperCase().startsWith('MI');

    // CASO ESPECIAL: CRX sin tracking todavía (MIKA actualiza con delay).
    // Lo metemos en un array de pendientes — el PASO 3.5 lo incluirá en byOrderRef
    // para que sea encontrable por nº de pedido o cliente desde la app.
    if (!odooTracking && isCorreosExpress) {
      const orderRef = (picking.origin || '').toUpperCase().trim();
      if (!orderRef) { unmatched++; continue; }
      if (!trackingIndex.pendingCrx) trackingIndex.pendingCrx = [];
      trackingIndex.pendingCrx.push({
        pickingId: picking.id,
        pickingName: picking.name,
        orderRef: orderRef,
        clientName: picking.partner_id ? picking.partner_id[1] : '',
        partnerId: picking.partner_id ? picking.partner_id[0] : null,
        saleId: picking.sale_id ? picking.sale_id[0] : null,
        saleName: picking.sale_id ? picking.sale_id[1] : '',
        weight: picking.weight || null,
        dateDone: picking.date_done || null,
        odooTracking: null,
        odooCarrierName: odooCarrierName || '',
        state: picking.state,
        tracking: null,
        carrier: 'CORREOS EXPRESS',
        source: 'odoo-carrier-pending',
        pendingTracking: true
      });
      matched++;
      continue;
    }

    if (!odooTracking) continue;

    const pickingData = {
      pickingId: picking.id,
      pickingName: picking.name,
      orderRef: picking.origin || '',
      clientName: picking.partner_id ? picking.partner_id[1] : '',
      partnerId: picking.partner_id ? picking.partner_id[0] : null,
      saleId: picking.sale_id ? picking.sale_id[0] : null,
      saleName: picking.sale_id ? picking.sale_id[1] : '',
      weight: picking.weight || null,
      dateDone: picking.date_done || null,
      odooTracking: odooTracking,
      odooCarrierName: odooCarrierName || '',
      state: picking.state
    };

    // Si es CORREOS EXPRESS (carrier Odoo empieza por MI), añadir directamente sin Sendcloud
    if (isCorreosExpress) {
      const fullData = {
        ...pickingData,
        tracking: odooTracking,
        carrier: 'CORREOS EXPRESS',
        source: 'odoo-carrier'
      };

      trackingIndex.byTracking[odooTracking] = fullData;
      trackingIndex.byOdooTracking[odooTracking.toUpperCase()] = fullData;
      trackingIndex.byCarrier['CORREOS EXPRESS'][odooTracking] = fullData;
      
      matched++;
      continue;
    }

    // Primero intentar coincidencia exacta
    if (sendcloudByTracking[odooTracking]) {
      const scData = sendcloudByTracking[odooTracking];
      const finalCarrier = overrideCarrier(scData.carrier, odooTracking);
      const fullData = {
        ...pickingData,
        tracking: scData.tracking,
        carrier: finalCarrier,
        sendcloudData: scData
      };

      trackingIndex.byTracking[scData.tracking] = fullData;
      trackingIndex.byOdooTracking[odooTracking.toUpperCase()] = fullData;

      if (trackingIndex.byCarrier[finalCarrier]) {
        trackingIndex.byCarrier[finalCarrier][scData.tracking] = fullData;
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
          const finalCarrier = overrideCarrier(carrier, odooTracking);
          const fullData = {
            ...pickingData,
            tracking: scParcel.tracking,
            carrier: finalCarrier,
            sendcloudData: scParcel,
            matchType: 'pattern'
          };

          trackingIndex.byTracking[scParcel.tracking] = fullData;
          trackingIndex.byOdooTracking[odooTracking.toUpperCase()] = fullData;
          if (trackingIndex.byCarrier[finalCarrier]) {
            trackingIndex.byCarrier[finalCarrier][scParcel.tracking] = fullData;
          }
          
          matched++;
          foundMatch = true;
          break;
        }
      }
    }

    if (!foundMatch) {
      // CLAVE: Añadir al índice IGUALMENTE por tracking de Odoo
      // Así al escanear el tracking directo o extraerlo de un QR, se encuentra en <1ms
      const t = odooTracking.toUpperCase().trim();
      let detectedCarrier = null;
      if (/^Z89/.test(t)) detectedCarrier = 'GLS';
      else if (/^PK/.test(t)) detectedCarrier = 'CORREOS';
      else if (/^MI/.test(t)) detectedCarrier = 'CORREOS EXPRESS';
      else if (/^9300500/.test(t)) detectedCarrier = 'CORREOS EXPRESS';
      else if (/^6C20/.test(t)) detectedCarrier = 'ASENDIA';
      else if (/^H103/.test(t)) detectedCarrier = 'ASENDIA';
      else if (/^6A/.test(t)) detectedCarrier = 'SPRING';
      else if (/^LS\d{9}[A-Z]{2}$/.test(t)) detectedCarrier = 'ASENDIA';
      else if (/^LS|^LX|^LV|^LT|^3[A-Z]|^CP|^Z96|^XSMT|^0008|^0626/.test(t)) detectedCarrier = 'SPRING';
      else if (/^CTT|^EA/.test(t)) detectedCarrier = 'CTT';
      else if (/^C0/.test(t)) detectedCarrier = 'CORREOS';
      else if (/^\d{8}$/.test(t)) detectedCarrier = 'INPOST';

      const odooOnlyData = {
        ...pickingData,
        tracking: odooTracking,
        carrier: detectedCarrier || 'DESCONOCIDO',
        source: 'odoo-only'
      };

      trackingIndex.byOdooTracking[t] = odooOnlyData;
      // También añadir a byTracking con la key del tracking de Odoo
      trackingIndex.byTracking[t] = odooOnlyData;
      // Y a byCarrier si el carrier es conocido
      if (detectedCarrier && trackingIndex.byCarrier[detectedCarrier]) {
        trackingIndex.byCarrier[detectedCarrier][t] = odooOnlyData;
      }

      unmatched++;
    }
  }

  trackingIndex.matched = matched;
  trackingIndex.unmatched = unmatched;

  // ============================================
  // PASO 3.5: Construir índices auxiliares (búsqueda por pedido y cliente)
  // ============================================
  console.log('🔗 PASO 3.5: Construyendo índices auxiliares...');

  trackingIndex.byOrderRef = {};      // orderRef → [pickings]
  trackingIndex.byClientName = {};    // clientName lowercase → [pickings]
  trackingIndex.byPartnerId = {};     // partnerId → [pickings]

  const allEntries = new Set();
  Object.values(trackingIndex.byOdooTracking || {}).forEach(e => allEntries.add(e));
  Object.values(trackingIndex.byTracking || {}).forEach(e => allEntries.add(e));
  // Incluir pendientes CRX (sin tracking aún) para que sean encontrables por orderRef
  (trackingIndex.pendingCrx || []).forEach(e => allEntries.add(e));

  let dupTrackings = 0;
  const trackingCounts = {};

  for (const entry of allEntries) {
    if (entry.orderRef) {
      const key = entry.orderRef.toUpperCase();
      if (!trackingIndex.byOrderRef[key]) trackingIndex.byOrderRef[key] = [];
      trackingIndex.byOrderRef[key].push({
        pickingId: entry.pickingId,
        pickingName: entry.pickingName,
        tracking: entry.tracking || entry.odooTracking,
        carrier: entry.carrier,
        clientName: entry.clientName,
        state: entry.state
      });
    }
    if (entry.clientName) {
      // Extraer primer nombre (formato "Nombre, Nombre" en Odoo)
      const firstName = entry.clientName.split(',')[0].trim().toLowerCase();
      if (firstName.length >= 3) {
        if (!trackingIndex.byClientName[firstName]) trackingIndex.byClientName[firstName] = [];
        trackingIndex.byClientName[firstName].push({
          pickingId: entry.pickingId,
          pickingName: entry.pickingName,
          tracking: entry.tracking || entry.odooTracking,
          carrier: entry.carrier,
          orderRef: entry.orderRef
        });
      }
    }
    // Contar duplicados de tracking (mismo tracking en múltiples pickings)
    const trk = entry.odooTracking || entry.tracking;
    if (trk) {
      trackingCounts[trk] = (trackingCounts[trk] || 0) + 1;
    }
  }

  // Detectar trackings duplicados
  trackingIndex.duplicateTrackings = {};
  for (const [trk, count] of Object.entries(trackingCounts)) {
    if (count > 1) {
      trackingIndex.duplicateTrackings[trk] = count;
      dupTrackings++;
    }
  }

  console.log(`   📋 Índice por pedido: ${Object.keys(trackingIndex.byOrderRef).length} pedidos`);
  console.log(`   👤 Índice por cliente: ${Object.keys(trackingIndex.byClientName).length} clientes únicos`);
  console.log(`   ⚠️ Trackings duplicados: ${dupTrackings}`);

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