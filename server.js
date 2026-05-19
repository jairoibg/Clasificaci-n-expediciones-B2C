const express = require('express');
const cors = require('cors');
const xmlrpc = require('xmlrpc');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==============================================
// CONFIGURACIÓN
// ==============================================
const CONFIG = {
  odoo: {
    url: process.env.ODOO_URL || 'https://blackdivision.processcontrol.sh',
    db: process.env.ODOO_DB || 'blackdivision',
    user: process.env.ODOO_USER || 'j.bernabe@illice.com',
    apiKey: process.env.ODOO_API_KEY || '98b68f64a4ee2fd5362f16f3b0427a629877f80f'
  },
  sendcloud: {
    publicKey: process.env.SENDCLOUD_PUBLIC_KEY || '462e735b-40fc-4fc5-9665-f606016cfb7f',
    secretKey: process.env.SENDCLOUD_SECRET_KEY || 'e2839e70192542ffaffbd01dd9693fe1',
    apiUrl: 'https://panel.sendcloud.sc/api/v2'
  }
};

const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DATA_FILE = path.join(VOLUME_PATH, 'data.json');
const SENDCLOUD_CACHE_FILE = path.join(VOLUME_PATH, 'sendcloud-cache.json');
const TRACKING_INDEX_FILE = path.join(VOLUME_PATH, 'tracking-index.json');

// MAPEO CORREGIDO - CORREOS EXPRESS separado
const SENDCLOUD_CARRIER_MAP = {
  'correos': 'CORREOS',
  'correos_de_espana': 'CORREOS',
  'correos_express': 'CORREOS EXPRESS',
  'correos_express_es': 'CORREOS EXPRESS',
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
  'asendia_spain': 'ASENDIA',
  'asendia_es': 'ASENDIA'
};

const CARRIERS = ['ASENDIA', 'CORREOS', 'CORREOS EXPRESS', 'CTT', 'GLS', 'INPOST', 'SPRING'];

// =============================================
// CACHÉ SENDCLOUD
// =============================================
let sendcloudCache = { parcels: {} };

function loadSendcloudCache() {
  try {
    if (fs.existsSync(SENDCLOUD_CACHE_FILE)) {
      const data = fs.readFileSync(SENDCLOUD_CACHE_FILE, 'utf8');
      sendcloudCache = JSON.parse(data);
      console.log('📦 Caché Sendcloud cargada: ' + Object.keys(sendcloudCache.parcels || {}).length + ' envíos');
    }
  } catch (err) {
    console.error('Error cargando caché Sendcloud:', err.message);
  }
}

function findInSendcloudCache(tracking) {
  if (!tracking || !sendcloudCache.parcels) return null;
  const trackingUpper = tracking.toUpperCase().trim();
  if (sendcloudCache.parcels[tracking]) return sendcloudCache.parcels[tracking];
  for (const [key, value] of Object.entries(sendcloudCache.parcels)) {
    if (key.toUpperCase() === trackingUpper) return value;
  }
  return null;
}

// ============================================
// ÍNDICE DE TRACKING
// ============================================
let trackingIndex = {
  lastSync: null, totalOdoo: 0, totalSendcloud: 0, matched: 0,
  byTracking: {}, byOdooTracking: {}, byCarrier: {}
};

function loadTrackingIndex() {
  try {
    if (fs.existsSync(TRACKING_INDEX_FILE)) {
      const data = fs.readFileSync(TRACKING_INDEX_FILE, 'utf8');
      trackingIndex = JSON.parse(data);
      const age = trackingIndex.lastSync ? Math.round((Date.now() - new Date(trackingIndex.lastSync).getTime()) / 60000) : 'N/A';
      console.log('📊 Índice cargado: ' + trackingIndex.matched + ' coincidencias (hace ' + age + ' min)');
      return true;
    }
  } catch (err) {
    console.error('⚠️ Error cargando índice:', err.message);
  }
  console.log('📊 Sin índice previo - se regenerará');
  return false;
}

// PATTERN MATCHING MEJORADO
function findInTrackingIndex(tracking) {
  var clean = tracking.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  
  if (clean.length < 5) return null;

  // PASO 1: Match exacto en byTracking (Sendcloud) - O(1)
  if (trackingIndex.byTracking && trackingIndex.byTracking[clean]) {
    return trackingIndex.byTracking[clean];
  }
  
  // PASO 2: Match exacto en byOdooTracking - O(1)
  if (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[clean]) {
    return trackingIndex.byOdooTracking[clean];
  }

  // PASO 2.3: ASENDIA - Si tracking empieza con 6C20 y no tuvo match exacto,
  // intentar prefijo de 12 chars (último dígito puede variar entre barcode y tracking Odoo)
  // Ej: barcode extrae 6C20629705008, Odoo tiene 6C20629705001 (comparten 6C2062970500)
  if (/^6C20/.test(clean) && clean.length >= 12 && trackingIndex.byCarrier && trackingIndex.byCarrier["ASENDIA"]) {
    var prefix12 = clean.substring(0, 12);
    var asCarrierData = trackingIndex.byCarrier["ASENDIA"];
    var asCarrierKeys = Object.keys(asCarrierData);
    for (var px = 0; px < asCarrierKeys.length; px++) {
      if (asCarrierKeys[px].substring(0, 12) === prefix12) {
        console.log("   🎯 Match ASENDIA prefijo 12: " + asCarrierKeys[px] + " (buscado: " + clean + ")");
        return asCarrierData[asCarrierKeys[px]];
      }
    }
  }

  // PASO 2.5: ASENDIA - Extraer tracking embebido del barcode ANTES del matching genérico
  var asendiaExtract = extractAsendiaTracking(clean);
  if (asendiaExtract.extracted && !asendiaExtract.isDirectMatch) {
    var extractedUpper = asendiaExtract.extracted.toUpperCase();
    // Buscar match exacto en byTracking
    if (trackingIndex.byTracking && trackingIndex.byTracking[extractedUpper]) {
      console.log("   🎯 Match ASENDIA extraído (byTracking): " + extractedUpper);
      return trackingIndex.byTracking[extractedUpper];
    }
    // Buscar match exacto en byOdooTracking
    if (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[extractedUpper]) {
      console.log("   🎯 Match ASENDIA extraído (byOdooTracking): " + extractedUpper);
      return trackingIndex.byOdooTracking[extractedUpper];
    }
    // Buscar en byCarrier ASENDIA por odooTracking exacto
    var asendiaCarrierData = trackingIndex.byCarrier && trackingIndex.byCarrier["ASENDIA"];
    if (asendiaCarrierData) {
      if (asendiaCarrierData[extractedUpper]) {
        console.log("   🎯 Match ASENDIA extraído (byCarrier key): " + extractedUpper);
        return asendiaCarrierData[extractedUpper];
      }
      var asKeys = Object.keys(asendiaCarrierData);
      for (var ae = 0; ae < asKeys.length; ae++) {
        var aeData = asendiaCarrierData[asKeys[ae]];
        if (aeData.odooTracking && aeData.odooTracking.toUpperCase() === extractedUpper) {
          console.log("   🎯 Match ASENDIA extraído (odooTracking): " + extractedUpper);
          return aeData;
        }
      }
    }
    // FALLBACK: prefijo de 12 chars - el último dígito del barcode puede diferir del tracking Odoo
    // Ej: barcode extrae 6C20629705008 pero Odoo tiene 6C20629705001 (comparten 12 chars)
    if (extractedUpper.length >= 12) {
      var prefix12ext = extractedUpper.substring(0, 12);
      var asFallbackData = trackingIndex.byCarrier && trackingIndex.byCarrier["ASENDIA"];
      if (asFallbackData) {
        var asFbKeys = Object.keys(asFallbackData);
        for (var afb = 0; afb < asFbKeys.length; afb++) {
          if (asFbKeys[afb].substring(0, 12) === prefix12ext) {
            console.log("   🎯 Match ASENDIA prefijo 12: " + asFbKeys[afb] + " (extraído: " + extractedUpper + ")");
            return asFallbackData[asFbKeys[afb]];
          }
          var afbData = asFallbackData[asFbKeys[afb]];
          if (afbData.odooTracking && afbData.odooTracking.toUpperCase().substring(0, 12) === prefix12ext) {
            console.log("   🎯 Match ASENDIA prefijo 12 (odoo): " + afbData.odooTracking + " (extraído: " + extractedUpper + ")");
            return afbData;
          }
        }
      }
    }
    // Patrón ASENDIA detectado pero no en índice - NO caer al matching genérico
    console.log("   ⚠️ ASENDIA extraído " + extractedUpper + " no en índice, se buscará en Odoo");
    return null;
  }

  // PASO 2.6: INPOST - Extraer tracking de 8 dígitos embebido en barcode largo
  if (clean.length > 10 && /^\d+$/.test(clean)) {
    var inpostExtract = extractInpostTracking(clean);
    if (inpostExtract.extracted && !inpostExtract.isDirectMatch) {
      var ipTracking = inpostExtract.extracted;
      // Buscar en byCarrier INPOST
      if (trackingIndex.byCarrier && trackingIndex.byCarrier["INPOST"] && trackingIndex.byCarrier["INPOST"][ipTracking]) {
        console.log("   🎯 Match INPOST extraído (pos 2-9): " + ipTracking);
        return trackingIndex.byCarrier["INPOST"][ipTracking];
      }
      // Buscar en byOdooTracking
      if (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[ipTracking]) {
        var ipData = trackingIndex.byOdooTracking[ipTracking];
        if (ipData.carrier === 'INPOST') {
          console.log("   🎯 Match INPOST extraído (byOdoo): " + ipTracking);
          return ipData;
        }
      }
      // Buscar en byTracking
      if (trackingIndex.byTracking && trackingIndex.byTracking[ipTracking]) {
        var ipData2 = trackingIndex.byTracking[ipTracking];
        if (ipData2.carrier === 'INPOST') {
          console.log("   🎯 Match INPOST extraído (byTracking): " + ipTracking);
          return ipData2;
        }
      }
    }
  }

  // PASO 3: CTT/SPRING - Escaneado LARGO (>=18 chars)
  // GUARD: evitar contaminación cross-carrier (barcode CTT matcheando SPRING y viceversa)
  if (clean.length >= 18 && trackingIndex.byCarrier) {
    var isCTTFormat = /^00030100/.test(clean);
    var isSPRINGFormat = /^0626/.test(clean);

    // Solo buscar CTT si el barcode NO es claramente SPRING
    if (!isSPRINGFormat) {
      var cttData = trackingIndex.byCarrier["CTT"];
      if (cttData) {
        var cttKeys = Object.keys(cttData);
        for (var i = 0; i < cttKeys.length; i++) {
          var cttTrack = cttKeys[i];
          var data = cttData[cttTrack];
          var odooTrack = data.odooTracking ? data.odooTracking.toUpperCase() : cttTrack;

          if (odooTrack.length >= 7) {
            if (clean.endsWith(odooTrack)) {
              console.log("   🔍 Match CTT sufijo: termina con " + odooTrack);
              return data;
            }
            if (clean.indexOf(odooTrack) !== -1) {
              console.log("   🔍 Match CTT contenido: contiene " + odooTrack);
              return data;
            }
          }
        }
      }
    }

    // Solo buscar SPRING si el barcode NO es claramente CTT
    if (!isCTTFormat) {
      var springData = trackingIndex.byCarrier["SPRING"];
      if (springData) {
        var springKeys = Object.keys(springData);
        for (var j = 0; j < springKeys.length; j++) {
          var springTrack = springKeys[j];
          var dataS = springData[springTrack];
          var odooTrackS = dataS.odooTracking ? dataS.odooTracking.toUpperCase() : springTrack;

          if (odooTrackS.length >= 7) {
            if (clean.endsWith(odooTrackS)) {
              console.log("   🔍 Match SPRING sufijo: termina con " + odooTrackS);
              return dataS;
            }
            if (clean.indexOf(odooTrackS) !== -1) {
              console.log("   🔍 Match SPRING contenido: contiene " + odooTrackS);
              return dataS;
            }
          }
        }
      }
    }
  }

  // PASO 3.5: GLS + CORREOS + ASENDIA - Match EXACTO por key en byCarrier
  if (clean.length >= 5 && trackingIndex.byCarrier) {
    var carrierChecks = ["GLS", "CORREOS", "ASENDIA", "SPRING", "CTT"];
    for (var ci = 0; ci < carrierChecks.length; ci++) {
      var cData = trackingIndex.byCarrier[carrierChecks[ci]];
      if (cData && cData[clean]) {
        return cData[clean];
      }
    }
  }

  // PASO 5: Búsqueda inversa - Escaneado CORTO (7-17 chars)
  if (clean.length >= 7 && clean.length <= 17 && trackingIndex.byCarrier) {
    
    var cttDataInv = trackingIndex.byCarrier["CTT"];
    if (cttDataInv) {
      var cttKeysInv = Object.keys(cttDataInv);
      for (var m = 0; m < cttKeysInv.length; m++) {
        var trackInv = cttKeysInv[m];
        var dataInv = cttDataInv[trackInv];
        if (trackInv.length > clean.length && trackInv.endsWith(clean)) {
          console.log("   🔍 Match CTT inverso: " + trackInv.slice(0, 10) + "... termina con " + clean);
          return dataInv;
        }
      }
    }
    
    var springDataInv = trackingIndex.byCarrier["SPRING"];
    if (springDataInv) {
      var springKeysInv = Object.keys(springDataInv);
      for (var n = 0; n < springKeysInv.length; n++) {
        var trackInvS = springKeysInv[n];
        var dataInvS = springDataInv[trackInvS];
        if (trackInvS.length > clean.length && trackInvS.endsWith(clean)) {
          console.log("   🔍 Match SPRING inverso: " + trackInvS.slice(0, 10) + "... termina con " + clean);
          return dataInvS;
        }
      }
    }
  }
  
  return null;
}

// =============================================
// AUTO-SYNC
// =============================================
let syncInProgress = false;
let lastSyncAttempt = null;

async function runSync() {
  if (syncInProgress) { console.log('⏳ Sync ya en progreso...'); return false; }
  const syncScript = path.join(__dirname, 'sync-full.js');
  if (!fs.existsSync(syncScript)) { console.log('⚠️ sync-full.js no encontrado'); return false; }
  
  syncInProgress = true;
  lastSyncAttempt = new Date().toISOString();
  console.log('\n🔄 Iniciando sync completo... (' + lastSyncAttempt + ')');
  
  return new Promise((resolve) => {
    const child = spawn('node', [syncScript], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => console.log('   ' + line));
    });
    child.stderr.on('data', (data) => console.error('   ❌ ' + data.toString()));
    child.on('close', (code) => {
      syncInProgress = false;
      if (code === 0) { console.log('✅ Sync completado'); loadTrackingIndex(); loadSendcloudCache(); resolve(true); }
      else { console.log('❌ Sync falló con código ' + code); resolve(false); }
    });
    child.on('error', (err) => { syncInProgress = false; console.error('❌ Error sync:', err.message); resolve(false); });
  });
}

function setupScheduledSync() {
  const SYNC_HOURS = [0, 6, 10, 12, 14];
  setInterval(() => {
    const now = new Date();
    if (SYNC_HOURS.includes(now.getHours()) && now.getMinutes() === 0) {
      console.log('\n⏰ Sync programado (' + now.getHours() + ':00)');
      runSync();
    }
  }, 60000);
  console.log('⏰ Sync programado para las ' + SYNC_HOURS.join(':00, ') + ':00');
}

// ============================================
// BASE DE DATOS
// ============================================
let database = { activeSessions: {}, pallets: {}, pickups: {}, manifests: {} };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      database = JSON.parse(data);
      console.log('📂 Datos cargados desde Volume');
      
      // MIGRACIÓN: pallets -> packages
      for (const carrier of Object.keys(database.activeSessions)) {
        const session = database.activeSessions[carrier];
        if (session && session.pallets && !session.packages) {
          const allPackages = [];
          for (const pallet of session.pallets) {
            if (pallet.packages && Array.isArray(pallet.packages)) allPackages.push(...pallet.packages);
          }
          database.activeSessions[carrier] = { packages: allPackages, lastUpdate: session.pallets[0]?.lastUpdate || new Date().toISOString() };
          console.log('   ✅ Migrada sesión ' + carrier + ': ' + allPackages.length + ' paquetes');
        }
      }
      saveData();
      return;
    }
    const fallbackFile = path.join(__dirname, 'data.json');
    if (fs.existsSync(fallbackFile)) {
      database = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
      console.log('📂 Datos cargados desde GitHub');
      saveData();
    }
  } catch (err) { console.error('Error cargando datos:', err.message); }
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(database, null, 2)); }
  catch (err) { console.error('Error guardando:', err.message); }
}

loadData();
loadSendcloudCache();

// ============================================
// FUNCIONES DE SESIÓN (ESTRUCTURA SIMPLE)
// ============================================
function getSession(carrier) {
  const c = carrier.toUpperCase();
  if (!database.activeSessions[c]) database.activeSessions[c] = { packages: [], lastUpdate: null };
  const session = database.activeSessions[c];
  if (!session.packages || !Array.isArray(session.packages)) session.packages = [];
  return session;
}

function addPackageToSession(carrier, packageData) {
  const session = getSession(carrier);
  if (session.packages.find(p => p.tracking === packageData.tracking)) return { added: false, reason: 'duplicate' };
  if (packageData.orderRef && session.packages.find(p => p.orderRef === packageData.orderRef)) return { added: false, reason: 'duplicate-order' };
  session.packages.push(packageData);
  session.lastUpdate = new Date().toISOString();
  saveData();
  return { added: true };
}

function clearSession(carrier) {
  database.activeSessions[carrier.toUpperCase()] = { packages: [], lastUpdate: null };
  saveData();
}

function removePackageFromSession(carrier, tracking) {
  const session = getSession(carrier);
  const len = session.packages.length;
  session.packages = session.packages.filter(p => p.tracking !== tracking);
  if (session.packages.length < len) { session.lastUpdate = new Date().toISOString(); saveData(); return true; }
  return false;
}

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
        if (err) reject(err); else { this.uid = uid; resolve(uid); }
      });
    });
  }

  async execute(model, method, args, kwargs = {}) {
    if (!this.uid) await this.authenticate();
    return new Promise((resolve, reject) => {
      this.objectClient.methodCall('execute_kw', [this.config.db, this.uid, this.config.apiKey, model, method, args, kwargs], (err, result) => {
        if (err) reject(err); else resolve(result);
      });
    });
  }

  async findPickingByTracking(tracking) {
    try {
      let pickings = await this.execute('stock.picking', 'search_read', [[['carrier_tracking_ref', '=', tracking]]], { 
        fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin', 'carrier_id'], limit: 1 
      });
      if (pickings.length > 0) return pickings[0];

      pickings = await this.execute('stock.picking', 'search_read', [[['carrier_tracking_ref', 'ilike', tracking]]], { 
        fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin', 'carrier_id'], limit: 1 
      });
      if (pickings.length > 0) return pickings[0];

      const patterns = this.extractTrackingPatterns(tracking);
      for (const pattern of patterns) {
        if (pattern.length >= 7) {
          pickings = await this.execute('stock.picking', 'search_read', [
            [['carrier_tracking_ref', 'ilike', pattern], ['state', '=', 'done'], ['picking_type_code', '=', 'outgoing']]
          ], { fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin', 'carrier_id'], limit: 10 });
          if (pickings.length > 0) {
            // Si hay múltiples resultados, elegir el que mejor coincida con el barcode escaneado
            const best = pickings.reduce((a, b) => {
              const cleanUpper = tracking.toUpperCase();
              const trackA = (a.carrier_tracking_ref || '').toUpperCase();
              const trackB = (b.carrier_tracking_ref || '').toUpperCase();
              let scoreA = 0, scoreB = 0;
              while (scoreA < trackA.length && scoreA < cleanUpper.length && trackA[scoreA] === cleanUpper[scoreA]) scoreA++;
              while (scoreB < trackB.length && scoreB < cleanUpper.length && trackB[scoreB] === cleanUpper[scoreB]) scoreB++;
              return scoreB > scoreA ? b : a;
            });
            console.log('   🔍 Match patrón Odoo: "' + pattern + '" → ' + best.carrier_tracking_ref + ' (mejor de ' + pickings.length + ')');
            return best;
          }
        }
      }
      return null;
    } catch (err) { console.error('   ❌ Error Odoo:', err.message); return null; }
  }

  extractTrackingPatterns(code) {
    const patterns = [];
    const clean = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const correos = clean.match(/[A-Z]{1,2}\d{10,}/gi);
    if (correos) patterns.push(...correos);
    const numeros = clean.match(/\d{10,}/g);
    if (numeros) patterns.push(...numeros);
    if (clean.length > 15 && /^\d+$/.test(clean)) {
      for (let len = Math.min(clean.length - 2, 15); len >= 7; len--) patterns.push(clean.slice(-len));
      }
    if (clean.length > 15) {
      // Prefijos largos: CTT barcode=26 chars (tracking 23 + sufijo 3),
      // con max 15 matcheaba demasiados CTT y el correcto no estaba en los resultados
      for (let len = Math.min(clean.length - 1, 25); len >= 10; len--) patterns.push(clean.substring(0, len));
    }
    return [...new Set(patterns)].sort((a, b) => b.length - a.length);
  }

  async findPickingsByClientName(clientName, limit = 20) {
    try {
      const dateFilter = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
      console.log('   🔍 Buscando cliente: "' + clientName + '"');
      const pickings = await this.execute('stock.picking', 'search_read', [
        [['partner_id.name', 'ilike', clientName], ['state', '=', 'done'], ['picking_type_code', '=', 'outgoing'], ['carrier_tracking_ref', '!=', false], ['scheduled_date', '>=', dateFilter]]
      ], { fields: ['id', 'name', 'carrier_tracking_ref', 'partner_id', 'origin', 'scheduled_date', 'manual_expedition_date'], order: 'scheduled_date desc', limit });
      console.log('   📋 Encontrados: ' + pickings.length + ' resultados');
      return pickings;
    } catch (err) { console.error('   ❌ Error:', err.message); return []; }
  }

  async findPickingsByOrderRef(orderRef, limit = 20) {
    try {
      const dateFilter = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
      console.log('   🔍 Buscando pedido: "' + orderRef + '"');
      const pickings = await this.execute('stock.picking', 'search_read', [
        [['origin', 'ilike', orderRef], ['state', '=', 'done'], ['picking_type_code', '=', 'outgoing'], ['carrier_tracking_ref', '!=', false], ['scheduled_date', '>=', dateFilter]]
      ], { fields: ['id', 'name', 'carrier_tracking_ref', 'partner_id', 'origin', 'scheduled_date', 'manual_expedition_date'], order: 'scheduled_date desc', limit });
      console.log('   📋 Encontrados: ' + pickings.length + ' resultados');
      return pickings;
    } catch (err) { console.error('   ❌ Error:', err.message); return []; }
  }

  async updateExpeditionDate(pickingIds, date) {
    return await this.execute('stock.picking', 'write', [pickingIds, { manual_expedition_date: date }]);
  }
}

// ============================================
// EXTRACCIÓN DE PATRONES ESPECIALES
// ============================================

// Extrae el tracking de Odoo embebido en un barcode ASENDIA
function extractAsendiaTracking(scannedClean) {
  // LS-format: LS + 9 digits + 2 letters (ej: LS226449335CH) -> ES el tracking
  if (/^LS\d{9}[A-Z]{2}$/.test(scannedClean)) {
    return { extracted: scannedClean, isDirectMatch: true };
  }
  // 6C20-format ya como tracking (13 chars) -> ES el tracking
  if (/^6C20\d{9}$/.test(scannedClean)) {
    return { extracted: scannedClean, isDirectMatch: true };
  }
  // Barcode largo con 6C20 embebido -> extraer 13 chars
  var idx = scannedClean.indexOf('6C20');
  if (idx >= 0 && scannedClean.length >= idx + 13) {
    return { extracted: scannedClean.substring(idx, idx + 13), isDirectMatch: false };
  }
  return { extracted: null, isDirectMatch: false };
}

// INPOST: Barcodes largos (todo numérico) contienen tracking de 8 dígitos embebido
// Formato observado: 13 + [8 dígitos tracking] + sufijo numérico
// Ejemplo: 130486133001010401330148898 → tracking = 04861330
function extractInpostTracking(scannedClean) {
  // Match directo: tracking de 8 dígitos
  if (/^\d{8}$/.test(scannedClean)) {
    return { extracted: scannedClean, isDirectMatch: true };
  }
  // Barcode largo numérico: extraer 8 dígitos desde posición 2
  if (scannedClean.length >= 10 && /^\d+$/.test(scannedClean)) {
    var candidate = scannedClean.substring(2, 10);
    if (/^\d{8}$/.test(candidate)) {
      return { extracted: candidate, isDirectMatch: false };
    }
  }
  return { extracted: null, isDirectMatch: false };
}

function extractSpecialPatterns(scanned) {
  const clean = scanned.toUpperCase().trim();
  const cleanAlnum = clean.replace(/[^A-Z0-9]/g, '');
  const result = { patterns: [clean], detectedCarrier: null };

  // GLS QR: Extraer tracking de formato ...ESxxxxxxxxCCE...
  const glsMatch = clean.match(/ES([A-Z][0-9]{2}[A-Z0-9]{5})[A-Z]{2,3}/);
  if (glsMatch) {
    result.patterns.push(glsMatch[1]);
    result.detectedCarrier = 'GLS';
    console.log('   🔍 Patrón GLS extraído: ' + glsMatch[1]);
  }

  // SPRING: Extraer tracking embebido de barcodes GS1-128 largos
  // Ejemplo: %000542106265024593998328040 → tracking: 06265024593998
  if (!result.detectedCarrier && cleanAlnum.length > 20 && /^\d+$/.test(cleanAlnum)) {
    const springPrefixes = ['0626', '0008'];
    for (const prefix of springPrefixes) {
      const idx = cleanAlnum.indexOf(prefix);
      if (idx > 0) {
        // Extraer substrings de longitudes típicas de tracking SPRING (12-16 chars)
        // Orden: corto→largo para que el match exacto (14 chars) se pruebe antes
        for (var len = 12; len <= 16; len++) {
          if (idx + len <= cleanAlnum.length) {
            result.patterns.push(cleanAlnum.substring(idx, idx + len));
          }
        }
        result.detectedCarrier = 'SPRING';
        console.log('   🔍 Patrones SPRING extraídos desde pos ' + idx + ': ' + cleanAlnum.substring(idx, Math.min(idx + 16, cleanAlnum.length)));
        break;
      }
    }
  }

  // ASENDIA: Extraer tracking embebido
  if (!result.detectedCarrier) {
    const asResult = extractAsendiaTracking(cleanAlnum);
    if (asResult.extracted && !asResult.isDirectMatch) {
      result.patterns.push(asResult.extracted);
      result.detectedCarrier = 'ASENDIA';
      console.log('   🔍 Patrón ASENDIA extraído: ' + asResult.extracted);
    }
  }

  result.patterns = [...new Set(result.patterns)];
  return result;
}

const odooClient = new OdooClient(CONFIG.odoo);

// ============================================
// CLIENTE SENDCLOUD
// ============================================
class SendcloudClient {
  constructor(config) {
    this.config = config;
    this.authHeader = 'Basic ' + Buffer.from(config.publicKey + ':' + config.secretKey).toString('base64');
  }

  async getParcelByTracking(tracking) {
    try {
      const response = await fetch(this.config.apiUrl + '/tracking/' + tracking, {
        method: 'GET', headers: { 'Authorization': this.authHeader, 'Content-Type': 'application/json' }
      });
      if (!response.ok) { if (response.status === 404) return null; throw new Error('Sendcloud API error: ' + response.status); }
      return await response.json();
    } catch (err) { console.error('   ❌ Sendcloud error:', err.message); return null; }
  }

  normalizeCarrier(carrierCode) {
    if (!carrierCode) return null;
    const normalized = carrierCode.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
    return SENDCLOUD_CARRIER_MAP[normalized] || carrierCode.toUpperCase();
  }
}

const sendcloudClient = new SendcloudClient(CONFIG.sendcloud);

// ============================================
// DETECCIÓN DE TRANSPORTISTA
// ============================================
function overrideCarrier(carrier, tracking) {
  if (!carrier || !tracking) return carrier;
  const t = tracking.toUpperCase().trim();
  if (/^H103/.test(t) && carrier === 'SPRING') return 'ASENDIA';
  return carrier;
}

async function getCarrierFromTracking(tracking) {
  const startTime = Date.now();
  const clean = tracking.trim().toUpperCase();

  // Extraer patrones especiales (GLS QR)
  const extracted = extractSpecialPatterns(clean);
  const glsPattern = extracted.detectedCarrier === 'GLS' && extracted.patterns.length > 1 ? extracted.patterns[1] : null;
  
  // Si es GLS con patrón extraído, buscar primero el patrón
  if (glsPattern) {
    // Buscar patrón GLS en índice
    const indexResult = findInTrackingIndex(glsPattern);
    if (indexResult && indexResult.orderRef) {
      const elapsed = Date.now() - startTime;
      console.log('   ⚡ Índice GLS: ' + glsPattern + ' (' + elapsed + 'ms)');
      return {
        carrier: 'GLS',
        picking: { id: indexResult.pickingId, name: indexResult.pickingName, carrier_tracking_ref: indexResult.odooTracking, origin: indexResult.orderRef, partner_id: [null, indexResult.clientName] },
        source: 'index (patrón: ' + glsPattern + ')', elapsed
      };
    }
    
    // Buscar patrón GLS en Odoo
    console.log('   🔍 Buscando en Odoo: ' + glsPattern);
    const picking = await odooClient.findPickingByTracking(glsPattern);
    if (picking) {
      const elapsed = Date.now() - startTime;
      console.log('   ✅ GLS encontrado en Odoo: ' + (picking.origin || 'sin pedido'));
      return { carrier: 'GLS', picking, source: 'odoo (patrón: ' + glsPattern + ')', elapsed };
    }
  }
  
  // ASENDIA: extraer tracking embebido del barcode
  const asendiaResult = extractAsendiaTracking(clean.replace(/[^A-Z0-9]/g, ''));
  if (asendiaResult.extracted && !asendiaResult.isDirectMatch) {
    const asTracking = asendiaResult.extracted.toUpperCase();
    // Buscar en índice
    const asIndex = findInTrackingIndex(asTracking);
    if (asIndex && asIndex.orderRef) {
      const elapsed = Date.now() - startTime;
      console.log('   ⚡ Índice ASENDIA: ' + asTracking + ' (' + elapsed + 'ms)');
      return {
        carrier: 'ASENDIA',
        picking: { id: asIndex.pickingId, name: asIndex.pickingName, carrier_tracking_ref: asIndex.odooTracking, origin: asIndex.orderRef, partner_id: [null, asIndex.clientName] },
        source: 'index (ASENDIA extraído: ' + asTracking + ')', elapsed
      };
    }
    // Buscar en Odoo con el tracking extraído
    console.log('   🔍 Buscando ASENDIA en Odoo: ' + asTracking);
    const asPicking = await odooClient.findPickingByTracking(asTracking);
    if (asPicking) {
      const elapsed = Date.now() - startTime;
      console.log('   ✅ ASENDIA encontrado en Odoo: ' + (asPicking.origin || 'sin pedido'));
      return { carrier: 'ASENDIA', picking: asPicking, source: 'odoo (ASENDIA extraído: ' + asTracking + ')', elapsed };
    }
    // Fallback Odoo: buscar con prefijo de 12 chars (último dígito barcode puede diferir)
    // Ej: barcode extrae 6C20625207088 pero Odoo tiene 6C20625207080
    if (asTracking.length >= 12) {
      const asPrefix12 = asTracking.substring(0, 12);
      console.log('   🔍 Buscando ASENDIA prefijo 12 en Odoo: ' + asPrefix12);
      const asPickingPrefix = await odooClient.findPickingByTracking(asPrefix12);
      if (asPickingPrefix) {
        const elapsed = Date.now() - startTime;
        console.log('   ✅ ASENDIA prefijo encontrado en Odoo: ' + (asPickingPrefix.origin || 'sin pedido'));
        return { carrier: 'ASENDIA', picking: asPickingPrefix, source: 'odoo (ASENDIA prefijo: ' + asPrefix12 + ')', elapsed };
      }
    }
  }

  // INPOST: extraer tracking de 8 dígitos embebido en barcode largo numérico
  const cleanAlnum = clean.replace(/[^A-Z0-9]/g, '');
  if (cleanAlnum.length > 10 && /^\d+$/.test(cleanAlnum)) {
    const inpostResult = extractInpostTracking(cleanAlnum);
    if (inpostResult.extracted && !inpostResult.isDirectMatch) {
      const ipTracking = inpostResult.extracted;
      // Buscar en índice
      const ipIndex = findInTrackingIndex(ipTracking);
      if (ipIndex && ipIndex.carrier === 'INPOST') {
        const elapsed = Date.now() - startTime;
        console.log('   ⚡ Índice INPOST: ' + ipTracking + ' (' + elapsed + 'ms)');
        return {
          carrier: 'INPOST',
          picking: { id: ipIndex.pickingId, name: ipIndex.pickingName, carrier_tracking_ref: ipIndex.odooTracking, origin: ipIndex.orderRef, partner_id: [null, ipIndex.clientName] },
          source: 'index (INPOST extraído: ' + ipTracking + ')', elapsed
        };
      }
      // Solo buscar en Odoo si el tracking parece genuinamente INPOST (prefijos 04/81)
      // Evita llamadas Odoo innecesarias para barcodes numéricos de otros carriers
      if (/^(04|81)\d{6}$/.test(ipTracking)) {
        console.log('   🔍 Buscando INPOST en Odoo: ' + ipTracking);
        const ipPicking = await odooClient.findPickingByTracking(ipTracking);
        if (ipPicking) {
          const elapsed = Date.now() - startTime;
          console.log('   ✅ INPOST encontrado en Odoo: ' + (ipPicking.origin || 'sin pedido'));
          return { carrier: 'INPOST', picking: ipPicking, source: 'odoo (INPOST extraído: ' + ipTracking + ')', elapsed };
        }
      }
    }
  }

  // SPRING: buscar tracking embebido extraído del barcode GS1-128
  if (extracted.detectedCarrier === 'SPRING' && extracted.patterns.length > 1) {
    const springPatterns = extracted.patterns.slice(1); // skip el código completo
    for (const pat of springPatterns) {
      // Buscar en índice
      const spIndex = findInTrackingIndex(pat);
      if (spIndex && (spIndex.carrier === 'SPRING' || spIndex.orderRef)) {
        const elapsed = Date.now() - startTime;
        console.log('   ⚡ Índice SPRING: ' + pat + ' (' + elapsed + 'ms)');
        return {
          carrier: spIndex.carrier || 'SPRING',
          picking: { id: spIndex.pickingId, name: spIndex.pickingName, carrier_tracking_ref: spIndex.odooTracking, origin: spIndex.orderRef, partner_id: [null, spIndex.clientName] },
          source: 'index (SPRING extraído: ' + pat + ')', elapsed
        };
      }
    }
    // Buscar en Odoo con cada patrón extraído
    for (const pat of springPatterns) {
      console.log('   🔍 Buscando SPRING en Odoo: ' + pat);
      const spPicking = await odooClient.findPickingByTracking(pat);
      if (spPicking) {
        const elapsed = Date.now() - startTime;
        console.log('   ✅ SPRING encontrado en Odoo: ' + (spPicking.origin || 'sin pedido'));
        return { carrier: 'SPRING', picking: spPicking, source: 'odoo (SPRING extraído: ' + pat + ')', elapsed };
      }
    }
  }

  // FLUJO NORMAL PARA TODOS LOS TRANSPORTISTAS

  // 1. Índice pre-calculado
  const indexResult = findInTrackingIndex(clean);
  if (indexResult && indexResult.carrier !== 'DESCONOCIDO') {
    const elapsed = Date.now() - startTime;
    const finalCarrier = overrideCarrier(indexResult.carrier, indexResult.odooTracking || clean);
    console.log('   ⚡ Índice: ' + finalCarrier + ' (' + elapsed + 'ms)');
    return {
      carrier: finalCarrier,
      picking: { id: indexResult.pickingId, name: indexResult.pickingName, carrier_tracking_ref: indexResult.odooTracking, origin: indexResult.orderRef, partner_id: [null, indexResult.clientName] },
      source: 'index', elapsed
    };
  }

  // Si el índice tenía DESCONOCIDO, reusar datos del picking pero seguir detectando carrier
  let picking;
  let odooTracking;

  if (indexResult) {
    console.log('   ⚠️ Índice DESCONOCIDO, intentando Sendcloud...');
    picking = { id: indexResult.pickingId, name: indexResult.pickingName, carrier_tracking_ref: indexResult.odooTracking, origin: indexResult.orderRef, partner_id: [null, indexResult.clientName] };
    odooTracking = indexResult.odooTracking;
  } else {
    // 2. Buscar en Odoo
    console.log('   🔍 No en índice, buscando en Odoo...');
    picking = await odooClient.findPickingByTracking(clean);
    if (!picking) return { carrier: null, picking: null, source: 'not_found' };
    odooTracking = picking.carrier_tracking_ref;
    console.log('   📍 Tracking Odoo: ' + odooTracking);
  }

  // 3. Detectar CORREOS EXPRESS por carrier Odoo (MI*)
  if (picking.carrier_id) {
    const carrierName = picking.carrier_id[1] || '';
    if (carrierName.toUpperCase().startsWith('MI')) {
      console.log('   ✅ CORREOS EXPRESS detectado por carrier Odoo: ' + carrierName);
      return { carrier: 'CORREOS EXPRESS', picking, source: 'odoo-carrier', elapsed: Date.now() - startTime };
    }
  }

  // 4. Caché Sendcloud
  const cached = findInSendcloudCache(odooTracking);
  if (cached && cached.carrier) {
    const cachedCarrier = overrideCarrier(cached.carrier, odooTracking);
    console.log('   ⚡ Caché: ' + cachedCarrier + ' (' + (Date.now() - startTime) + 'ms)');
    return { carrier: cachedCarrier, picking, source: 'cache', elapsed: Date.now() - startTime };
  }

  // 5. API Sendcloud
  console.log('   🌐 Consultando Sendcloud API...');
  const sendcloudData = await sendcloudClient.getParcelByTracking(odooTracking);
  if (sendcloudData && sendcloudData.carrier_code) {
    const scCarrier = overrideCarrier(sendcloudClient.normalizeCarrier(sendcloudData.carrier_code), odooTracking);
    console.log('   🌐 Sendcloud: ' + scCarrier + ' (' + (Date.now() - startTime) + 'ms)');
    return { carrier: scCarrier, picking, source: 'sendcloud', elapsed: Date.now() - startTime };
  }

  return { carrier: null, picking, source: 'no_sendcloud' };
}

function generatePickupId(carrier) {
  const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const count = Object.keys(database.pickups).filter(id => id.includes(dateStr) && id.startsWith(carrier)).length + 1;
  return carrier + '-REC-' + dateStr + '-' + String(count).padStart(3, '0');
}

// Frontend estático
const FRONTEND_DIR = path.join(__dirname, 'public');
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// ---- HELPER: detectar transportista por nombre carrier Odoo ----
function detectCarrierFromOdooName(carrierName) {
  if (!carrierName) return null;
  const n = carrierName.toUpperCase();
  if (n.startsWith('MI'))                                    return 'CORREOS EXPRESS';
  if (n.includes('CORREOS EXPRESS') || n.includes('CEX'))   return 'CORREOS EXPRESS';
  if (n.includes('CORREOS') || n.includes('ORDINARIO'))     return 'CORREOS';
  if (n.includes('CTT'))                                     return 'CTT';
  if (n.includes('GLS'))                                     return 'GLS';
  if (n.includes('INPOST') || n.includes('IN POST'))        return 'INPOST';
  if (n.includes('SPRING'))                                  return 'SPRING';
  if (n.includes('ASENDIA'))                                 return 'ASENDIA';
  return null;
}

// ============================================
// ENDPOINTS API
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), indexLoaded: !!trackingIndex.lastSync, indexMatched: trackingIndex.matched });
});

app.get('/api/carriers', (req, res) => res.json({ carriers: CARRIERS }));

app.get('/api/test-odoo', async (req, res) => {
  try { const uid = await odooClient.authenticate(); res.json({ success: true, uid }); }
  catch (error) { res.json({ success: false, error: error.message }); }
});

app.get('/api/test-sendcloud', async (req, res) => {
  try {
    const response = await fetch(CONFIG.sendcloud.apiUrl + '/user', { method: 'GET', headers: { 'Authorization': sendcloudClient.authHeader, 'Content-Type': 'application/json' } });
    if (response.ok) res.json({ success: true, user: await response.json() });
    else res.json({ success: false, error: 'HTTP ' + response.status });
  } catch (error) { res.json({ success: false, error: error.message }); }
});

// Índice
app.get('/api/index-stats', (req, res) => {
  const age = trackingIndex.lastSync ? Math.round((Date.now() - new Date(trackingIndex.lastSync).getTime()) / 60000) : null;
  res.json({ lastSync: trackingIndex.lastSync, ageMinutes: age, totalOdoo: trackingIndex.totalOdoo, totalSendcloud: trackingIndex.totalSendcloud, matched: trackingIndex.matched, unmatched: trackingIndex.unmatched || 0, byCarrier: trackingIndex.byCarrier || {}, syncInProgress, lastSyncAttempt });
});

app.post('/api/reload-index', async (req, res) => {
  if (syncInProgress) return res.json({ success: false, message: 'Sync ya en progreso' });
  console.log('🔄 Recarga de índice solicitada');
  const success = await runSync();
  res.json({ success, message: success ? 'Índice regenerado' : 'Error regenerando índice', stats: { lastSync: trackingIndex.lastSync, matched: trackingIndex.matched } });
});

// Sesiones
app.get('/api/session/:carrier', (req, res) => {
  const session = getSession(req.params.carrier);
  res.json({ carrier: req.params.carrier.toUpperCase(), packages: session.packages, count: session.packages.length, lastUpdate: session.lastUpdate });
});

app.get('/api/sessions', (req, res) => {
  const sessions = {};
  for (const carrier of CARRIERS) {
    const session = database.activeSessions[carrier];
    if (session && session.packages && session.packages.length > 0) {
      sessions[carrier] = { count: session.packages.length, lastUpdate: session.lastUpdate };
    }
  }
  res.json({ sessions });
});

app.delete('/api/session/:carrier', (req, res) => {
  clearSession(req.params.carrier);
  res.json({ success: true, message: 'Sesión de ' + req.params.carrier.toUpperCase() + ' limpiada' });
});

app.delete('/api/session/:carrier/package/:tracking', (req, res) => {
  const removed = removePackageFromSession(req.params.carrier, req.params.tracking.toUpperCase());
  res.json({ success: removed, message: removed ? 'Paquete eliminado' : 'Paquete no encontrado' });
});

// Escaneo
app.post('/api/scan', async (req, res) => {
  const { tracking, expectedCarrier } = req.body;
  if (!tracking || !expectedCarrier) return res.status(400).json({ error: 'Faltan datos' });

  const clean = tracking.trim().toUpperCase();
  const expected = expectedCarrier.toUpperCase();
  console.log('\n📦 SCAN: ' + clean + ' → ' + expected);
  
  const session = getSession(expected);
  if (session.packages.find(p => p.tracking === clean)) {
    return res.json({ success: false, error: 'DUPLICADO', message: 'Este paquete ya está escaneado', tracking: clean });
  }

  const det = await getCarrierFromTracking(clean);

  if (!det.picking) {
    console.log('   ❌ No existe en Odoo');
    return res.json({ success: false, error: 'NO_ENCONTRADO', message: 'El tracking ' + clean + ' no existe en Odoo', tracking: clean });
  }

  if (det.carrier && det.carrier !== 'DESCONOCIDO' && det.carrier !== expected) {
    console.log('   ❌ Es ' + det.carrier + ', no ' + expected);
    return res.json({ success: false, error: 'TRANSPORTISTA_INCORRECTO', message: 'Este paquete es de ' + det.carrier + ', no de ' + expected, detectedCarrier: det.carrier });
  }

  if (!det.carrier || det.carrier === 'DESCONOCIDO') {
    console.log('   ⚠️ No se pudo verificar transportista');
    return res.json({ success: false, error: 'NO_VERIFICADO', message: 'No se pudo verificar el transportista. Busca por nombre de cliente.', tracking: clean, picking: det.picking });
  }

  // Detectar duplicado por pedido (diferentes barcodes CTT multi-collo resuelven al mismo pedido)
  const orderRef = det.picking.origin || '';
  if (orderRef) {
    const existingByOrder = session.packages.find(p => p.orderRef === orderRef);
    if (existingByOrder) {
      console.log('   ⚠️ Pedido ' + orderRef + ' ya escaneado (barcode diferente: ' + existingByOrder.tracking.substring(0, 20) + '...)');
      return res.json({ success: false, error: 'DUPLICADO', message: 'El pedido ' + orderRef + ' ya está escaneado (tracking diferente)', tracking: clean, orderRef: orderRef });
    }
  }

  const packageData = { tracking: clean, pickingId: det.picking.id, orderRef: orderRef, clientName: det.picking.partner_id ? det.picking.partner_id[1] : '', scannedAt: new Date().toISOString() };
  addPackageToSession(expected, packageData);
  const updatedSession = getSession(expected);
  
  console.log('   ✅ ' + det.carrier + ' | ' + det.source + ' | ' + (det.elapsed || '?') + 'ms | Pedido: ' + packageData.orderRef);
  res.json({ success: true, tracking: clean, detectedCarrier: det.carrier, package: packageData, sessionCount: updatedSession.packages.length, source: det.source, responseTime: det.elapsed });
});

app.post('/api/add-tracking', async (req, res) => {
  const { tracking, carrier, pickingId, orderRef, clientName } = req.body;
  if (!tracking || !carrier) return res.status(400).json({ error: 'Tracking y carrier requeridos' });
  
  const clean = tracking.trim().toUpperCase();
  const carrierUpper = carrier.toUpperCase();
  const session = getSession(carrierUpper);
  
  if (session.packages.find(p => p.tracking === clean)) {
    return res.json({ success: false, error: 'DUPLICADO', message: 'Este paquete ya está escaneado' });
  }
  
  const det = await getCarrierFromTracking(clean);
  if (det.carrier && det.carrier !== 'DESCONOCIDO' && det.carrier !== carrierUpper) {
    return res.json({ success: false, error: 'TRANSPORTISTA_INCORRECTO', message: 'Este paquete es de ' + det.carrier + ', no de ' + carrierUpper, detectedCarrier: det.carrier });
  }
  
  const packageData = { tracking: clean, pickingId: pickingId || det.picking?.id, orderRef: orderRef || det.picking?.origin || '', clientName: clientName || (det.picking?.partner_id ? det.picking.partner_id[1] : ''), scannedAt: new Date().toISOString(), addedManually: true };
  addPackageToSession(carrierUpper, packageData);
  
  res.json({ success: true, tracking: clean, carrier: carrierUpper, package: packageData, sessionCount: getSession(carrierUpper).packages.length });
});

app.get('/api/detect-carrier/:tracking', async (req, res) => {
  const result = await getCarrierFromTracking(req.params.tracking.trim());
  res.json({ carrier: result.carrier, picking: result.picking, source: result.source, time: result.elapsed });
});

app.get('/api/search-client/:name', async (req, res) => {
  const searchTerm = req.params.name.trim();
  if (searchTerm.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres' });
  
  console.log('\n🔎 BÚSQUEDA: "' + searchTerm + '"');
  const isOrderRef = /^(DF|SO|PO|WH|S)\d/i.test(searchTerm);
  
  let pickings = isOrderRef ? await odooClient.findPickingsByOrderRef(searchTerm) : await odooClient.findPickingsByClientName(searchTerm);
  if (pickings.length === 0) {
    pickings = isOrderRef ? await odooClient.findPickingsByClientName(searchTerm) : await odooClient.findPickingsByOrderRef(searchTerm);
  }
  
  const results = pickings.map(p => ({ id: p.id, name: p.name, tracking: p.carrier_tracking_ref, client: p.partner_id ? p.partner_id[1] : 'Sin cliente', origin: p.origin, date: p.scheduled_date, expedited: !!p.manual_expedition_date }));
  console.log('   ✅ Devolviendo ' + results.length + ' resultados');
  res.json({ query: searchTerm, count: results.length, results });
});

// Búsqueda global
app.get('/api/search', (req, res) => {
  const query = (req.query.q || '').trim().toUpperCase();
  if (query.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres' });
  
  const results = { pallets: [], packages: [], pickups: [] };
  for (const pallet of Object.values(database.pallets)) {
    if (pallet.id.toUpperCase().includes(query)) results.pallets.push(pallet);
    else {
      const match = pallet.packages.find(p => p.tracking.toUpperCase().includes(query) || (p.orderRef && p.orderRef.toUpperCase().includes(query)));
      if (match) results.packages.push({ pallet, package: match });
    }
  }
  for (const pickup of Object.values(database.pickups)) {
    if (pickup.id.toUpperCase().includes(query)) results.pickups.push(pickup);
  }
  res.json({ query, results, totalResults: results.pallets.length + results.packages.length + results.pickups.length });
});

// ============================================
// PALETS
// ============================================
app.post('/api/pallets', (req, res) => {
  const { carrier } = req.body;
  if (!carrier) return res.status(400).json({ error: 'Carrier requerido' });
  
  const carrierUpper = carrier.toUpperCase();
  const session = getSession(carrierUpper);
  if (!session.packages || session.packages.length === 0) return res.status(400).json({ error: 'No hay paquetes para crear el palet' });
  
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const count = Object.keys(database.pallets).filter(id => id.startsWith(carrierUpper + '-' + dateStr)).length + 1;
  const palletId = carrierUpper + '-' + dateStr + '-' + String(count).padStart(3, '0');
  
  const pallet = {
    id: palletId, carrier: carrierUpper, packages: [...session.packages], trackings: session.packages.map(p => p.tracking),
    totalPackages: session.packages.length, createdAt: now.toISOString(), date: now.toISOString().split('T')[0], status: 'pending'
  };
  
  database.pallets[palletId] = pallet;
  clearSession(carrierUpper);
  console.log('\n📦 PALET CREADO: ' + palletId + ' - ' + pallet.totalPackages + ' paquetes');
  res.json({ success: true, pallet });
});

app.get('/api/pallets', (req, res) => {
  const dateFilter = req.query.date || new Date().toISOString().split('T')[0];
  const filteredPallets = Object.values(database.pallets).filter(p => p.date === dateFilter);
  const grouped = {};
  
  for (const carrier of CARRIERS) {
    const carrierPallets = filteredPallets.filter(p => p.carrier === carrier);
    if (carrierPallets.length > 0) {
      grouped[carrier] = {
        total: carrierPallets.length, totalPackages: carrierPallets.reduce((sum, p) => sum + p.totalPackages, 0),
        pending: carrierPallets.filter(p => p.status === 'pending').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
        pickedUp: carrierPallets.filter(p => p.status === 'picked_up').sort((a, b) => new Date(b.pickedUpAt || b.createdAt) - new Date(a.pickedUpAt || a.createdAt))
      };
    }
  }
  
  res.json({ date: dateFilter, carriers: grouped, summary: {
    totalPallets: filteredPallets.length, totalPackages: filteredPallets.reduce((sum, p) => sum + p.totalPackages, 0),
    pendingPallets: filteredPallets.filter(p => p.status === 'pending').length, pickedUpPallets: filteredPallets.filter(p => p.status === 'picked_up').length
  }});
});

app.get('/api/pallets/:id', (req, res) => {
  const pallet = database.pallets[req.params.id];
  if (!pallet) return res.status(404).json({ error: 'Palet no encontrado' });
  res.json({ pallet });
});

app.delete('/api/pallets/:id', (req, res) => {
  const palletId = req.params.id;
  const pallet = database.pallets[palletId];
  if (!pallet) return res.status(404).json({ error: 'Palet no encontrado' });
  
  if (pallet.status === 'picked_up' && pallet.pickupId) {
    const pickup = database.pickups[pallet.pickupId];
    if (pickup) {
      pickup.palletIds = pickup.palletIds.filter(id => id !== palletId);
      pickup.pallets = pickup.pallets.filter(p => p.id !== palletId);
      pickup.totalPallets = pickup.pallets.length;
      pickup.totalPackages = pickup.pallets.reduce((sum, p) => sum + p.totalPackages, 0);
      if (pickup.palletIds.length === 0) {
        if (database.manifests[pallet.pickupId]) delete database.manifests[pallet.pickupId];
        delete database.pickups[pallet.pickupId];
      }
    }
  }
  
  delete database.pallets[palletId];
  saveData();
  console.log('\n🗑️ PALET ELIMINADO: ' + palletId);
  res.json({ success: true, message: 'Palet ' + palletId + ' eliminado' });
});

app.get('/api/pallets/:id/label', (req, res) => {
  const pallet = database.pallets[req.params.id];
  if (!pallet) return res.status(404).json({ error: 'Palet no encontrado' });
  
  const d = new Date(pallet.createdAt);
  const dateStr = d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Etiqueta ' + pallet.id + '</title><style>*{margin:0;padding:0;box-sizing:border-box}@page{size:100mm 150mm;margin:5mm}body{font-family:Arial,sans-serif;width:100mm;padding:5mm}.label{border:3px solid #000;padding:10px;text-align:center}.carrier{font-size:28px;font-weight:bold;background:#000;color:#fff;padding:10px;margin:-10px -10px 10px -10px}.pallet-id{font-size:20px;font-weight:bold;margin:10px 0;font-family:monospace}.barcode{margin:15px auto;padding:10px}.barcode svg{width:80mm;height:20mm}.info{display:flex;justify-content:space-around;margin:15px 0;font-size:14px}.info-box{border:1px solid #000;padding:8px 15px}.info-box .label-text{font-size:10px;color:#666}.info-box .value{font-size:24px;font-weight:bold}.datetime{font-size:12px;color:#333;margin-top:10px}.footer{margin-top:15px;padding-top:10px;border-top:1px dashed #000;font-size:10px;color:#666}@media print{body{width:100mm}.no-print{display:none}}</style><script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script></head><body><div class="label"><div class="carrier">' + pallet.carrier + '</div><div class="pallet-id">' + pallet.id + '</div><div class="barcode"><svg id="barcode"></svg></div><div class="info"><div class="info-box"><div class="label-text">ENVÍOS</div><div class="value">' + pallet.totalPackages + '</div></div><div class="info-box"><div class="label-text">PALET</div><div class="value">#' + pallet.id.split('-').pop() + '</div></div></div><div class="datetime">Fecha: ' + dateStr + ' - Hora: ' + timeStr + '</div><div class="footer">Illice Brands Group - White Division</div></div><div class="no-print" style="margin-top:20px;text-align:center"><button onclick="window.print()" style="padding:10px 30px;font-size:16px;cursor:pointer">Imprimir</button></div><script>JsBarcode("#barcode","' + pallet.id + '",{format:"CODE128",width:2,height:60,displayValue:false})</script></body></html>');
});

// ============================================
// RECOGIDAS
// ============================================
app.post('/api/pickup/scan-pallet', (req, res) => {
  const { palletId, expectedCarrier } = req.body;
  const pallet = database.pallets[palletId];
  if (!pallet) return res.json({ success: false, message: 'Palet no encontrado' });
  if (pallet.carrier !== expectedCarrier.toUpperCase()) return res.json({ success: false, message: 'Este palet es de ' + pallet.carrier + ', no de ' + expectedCarrier });
  if (pallet.status === 'picked_up') return res.json({ success: false, message: 'Este palet ya fue recogido' });
  res.json({ success: true, pallet });
});

app.post('/api/pickup', async (req, res) => {
  const { carrier, palletIds } = req.body;
  if (!carrier || !palletIds?.length) return res.status(400).json({ error: 'Faltan datos' });
  
  const pickupId = generatePickupId(carrier.toUpperCase());
  const now = new Date();
  let totalPackages = 0;
  const pickingIds = [];
  const pallets = [];
  
  for (const palletId of palletIds) {
    const pallet = database.pallets[palletId];
    if (pallet && pallet.status === 'pending') {
      pallet.status = 'picked_up';
      pallet.pickupId = pickupId;
      pallet.pickedUpAt = now.toISOString();
      totalPackages += pallet.totalPackages;
      pallets.push(pallet);
      pallet.packages.forEach(pkg => { if (pkg.pickingId) pickingIds.push(pkg.pickingId); });
    }
  }
  
  if (pickingIds.length > 0) {
    try {
      await odooClient.updateExpeditionDate(pickingIds, now.toISOString().split('T')[0]);
      console.log('✅ Actualizada fecha expedición para ' + pickingIds.length + ' albaranes');
    } catch (err) { console.error('Error Odoo:', err.message); }
  }
  
  database.pickups[pickupId] = {
    id: pickupId, carrier: carrier.toUpperCase(), palletIds: pallets.map(p => p.id), pallets,
    totalPackages, totalPallets: pallets.length, createdAt: now.toISOString(), date: now.toISOString().split('T')[0], status: 'pending_signature'
  };
  
  saveData();
  console.log('\n🚚 RECOGIDA: ' + pickupId + ' - ' + pallets.length + ' palets, ' + totalPackages + ' paquetes');
  res.json({ success: true, message: 'Recogida creada: ' + pallets.length + ' palets, ' + totalPackages + ' paquetes', pickup: database.pickups[pickupId] });
});

app.post('/api/pickup/:id/undo', (req, res) => {
  const pickup = database.pickups[req.params.id];
  if (!pickup) return res.status(404).json({ error: 'Recogida no encontrada' });
  
  for (const palletId of pickup.palletIds) {
    const pallet = database.pallets[palletId];
    if (pallet) { pallet.status = 'pending'; delete pallet.pickupId; delete pallet.pickedUpAt; }
  }
  
  if (database.manifests[req.params.id]) delete database.manifests[req.params.id];
  delete database.pickups[req.params.id];
  saveData();
  
  console.log('\n↩️ RECOGIDA DESHECHA: ' + req.params.id);
  res.json({ success: true, message: 'Recogida deshecha. ' + pickup.palletIds.length + ' palets vueltos a estado pendiente.' });
});

app.delete('/api/pickup/:id', (req, res) => {
  const pickup = database.pickups[req.params.id];
  if (!pickup) return res.status(404).json({ error: 'Recogida no encontrada' });
  
  const deletePallets = req.query.deletePallets === 'true';
  
  if (deletePallets) {
    for (const palletId of pickup.palletIds) { if (database.pallets[palletId]) delete database.pallets[palletId]; }
  } else {
    for (const palletId of pickup.palletIds) {
      const pallet = database.pallets[palletId];
      if (pallet) { pallet.status = 'pending'; delete pallet.pickupId; delete pallet.pickedUpAt; }
    }
  }
  
  if (database.manifests[req.params.id]) delete database.manifests[req.params.id];
  delete database.pickups[req.params.id];
  saveData();
  
  console.log('\n🗑️ RECOGIDA ELIMINADA: ' + req.params.id);
  res.json({ success: true, message: deletePallets ? 'Recogida y palets eliminados' : 'Recogida eliminada. Palets vueltos a pendiente.' });
});

// ============================================
// MANIFIESTOS
// ============================================
app.get('/api/manifest/:pickupId', (req, res) => {
  const pickup = database.pickups[req.params.pickupId];
  if (!pickup) return res.status(404).json({ error: 'Recogida no encontrada' });
  
  const manifest = database.manifests[req.params.pickupId];
  const isSigned = manifest && manifest.signedAt;
  const d = new Date(pickup.createdAt);
  const dateStr = d.toLocaleDateString('es-ES', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  
  let palletsHtml = '';
  pickup.pallets.forEach((pallet, idx) => {
    let rows = '';
    pallet.packages.forEach((pkg, i) => { rows += '<tr><td>' + (i+1) + '</td><td class="tracking">' + pkg.tracking + '</td><td>' + (pkg.orderRef||'-') + '</td><td>' + (pkg.clientName||'-') + '</td></tr>'; });
    palletsHtml += '<div class="pallet-section"><div class="pallet-header"><strong>PALET ' + (idx+1) + ': ' + pallet.id + '</strong><span>' + pallet.totalPackages + ' envíos</span></div><table class="packages-table"><thead><tr><th>#</th><th>Tracking</th><th>Pedido</th><th>Cliente</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  });
  
  let signatureSection = '';
  if (isSigned) {
    signatureSection = '<div class="signature-section signed"><h3>MANIFIESTO FIRMADO</h3><p>Firmado el ' + new Date(manifest.signedAt).toLocaleString('es-ES') + '</p><div class="signature-grid"><div class="signature-box"><div class="label">ENTREGADO POR (Almacén)</div><img src="' + manifest.warehouseSignature + '" class="signature-img"><div class="signer-name">' + (manifest.warehouseName||'') + '</div></div><div class="signature-box"><div class="label">RECIBIDO POR (Transportista)</div><img src="' + manifest.driverSignature + '" class="signature-img"><div class="signer-name">' + (manifest.driverName||'') + '</div><div class="signer-dni">DNI: ' + (manifest.driverDNI||'') + '</div></div></div></div>';
        } else {
    signatureSection = '<div class="signature-section" id="signatureSection"><h3>CONFORMIDAD DE ENTREGA</h3><p style="font-size:12px;color:#666;margin:10px 0">El transportista confirma haber recibido los palets y envíos detallados.</p><div class="signature-grid"><div class="signature-box"><div class="label">ENTREGADO POR (Almacén)</div><canvas id="warehouseSignature" class="signature-canvas"></canvas><button class="clear-btn" onclick="clearSignature(\'warehouseSignature\')">Limpiar</button><input type="text" id="warehouseName" placeholder="Nombre" class="signer-input"></div><div class="signature-box"><div class="label">RECIBIDO POR (Transportista)</div><canvas id="driverSignature" class="signature-canvas"></canvas><button class="clear-btn" onclick="clearSignature(\'driverSignature\')">Limpiar</button><input type="text" id="driverName" placeholder="Nombre" class="signer-input"><input type="text" id="driverDNI" placeholder="DNI" class="signer-input"></div></div><button id="signBtn" class="sign-btn" onclick="signManifest()">FIRMAR Y GUARDAR MANIFIESTO</button></div>';
  }
  
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Manifiesto ' + pickup.id + '</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;padding:20px;max-width:210mm;margin:0 auto}.header{border-bottom:3px solid #000;padding-bottom:15px;margin-bottom:20px}.company{font-size:22px;font-weight:bold}.company-address{font-size:12px;color:#666;margin-top:5px}.title{font-size:20px;margin-top:10px;color:#333}.carrier-badge{display:inline-block;background:#000;color:#fff;padding:8px 20px;font-size:18px;font-weight:bold;margin-top:10px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:20px 0;padding:15px;background:#f5f5f5}.info-item{font-size:14px}.info-item .label{color:#666;font-size:12px}.info-item .value{font-size:18px;font-weight:bold}.summary{display:flex;justify-content:space-around;background:#e0e0e0;padding:15px;margin:20px 0}.summary-item{text-align:center}.summary-item .number{font-size:32px;font-weight:bold}.summary-item .text{font-size:12px;color:#666}.pallet-section{margin:20px 0;border:1px solid #ccc}.pallet-header{background:#333;color:#fff;padding:10px 15px;display:flex;justify-content:space-between}.packages-table{width:100%;border-collapse:collapse;font-size:12px}.packages-table th{background:#f0f0f0;padding:8px;text-align:left;border-bottom:2px solid #ccc}.packages-table td{padding:6px 8px;border-bottom:1px solid #eee}.packages-table .tracking{font-family:monospace;font-weight:bold}.signature-section{margin-top:30px;padding:20px;border:2px solid #000}.signature-section h3{margin-bottom:10px}.signature-section.signed{background:#f0fff0;border-color:#22c55e}.signature-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:15px}.signature-box{text-align:center}.signature-box .label{font-size:12px;color:#666;margin-bottom:10px;font-weight:bold}.signature-canvas{border:1px solid #000;width:100%;height:120px;touch-action:none;background:#fff}.signature-img{border:1px solid #ccc;max-width:100%;height:120px;object-fit:contain}.clear-btn{margin-top:5px;padding:5px 15px;font-size:12px;cursor:pointer}.signer-input{width:100%;padding:8px;margin-top:8px;border:1px solid #ccc;font-size:14px}.signer-name{font-weight:bold;margin-top:10px}.signer-dni{font-size:12px;color:#666}.sign-btn{width:100%;padding:15px;margin-top:20px;background:#22c55e;color:white;border:none;font-size:18px;font-weight:bold;cursor:pointer}.sign-btn:hover{background:#16a34a}.sign-btn:disabled{background:#ccc;cursor:not-allowed}@media print{.no-print{display:none!important}.signature-section{page-break-inside:avoid}.signature-canvas{display:none}}.action-buttons{position:fixed;bottom:20px;right:20px;display:flex;gap:10px;z-index:100}.action-btn{padding:15px 25px;background:#000;color:#fff;border:none;font-size:16px;cursor:pointer;border-radius:8px}.action-btn:hover{background:#333}.action-btn.download{background:#2563eb}.action-btn.download:hover{background:#1d4ed8}</style><script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script></head><body><div class="action-buttons no-print"><button class="action-btn" onclick="window.print()">Imprimir</button><button class="action-btn download" onclick="downloadPDF()">Descargar PDF</button></div><div id="manifest-content"><div class="header"><div class="company">Illice Brands Group - White Division</div><div class="company-address">Calle Moros y Cristianos 10, Albatera, España</div><div class="title">MANIFIESTO DE RECOGIDA</div><div class="carrier-badge">' + pickup.carrier + '</div></div><div class="info-grid"><div class="info-item"><div class="label">FECHA</div><div class="value">' + dateStr + '</div></div><div class="info-item"><div class="label">HORA</div><div class="value">' + timeStr + '</div></div><div class="info-item"><div class="label">ID RECOGIDA</div><div class="value">' + pickup.id + '</div></div><div class="info-item"><div class="label">TRANSPORTISTA</div><div class="value">' + pickup.carrier + '</div></div></div><div class="summary"><div class="summary-item"><div class="number">' + pickup.totalPallets + '</div><div class="text">PALETS</div></div><div class="summary-item"><div class="number">' + pickup.totalPackages + '</div><div class="text">ENVÍOS TOTALES</div></div></div>' + palletsHtml + signatureSection + '</div><script>const canvases={};const contexts={};function initCanvas(id){const canvas=document.getElementById(id);if(!canvas)return;canvases[id]=canvas;contexts[id]=canvas.getContext("2d");canvas.width=canvas.offsetWidth;canvas.height=canvas.offsetHeight;let isDrawing=false;let lastX=0;let lastY=0;function getPos(e){const rect=canvas.getBoundingClientRect();const x=(e.touches?e.touches[0].clientX:e.clientX)-rect.left;const y=(e.touches?e.touches[0].clientY:e.clientY)-rect.top;return{x,y}}function startDrawing(e){isDrawing=true;const pos=getPos(e);lastX=pos.x;lastY=pos.y}function draw(e){if(!isDrawing)return;e.preventDefault();const pos=getPos(e);const ctx=contexts[id];ctx.beginPath();ctx.moveTo(lastX,lastY);ctx.lineTo(pos.x,pos.y);ctx.strokeStyle="#000";ctx.lineWidth=2;ctx.lineCap="round";ctx.stroke();lastX=pos.x;lastY=pos.y}function stopDrawing(){isDrawing=false}canvas.addEventListener("mousedown",startDrawing);canvas.addEventListener("mousemove",draw);canvas.addEventListener("mouseup",stopDrawing);canvas.addEventListener("mouseout",stopDrawing);canvas.addEventListener("touchstart",startDrawing);canvas.addEventListener("touchmove",draw);canvas.addEventListener("touchend",stopDrawing)}function clearSignature(id){const canvas=canvases[id];const ctx=contexts[id];if(canvas&&ctx)ctx.clearRect(0,0,canvas.width,canvas.height)}function isCanvasBlank(id){const canvas=canvases[id];if(!canvas)return true;const ctx=contexts[id];const pixelBuffer=new Uint32Array(ctx.getImageData(0,0,canvas.width,canvas.height).data.buffer);return!pixelBuffer.some(color=>color!==0)}async function signManifest(){const warehouseName=document.getElementById("warehouseName")?.value||"";const driverName=document.getElementById("driverName")?.value||"";const driverDNI=document.getElementById("driverDNI")?.value||"";if(!driverName||!driverDNI){alert("Por favor, introduce el nombre y DNI del transportista");return}if(isCanvasBlank("driverSignature")){alert("Por favor, el transportista debe firmar");return}const warehouseSignature=canvases["warehouseSignature"]?.toDataURL()||"";const driverSignature=canvases["driverSignature"]?.toDataURL()||"";const btn=document.getElementById("signBtn");btn.disabled=true;btn.textContent="Guardando...";try{const response=await fetch("/api/manifest/' + pickup.id + '/sign",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({warehouseName,warehouseSignature,driverName,driverDNI,driverSignature})});const result=await response.json();if(result.success){alert("Manifiesto firmado correctamente");location.reload()}else{alert("Error: "+result.error);btn.disabled=false;btn.textContent="FIRMAR Y GUARDAR MANIFIESTO"}}catch(err){alert("Error de conexión");btn.disabled=false;btn.textContent="FIRMAR Y GUARDAR MANIFIESTO"}}if(document.getElementById("warehouseSignature")){initCanvas("warehouseSignature");initCanvas("driverSignature")}function downloadPDF(){const element=document.getElementById("manifest-content");const opt={margin:10,filename:"Manifiesto_' + pickup.id + '.pdf",image:{type:"jpeg",quality:0.98},html2canvas:{scale:2,useCORS:true},jsPDF:{unit:"mm",format:"a4",orientation:"portrait"}};document.querySelector(".action-buttons").style.display="none";html2pdf().set(opt).from(element).save().then(()=>{document.querySelector(".action-buttons").style.display="flex"})}</script></body></html>');
});

app.post('/api/manifest/:pickupId/sign', (req, res) => {
  const pickup = database.pickups[req.params.pickupId];
  if (!pickup) return res.status(404).json({ error: 'Recogida no encontrada' });
  
  const { warehouseName, warehouseSignature, driverName, driverDNI, driverSignature } = req.body;
  if (!driverName || !driverDNI || !driverSignature) return res.status(400).json({ error: 'Faltan datos del transportista' });
  
  const now = new Date();
  database.manifests[req.params.pickupId] = { pickupId: req.params.pickupId, warehouseName: warehouseName || '', warehouseSignature: warehouseSignature || '', driverName, driverDNI, driverSignature, signedAt: now.toISOString() };
  pickup.status = 'signed';
  pickup.signedAt = now.toISOString();
  saveData();
  
  console.log('\n✍️ MANIFIESTO FIRMADO: ' + req.params.pickupId + ' - ' + driverName + ' (' + driverDNI + ')');
  res.json({ success: true, message: 'Manifiesto firmado' });
});

// Documentos
app.get('/api/documents', (req, res) => {
  let pickups = Object.values(database.pickups);
  if (req.query.date) pickups = pickups.filter(p => p.date === req.query.date);
  pickups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ documents: pickups.map(p => ({ ...p, manifest: database.manifests[p.id] || null, isSigned: !!database.manifests[p.id] })) });
});

// Stats
app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayPallets = Object.values(database.pallets).filter(p => p.date === today);
  const todayPickups = Object.values(database.pickups).filter(p => p.date === today);
  let packagesInProgress = 0;
  for (const carrier of CARRIERS) {
    const session = database.activeSessions[carrier];
    if (session && session.packages) packagesInProgress += session.packages.length;
  }
  const indexAge = trackingIndex.lastSync ? Math.round((Date.now() - new Date(trackingIndex.lastSync).getTime()) / 60000) : null;
  
  res.json({
    totalPallets: todayPallets.length, totalPackages: todayPallets.reduce((sum, p) => sum + p.totalPackages, 0), packagesInProgress,
    palletsPending: todayPallets.filter(p => p.status === 'pending').length, palletsPickedUp: todayPallets.filter(p => p.status === 'picked_up').length,
    totalPickups: todayPickups.length, signedManifests: todayPickups.filter(p => database.manifests[p.id]).length,
    index: { loaded: !!trackingIndex.lastSync, matched: trackingIndex.matched, ageMinutes: indexAge }
  });
});

// ============================================
// ENDPOINT INFORME DE COBERTURA
// ============================================
// ============================================
// CONTEO RÁPIDO DE ESCANEOS (sin consultar Odoo)
// ============================================
app.get('/api/scan-counts', (req, res) => {
  const counts = {};
  let totalSession = 0, totalPallets = 0;

  for (const carrier of CARRIERS) {
    const session = database.activeSessions[carrier];
    const sessionCount = (session && session.packages) ? session.packages.length : 0;

    let palletCount = 0;
    const today = new Date().toISOString().split('T')[0];
    for (const pallet of Object.values(database.pallets)) {
      if (pallet.carrier === carrier && pallet.createdAt && pallet.createdAt.startsWith(today)) {
        palletCount += (pallet.packages || []).length;
      }
    }

    counts[carrier] = { session: sessionCount, pallets: palletCount, total: sessionCount + palletCount };
    totalSession += sessionCount;
    totalPallets += palletCount;
  }

  res.json({
    timestamp: new Date().toISOString(),
    totalSession,
    totalPallets,
    grandTotal: totalSession + totalPallets,
    byCarrier: counts
  });
});

app.get('/api/odoo-outs', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Parámetros from y to requeridos (YYYY-MM-DD)' });

  const dateFrom = from + ' 00:00:00';
  const dateTo   = to   + ' 23:59:59';

  console.log('\n📊 ODOO-OUTS B2C: ' + from + ' → ' + to);

  try {
    const domain = [
      '&',
        '|',
          ['location_id', 'ilike', 'salida'],
          ['location_id', 'ilike', 'empaquetad'],
        '&', ['state', '=', 'done'],
        '&', ['sale_id.team_id', 'ilike', 'shopify'],
        '&', ['location_dest_id', 'ilike', 'customers'],
        '&', ['date_done', '!=', false],
        '&', ['date_done', '>=', dateFrom],
              ['date_done', '<=', dateTo]
    ];

    const pickings = await odooClient.execute(
      'stock.picking', 'search_read',
      [domain],
      {
        fields: ['id', 'name', 'carrier_tracking_ref', 'carrier_id', 'partner_id', 'origin', 'date_done', 'state', 'sale_id'],
        order: 'date_done desc',
        limit: 50000
      }
    );

    console.log('   📦 ' + pickings.length + ' OUTs B2C encontrados en Odoo');

    const scannedTrackings = new Set();
    const scannedPickingIds = new Set();
    const scannedTrackingsClean = [];  // Para matching por substring
    for (const pallet of Object.values(database.pallets)) {
      for (const pkg of (pallet.packages || [])) {
        if (pkg.tracking) {
          const t = pkg.tracking.toUpperCase().trim();
          scannedTrackings.add(t);
          scannedTrackingsClean.push(t.replace(/[^A-Z0-9]/g, ''));
        }
        if (pkg.pickingId) scannedPickingIds.add(pkg.pickingId);
      }
    }
    for (const carrier of CARRIERS) {
      const session = database.activeSessions[carrier];
      if (session && session.packages) {
        for (const pkg of session.packages) {
          if (pkg.tracking) {
            const t = pkg.tracking.toUpperCase().trim();
            scannedTrackings.add(t);
            scannedTrackingsClean.push(t.replace(/[^A-Z0-9]/g, ''));
          }
          if (pkg.pickingId) scannedPickingIds.add(pkg.pickingId);
        }
      }
    }

    // Pre-extraer trackings embebidos en barcodes usando extractAsendiaTracking() e extractInpostTracking()
    const extractedOdooTrackings = new Set();
    for (const scanned of scannedTrackingsClean) {
      const asResult = extractAsendiaTracking(scanned);
      if (asResult.extracted) {
        extractedOdooTrackings.add(asResult.extracted.toUpperCase());
      }
      // INPOST: extraer 8 dígitos de barcode largo numérico
      const ipResult = extractInpostTracking(scanned);
      if (ipResult.extracted) {
        extractedOdooTrackings.add(ipResult.extracted.toUpperCase());
      }
      // También añadir el tracking limpio completo
      extractedOdooTrackings.add(scanned);
    }

    // Matching avanzado: patrones extraídos + substring (devuelve el tipo de match)
    function matchAdvanced(odooTracking) {
      if (!odooTracking || odooTracking.length < 7) return null;
      const clean = odooTracking.toUpperCase().replace(/[^A-Z0-9]/g, '');
      // 1. Check si el tracking de Odoo está entre los extractedOdooTrackings
      if (extractedOdooTrackings.has(clean)) return 'extractedTracking';
      // 2. Substring: el tracking de Odoo aparece dentro de algún barcode escaneado (CTT, largos)
      for (const scanned of scannedTrackingsClean) {
        if (scanned.length >= 15 && clean.length >= 7) {
          if (scanned.includes(clean)) return 'substring';
        }
      }
      return null;
    }

    console.log('   🔍 Trackings en app: ' + scannedTrackings.size + ' | PickingIDs: ' + scannedPickingIds.size + ' | Extracted patterns: ' + extractedOdooTrackings.size);

    const byCarrier = {};
    for (const c of [...CARRIERS, 'DESCONOCIDO']) {
      byCarrier[c] = { total: 0, scanned: 0, missing: 0, pct: 0, records: [] };
    }

    for (const picking of pickings) {
      const odooCarrierName = picking.carrier_id ? picking.carrier_id[1] : '';
      let carrier = null;

      // 1. Prefijo de tracking (O(1), muy fiable)
      if (!carrier && picking.carrier_tracking_ref) {
        const t = picking.carrier_tracking_ref.toUpperCase().trim();
        if (/^PK/.test(t)) carrier = 'CORREOS';
        else if (/^MI/.test(t)) carrier = 'CORREOS EXPRESS';
        else if (/^Z89/.test(t)) carrier = 'GLS';
        else if (/^6C20/.test(t)) carrier = 'ASENDIA';
        else if (/^H103/.test(t)) carrier = 'ASENDIA';
        else if (/^6A/.test(t)) carrier = 'SPRING';
        else if (/^LS\d{9}[A-Z]{2}$/.test(t)) carrier = 'ASENDIA';
        else if (/^LS|^LX|^LV|^LT|^3[A-Z]|^CP|^Z96|^XSMT|^0008|^0626/.test(t)) carrier = 'SPRING';
        else if (/^CTT|^EA/.test(t)) carrier = 'CTT';
        else if (/^C0/.test(t)) carrier = 'CORREOS';
        else if (/^\d{8}$/.test(t)) carrier = 'INPOST';
      }

      // 2. Lookup exacto en índice (O(1), sin pattern matching costoso)
      if (!carrier && picking.carrier_tracking_ref) {
        const trackClean = picking.carrier_tracking_ref.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const idxExact = (trackingIndex.byTracking && trackingIndex.byTracking[trackClean]) ||
                         (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[trackClean]);
        if (idxExact && idxExact.carrier && idxExact.carrier !== 'DESCONOCIDO') {
          carrier = overrideCarrier(idxExact.carrier, trackClean);
        }
      }

      // 3. Nombre carrier en Odoo (fallback para envíos sin tracking o prefijo desconocido)
      if (!carrier) {
        carrier = detectCarrierFromOdooName(odooCarrierName);
      }

      const key = carrier || 'DESCONOCIDO';
      if (!byCarrier[key]) byCarrier[key] = { total: 0, scanned: 0, missing: 0, pct: 0, records: [] };

      const tracking  = (picking.carrier_tracking_ref || '').toUpperCase().trim();
      let matchSource = null;
      if (scannedPickingIds.has(picking.id)) {
        matchSource = 'pickingId';
      } else if (tracking.length > 0 && scannedTrackings.has(tracking)) {
        matchSource = 'exactTracking';
      } else {
        matchSource = matchAdvanced(tracking);
      }
      const isScanned = matchSource !== null;

      byCarrier[key].total++;
      if (isScanned) byCarrier[key].scanned++;
      byCarrier[key].records.push({
        id:          picking.id,
        name:        picking.name,
        tracking:    picking.carrier_tracking_ref || '',
        carrier:     key,
        odooCarrier: odooCarrierName,
        client:      picking.partner_id ? picking.partner_id[1] : '',
        saleOrder:   picking.sale_id   ? picking.sale_id[1]   : '',
        origin:      picking.origin || '',
        dateDone:    picking.date_done || '',
        scanned:     isScanned,
        matchSource: matchSource
      });
    }

    const summary = {};
    for (const [c, data] of Object.entries(byCarrier)) {
      if (data.total === 0 && c === 'DESCONOCIDO') continue;
      data.missing = data.total - data.scanned;
      data.pct     = data.total > 0 ? Math.min(100, (data.scanned / data.total) * 100) : 0;
      summary[c]   = data;
    }

    const totalAll     = pickings.length;
    const totalScanned = Object.values(summary).reduce((s, d) => s + d.scanned, 0);

    console.log('   ✅ ' + totalScanned + ' / ' + totalAll + ' escaneados (' +
      (totalAll > 0 ? ((totalScanned / totalAll) * 100).toFixed(1) : 0) + '%)');

    res.json({
      from, to,
      total:    totalAll,
      scanned:  totalScanned,
      missing:  totalAll - totalScanned,
      coverage: totalAll > 0 ? Math.min(100, (totalScanned / totalAll) * 100) : 0,
      byCarrier: summary
    });

  } catch (err) {
    console.error('   ❌ Error:', err.message);
    res.status(500).json({ error: 'Error consultando Odoo: ' + err.message });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', async () => {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  📦 CLASIFICADOR DE EXPEDICIONES v10.1                        ║');
  console.log('║  🔗 Sendcloud + Odoo | Índice Pre-calculado | Auto-Sync       ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║  🌐 Puerto: ' + PORT + '                                              ║');
  console.log('║  🏷️  Etiqueta: /api/pallets/{id}/label                        ║');
  console.log('║  📋 Manifiesto: /api/manifest/{pickupId}                      ║');
  console.log('║  📊 Índice: /api/index-stats                                  ║');
  console.log('║  🔄 Recargar: POST /api/reload-index                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  
  const indexLoaded = loadTrackingIndex();
  
  try { const uid = await odooClient.authenticate(); console.log('✅ Odoo conectado (UID: ' + uid + ')'); }
  catch (err) { console.log('❌ Error Odoo:', err.message); }
  
  console.log('🔑 Sendcloud configurado');
  console.log('📊 Palets en memoria: ' + Object.keys(database.pallets).length);
  console.log('📋 Recogidas en memoria: ' + Object.keys(database.pickups).length);
  
  setupScheduledSync();
  
  if (!indexLoaded || !trackingIndex.lastSync) {
    console.log('\n⏳ Auto-sync programado en 10 segundos...');
    setTimeout(() => { console.log('\n🚀 Ejecutando auto-sync inicial...'); runSync(); }, 10000);
  } else {
    const ageHours = (Date.now() - new Date(trackingIndex.lastSync).getTime()) / 3600000;
    if (ageHours > 4) {
      console.log('\n⏳ Índice antiguo (' + Math.round(ageHours) + 'h), auto-sync en 10 segundos...');
      setTimeout(() => runSync(), 10000);
    }
  }
});


