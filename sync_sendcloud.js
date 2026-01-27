/**
 * SYNC-SENDCLOUD.JS
 * Script para descargar envíos de Sendcloud y guardarlos en caché local
 * 
 * Uso: node sync-sendcloud.js
 * 
 * Descarga todos los envíos desde ayer 00:00 hasta ahora
 */

const fs = require('fs');
const path = require('path');

// Configuración Sendcloud
const CONFIG = {
  publicKey: '462e735b-40fc-4fc5-9665-f606016cfb7f',
  secretKey: 'e2839e70192542ffaffbd01dd9693fe1',
  apiUrl: 'https://panel.sendcloud.sc/api/v2'
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

// Archivo de caché
const CACHE_FILE = path.join(__dirname, 'sendcloud-cache.json');

async function fetchParcels(updatedAfter) {
  const authHeader = 'Basic ' + Buffer.from(`${CONFIG.publicKey}:${CONFIG.secretKey}`).toString('base64');
  
  let allParcels = [];
  // Usar updated_after con formato ISO 8601
  let nextUrl = `${CONFIG.apiUrl}/parcels?updated_after=${encodeURIComponent(updatedAfter)}&limit=500`;
  let page = 1;
  
  while (nextUrl && page <= 35) {
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
        console.log(`   📦 ${allParcels.length} envíos descargados...`);
      }
      
      // Siguiente página
      nextUrl = data.next || null;
      page++;
      
      // Pequeña pausa para no saturar la API
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

async function sync() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  🔄 SINCRONIZACIÓN SENDCLOUD                                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Calcular fecha: ayer a las 00:00:00 en formato ISO 8601
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  
  // Formato ISO 8601 completo
  const updatedAfter = yesterday.toISOString();
  
  console.log(`📅 Desde: ${yesterday.toLocaleString('es-ES')}`);
  console.log(`📅 Hasta: ${now.toLocaleString('es-ES')}`);
  console.log(`🔗 Parámetro: updated_after=${updatedAfter}`);
  console.log('');
  console.log('🔄 Descargando envíos de Sendcloud...');
  
  const parcels = await fetchParcels(updatedAfter);
  
  console.log('');
  console.log(`📦 Total descargados: ${parcels.length} envíos`);
  
  // Procesar y crear caché indexada por tracking
  const cache = {
    lastSync: now.toISOString(),
    updatedAfter: updatedAfter,
    totalParcels: parcels.length,
    parcels: {}
  };
  
  let processed = 0;
  let withTracking = 0;
  
  for (const parcel of parcels) {
    processed++;
    
    // Puede tener tracking_number o carrier_tracking_ref
    const tracking = parcel.tracking_number || parcel.carrier?.tracking_number;
    
    if (tracking) {
      withTracking++;
      cache.parcels[tracking] = {
        tracking: tracking,
        carrier: normalizeCarrier(parcel.carrier?.code || parcel.shipment?.name),
        carrierCode: parcel.carrier?.code || null,
        orderId: parcel.order_number || null,
        externalRef: parcel.external_reference || null,
        name: parcel.name || null,
        company: parcel.company_name || null,
        status: parcel.status?.message || null,
        createdAt: parcel.date_created || null
      };
    }
  }
  
  // Guardar caché
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  
  console.log('');
  console.log('📊 Resumen:');
  console.log(`   • Envíos procesados: ${processed}`);
  console.log(`   • Con tracking: ${withTracking}`);
  console.log(`   • Sin tracking: ${processed - withTracking}`);
  console.log('');
  console.log(`💾 Guardado en: ${CACHE_FILE}`);
  console.log('');
  
  // Mostrar ejemplo de transportistas
  const carrierCounts = {};
  for (const p of Object.values(cache.parcels)) {
    const c = p.carrier || 'DESCONOCIDO';
    carrierCounts[c] = (carrierCounts[c] || 0) + 1;
  }
  
  console.log('📈 Por transportista:');
  for (const [carrier, count] of Object.entries(carrierCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`   • ${carrier}: ${count}`);
  }
  
  console.log('');
  console.log('✅ Sincronización completada');
  console.log('');
}

// Ejecutar
sync().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});