const express = require('express');
const cors = require('cors');
const xmlrpc = require('xmlrpc');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');
let compression;
try { compression = require('compression'); } catch (e) { console.warn('⚠️ compression not installed'); }

const app = express();
app.use(cors());
if (compression) {
  app.use(compression({
    level: 6,           // balance velocidad/compresión
    threshold: 1024,    // solo comprimir respuestas > 1 KB
    filter: (req, res) => {
      // No comprimir si el cliente no lo acepta
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    }
  }));
  console.log('✅ Gzip compression habilitada');
}
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
// (#034) Aviso de seguridad: si no hay env vars, se están usando las claves
// hardcodeadas expuestas en el repositorio. Rotar y configurar en Railway.
if (!process.env.ODOO_API_KEY || !process.env.SENDCLOUD_SECRET_KEY) {
  console.warn('🔐 ⚠️ SEGURIDAD: credenciales por FALLBACK hardcodeado (sin env vars). Configurar ODOO_API_KEY / SENDCLOUD_PUBLIC_KEY / SENDCLOUD_SECRET_KEY en Railway y ROTAR las claves expuestas en GitHub.');
}

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
  'asendia_es': 'ASENDIA',
  // AMAZON: confirmado en producción que Sendcloud envía 'amazon' (no amazon_shipping)
  'amazon': 'AMAZON',
  'amazon_shipping': 'AMAZON',
  'amazon_logistics': 'AMAZON',
  'amazon_es': 'AMAZON'
};

const CARRIERS = ['AMAZON', 'ASENDIA', 'CORREOS', 'CORREOS EXPRESS', 'CTT', 'GLS', 'INPOST', 'SPRING'];

// =============================================
// CACHÉ SENDCLOUD
// =============================================
let sendcloudCache = { parcels: {} };
let sendcloudCacheUpper = {}; // Índice O(1) case-insensitive

async function loadSendcloudCache() {
  try {
    if (fs.existsSync(SENDCLOUD_CACHE_FILE)) {
      // Lectura ASÍNCRONA (#037): no bloquea el event loop durante el I/O del
      // fichero de ~17MB. El JSON.parse sigue siendo síncrono pero es menos.
      const data = await fs.promises.readFile(SENDCLOUD_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      sendcloudCache = parsed;
      // Construir índice uppercase para O(1) lookup case-insensitive
      const upper = {};
      for (const [key, value] of Object.entries(sendcloudCache.parcels || {})) {
        upper[key.toUpperCase()] = value;
      }
      sendcloudCacheUpper = upper;
      console.log('📦 Caché Sendcloud cargada: ' + Object.keys(sendcloudCache.parcels || {}).length + ' envíos (index O(1) listo)');
    }
  } catch (err) {
    // No pisar la caché en memoria si el parse falla (fichero a medio escribir)
    console.error('Error cargando caché Sendcloud (se mantiene la anterior):', err.message);
  }
}

function findInSendcloudCache(tracking) {
  if (!tracking || !sendcloudCache.parcels) return null;
  // Match directo
  if (sendcloudCache.parcels[tracking]) return sendcloudCache.parcels[tracking];
  // Match case-insensitive vía índice O(1) (antes iteraba 50k entradas)
  const trackingUpper = tracking.toUpperCase().trim();
  if (sendcloudCacheUpper[trackingUpper]) return sendcloudCacheUpper[trackingUpper];
  return null;
}

// ============================================
// ÍNDICE DE TRACKING
// ============================================
let trackingIndex = {
  lastSync: null, totalOdoo: 0, totalSendcloud: 0, matched: 0,
  byTracking: {}, byOdooTracking: {}, byCarrier: {}
};

async function loadTrackingIndex() {
  try {
    if (fs.existsSync(TRACKING_INDEX_FILE)) {
      // Lectura ASÍNCRONA (#037) del índice (grande, ~100-186MB): el I/O ya no
      // bloquea el event loop. El JSON.parse posterior sí bloquea, pero se
      // construye un objeto NUEVO y solo se sustituye si el parse tiene éxito
      // (nunca se deja el índice a medias por un fichero corrupto).
      const data = await fs.promises.readFile(TRACKING_INDEX_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object' || !parsed.byTracking) throw new Error('estructura de índice inválida');
      trackingIndex = parsed;
      const age = trackingIndex.lastSync ? Math.round((Date.now() - new Date(trackingIndex.lastSync).getTime()) / 60000) : 'N/A';
      console.log('📊 Índice cargado: ' + trackingIndex.matched + ' coincidencias (hace ' + age + ' min)');
      return true;
    }
  } catch (err) {
    // Mantener el índice en memoria si el nuevo no parsea (no degradar el servicio)
    console.error('⚠️ Error cargando índice (se mantiene el anterior):', err.message);
    return false;
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

  // PASO 2.3: ASENDIA - Si tracking empieza con 6C** (#036: 6C20, 6C21, futuros) y no
  // tuvo match exacto, intentar prefijo de 12 chars (último dígito puede variar)
  // Ej: barcode extrae 6C21052489298, Odoo tiene 6C21052489292 (comparten 6C2105248929)
  if (/^6C\d\d/.test(clean) && clean.length >= 12 && trackingIndex.byCarrier && trackingIndex.byCarrier["ASENDIA"]) {
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

  // PASO 2.6: INPOST - tracking de 8 dígitos directo o embebido en barcode largo
  // Procesa tanto isDirectMatch=true (^\d{8}$) como =false (sliding extraído).
  // Antes solo procesaba !isDirectMatch → para 8 dígitos puros caía a Odoo (#030).
  if ((clean.length > 10 && /^\d+$/.test(clean)) || /^\d{8}$/.test(clean)) {
    var inpostExtract = extractInpostTracking(clean);
    if (inpostExtract.extracted) {
      var ipTracking = inpostExtract.extracted;
      // IMPORTANTE: Odoo guarda algunos INPOST con prefijo "E1" (ej. E183954005).
      // El sync indexa el tracking completo (con E1) pero el barcode físico solo
      // tiene los 8 dígitos (83954005). Buscamos ambas formas.
      var ipTrackingE1 = "E1" + ipTracking;
      // Buscar en byCarrier INPOST (probar 8-dig directo y con prefijo E1)
      if (trackingIndex.byCarrier && trackingIndex.byCarrier["INPOST"]) {
        if (trackingIndex.byCarrier["INPOST"][ipTracking]) {
          console.log("   🎯 Match INPOST (" + (inpostExtract.isDirectMatch ? "directo" : "pos " + inpostExtract.position) + "): " + ipTracking);
          return trackingIndex.byCarrier["INPOST"][ipTracking];
        }
        if (trackingIndex.byCarrier["INPOST"][ipTrackingE1]) {
          console.log("   🎯 Match INPOST (E1-prefix): " + ipTrackingE1);
          return trackingIndex.byCarrier["INPOST"][ipTrackingE1];
        }
      }
      // Buscar en byOdooTracking (idem)
      if (trackingIndex.byOdooTracking) {
        var ipData = trackingIndex.byOdooTracking[ipTracking] || trackingIndex.byOdooTracking[ipTrackingE1];
        if (ipData && ipData.carrier === 'INPOST') {
          console.log("   🎯 Match INPOST extraído (byOdoo): " + (ipData.odooTracking || ipTracking));
          return ipData;
        }
      }
      // Buscar en byTracking
      if (trackingIndex.byTracking) {
        var ipData2 = trackingIndex.byTracking[ipTracking] || trackingIndex.byTracking[ipTrackingE1];
        if (ipData2 && ipData2.carrier === 'INPOST') {
          console.log("   🎯 Match INPOST extraído (byTracking): " + (ipData2.tracking || ipTracking));
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

async function runSync(opts = {}) {
  if (syncInProgress) { console.log('⏳ Sync ya en progreso...'); return false; }
  const syncScript = path.join(__dirname, 'sync-full.js');
  if (!fs.existsSync(syncScript)) { console.log('⚠️ sync-full.js no encontrado'); return false; }

  syncInProgress = true;
  lastSyncAttempt = new Date().toISOString();
  // --full (barrido announced 14d) solo de noche o si se fuerza: de día el sync
  // es ligero para no alargar la contención de CPU en hora punta (#037).
  const args = opts.full ? [syncScript, '--full'] : [syncScript];
  console.log('\n🔄 Iniciando sync ' + (opts.full ? 'COMPLETO' : 'ligero') + '... (' + lastSyncAttempt + ')');

  return new Promise((resolve) => {
    const child = spawn('node', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    // WATCHDOG (#043): si el sync se cuelga (socket sin timeout, Odoo colgado…),
    // matarlo a los 25 min. Sin esto, syncInProgress quedaba true PARA SIEMPRE
    // y el índice dejaba de refrescarse (verificado: 23h sin sync → escaneos
    // del día cayendo a Odoo → "va muy lento").
    const watchdog = setTimeout(() => {
      console.error('   ⏱️🛑 WATCHDOG: sync >25 min — matando proceso hijo colgado');
      try { child.kill('SIGKILL'); } catch (_) {}
    }, 25 * 60 * 1000);
    child.stdout.on('data', (data) => {
      data.toString().split('\n').filter(l => l.trim()).forEach(line => console.log('   ' + line));
    });
    child.stderr.on('data', (data) => console.error('   ❌ ' + data.toString()));
    child.on('close', (code) => {
      clearTimeout(watchdog);
      syncInProgress = false;
      if (code === 0) {
        console.log('✅ Sync completado');
        // La recarga del índice hace JSON.parse de un fichero grande (bloqueante).
        // Se difiere con setImmediate para drenar antes las requests en vuelo, y
        // se mide su duración para vigilar el bloqueo del event loop (#037).
        setImmediate(async () => {
          const t0 = Date.now();
          await loadTrackingIndex();
          await loadSendcloudCache();
          try { buildScanningIndexJson(); } catch (e) { console.error('⚠️ Error pre-serializando índice:', e.message); }
          const ms = Date.now() - t0;
          console.log('🔁 Índice recargado en ' + ms + 'ms' + (ms > 1500 ? ' ⚠️ (bloqueo largo del event loop)' : ''));
        });
        resolve(true);
      }
      else { console.log('❌ Sync falló con código ' + code); resolve(false); }
    });
    child.on('error', (err) => { syncInProgress = false; console.error('❌ Error sync:', err.message); resolve(false); });
  });
}

function setupScheduledSync() {
  // Sync cada 30 minutos en horario laboral (6-22h) para que el índice
  // siempre tenga los pickings más recientes y los scans no caigan a Odoo lento
  setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    // AUTO-CURADO (#043): si el índice envejece >90 min en horario laboral y no
    // hay sync corriendo, relanzar YA (no esperar a :00/:30). Cubre cualquier
    // fallo del schedule (proceso reiniciado, sync abortado, cuelgue previo…).
    const idxAgeMin = trackingIndex.lastSync ? (Date.now() - new Date(trackingIndex.lastSync).getTime()) / 60000 : 99999;
    if (hour >= 6 && hour <= 22 && idxAgeMin > 90 && !syncInProgress) {
      console.error('\n🚑 AUTO-CURADO: índice con ' + Math.round(idxAgeMin) + ' min de antigüedad en horario laboral — relanzando sync');
      runSync();
      return;
    }

    // En horario laboral 6-22h: cada 30 min (en :00 y :30) — sync LIGERO
    if (hour >= 6 && hour <= 22 && (minute === 0 || minute === 30)) {
      console.log('\n⏰ Sync programado (' + hour + ':' + String(minute).padStart(2,'0') + ')');
      runSync();
      return;
    }
    // Fuera de horario: 00:00 y 04:00 — sync COMPLETO (backfill announced 14d)
    if ((hour === 0 || hour === 4) && minute === 0) {
      console.log('\n⏰ Sync nocturno COMPLETO (' + hour + ':00)');
      runSync({ full: true });
    }
  }, 60000);
  console.log('⏰ Sync ligero cada 30 min (6h-22h) + 2 nocturnos COMPLETOS (00, 04)');
}

// ============================================
// BASE DE DATOS
// ============================================
let database = { activeSessions: {}, pallets: {}, pickups: {}, manifests: {} };

function isDatabaseEmpty() {
  return Object.keys(database.pallets || {}).length === 0
    && Object.keys(database.pickups || {}).length === 0
    && Object.keys(database.activeSessions || {}).length === 0;
}

function fileHasRealData(f) {
  try { return fs.existsSync(f) && fs.statSync(f).size > 200; } catch (_) { return false; }
}

// Escritura ATÓMICA: escribe a un temporal y renombra (rename es atómico en el
// mismo filesystem en Linux/Railway). Evita dejar data.json truncado si el proceso
// muere a mitad de un writeFileSync de 30+ MB (causa histórica de wipes de datos).
function atomicWriteFileSync(file, contents) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (e) {
    // Fallback (p.ej. Windows local: rename sobre fichero existente falla)
    try { fs.writeFileSync(file, contents); }
    finally { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {} }
  }
}

function migratePalletsToPackages() {
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
}

function logPalletDateRange() {
  const dates = Object.values(database.pallets).map(p => p.date).filter(Boolean).sort();
  if (dates.length) console.log('   📅 Rango de palets en disco: ' + dates[0] + ' → ' + dates[dates.length - 1]);
}

function loadData() {
  // Aviso CRÍTICO de persistencia: sin volumen montado los datos son efímeros
  // y se pierden en cada redeploy de Railway.
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.log('💾 Persistencia: volumen Railway MONTADO en ' + VOLUME_PATH);
  } else {
    console.warn('⚠️ ⚠️ PERSISTENCIA EFÍMERA: RAILWAY_VOLUME_MOUNT_PATH no definido.');
    console.warn('   VOLUME_PATH=' + VOLUME_PATH + ' (disco del contenedor). LOS DATOS SE PIERDEN EN CADA REDEPLOY.');
  }

  // Fuentes por orden de preferencia: volumen, backup del volumen, semilla de git.
  const sources = [
    { file: DATA_FILE, label: 'volumen', isVolume: true },
    { file: DATA_FILE + '.bak', label: 'backup del volumen', isVolume: true },
    { file: path.join(__dirname, 'data.json'), label: 'semilla de git', isVolume: false }
  ];

  for (const src of sources) {
    if (!fs.existsSync(src.file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(src.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('estructura no válida');
      database = Object.assign({ activeSessions: {}, pallets: {}, pickups: {}, manifests: {} }, parsed);
      const nP = Object.keys(database.pallets).length;
      console.log('📂 Datos cargados desde ' + src.label + ' (' + src.file + '): ' + nP + ' palets, ' + Object.keys(database.pickups).length + ' recogidas');
      logPalletDateRange();
      migratePalletsToPackages();
      if (src.isVolume && nP > 0) {
        // Backup inmediato del estado bueno recién cargado.
        try { fs.copyFileSync(src.file, DATA_FILE + '.bak'); } catch (_) {}
      }
      saveData();
      return;
    } catch (err) {
      console.error('⚠️ No se pudo cargar ' + src.label + ' (' + src.file + '): ' + err.message);
      // Preservar el fichero corrupto del volumen para forense; NUNCA arrancar
      // sobre él ni sobrescribirlo con una BD vacía.
      if (src.file === DATA_FILE) {
        try {
          const quarantine = DATA_FILE + '.corrupt-' + Date.now();
          fs.renameSync(DATA_FILE, quarantine);
          console.error('   🔒 data.json corrupto preservado como ' + quarantine);
        } catch (_) {}
      }
    }
  }
  console.warn('⚠️ Arrancando con base de datos VACÍA (no se encontró ningún data.json válido).');
}

// Throttled save: agrupa múltiples saveData en 2 segundos para no saturar I/O
// con data.json de 30+ MB en cada escaneo. Escritura atómica + guard anti-borrado.
let saveTimer = null;
let savePending = false;
let lastBackupDay = null;

function writeDatabaseToDisk() {
  // GUARD ANTI-WIPE: nunca sobrescribir un data.json que tiene datos por una BD
  // vacía en memoria (protege del bug histórico: parse fallido -> BD vacía ->
  // save borraba todo el volumen).
  if (isDatabaseEmpty() && fileHasRealData(DATA_FILE)) {
    console.error('🛑 saveData ABORTADO: BD en memoria vacía pero data.json en disco tiene datos. No se sobrescribe (pérdida evitada).');
    return;
  }
  atomicWriteFileSync(DATA_FILE, JSON.stringify(database));
  maybeDailyBackup();
}

function maybeDailyBackup() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastBackupDay || isDatabaseEmpty()) return;
    // Backup comprimido (gzip) para no llenar el volumen: ~4 MB/día vs ~30 MB.
    const gz = zlib.gzipSync(JSON.stringify(database), { level: 6 });
    atomicWriteFileSync(path.join(VOLUME_PATH, 'data.backup.' + day + '.json.gz'), gz);
    lastBackupDay = day;
    console.log('🗂️ Backup diario creado: data.backup.' + day + '.json.gz (' + (gz.length / 1048576).toFixed(1) + ' MB)');
    pruneOldBackups(30);
  } catch (err) { console.error('Error backup diario:', err.message); }
}

function pruneOldBackups(keepDays) {
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    for (const f of fs.readdirSync(VOLUME_PATH)) {
      if (/^data\.backup\.\d{4}-\d{2}-\d{2}\.json(\.gz)?$/.test(f)) {
        const full = path.join(VOLUME_PATH, f);
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      }
    }
  } catch (_) {}
}

function saveData() {
  savePending = true;
  if (saveTimer) return; // ya hay uno pendiente
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!savePending) return;
    savePending = false;
    try { writeDatabaseToDisk(); }
    catch (err) { console.error('Error guardando:', err.message); }
  }, 2000);
}

// Save síncrono para situaciones críticas (shutdown, etc.)
function saveDataSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  savePending = false;
  try { writeDatabaseToDisk(); }
  catch (err) { console.error('Error guardando:', err.message); }
}

// Garantizar guardado si el proceso se cierra
process.on('SIGTERM', () => { saveDataSync(); process.exit(0); });
process.on('SIGINT', () => { saveDataSync(); process.exit(0); });

// ============================================
// SETS PRECOMPUTADOS DE SCANS (rendimiento)
// ============================================
// Estos Sets contienen TODOS los trackings y pickingIds escaneados HISTÓRICAMENTE
// Se construyen UNA SOLA VEZ al cargar la app y se actualizan incrementalmente
// en cada scan/palet/recogida. Esto evita iterar 185k+ paquetes en cada /api/odoo-outs.
const globalScannedTrackings = new Set();
const globalScannedPickingIds = new Set();
// Patrones extraídos (ASENDIA 6C20*, INPOST 8 dígitos embebidos en barcodes largos)
// para que un escaneo del barcode largo cuente como escaneado del tracking de Odoo
const globalExtractedTrackings = new Set();
// Subconjunto de barcodes "largos" (>=15 chars) para matching por substring rápido
// Esto reduce dramáticamente las iteraciones (la mayoría de trackings son cortos)
const globalLongScannedBarcodes = [];

function rebuildGlobalScans() {
  const t0 = Date.now();
  globalScannedTrackings.clear();
  globalScannedPickingIds.clear();
  globalExtractedTrackings.clear();
  globalLongScannedBarcodes.length = 0;
  let count = 0;
  // Palets cerrados
  for (const pallet of Object.values(database.pallets)) {
    for (const pkg of (pallet.packages || [])) {
      _addPackageToGlobalSets(pkg);
      count++;
    }
  }
  // Sesiones activas (nuevo formato: array de sesiones por carrier)
  for (const carrier of CARRIERS) {
    const sessions = database.activeSessions[carrier];
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        for (const pkg of (s.packages || [])) {
          _addPackageToGlobalSets(pkg);
          count++;
        }
      }
    } else if (sessions && Array.isArray(sessions.packages)) {
      // Formato antiguo (por si rebuild se llama antes de migrate)
      for (const pkg of sessions.packages) {
        _addPackageToGlobalSets(pkg);
        count++;
      }
    }
  }
  console.log('📊 Sets globales construidos: ' + globalScannedTrackings.size + ' trackings, ' + globalScannedPickingIds.size + ' pickingIds, ' + globalExtractedTrackings.size + ' patrones (' + count + ' paquetes en ' + (Date.now()-t0) + 'ms)');
}

function _addPackageToGlobalSets(pkg) {
  if (pkg.tracking) {
    const t = pkg.tracking.toUpperCase().trim();
    globalScannedTrackings.add(t);
    const clean = t.replace(/[^A-Z0-9]/g, '');
    globalExtractedTrackings.add(clean);
    // Solo añadimos a "largos" si vale la pena para substring matching (CTT/SPRING long barcodes)
    if (clean.length >= 15) globalLongScannedBarcodes.push(clean);
    // ASENDIA (6C20XXXXXXXXX embebido)
    try {
      const asResult = extractAsendiaTracking(clean);
      if (asResult.extracted) globalExtractedTrackings.add(asResult.extracted.toUpperCase());
    } catch {}
    // INPOST (8 dígitos embebidos)
    try {
      const ipResult = extractInpostTracking(clean);
      if (ipResult.extracted) globalExtractedTrackings.add(ipResult.extracted.toUpperCase());
    } catch {}
  }
  if (pkg.pickingId) globalScannedPickingIds.add(pkg.pickingId);
}

function addPackageToGlobalScans(pkg) {
  _addPackageToGlobalSets(pkg);
}

function removePackageFromGlobalScans(pkg) {
  // NO eliminamos del Set global. Un tracking escaneado una vez permanece como
  // "escaneado" para siempre (coherente con el histórico permanente).
  // Si un palet se elimina, los Sets globales no se desactualizan: lo importante
  // es que el envío fue escaneado en algún momento.
}

loadData();
loadSendcloudCache();

// ============================================
// FUNCIONES DE SESIÓN (MÚLTIPLES SESIONES POR CARRIER)
// ============================================
// Estructura nueva: database.activeSessions[carrier] es un ARRAY de sesiones
// Cada sesión: { id, letter, packages: [], createdAt, lastUpdate, fromPalletId? }
// Múltiples palets simultáneos del mismo transportista

const SESSION_LETTERS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T'];

function migrateSessionsFormat() {
  for (const carrier of CARRIERS) {
    const current = database.activeSessions[carrier];
    if (Array.isArray(current)) continue; // ya migrado
    if (!current) {
      database.activeSessions[carrier] = [];
      continue;
    }
    // Formato antiguo: { packages: [], lastUpdate }
    if (current.packages && Array.isArray(current.packages) && current.packages.length > 0) {
      database.activeSessions[carrier] = [{
        id: 'sess-' + Date.now() + '-' + carrier.replace(/\s+/g, '_'),
        letter: 'A',
        packages: current.packages,
        createdAt: current.lastUpdate || new Date().toISOString(),
        lastUpdate: current.lastUpdate || new Date().toISOString()
      }];
    } else {
      database.activeSessions[carrier] = [];
    }
  }
  console.log('📋 Sesiones migradas a formato array (múltiples palets)');
}

// TTL para considerar una sesión vacía como "abandonada" y auto-eliminarla.
// Evita que se acumulen palets con 0 envíos cuando el operario pulsa "+ Nuevo"
// por error o cancela un flujo a medias. 5 min es margen suficiente para que el
// operario que recién la creó pueda escanear si lo iba a hacer.
const EMPTY_SESSION_TTL_MS = 5 * 60 * 1000;

function pruneEmptyStaleSessions(carrier) {
  const c = carrier.toUpperCase();
  const arr = database.activeSessions[c];
  if (!Array.isArray(arr) || arr.length === 0) return;
  const now = Date.now();
  let pruned = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i];
    if (!s || (s.packages && s.packages.length > 0)) continue;
    const last = s.lastUpdate ? new Date(s.lastUpdate).getTime() : (s.createdAt ? new Date(s.createdAt).getTime() : 0);
    if (last && (now - last) > EMPTY_SESSION_TTL_MS) {
      arr.splice(i, 1);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log('🧹 Sesiones vacías abandonadas eliminadas: ' + pruned + ' en ' + c);
    saveData();
  }
}

function getSessionsArray(carrier) {
  const c = carrier.toUpperCase();
  if (!Array.isArray(database.activeSessions[c])) {
    database.activeSessions[c] = [];
  }
  // Auto-prune de sesiones vacías abandonadas (no afecta sesiones recientes ni con paquetes)
  pruneEmptyStaleSessions(c);
  return database.activeSessions[c];
}

// Devuelve la primera sesión (default cuando hay solo una o cuando el cliente no especifica)
function getDefaultSession(carrier) {
  const sessions = getSessionsArray(carrier);
  return sessions.length > 0 ? sessions[0] : null;
}

function getSessionById(carrier, sessionId) {
  return getSessionsArray(carrier).find(s => s.id === sessionId);
}

function nextAvailableLetter(sessions) {
  const used = new Set(sessions.map(s => s.letter));
  for (const l of SESSION_LETTERS) {
    if (!used.has(l)) return l;
  }
  return 'X'; // fallback
}

function createNewSession(carrier, opts = {}) {
  const sessions = getSessionsArray(carrier);
  const newSession = {
    id: 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    letter: opts.letter || nextAvailableLetter(sessions),
    packages: opts.packages || [],
    createdAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    fromPalletId: opts.fromPalletId || null
  };
  sessions.push(newSession);
  saveData();
  return newSession;
}

function addPackageToSession(carrier, packageData, sessionId = null) {
  const sessions = getSessionsArray(carrier);

  // Buscar duplicados en CUALQUIER sesión del carrier
  for (const s of sessions) {
    if (s.packages.find(p => p.tracking === packageData.tracking)) {
      return { added: false, reason: 'duplicate', sessionId: s.id, sessionLetter: s.letter };
    }
    if (packageData.orderRef && s.packages.find(p => p.orderRef === packageData.orderRef)) {
      return { added: false, reason: 'duplicate-order', sessionId: s.id, sessionLetter: s.letter };
    }
  }

  // Elegir sesión
  let session = sessionId ? getSessionById(carrier, sessionId) : null;
  if (!session) {
    // Si no se especificó o no se encontró, usar la primera o crear nueva
    session = sessions[0] || createNewSession(carrier);
  }

  session.packages.push(packageData);
  session.lastUpdate = new Date().toISOString();
  addPackageToGlobalScans(packageData);
  saveData();
  return { added: true, sessionId: session.id, sessionLetter: session.letter };
}

function clearSession(carrier, sessionId = null) {
  const sessions = getSessionsArray(carrier);
  if (sessionId) {
    // Limpiar solo una sesión específica
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) sessions.splice(idx, 1);
  } else {
    // Limpiar todas (legacy behavior)
    database.activeSessions[carrier.toUpperCase()] = [];
  }
  saveData();
}

function removePackageFromSession(carrier, tracking, sessionId = null) {
  const sessions = getSessionsArray(carrier);
  const targets = sessionId ? sessions.filter(s => s.id === sessionId) : sessions;
  let removed = false;
  for (const session of targets) {
    const len = session.packages.length;
    session.packages = session.packages.filter(p => p.tracking !== tracking);
    if (session.packages.length < len) {
      session.lastUpdate = new Date().toISOString();
      removed = true;
    }
  }
  if (removed) saveData();
  return removed;
}

// Wrapper para compatibilidad con código que espera estructura antigua
function getSession(carrier) {
  const sessions = getSessionsArray(carrier);
  if (sessions.length === 0) return { packages: [], lastUpdate: null, _emptyVirtual: true };
  // Combinar todos los paquetes para vista agregada (usado por endpoints legacy)
  const allPackages = [];
  let latestUpdate = null;
  for (const s of sessions) {
    allPackages.push(...s.packages);
    if (!latestUpdate || s.lastUpdate > latestUpdate) latestUpdate = s.lastUpdate;
  }
  return { packages: allPackages, lastUpdate: latestUpdate, _sessionsCount: sessions.length };
}

// Ejecutar migración + reconstruir Sets ahora que las funciones están definidas
migrateSessionsFormat();
rebuildGlobalScans();

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

  // Wrapper con timeout para que las búsquedas Odoo lentas no bloqueen el proceso
  async executeWithTimeout(model, method, args, kwargs = {}, timeoutMs = 3000) {
    return Promise.race([
      this.execute(model, method, args, kwargs),
      new Promise((_, reject) => setTimeout(() => reject(new Error('odoo-timeout')), timeoutMs))
    ]);
  }

  async findPickingByTracking(tracking, meta = {}) {
    // meta.timedOut se pone a true si ALGUNA de las búsquedas falló por timeout.
    // El caller lo usa para NO cachear como negativo un tracking que quizá existe
    // pero Odoo no respondió a tiempo (evita envenenar el negative cache).
    const t0 = Date.now();
    try {
      // 1. Exact match (most common case, fast) — 3s timeout
      let pickings = await this.executeWithTimeout('stock.picking', 'search_read', [[['carrier_tracking_ref', '=', tracking]]], {
        fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin', 'carrier_id'], limit: 1
      }, 3000).catch(e => { console.warn('   ⏱️ Odoo exact timeout (' + e.message + ')'); meta.timedOut = true; return []; });
      if (pickings.length > 0) { console.log('   🔍 Odoo exact match: ' + (Date.now()-t0) + 'ms'); return pickings[0]; }

      // 1.5 (#033): 8 dígitos puros = espacio de tracking minúsculo (INPOST). El ilike
      // con 8 dígitos matchea cualquier tracking largo que los CONTENGA (falsos
      // positivos verificados con números aleatorios). Solo aceptar exacto o E1+8.
      if (/^\d{8}$/.test(tracking)) {
        const e1 = await this.executeWithTimeout('stock.picking', 'search_read', [[['carrier_tracking_ref', '=', 'E1' + tracking]]], {
          fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin', 'carrier_id'], limit: 1
        }, 2000).catch(e => { console.warn('   ⏱️ Odoo E1-exact timeout (' + e.message + ')'); meta.timedOut = true; return []; });
        if (e1.length > 0) { console.log('   🔍 Odoo E1-exact match: ' + (Date.now()-t0) + 'ms'); return e1[0]; }
        console.log('   🚫 8 dígitos sin match exacto en Odoo — no se intenta ilike (anti-falso-positivo)');
        return null;
      }

      // 2. ilike with full barcode — 2s timeout
      pickings = await this.executeWithTimeout('stock.picking', 'search_read', [[['carrier_tracking_ref', 'ilike', tracking]]], {
        fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin', 'carrier_id'], limit: 1
      }, 2000).catch(e => { console.warn('   ⏱️ Odoo ilike timeout'); meta.timedOut = true; return []; });
      if (pickings.length > 0) { console.log('   🔍 Odoo ilike match: ' + (Date.now()-t0) + 'ms'); return pickings[0]; }

      // 3. Pattern matching - LIMITADO a top 2 patrones (antes 3) y timeout 2s cada uno
      const patterns = this.extractTrackingPatterns(tracking).slice(0, 2);
      for (const pattern of patterns) {
        if (pattern.length >= 7) {
          pickings = await this.executeWithTimeout('stock.picking', 'search_read', [
            [['carrier_tracking_ref', 'ilike', pattern], ['state', '=', 'done'], ['picking_type_code', '=', 'outgoing']]
          ], { fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin', 'carrier_id'], limit: 10 }, 2000).catch(e => { console.warn('   ⏱️ Odoo pattern timeout'); meta.timedOut = true; return []; });
          if (pickings.length > 0) {
            const best = pickings.reduce((a, b) => {
              const cleanUpper = tracking.toUpperCase();
              const trackA = (a.carrier_tracking_ref || '').toUpperCase();
              const trackB = (b.carrier_tracking_ref || '').toUpperCase();
              let scoreA = 0, scoreB = 0;
              while (scoreA < trackA.length && scoreA < cleanUpper.length && trackA[scoreA] === cleanUpper[scoreA]) scoreA++;
              while (scoreB < trackB.length && scoreB < cleanUpper.length && trackB[scoreB] === cleanUpper[scoreB]) scoreB++;
              return scoreB > scoreA ? b : a;
            });
            console.log('   🔍 Match patrón Odoo: "' + pattern + '" → ' + best.carrier_tracking_ref + ' (mejor de ' + pickings.length + ', ' + (Date.now()-t0) + 'ms)');
            return best;
          }
        }
      }
      console.log('   🔍 Odoo not found: ' + (Date.now()-t0) + 'ms');
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
// (#036) Generalizado de 6C20 a la familia 6C** completa: ASENDIA estrenó el
// prefijo 6C21 (2.977 en índice, sustituye a 6C20) y la etiqueta física lleva
// el tracking embebido en un barcode tipo 0059494116C2105248929802250V.
function extractAsendiaTracking(scannedClean) {
  // LS-format: LS + 9 digits + 2 letters (ej: LS226449335CH) -> ES el tracking
  if (/^LS\d{9}[A-Z]{2}$/.test(scannedClean)) {
    return { extracted: scannedClean, isDirectMatch: true };
  }
  // 6C**-format ya como tracking (13 chars: 6C + 11 dígitos) -> ES el tracking
  if (/^6C\d{11}$/.test(scannedClean)) {
    return { extracted: scannedClean, isDirectMatch: true };
  }
  // Barcode/QR largo con 6C embebido -> extraer 6C + 10-11 dígitos.
  // OJO (#036, verificado con etiqueta real DF1441749EU): la etiqueta lleva el
  // tracking SIN dígito de control (12 chars) seguido del código de ruta "802...".
  //  - Barcode %0094140116C2105250900802250 -> greedy extrae 6C21052509008 (el 8
  //    es de la ruta) -> el fallback prefijo-12 lo corrige contra el índice.
  //  - QR ...6C2105250900GEOP... -> extrae los 12 justos -> prefijo-12 directo.
  var m = /6C\d{10,11}/.exec(scannedClean);
  if (m) {
    return { extracted: m[0], isDirectMatch: false };
  }
  return { extracted: null, isDirectMatch: false };
}

// GUARD: detectar barcodes SPRING para evitar que el sliding INPOST los capture.
// SPRING usa GS1-128 con tracking embebido que empieza por 0626, 0008 o 0621 seguido
// de al menos 8 dígitos más. Si el barcode contiene este patrón, NO es INPOST.
// (0621 añadido tras caso DF1333089EU con tracking 06215292478046).
function looksLikeSpringBarcode(clean) {
  if (!/^\d+$/.test(clean)) return false;
  if (clean.length < 14) return false; // tracking SPRING corto puede ser 14 dígitos (0621...)
  return /0626\d{8,}/.test(clean) || /0008\d{8,}/.test(clean) || /0621\d{8,}/.test(clean);
}

// GUARD UNIVERSAL: ¿el barcode numérico tiene patrón de OTRO carrier (no INPOST)?
// Casos detectados que el sliding INPOST capturaba por error:
//   - CRX 23 dígitos `93005001...` (ej. DF126073SF, DF125921SF)
//   - SPRING `0621...` (ej. DF1333089EU con tracking 06215292478046)
//   - CTT `0003...` con 22 dígitos (ej. DF1339988EU con tracking 0003010003019701983513)
// Devuelve el carrier detectado (string) o null si no matchea ningún patrón.
function hasNonInpostNumericPattern(clean) {
  if (!clean || !/^\d+$/.test(clean)) return null;
  // EAN-13 España (#033): los códigos de producto/factura españoles empiezan por 84
  // y sus ventanas de 8 dígitos colisionan con trackings INPOST reales del índice
  // (verificado: 8477128076710 → ventana 84771280 = tracking INPOST real).
  // Ningún carrier usa 13 dígitos numéricos con prefijo 84 → es un producto, no un envío.
  if (clean.length === 13 && /^84/.test(clean)) return 'EAN13_PRODUCTO';
  // (#035) Familias SPRING numéricas NUEVAS (verificadas en índice de producción):
  // 181+15 díg (contienen ventana 81xxxxxx → colisionaban con heurística INPOST;
  // casos operarios CO531753/KA305576/DF1351565EU...), 65480525+16 (24 díg) y
  // 00373165+12 (20 díg). Bloquean el sliding INPOST sobre estos barcodes.
  if (/^181\d{15}$/.test(clean)) return 'SPRING';
  if (/^65480525\d{16}$/.test(clean)) return 'SPRING';
  if (/^00373165\d{12}$/.test(clean)) return 'SPRING';
  // CRX: 23 dígitos con prefijo 9300500
  if (clean.length >= 18 && /^9300500\d/.test(clean)) return 'CORREOS EXPRESS';
  // SPRING: barcodes largos con tracking embebido 0626 / 0008 / 0621 + 8+ dígitos
  if (clean.length >= 14 && /(0626|0008|0621)\d{8,}/.test(clean)) return 'SPRING';
  // CTT: barcode largo con prefijo 0003 + 15+ dígitos más (formato típico 0003010003019701... = 22 dígitos)
  if (clean.length >= 18 && /^0003\d{15,}/.test(clean)) return 'CTT';
  return null;
}

// INPOST: Barcodes largos (todo numérico) contienen tracking de 8 dígitos embebido
// Formato observado:
//   130486133001010401330148898 → tracking = 04861330 (posición 2-10)
//   13083299791010104013        → tracking = 83299791 (posición 3-11)
// La posición exacta del tracking varía según el formato del barcode,
// por eso usamos sliding window que busca cualquier subcadena de 8 dígitos
// que coincida con un tracking INPOST conocido en el índice.
function extractInpostTracking(scannedClean) {
  // Match directo: tracking de 8 dígitos
  if (/^\d{8}$/.test(scannedClean)) {
    return { extracted: scannedClean, isDirectMatch: true };
  }
  if (scannedClean.length >= 10 && /^\d+$/.test(scannedClean)) {
    // GUARD UNIVERSAL: si el barcode tiene patrón de OTRO carrier (CRX/SPRING/CTT/...),
    // NO hacer sliding INPOST — evita falsos positivos donde una ventana de 8 dígitos
    // del barcode coincide por casualidad con un tracking INPOST conocido.
    // Casos cubiertos:
    //   - DF126073SF, DF125921SF (CRX 9300500...) clasificados como INPOST
    //   - DF1289908EU, DF1290868EU, DF1333089EU (SPRING 0621/0626/0008) → INPOST
    //   - DF1339988EU (CTT 0003...) → INPOST
    const otherCarrier = hasNonInpostNumericPattern(scannedClean);
    if (otherCarrier) {
      return { extracted: null, isDirectMatch: false, skipped: 'other-carrier:' + otherCarrier };
    }
    // SLIDING WINDOW: probar todas las posiciones de 8 dígitos consecutivos
    // y verificar si alguna coincide con un INPOST conocido en el índice
    const inpostIndex = trackingIndex && trackingIndex.byCarrier && trackingIndex.byCarrier['INPOST'];
    const byOdoo = trackingIndex && trackingIndex.byOdooTracking;
    const byTrk = trackingIndex && trackingIndex.byTracking;

    for (let i = 0; i <= scannedClean.length - 8; i++) {
      const candidate = scannedClean.substring(i, i + 8);
      // Match exacto en índice INPOST
      if (inpostIndex && inpostIndex[candidate]) {
        return { extracted: candidate, isDirectMatch: false, position: i, source: 'index-inpost' };
      }
      // Match en byOdooTracking con carrier INPOST
      if (byOdoo && byOdoo[candidate] && byOdoo[candidate].carrier === 'INPOST') {
        return { extracted: candidate, isDirectMatch: false, position: i, source: 'index-odoo' };
      }
      // Match en byTracking con carrier INPOST
      if (byTrk && byTrk[candidate] && byTrk[candidate].carrier === 'INPOST') {
        return { extracted: candidate, isDirectMatch: false, position: i, source: 'index-tracking' };
      }
    }

    // Si el barcode contiene patrón INPOST típico (prefijos 04/81/83/84/85 + 6 dígitos)
    // intentar extracción posicional como fallback.
    // (#035) 84/85 añadidos: la numeración INPOST actual empieza por 84/85
    // (verificado en índice de producción: 9.840 trackings, todos 84xx/85xx).
    for (let i = 0; i <= scannedClean.length - 8; i++) {
      const candidate = scannedClean.substring(i, i + 8);
      if (/^(04|81|83|84|85)\d{6}$/.test(candidate)) {
        return { extracted: candidate, isDirectMatch: false, position: i, source: 'prefix' };
      }
    }

    // ELIMINADO el fallback legacy substring(2, 10): causaba falsos positivos
    // para trackings CRX/CORREOS de 23 dígitos como 93005001313132701335831
    // que extraía 00500131 → disparaba búsquedas Odoo innecesarias (~10s)
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
    console.log('   🔍 Patrón GLS extraído (QR): ' + glsMatch[1]);
  }

  // GLS sliding window: buscar Z89 + 5 chars en cualquier posición del barcode
  // Cubre SSCC y otros formatos con tracking GLS embebido (no solo el QR ES...CCE)
  // Ejemplo: 00340014240000Z89TJVNX → Z89TJVNX
  if (!result.detectedCarrier && cleanAlnum.length >= 8) {
    const glsIndex = trackingIndex && trackingIndex.byCarrier && trackingIndex.byCarrier['GLS'];
    const idx = cleanAlnum.indexOf('Z89');
    if (idx >= 0 && cleanAlnum.length >= idx + 8) {
      const candidate = cleanAlnum.substring(idx, idx + 8);
      // Validar formato Z89 + 5 alfanuméricos
      if (/^Z89[A-Z0-9]{5}$/.test(candidate)) {
        // Match exacto en índice GLS, byOdooTracking o byTracking
        const inGls = glsIndex && glsIndex[candidate];
        const inOdoo = trackingIndex && trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[candidate];
        const inTrk = trackingIndex && trackingIndex.byTracking && trackingIndex.byTracking[candidate];
        if (inGls || inOdoo || inTrk) {
          result.patterns.push(candidate);
          result.detectedCarrier = 'GLS';
          console.log('   🔍 Patrón GLS extraído (Z89 sliding): ' + candidate + ' (pos ' + idx + ')');
        } else {
          // Aunque no esté en índice, si el formato encaja añadirlo como candidato
          // para que se busque en Odoo
          result.patterns.push(candidate);
          if (!result.detectedCarrier) result.detectedCarrier = 'GLS';
          console.log('   🔍 Patrón GLS candidato (Z89 sliding, no en índice): ' + candidate);
        }
      }
    }
  }

  // SPRING: Extraer tracking embebido de barcodes GS1-128 largos
  // Ejemplo: %000542106265024593998328040 → tracking: 06265024593998
  // - '0621' añadido (caso DF1341430EU, tracking 06215292484946)
  // - idx >= 0 (el prefijo puede estar en posición 0)
  // - length >= 16 (antes >20, dejaba fuera barcodes cortos)
  // - TODAS las ocurrencias del prefijo (antes solo la primera: un '0626' falso
  //   anterior al real producía substrings erróneos y el match fallaba)
  if (!result.detectedCarrier && cleanAlnum.length >= 16 && /^\d+$/.test(cleanAlnum)) {
    const springPrefixes = ['0626', '0008', '0621'];
    let foundSpring = false;
    for (const prefix of springPrefixes) {
      let idx = cleanAlnum.indexOf(prefix);
      while (idx >= 0) {
        // Extraer substrings de longitudes típicas de tracking SPRING (12-16 chars)
        // Orden: corto→largo para que el match exacto (14 chars) se pruebe antes
        for (var len = 12; len <= 16; len++) {
          if (idx + len <= cleanAlnum.length) {
            result.patterns.push(cleanAlnum.substring(idx, idx + len));
          }
        }
        if (!foundSpring) {
          console.log('   🔍 Patrones SPRING extraídos desde pos ' + idx + ': ' + cleanAlnum.substring(idx, Math.min(idx + 16, cleanAlnum.length)));
        }
        foundSpring = true;
        idx = cleanAlnum.indexOf(prefix, idx + 1);
      }
    }
    if (foundSpring) result.detectedCarrier = 'SPRING';
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
    const t0 = Date.now();
    // Timeout de 2.5s para evitar bloquear escaneos
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(this.config.apiUrl + '/tracking/' + tracking, {
        method: 'GET',
        headers: { 'Authorization': this.authHeader, 'Content-Type': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error('Sendcloud API error: ' + response.status);
      }
      const data = await response.json();
      console.log('   🌐 Sendcloud API: ' + (Date.now()-t0) + 'ms');
      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.warn('   ⏱️ Sendcloud API timeout (2.5s)');
      } else {
        console.error('   ❌ Sendcloud error:', err.message);
      }
      return null;
    }
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
  const t = tracking.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  // CORREOS EXPRESS: prefijo 9300500 característico
  if (/^9300500/.test(t)) return 'CORREOS EXPRESS';
  if (/^H103/.test(t) && carrier === 'SPRING') return 'ASENDIA';
  // 8 dígitos exactos = INPOST (override directo)
  if (/^\d{8}$/.test(t)) return 'INPOST';
  // Barcode largo numérico que CONTIENE un INPOST conocido en el índice
  // Esto previene que se clasifique como CORREOS por colisión accidental.
  // GUARD UNIVERSAL: si el barcode tiene patrón de OTRO carrier (CRX/SPRING/CTT/etc),
  // NO forzar INPOST. Cubre los casos DF126073SF (CRX), DF1333089EU (SPRING 0621),
  // DF1339988EU (CTT 0003), etc.
  if (t.length >= 10 && /^\d+$/.test(t) && !hasNonInpostNumericPattern(t)) {
    const inpostIndex = trackingIndex && trackingIndex.byCarrier && trackingIndex.byCarrier['INPOST'];
    if (inpostIndex) {
      for (let i = 0; i <= t.length - 8; i++) {
        const win = t.substring(i, i + 8);
        if (inpostIndex[win]) return 'INPOST';
      }
    }
  }
  return carrier;
}

// Caché de NEGATIVE LOOKUPS: trackings que ya sabemos que no existen en Odoo.
// Evita repetir búsquedas costosas (3-5s) cuando el mismo tracking se escanea
// varias veces o cuando varios operarios prueban trackings inválidos.
// TTL 5 min para que después del próximo sync se reintente.
const negativeLookupCache = new Map(); // tracking → timestamp
const NEGATIVE_LOOKUP_TTL_MS = 5 * 60 * 1000;

function isNegativeCached(tracking) {
  const ts = negativeLookupCache.get(tracking);
  if (!ts) return false;
  if (Date.now() - ts > NEGATIVE_LOOKUP_TTL_MS) {
    negativeLookupCache.delete(tracking);
    return false;
  }
  return true;
}

function cacheNegativeLookup(tracking) {
  // Limpiar entradas viejas si el cache crece mucho (>10k entries)
  if (negativeLookupCache.size > 10000) {
    const cutoff = Date.now() - NEGATIVE_LOOKUP_TTL_MS;
    for (const [k, v] of negativeLookupCache) {
      if (v < cutoff) negativeLookupCache.delete(k);
    }
  }
  negativeLookupCache.set(tracking, Date.now());
}

// ¿El tracking tiene algún prefijo/formato CONOCIDO de carrier?
// Si no, no tiene sentido buscar en Odoo (devolvemos rápido NO_ENCONTRADO).
function hasKnownCarrierShape(clean) {
  if (!clean) return false;
  // Prefijos directos
  if (/^(PK|MI|Z89|6C\d{2}|H103|6A|LS|LX|LV|LT|3[A-Z]|CP|Z96|XSMT|0008|0626|CTT|EA|C0|9300500)/.test(clean)) return true;
  // AMAZON: ES seguido de exactamente 10 dígitos (ej. ES2527229735)
  if (/^ES\d{10}$/.test(clean)) return true;
  // 8 dígitos exactos → INPOST candidato
  if (/^\d{8}$/.test(clean)) return true;
  // Barcodes numéricos largos (típico GS1) → SPRING/CTT/INPOST embebido
  if (clean.length >= 10 && /^\d+$/.test(clean)) return true;
  // ES...CCE (GLS QR)
  if (/ES[A-Z]\d{2}[A-Z0-9]{5}[A-Z]{2,3}/.test(clean)) return true;
  // Letras de tracking típicas tipo 2-3 letras + 9+ dígitos
  if (/^[A-Z]{1,3}\d{8,}/.test(clean)) return true;
  // PATRONES EMBEBIDOS en barcodes GS1-128 / SSCC largos:
  // ASENDIA (6C** embebido, #036: 10-11 dígitos, la etiqueta omite el check digit),
  // GLS (Z89), ASENDIA H1023 (H103+digits), SPRING (0626/0008 dentro)
  if (clean.length >= 12 && /(6C\d{10}|Z89[A-Z0-9]{5}|H103\d{4}|0626\d{8}|0008\d{8})/.test(clean)) return true;
  return false;
}

async function getCarrierFromTracking(tracking) {
  const startTime = Date.now();
  const clean = tracking.trim().toUpperCase();

  // FAST PATH 1: caché de negative lookups
  if (isNegativeCached(clean)) {
    console.log('   ⚡ Negative cache hit: ' + clean.slice(0, 20) + '... (' + (Date.now() - startTime) + 'ms)');
    return { carrier: null, picking: null, source: 'negative-cache' };
  }

  // FAST PATH 2: si no tiene shape conocido + no está en índice + no en cache, no ir a Odoo
  // Comprobamos primero si está en índice (rápido); si no, comprobamos shape
  const inIdx = trackingIndex && (
    (trackingIndex.byTracking && trackingIndex.byTracking[clean]) ||
    (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[clean.replace(/[^A-Z0-9]/g, '')])
  );
  const inCache = findInSendcloudCache(clean);
  if (!inIdx && !inCache && !hasKnownCarrierShape(clean.replace(/[^A-Z0-9]/g, ''))) {
    cacheNegativeLookup(clean);
    console.log('   ⚡ No carrier shape + no en índice: ' + clean.slice(0, 20) + ' (' + (Date.now() - startTime) + 'ms)');
    return { carrier: null, picking: null, source: 'no_shape' };
  }

  // FAST PATH 3 (#033): MATCH EXACTO ANTES DE CUALQUIER EXTRACCIÓN DE PATRONES.
  // Bug real verificado: trackings SPRING de la familia 00828000828088860... contienen
  // '0008' en posición interior → el extractor GS1 se disparaba ANTES que el match
  // exacto, extraía un prefijo común a toda la familia ('000828088860') y el ilike de
  // Odoo asignaba TODOS los escaneos al MISMO picking equivocado. Un match exacto en
  // el índice es siempre más fiable que un patrón extraído: va primero.
  {
    const cleanAlnum = clean.replace(/[^A-Z0-9]/g, '');
    const exact = (trackingIndex.byTracking && trackingIndex.byTracking[cleanAlnum]) ||
                  (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[cleanAlnum]);
    if (exact && exact.carrier && exact.carrier !== 'DESCONOCIDO' && exact.pickingId) {
      const elapsed = Date.now() - startTime;
      const finalCarrier = overrideCarrier(exact.carrier, exact.odooTracking || cleanAlnum);
      console.log('   ⚡ Match exacto índice (pre-extracción): ' + finalCarrier + ' (' + elapsed + 'ms)');
      return {
        carrier: finalCarrier,
        picking: { id: exact.pickingId, name: exact.pickingName, carrier_tracking_ref: exact.odooTracking, origin: exact.orderRef, partner_id: [null, exact.clientName] },
        source: 'index-exact', elapsed
      };
    }
  }

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
      console.log('   🔍 INPOST extraído de barcode: ' + ipTracking + ' (pos ' + (inpostResult.position || '?') + ', source: ' + (inpostResult.source || '?') + ')');

      // ATAJO CRÍTICO (fix #4): si el sliding YA encontró el match en el índice
      // (source 'index-*'), usar esos datos DIRECTAMENTE sin llamar a Odoo.
      // Antes este código llamaba a findInTrackingIndex(ipTracking) que devuelve
      // null para trackings que solo están en byCarrier (no en byTracking ni
      // byOdooTracking) y caía al fallback de Odoo. Resultado: cada scan INPOST
      // hacía 1-3s de lookup Odoo innecesario → con 5+ operarios concurrentes
      // los timeouts se acumulaban y algún scan fallaba.
      if (inpostResult.source && inpostResult.source.startsWith('index')) {
        let ipData = null;
        if (trackingIndex.byCarrier && trackingIndex.byCarrier['INPOST']) {
          ipData = trackingIndex.byCarrier['INPOST'][ipTracking];
        }
        if (!ipData && trackingIndex.byOdooTracking) ipData = trackingIndex.byOdooTracking[ipTracking];
        if (!ipData && trackingIndex.byTracking) ipData = trackingIndex.byTracking[ipTracking];
        if (ipData) {
          const elapsed = Date.now() - startTime;
          console.log('   ⚡ Índice INPOST (atajo directo): ' + ipTracking + ' (' + elapsed + 'ms)');
          return {
            carrier: 'INPOST',
            picking: {
              id: ipData.pickingId,
              name: ipData.pickingName,
              carrier_tracking_ref: ipData.odooTracking || ipData.tracking || ipTracking,
              origin: ipData.orderRef,
              partner_id: [null, ipData.clientName]
            },
            source: 'index (INPOST extraído: ' + ipTracking + ')', elapsed
          };
        }
      }

      // Si el atajo del índice no aplicó, intentar findInTrackingIndex
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

      // ÚLTIMO RECURSO: solo si el extract NO fue del índice (fallback posicional)
      // y el formato coincide con INPOST (04/81/83 + 6 dígitos), preguntar a Odoo.
      // Antes este branch corría TAMBIÉN cuando fromIndex=true, generando lookups
      // Odoo innecesarios. Ahora solo cuando es un candidato heurístico.
      const looksInpost = /^(04|81|83|84|85)\d{6}$/.test(ipTracking);
      const fromIndexExtract = inpostResult.source && inpostResult.source.startsWith('index');
      if (looksInpost && !fromIndexExtract) {
        console.log('   🔍 Buscando INPOST en Odoo (candidato heurístico): ' + ipTracking);
        const ipPicking = await odooClient.findPickingByTracking(ipTracking);
        // VALIDACIÓN (#033): el ilike de Odoo puede devolver un picking cuyo tracking
        // simplemente CONTIENE los 8 dígitos en cualquier posición (verificado: EAN13
        // de producto '8440456214747' → ventana '04562147' → picking ajeno). Solo
        // aceptar si el tracking del picking ES el candidato o su forma E1+8.
        if (ipPicking) {
          const ipRef = String(ipPicking.carrier_tracking_ref || '').toUpperCase().trim();
          if (ipRef === ipTracking || ipRef === 'E1' + ipTracking) {
            const elapsed = Date.now() - startTime;
            console.log('   ✅ INPOST encontrado en Odoo: ' + (ipPicking.origin || 'sin pedido'));
            return { carrier: 'INPOST', picking: ipPicking, source: 'odoo (INPOST extraído: ' + ipTracking + ')', elapsed };
          }
          console.log('   🚫 Match INPOST débil descartado: picking ' + ipPicking.id + ' ref=' + ipRef + ' ≠ ' + ipTracking);
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
      // VALIDACIÓN (#033): un patrón extraído de una posición interior del barcode
      // puede ser el prefijo común de toda una familia de trackings (verificado:
      // '0008' interior en la familia 00828000828088860...) → el ilike devolvía
      // siempre el mismo picking ajeno. Solo aceptar si el tracking del picking
      // está alineado con el patrón (uno es prefijo del otro).
      if (spPicking) {
        const spRef = String(spPicking.carrier_tracking_ref || '').toUpperCase().trim();
        if (spRef === pat || spRef.startsWith(pat) || pat.startsWith(spRef)) {
          const elapsed = Date.now() - startTime;
          console.log('   ✅ SPRING encontrado en Odoo: ' + (spPicking.origin || 'sin pedido'));
          return { carrier: 'SPRING', picking: spPicking, source: 'odoo (SPRING extraído: ' + pat + ')', elapsed };
        }
        console.log('   🚫 Match SPRING débil descartado: picking ' + spPicking.id + ' ref=' + spRef + ' no alineado con ' + pat);
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

  // 1.5 ATAJO: Si Sendcloud cache tiene el tracking + tenemos el orderId en el índice
  // de pedidos, podemos saltar la búsqueda lenta en Odoo (3-5 segundos)
  const directCache = findInSendcloudCache(clean);
  if (directCache && directCache.carrier && directCache.orderId) {
    const orderRefUpper = directCache.orderId.toUpperCase();
    const byOrderEntries = trackingIndex.byOrderRef && trackingIndex.byOrderRef[orderRefUpper];
    if (byOrderEntries && byOrderEntries.length > 0) {
      const e = byOrderEntries[0];
      const finalCarrier = overrideCarrier(directCache.carrier, clean);
      const elapsed = Date.now() - startTime;
      console.log('   ⚡ Cache+OrderRef: ' + finalCarrier + ' via ' + orderRefUpper + ' (' + elapsed + 'ms)');
      return {
        carrier: finalCarrier,
        picking: { id: e.pickingId, name: e.pickingName, carrier_tracking_ref: e.tracking, origin: orderRefUpper, partner_id: [null, e.clientName] },
        source: 'cache+order', elapsed
      };
    }
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
    const lookupMeta = {};
    picking = await odooClient.findPickingByTracking(clean, lookupMeta);
    if (!picking) {
      // FALLBACK Sendcloud-cache: si el cache tiene carrier+pedido para este
      // tracking (típico picking >14 días fuera del índice, o Odoo caído),
      // devolver el carrier con picking sintético en vez de fallar.
      // Caso real: KA297687 (picking de 14 días, tracking LX071833722NL en
      // cache Sendcloud pero no en índice; Odoo lento → operario bloqueado).
      const dc = findInSendcloudCache(clean);
      if (dc && dc.carrier) {
        const fbCarrier = overrideCarrier(dc.carrier, clean);
        const elapsed = Date.now() - startTime;
        console.log('   🛟 Fallback cache Sendcloud: ' + fbCarrier + ' | pedido: ' + (dc.orderId || '?') + (lookupMeta.timedOut ? ' (Odoo timeout)' : ' (no en Odoo)') + ' (' + elapsed + 'ms)');
        return {
          carrier: fbCarrier,
          picking: {
            id: null,
            name: dc.orderId || null,
            carrier_tracking_ref: dc.tracking || clean,
            origin: dc.orderId || '',
            partner_id: [null, dc.name || '']
          },
          source: 'cache-fallback' + (lookupMeta.timedOut ? '-timeout' : ''),
          elapsed
        };
      }
      // Solo cachear como negativo si Odoo respondió DEFINITIVAMENTE que no existe.
      // Un timeout NO es un "no existe": cachearlo bloqueaba reintentos de
      // trackings válidos durante 5 min ("hay que añadirlo manualmente").
      if (!lookupMeta.timedOut) {
        cacheNegativeLookup(clean);
        return { carrier: null, picking: null, source: 'not_found' };
      }
      console.log('   ⏱️ Odoo timeout sin fallback — NO se cachea negativo (reintentable)');
      return { carrier: null, picking: null, source: 'odoo_timeout' };
    }
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
  if (n.includes('AMAZON'))                                  return 'AMAZON';
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

// Índice compacto para escaneo del lado del cliente (0ms matching)
// Devuelve array compacto [tracking, pickingId, orderRef, clientName, carrier] por entrada
let scanningIndexCacheKey = null;
let scanningIndexJsonCache = null;   // STRING JSON ya serializado (evita re-serializar 2.4MB en cada request)
let scanningIndexGzipCache = null;   // BUFFER gzip pre-comprimido (evita gzipear en cada request)

// Construye (UNA vez) el JSON del índice de escaneo cliente, lo cachea como STRING
// y pre-comprime el gzip. Serializar+comprimir 2.4MB en cada request bloquea el
// event loop de Node; hacerlo una sola vez tras el sync evita ese bloqueo cuando
// muchos operarios abren la app a la vez (causa del "Application failed to respond").
function buildScanningIndexJson() {
  const etag = '"' + (trackingIndex.lastSync || '0') + '-' + (trackingIndex.matched || 0) + '"';
  const entries = [];
  const seen = new Set();
  function addEntry(tracking, data) {
    if (!tracking) return;
    const key = tracking.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push([key, data.pickingId || 0, data.orderRef || '', data.clientName || '', data.carrier || '']);
  }
  for (const [t, data] of Object.entries(trackingIndex.byTracking || {})) addEntry(t, data);
  for (const [t, data] of Object.entries(trackingIndex.byOdooTracking || {})) addEntry(t, data);
  const result = { lastSync: trackingIndex.lastSync, count: entries.length, entries };
  scanningIndexJsonCache = JSON.stringify(result);
  try {
    scanningIndexGzipCache = zlib.gzipSync(scanningIndexJsonCache, { level: 6 });
  } catch (e) {
    scanningIndexGzipCache = null;
    console.error('⚠️ Error pre-gzip índice:', e.message);
  }
  scanningIndexCacheKey = etag;
  const rawKB = Math.round(scanningIndexJsonCache.length / 1024);
  const gzKB = scanningIndexGzipCache ? Math.round(scanningIndexGzipCache.length / 1024) : '?';
  console.log('🧮 Índice de escaneo pre-serializado: ' + entries.length + ' entradas (' + rawKB + ' KB raw / ' + gzKB + ' KB gzip)');
  return etag;
}

app.get('/api/scanning-index', (req, res) => {
  const ifNoneMatch = req.headers['if-none-match'];
  const etag = '"' + (trackingIndex.lastSync || '0') + '-' + (trackingIndex.matched || 0) + '"';

  if (ifNoneMatch === etag) {
    res.status(304).end();
    return;
  }

  // Servir contenido pre-serializado (no re-serializar/re-comprimir: evita bloquear el event loop).
  // Si el cache no existe o el sync cambió, regenerarlo una sola vez.
  if (!scanningIndexJsonCache || scanningIndexCacheKey !== etag) {
    buildScanningIndexJson();
  }

  res.setHeader('ETag', scanningIndexCacheKey);
  // Caché del navegador 30 min: el índice solo cambia con el sync (cada 30 min).
  // Tras expirar, el navegador revalida con ETag (304 si no cambió → respuesta instantánea sin body).
  res.setHeader('Cache-Control', 'public, max-age=1800, must-revalidate');
  res.type('application/json');

  // Si el cliente acepta gzip y tenemos el buffer pre-comprimido, servirlo directamente
  // (bypass del middleware compression → cero CPU de compresión por request).
  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptsGzip && scanningIndexGzipCache) {
    // El middleware compression no recomprime si Content-Encoding ya está seteado.
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return res.end(scanningIndexGzipCache);
  }
  res.send(scanningIndexJsonCache);
});

app.post('/api/reload-index', (req, res) => {
  if (syncInProgress) return res.json({ success: false, message: 'Sync ya en progreso' });
  // ?light=1 para forzar sync ligero; por defecto la recarga MANUAL es completa.
  const full = req.query.light !== '1';
  console.log('🔄 Recarga de índice solicitada (' + (full ? 'completo' : 'ligero') + ')');
  // Fire-and-forget: el sync tarda varios min y el proxy de Railway corta
  // conexiones largas. Respondemos ya y el sync corre detrás.
  runSync({ full });
  res.json({ success: true, started: true, message: 'Sync iniciado en background — consulta /api/index-diagnostic para ver el progreso' });
});

// Stats del histórico (palets/recogidas acumulados)
// El histórico NO se borra nunca - se mantiene íntegro
app.get('/api/history-stats', (req, res) => {
  let totalPackages = 0;
  for (const pallet of Object.values(database.pallets)) {
    totalPackages += (pallet.packages || []).length;
  }
  res.json({
    totalPallets: Object.keys(database.pallets).length,
    totalPackages,
    totalPickups: Object.keys(database.pickups).length,
    totalManifests: Object.keys(database.manifests || {}).length,
    scannedTrackingsCount: globalScannedTrackings.size,
    scannedPickingIdsCount: globalScannedPickingIds.size
  });
});

// Diagnóstico de persistencia: estado del volumen, ficheros y rango de palets.
// Úsalo para confirmar de un vistazo si el volumen está montado y qué días hay.
app.get('/api/persistence-status', (req, res) => {
  const stat = (f) => { try { const s = fs.statSync(f); return { exists: true, sizeMB: +(s.size / 1048576).toFixed(2), mtime: s.mtime.toISOString() }; } catch (_) { return { exists: false }; } };
  let backups = [], corrupt = [];
  try {
    for (const f of fs.readdirSync(VOLUME_PATH)) {
      if (/^data\.backup\.\d{4}-\d{2}-\d{2}\.json(\.gz)?$/.test(f)) backups.push(f);
      if (/^data\.json\.corrupt-\d+$/.test(f)) corrupt.push(f);
    }
  } catch (_) {}
  // Palets por día (para detectar días laborables sin registro)
  const byDay = {};
  for (const p of Object.values(database.pallets)) { const d = p.date || (p.createdAt || '').slice(0, 10); if (d) byDay[d] = (byDay[d] || 0) + 1; }
  const days = Object.keys(byDay).sort();
  res.json({
    volumeMounted: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
    volumePath: VOLUME_PATH,
    dataFile: stat(DATA_FILE),
    backupFile: stat(DATA_FILE + '.bak'),
    dailyBackups: backups.sort(),
    corruptQuarantined: corrupt.sort(),
    pallets: { total: Object.keys(database.pallets).length, firstDay: days[0] || null, lastDay: days[days.length - 1] || null, distinctDays: days.length },
    palletsByDay: byDay
  });
});

// ============================================
// BACKUP / RESTORE (#046) — para migrar de región de Railway sin perder palets
// ============================================
// Backup: descarga el data.json completo (palets/sesiones/recogidas/manifiestos).
// Solo lectura; los mismos datos ya son accesibles por la API abierta, así que
// si ADMIN_TOKEN no está configurado se permite (para poder hacer el backup
// previo a la migración). Si está configurado, se exige token.
app.get('/api/admin/backup-data', (req, res) => {
  if (process.env.ADMIN_TOKEN) {
    const provided = req.query.token || req.headers['x-admin-token'];
    if (provided !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'token inválido' });
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="data-backup-${stamp}.json"`);
  res.setHeader('X-Pallets', String(Object.keys(database.pallets).length));
  res.setHeader('X-Pickups', String(Object.keys(database.pickups).length));
  res.end(JSON.stringify(database));
});

// Restore: sube un data.json y lo escribe en el volumen. SIEMPRE requiere
// ADMIN_TOKEN (sobrescribe TODOS los palets). Guarda el actual antes de pisar.
// Se usa express.raw para aceptar el fichero grande (~40MB) saltando el
// límite global de express.json (10mb). El cliente debe enviarlo con
// Content-Type: application/octet-stream.
app.post('/api/admin/restore-data', express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
  if (!process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'Configura ADMIN_TOKEN en Railway antes de restaurar' });
  const provided = req.query.token || req.headers['x-admin-token'];
  if (provided !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'token inválido' });
  let incoming;
  try { incoming = JSON.parse(req.body.toString('utf8')); }
  catch (e) { return res.status(400).json({ error: 'JSON inválido: ' + e.message }); }
  if (!incoming || typeof incoming !== 'object' || !incoming.pallets) {
    return res.status(400).json({ error: 'data.json inválido (falta "pallets")' });
  }
  // Salvaguarda: copia del actual antes de sobrescribir
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.pre-restore-' + Date.now()); } catch (_) {}
  database = Object.assign({ activeSessions: {}, pallets: {}, pickups: {}, manifests: {} }, incoming);
  saveDataSync();
  try { rebuildGlobalScans(); } catch (_) {}
  console.log('♻️ RESTORE aplicado: ' + Object.keys(database.pallets).length + ' palets, ' + Object.keys(database.pickups).length + ' recogidas');
  res.json({ success: true, pallets: Object.keys(database.pallets).length, pickups: Object.keys(database.pickups).length, manifests: Object.keys(database.manifests || {}).length });
});

// Sesiones
// Sesión agregada (legacy compat): devuelve TODOS los paquetes del carrier combinados
app.get('/api/session/:carrier', (req, res) => {
  const session = getSession(req.params.carrier);
  res.json({ carrier: req.params.carrier.toUpperCase(), packages: session.packages, count: session.packages.length, lastUpdate: session.lastUpdate, sessionsCount: session._sessionsCount || 0 });
});

// Sesiones de un carrier: devuelve TODOS los palets abiertos
app.get('/api/sessions/:carrier', (req, res) => {
  const sessions = getSessionsArray(req.params.carrier);
  res.json({
    carrier: req.params.carrier.toUpperCase(),
    sessions: sessions.map(s => ({
      id: s.id,
      letter: s.letter,
      packages: s.packages,
      count: s.packages.length,
      createdAt: s.createdAt,
      lastUpdate: s.lastUpdate,
      fromPalletId: s.fromPalletId || null
    })),
    totalCount: sessions.reduce((a, s) => a + s.packages.length, 0)
  });
});

// Crear nueva sesión (nuevo palet) para un carrier
app.post('/api/sessions/:carrier/open', (req, res) => {
  const carrier = req.params.carrier.toUpperCase();
  if (!CARRIERS.includes(carrier)) return res.status(400).json({ error: 'Carrier inválido' });
  const newSession = createNewSession(carrier);
  console.log('🆕 Nueva sesión ' + newSession.letter + ' para ' + carrier + ' (id: ' + newSession.id + ')');
  res.json({ success: true, session: { id: newSession.id, letter: newSession.letter, packages: [], count: 0, createdAt: newSession.createdAt } });
});

// Cerrar/eliminar una sesión específica
app.delete('/api/sessions/:carrier/:sessionId', (req, res) => {
  clearSession(req.params.carrier, req.params.sessionId);
  res.json({ success: true, message: 'Sesión eliminada' });
});

// Limpieza inmediata de sesiones vacías del carrier (sin esperar el TTL de 5 min).
// El frontend la invoca al cargar las sesiones para asegurar que el operario no
// vea palets con 0 envíos olvidados de pulsaciones accidentales del botón "+ Nuevo".
app.post('/api/sessions/:carrier/prune-empty', (req, res) => {
  const c = req.params.carrier.toUpperCase();
  const arr = database.activeSessions[c];
  if (!Array.isArray(arr)) return res.json({ pruned: 0 });
  let pruned = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && (!arr[i].packages || arr[i].packages.length === 0)) {
      arr.splice(i, 1);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log('🧹 Sesiones vacías eliminadas (manual): ' + pruned + ' en ' + c);
    saveData();
  }
  res.json({ pruned });
});

app.get('/api/sessions', (req, res) => {
  // Devuelve resumen agregado por carrier (cuenta total + número de palets abiertos)
  const sessions = {};
  for (const carrier of CARRIERS) {
    const arr = getSessionsArray(carrier);
    if (arr.length === 0) continue;
    const totalCount = arr.reduce((a, s) => a + s.packages.length, 0);
    if (totalCount === 0 && arr.length === 0) continue;
    sessions[carrier] = {
      count: totalCount,
      palletCount: arr.length,
      lastUpdate: arr.reduce((m, s) => (!m || s.lastUpdate > m) ? s.lastUpdate : m, null),
      sessions: arr.map(s => ({ id: s.id, letter: s.letter, count: s.packages.length, lastUpdate: s.lastUpdate, fromPalletId: s.fromPalletId || null }))
    };
  }
  res.json({ sessions });
});

app.delete('/api/session/:carrier', (req, res) => {
  // Legacy: limpia TODAS las sesiones del carrier
  clearSession(req.params.carrier);
  res.json({ success: true, message: 'Todas las sesiones de ' + req.params.carrier.toUpperCase() + ' limpiadas' });
});

app.delete('/api/session/:carrier/package/:tracking', (req, res) => {
  // sessionId opcional vía query (?sessionId=...) o body
  const sessionId = req.query.sessionId || (req.body && req.body.sessionId) || null;
  const removed = removePackageFromSession(req.params.carrier, req.params.tracking.toUpperCase(), sessionId);
  res.json({ success: removed, message: removed ? 'Paquete eliminado' : 'Paquete no encontrado' });
});

// Escaneo
app.post('/api/scan', async (req, res) => {
  const { tracking, expectedCarrier, sessionId } = req.body;
  if (!tracking || !expectedCarrier) return res.status(400).json({ error: 'Faltan datos' });

  const clean = tracking.trim().toUpperCase();
  const expected = expectedCarrier.toUpperCase();
  console.log('\n📦 SCAN: ' + clean + ' → ' + expected + (sessionId ? ' (sess ' + sessionId.slice(-8) + ')' : ''));

  // Verificar duplicado en TODAS las sesiones del carrier (no solo la actual)
  const aggregated = getSession(expected);
  if (aggregated.packages.find(p => p.tracking === clean)) {
    return res.json({ success: false, error: 'YA_EN_PALET', message: 'Este paquete YA está en el palet ' + expected + '. Ya está registrado — no hace falta escanearlo otra vez.', tracking: clean });
  }

  // (#039) Códigos de última milla del PARTNER extranjero que NO están en
  // Odoo/Sendcloud y confunden al operario. En vez de mandarle a "buscar por
  // cliente" a ciegas, le decimos EXACTAMENTE qué código escanear:
  //  - CTT Portugal: el barcode de arriba "Cod. Bulto CTT(PT): DS…PT" no está
  //    en el sistema; el que SÍ funciona es el grande "Código Bulto" (0003…).
  if (/^DS\d{6,}PT$/.test(clean)) {
    console.log('   ℹ️ Código CTT-Portugal (partner) — guiar al Código Bulto');
    return res.json({
      success: false,
      error: 'ESCANEA_OTRO_CODIGO',
      detectedCarrier: 'CTT',
      message: 'Etiqueta CTT: el código "DS…PT" es de CTT Portugal y no está en el sistema. Escanea el código de barras grande "Código Bulto" (empieza por 0003…).',
      tracking: clean
    });
  }

  const det = await getCarrierFromTracking(clean);

  if (!det.picking) {
    // Caso especial CRX: detectamos el carrier por prefijo (9300500...) pero
    // el pedido aún no está en Odoo (MIKA actualiza con delay). Mensaje útil:
    if (/^9300500\d/.test(clean)) {
      console.log('   ❌ CRX no sincronizado');
      return res.json({
        success: false,
        error: 'CRX_NO_SINCRONIZADO',
        detectedCarrier: 'CORREOS EXPRESS',
        message: 'Etiqueta CRX detectada. Mira el "ID del pedido" en la etiqueta (13 dígitos junto al barcode) y tipéalo en el buscador.',
        tracking: clean
      });
    }
    // Odoo no respondió a tiempo: el tracking puede ser válido. NO mandar al
    // operario a buscar por cliente — basta reintentar el escaneo en unos segundos.
    if (det.source === 'odoo_timeout') {
      console.log('   ⏱️ Timeout Odoo — pedir reintento');
      return res.json({
        success: false,
        error: 'SISTEMA_LENTO',
        message: 'El sistema está lento. Vuelve a escanear este paquete en unos segundos.',
        tracking: clean
      });
    }
    console.log('   ❌ No existe en Odoo');
    return res.json({ success: false, error: 'NO_ENCONTRADO', message: 'Código no reconocido. En etiquetas internacionales escanea el código de barras ANCHO de abajo, o busca por la Referencia Pedido de la etiqueta (DF…/CO…/KA…).', tracking: clean });
  }

  if (det.carrier && det.carrier !== 'DESCONOCIDO' && det.carrier !== expected) {
    console.log('   ❌ Es ' + det.carrier + ', no ' + expected);
    return res.json({ success: false, error: 'TRANSPORTISTA_INCORRECTO', message: 'Este paquete es de ' + det.carrier + ', no de ' + expected, detectedCarrier: det.carrier });
  }

  if (!det.carrier || det.carrier === 'DESCONOCIDO') {
    console.log('   ⚠️ Carrier no verificado pero usuario eligió ' + expected + ' → permitiendo con confianza');
  }

  // Detectar duplicado por pedido (diferentes barcodes CTT multi-collo, o el
  // mismo pedido añadido antes por búsqueda manual con otra forma del tracking).
  // (#041) Mensaje CLARO: el operario cree que "no funciona" cuando en realidad
  // el pedido YA está en su palet. Le decimos en qué palet (letra) está.
  const orderRef = det.picking.origin || '';
  if (orderRef) {
    let inLetter = null;
    for (const s of getSessionsArray(expected)) {
      if (s.packages.find(p => p.orderRef === orderRef)) { inLetter = s.letter || 'A'; break; }
    }
    if (inLetter) {
      console.log('   ⚠️ Pedido ' + orderRef + ' ya en palet ' + expected + ' (' + inLetter + ')');
      return res.json({
        success: false,
        error: 'YA_EN_PALET',
        message: 'El pedido ' + orderRef + ' YA está en el palet ' + expected + ' (' + inLetter + '). Ya está registrado — no lo escanees otra vez.',
        tracking: clean, orderRef: orderRef, palletLetter: inLetter
      });
    }
  }

  const packageData = { tracking: clean, pickingId: det.picking.id, orderRef: orderRef, clientName: det.picking.partner_id ? det.picking.partner_id[1] : '', scannedAt: new Date().toISOString() };
  const addResult = addPackageToSession(expected, packageData, sessionId);
  if (!addResult.added) {
    return res.json({ success: false, error: 'DUPLICADO', message: 'Ya escaneado en sesión ' + addResult.sessionLetter, tracking: clean });
  }
  const updatedSession = getSession(expected);
  // NO invalidamos el caché aquí: el TTL de 30s + auto-refresh del frontend ya da datos frescos
  // sin penalizar la performance del servidor en cada escaneo

  console.log('   ✅ ' + det.carrier + ' | ' + det.source + ' | ' + (det.elapsed || '?') + 'ms | Pedido: ' + packageData.orderRef);
  res.json({ success: true, tracking: clean, detectedCarrier: det.carrier, package: packageData, sessionCount: updatedSession.packages.length, source: det.source, responseTime: det.elapsed });
});

app.post('/api/add-tracking', async (req, res) => {
  const { tracking, carrier, pickingId, orderRef, clientName, sessionId } = req.body;
  if (!tracking || !carrier) return res.status(400).json({ error: 'Tracking y carrier requeridos' });

  const clean = tracking.trim().toUpperCase();
  const carrierUpper = carrier.toUpperCase();
  const aggregated = getSession(carrierUpper);

  if (aggregated.packages.find(p => p.tracking === clean)) {
    return res.json({ success: false, error: 'DUPLICADO', message: 'Este paquete ya está escaneado' });
  }

  const det = await getCarrierFromTracking(clean);
  if (det.carrier && det.carrier !== 'DESCONOCIDO' && det.carrier !== carrierUpper) {
    return res.json({ success: false, error: 'TRANSPORTISTA_INCORRECTO', message: 'Este paquete es de ' + det.carrier + ', no de ' + carrierUpper, detectedCarrier: det.carrier });
  }

  const packageData = { tracking: clean, pickingId: pickingId || det.picking?.id, orderRef: orderRef || det.picking?.origin || '', clientName: clientName || (det.picking?.partner_id ? det.picking.partner_id[1] : ''), scannedAt: new Date().toISOString(), addedManually: true };
  const addResult = addPackageToSession(carrierUpper, packageData, sessionId);
  if (!addResult.added) {
    return res.json({ success: false, error: 'DUPLICADO', message: 'Ya escaneado en sesión ' + addResult.sessionLetter, tracking: clean });
  }

  const updatedSession = getSession(carrierUpper);
  res.json({ success: true, tracking: clean, carrier: carrierUpper, package: packageData, sessionCount: updatedSession.packages.length, sessionId: addResult.sessionId, sessionLetter: addResult.sessionLetter });
});

app.get('/api/detect-carrier/:tracking', async (req, res) => {
  const result = await getCarrierFromTracking(req.params.tracking.trim());
  res.json({ carrier: result.carrier, picking: result.picking, source: result.source, time: result.elapsed });
});

app.get('/api/search-client/:name', async (req, res) => {
  const searchTerm = req.params.name.trim();
  if (searchTerm.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres' });

  const startTime = Date.now();
  console.log('\n🔎 BÚSQUEDA: "' + searchTerm + '"');
  const isOrderRef = /^(DF|SO|PO|WH|S|CO|KA)\d/i.test(searchTerm);
  // ID del pedido CRX: número de 10-15 dígitos (típico Shopify order id)
  const isCrxOrderId = /^\d{10,15}$/.test(searchTerm);
  const upperTerm = searchTerm.toUpperCase();

  // 1. Buscar primero en el ÍNDICE LOCAL (instantáneo, O(1))
  let indexResults = [];

  // Por ID del pedido CRX (note) — exacto
  if (isCrxOrderId && trackingIndex.byCrxOrderId && trackingIndex.byCrxOrderId[searchTerm]) {
    indexResults = trackingIndex.byCrxOrderId[searchTerm].map(e => ({
      id: e.pickingId,
      name: e.pickingName,
      tracking: null,
      client: e.clientName || 'Sin cliente',
      origin: e.orderRef,
      carrier: e.carrier,
      state: e.state,
      source: 'index-crx-id',
      pendingTracking: e.pendingTracking
    }));
  }

  // Por pedido exacto
  if (indexResults.length === 0 && trackingIndex.byOrderRef && trackingIndex.byOrderRef[upperTerm]) {
    indexResults = trackingIndex.byOrderRef[upperTerm].map(e => ({
      id: e.pickingId,
      name: e.pickingName,
      tracking: e.tracking,
      client: e.clientName || 'Sin cliente',
      origin: upperTerm,
      carrier: e.carrier,
      state: e.state,
      source: 'index'
    }));
  }

  // Por pedido parcial (si no hubo match exacto)
  if (indexResults.length === 0 && isOrderRef && trackingIndex.byOrderRef) {
    for (const ref of Object.keys(trackingIndex.byOrderRef)) {
      if (ref.includes(upperTerm)) {
        for (const e of trackingIndex.byOrderRef[ref]) {
          indexResults.push({
            id: e.pickingId,
            name: e.pickingName,
            tracking: e.tracking,
            client: e.clientName || 'Sin cliente',
            origin: ref,
            carrier: e.carrier,
            state: e.state,
            source: 'index'
          });
        }
        if (indexResults.length >= 20) break;
      }
    }
  }

  // Por cliente (búsqueda parcial)
  if (indexResults.length === 0 && !isOrderRef && trackingIndex.byClientName) {
    const searchLower = searchTerm.toLowerCase();
    for (const clientKey of Object.keys(trackingIndex.byClientName)) {
      if (clientKey.includes(searchLower)) {
        for (const e of trackingIndex.byClientName[clientKey]) {
          indexResults.push({
            id: e.pickingId,
            name: e.pickingName,
            tracking: e.tracking,
            client: clientKey,
            origin: e.orderRef || '',
            carrier: e.carrier,
            source: 'index'
          });
        }
        if (indexResults.length >= 20) break;
      }
    }
  }

  if (indexResults.length > 0) {
    const elapsed = Date.now() - startTime;
    console.log('   ⚡ Índice local: ' + indexResults.length + ' resultados (' + elapsed + 'ms)');
    return res.json({ query: searchTerm, count: indexResults.length, results: indexResults, source: 'index', time: elapsed });
  }

  // 2. Fallback a Odoo (más lento)
  console.log('   🔍 No en índice, buscando en Odoo...');
  let pickings = isOrderRef ? await odooClient.findPickingsByOrderRef(searchTerm) : await odooClient.findPickingsByClientName(searchTerm);
  if (pickings.length === 0) {
    pickings = isOrderRef ? await odooClient.findPickingsByClientName(searchTerm) : await odooClient.findPickingsByOrderRef(searchTerm);
  }

  const results = pickings.map(p => ({
    id: p.id,
    name: p.name,
    tracking: p.carrier_tracking_ref,
    client: p.partner_id ? p.partner_id[1] : 'Sin cliente',
    origin: p.origin,
    date: p.scheduled_date,
    expedited: !!p.manual_expedition_date,
    source: 'odoo'
  }));
  const elapsed = Date.now() - startTime;
  console.log('   ✅ Devolviendo ' + results.length + ' resultados desde Odoo (' + elapsed + 'ms)');
  res.json({ query: searchTerm, count: results.length, results, source: 'odoo', time: elapsed });
});

// Endpoint de diagnóstico - estadísticas detalladas del índice
app.get('/api/index-diagnostic', (req, res) => {
  const byCarrierCount = {};
  for (const [carrier, data] of Object.entries(trackingIndex.byCarrier || {})) {
    byCarrierCount[carrier] = Object.keys(data).length;
  }

  const dupCount = Object.keys(trackingIndex.duplicateTrackings || {}).length;
  const orderRefCount = Object.keys(trackingIndex.byOrderRef || {}).length;
  const clientCount = Object.keys(trackingIndex.byClientName || {}).length;

  // Contar entries DESCONOCIDO
  let desconocidoCount = 0;
  for (const entry of Object.values(trackingIndex.byOdooTracking || {})) {
    if (entry.carrier === 'DESCONOCIDO') desconocidoCount++;
  }

  const age = trackingIndex.lastSync ? Math.round((Date.now() - new Date(trackingIndex.lastSync).getTime()) / 60000) : null;

  res.json({
    lastSync: trackingIndex.lastSync,
    ageMinutes: age,
    totals: {
      odoo: trackingIndex.totalOdoo,
      sendcloud: trackingIndex.totalSendcloud,
      matched: trackingIndex.matched,
      unmatched: trackingIndex.unmatched,
      desconocido: desconocidoCount,
      duplicateTrackings: dupCount,
      indexedOrderRefs: orderRefCount,
      indexedClients: clientCount
    },
    byCarrier: byCarrierCount,
    duplicateSamples: Object.entries(trackingIndex.duplicateTrackings || {}).slice(0, 10).map(([t, n]) => ({ tracking: t, count: n }))
  });
});

// Diagnóstico exhaustivo de un tracking: muestra todo lo que el sistema sabe
// para diagnosticar falsos positivos / no-encontrados (ej: trackings CRX nuevos).
app.get('/api/diag-tracking/:tracking', async (req, res) => {
  const raw = (req.params.tracking || '').trim();
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out = {
    raw, clean,
    prefix: null,
    looksLikeSpring: typeof looksLikeSpringBarcode === 'function' ? looksLikeSpringBarcode(clean) : false,
    inIndex: { byTracking: null, byOdooTracking: null, byCarrier: {} },
    inSendcloudCache: null,
    inSendcloudCacheUpper: null,
    inByOrderRef: null,
    extractInpost: null,
    extractSpecial: null,
    override: null,
    odooLive: null
  };
  // Prefijo simple
  if (/^9300500/.test(clean)) out.prefix = 'CORREOS EXPRESS (9300500)';
  else if (/^MI/.test(clean)) out.prefix = 'CORREOS EXPRESS (MI)';
  else if (/^PK/.test(clean)) out.prefix = 'CORREOS (PK)';
  else if (/^Z89/.test(clean)) out.prefix = 'GLS (Z89)';
  else if (/^6C2[01]/.test(clean)) out.prefix = 'ASENDIA (6C20/6C21)';
  else if (/^H103/.test(clean)) out.prefix = 'ASENDIA (H103)';
  else if (/^ES\d{10}$/.test(clean)) out.prefix = 'AMAZON (ES + 10 dígitos)';
  else if (/^(0626|0008)/.test(clean)) out.prefix = 'SPRING (0626/0008)';
  else if (/^\d{8}$/.test(clean)) out.prefix = 'INPOST (8 dígitos)';
  else if (/^CTT|^EA/.test(clean)) out.prefix = 'CTT';

  // Índice
  if (trackingIndex.byTracking && trackingIndex.byTracking[clean]) out.inIndex.byTracking = trackingIndex.byTracking[clean];
  if (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[clean]) out.inIndex.byOdooTracking = trackingIndex.byOdooTracking[clean];
  if (trackingIndex.byCarrier) {
    for (const c of CARRIERS) {
      if (trackingIndex.byCarrier[c] && trackingIndex.byCarrier[c][clean]) {
        out.inIndex.byCarrier[c] = trackingIndex.byCarrier[c][clean];
      }
    }
  }
  // Cache Sendcloud (directo y upper)
  if (sendcloudCache && sendcloudCache.parcels) {
    if (sendcloudCache.parcels[raw]) out.inSendcloudCache = sendcloudCache.parcels[raw];
    if (sendcloudCacheUpper && sendcloudCacheUpper[clean]) out.inSendcloudCacheUpper = sendcloudCacheUpper[clean];
  }
  // Si encontramos orderId en cache, verificar si está en byOrderRef
  const orderId = (out.inSendcloudCache && out.inSendcloudCache.orderId) || (out.inSendcloudCacheUpper && out.inSendcloudCacheUpper.orderId);
  if (orderId && trackingIndex.byOrderRef) {
    out.inByOrderRef = trackingIndex.byOrderRef[orderId.toUpperCase()] || null;
  }
  // Extracciones especiales
  try { out.extractInpost = extractInpostTracking(clean); } catch {}
  try { out.extractSpecial = extractSpecialPatterns(raw); } catch {}
  // Override
  try { out.override = overrideCarrier((out.inIndex.byTracking && out.inIndex.byTracking.carrier) || null, clean); } catch {}
  // Búsqueda LIVE en Odoo (puede ser lenta, ~2-5s)
  if (req.query.live === '1') {
    try {
      const picking = await odooClient.findPickingByTracking(clean);
      out.odooLive = picking || null;
      // Si hay orderId del cache, buscar también por origin
      if (orderId) {
        const pickingsByOrder = await odooClient.findPickingsByOrderRef(orderId);
        out.odooByOrder = pickingsByOrder.slice(0, 5);
      }
    } catch (err) {
      out.odooLive = { error: err.message };
    }
  }

  // Consulta directa a Sendcloud API por tracking
  if (req.query.sendcloud === '1') {
    try {
      const scData = await sendcloudClient.getParcelByTracking(clean);
      out.sendcloudApi = scData || null;
    } catch (err) {
      out.sendcloudApi = { error: err.message };
    }
  }

  // Buscar parcels en Sendcloud por external_reference (que CRX/MIKA podría usar)
  if (req.query.scExt) {
    try {
      const ext = String(req.query.scExt).trim();
      const url = `${CONFIG.sendcloud.apiUrl}/parcels?external_reference=${encodeURIComponent(ext)}&limit=5`;
      const authHeader = 'Basic ' + Buffer.from(`${CONFIG.sendcloud.publicKey}:${CONFIG.sendcloud.secretKey}`).toString('base64');
      const r = await fetch(url, { headers: { Authorization: authHeader } });
      out.sendcloudByExternal = r.ok ? await r.json() : { error: r.status };
    } catch (err) {
      out.sendcloudByExternal = { error: err.message };
    }
  }

  // Buscar parcels en Sendcloud por shipment_uuid u order_id alterno
  if (req.query.scOrderId) {
    try {
      const oid = String(req.query.scOrderId).trim();
      const url = `${CONFIG.sendcloud.apiUrl}/parcels?order_id=${encodeURIComponent(oid)}&limit=5`;
      const authHeader = 'Basic ' + Buffer.from(`${CONFIG.sendcloud.publicKey}:${CONFIG.sendcloud.secretKey}`).toString('base64');
      const r = await fetch(url, { headers: { Authorization: authHeader } });
      out.sendcloudByOrderId = r.ok ? await r.json() : { error: r.status };
    } catch (err) {
      out.sendcloudByOrderId = { error: err.message };
    }
  }

  // Buscar en Odoo por cualquier campo donde aparezca este id (sale, partner_id, name)
  if (req.query.odooSearch) {
    try {
      const q = String(req.query.odooSearch).trim();
      const out2 = {};
      // Buscar por sale_id (sale_order name)
      try {
        const sales = await odooClient.execute('sale.order', 'search_read', [
          [['name', 'ilike', q]]
        ], { fields: ['id', 'name', 'partner_id', 'state', 'date_order'], limit: 5 });
        out2.byOrderName = sales;
      } catch (e) { out2.byOrderName = { error: e.message }; }
      // Buscar por origin en pickings
      try {
        const picks = await odooClient.execute('stock.picking', 'search_read', [
          [['origin', 'ilike', q]]
        ], { fields: ['id', 'name', 'origin', 'state', 'carrier_id', 'carrier_tracking_ref'], limit: 5 });
        out2.byOrigin = picks;
      } catch (e) { out2.byOrigin = { error: e.message }; }
      // Buscar por carrier_tracking_ref parcial
      try {
        const picks2 = await odooClient.execute('stock.picking', 'search_read', [
          [['carrier_tracking_ref', 'ilike', q]]
        ], { fields: ['id', 'name', 'origin', 'state', 'carrier_id', 'carrier_tracking_ref'], limit: 5 });
        out2.byCarrierTracking = picks2;
      } catch (e) { out2.byCarrierTracking = { error: e.message }; }
      // Buscar por shopify external_id en sale (campo custom?)
      try {
        const sales2 = await odooClient.execute('sale.order', 'search_read', [
          [['client_order_ref', 'ilike', q]]
        ], { fields: ['id', 'name', 'client_order_ref', 'partner_id'], limit: 5 });
        out2.byClientOrderRef = sales2;
      } catch (e) { out2.byClientOrderRef = { error: e.message }; }
      // Probar varios campos custom típicos de Shopify
      const customFields = ['shopify_order_id', 'shopify_id', 'x_shopify_order_id', 'x_studio_shopify_id', 'origin', 'x_studio_id_pedido'];
      out2.customSearches = {};
      for (const f of customFields) {
        try {
          const r = await odooClient.execute('sale.order', 'search_read', [
            [[f, 'ilike', q]]
          ], { fields: ['id', 'name', f, 'partner_id'], limit: 3 });
          if (r && r.length > 0) out2.customSearches[f] = r;
          else out2.customSearches[f] = 'empty';
        } catch (e) { out2.customSearches[f] = 'field_not_exists'; }
      }
      // Buscar también en stock.picking campos custom
      const pickFields = ['x_studio_shopify_id', 'x_shopify_id', 'origin', 'note'];
      out2.pickingCustom = {};
      for (const f of pickFields) {
        try {
          const r = await odooClient.execute('stock.picking', 'search_read', [
            [[f, 'ilike', q]]
          ], { fields: ['id', 'name', f, 'origin'], limit: 3 });
          if (r && r.length > 0) out2.pickingCustom[f] = r;
          else out2.pickingCustom[f] = 'empty';
        } catch (e) { out2.pickingCustom[f] = 'field_not_exists'; }
      }
      out.odooSearch = out2;
    } catch (err) {
      out.odooSearch = { error: err.message };
    }
  }

  // Buscar parcels en Sendcloud por tracking number (no por endpoint /tracking)
  if (req.query.scTrack === '1') {
    try {
      const url = `${CONFIG.sendcloud.apiUrl}/parcels?tracking_number=${encodeURIComponent(clean)}&limit=5`;
      const authHeader = 'Basic ' + Buffer.from(`${CONFIG.sendcloud.publicKey}:${CONFIG.sendcloud.secretKey}`).toString('base64');
      const r = await fetch(url, { headers: { Authorization: authHeader } });
      out.sendcloudByTracking = r.ok ? await r.json() : { error: r.status, statusText: r.statusText };
    } catch (err) {
      out.sendcloudByTracking = { error: err.message };
    }
  }

  // Listar parcels de Sendcloud con order_id que matchee ?scOrder=CO123
  if (req.query.scOrder) {
    try {
      const orderId = String(req.query.scOrder).trim();
      const url = `${CONFIG.sendcloud.apiUrl}/parcels?order_number=${encodeURIComponent(orderId)}&limit=10`;
      const authHeader = 'Basic ' + Buffer.from(`${CONFIG.sendcloud.publicKey}:${CONFIG.sendcloud.secretKey}`).toString('base64');
      const r = await fetch(url, { headers: { Authorization: authHeader } });
      out.sendcloudByOrder = r.ok ? await r.json() : { error: r.status };
    } catch (err) {
      out.sendcloudByOrder = { error: err.message };
    }
  }

  // Listar pickings recientes con carrier MIKA (CRX) para investigar formato del tracking
  if (req.query.listCrx === '1') {
    try {
      const dateFilter = new Date(Date.now() - 3*24*60*60*1000).toISOString().split('T')[0];
      const pickings = await odooClient.execute('stock.picking', 'search_read', [
        [['carrier_id.name', 'ilike', 'mika'], ['scheduled_date', '>=', dateFilter], ['picking_type_code', '=', 'outgoing']]
      ], { fields: ['id', 'name', 'carrier_tracking_ref', 'origin', 'state', 'carrier_id', 'scheduled_date', 'note'], limit: 20, order: 'scheduled_date desc' });
      out.crxRecent = pickings;
    } catch (err) {
      out.crxRecent = { error: err.message };
    }
  }

  // Búsqueda Odoo SIN filtros (state cualquiera, sin scheduled_date) por origin si pasan ?odooOrigin=ORDER
  if (req.query.odooOrigin) {
    try {
      const origin = String(req.query.odooOrigin).trim();
      const pickings = await odooClient.execute('stock.picking', 'search_read', [
        [['origin', 'ilike', origin]]
      ], { fields: ['id', 'name', 'carrier_tracking_ref', 'partner_id', 'origin', 'scheduled_date', 'state', 'carrier_id', 'picking_type_id', 'note'], limit: 20 });
      out.odooByOriginUnfiltered = pickings;
    } catch (err) {
      out.odooByOriginUnfiltered = { error: err.message };
    }
  }
  res.json(out);
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
  const { carrier, sessionId, clientPackages } = req.body;
  if (!carrier) return res.status(400).json({ error: 'Carrier requerido' });

  const carrierUpper = carrier.toUpperCase();
  const sessions = getSessionsArray(carrierUpper);

  // Si nos pasan sessionId, cerrar solo esa sesión. Si no, cerrar la primera (compat).
  let targetSession;
  if (sessionId) {
    targetSession = sessions.find(s => s.id === sessionId);
  } else {
    targetSession = sessions[0];
  }

  // RECONCILIACIÓN ANTI-PÉRDIDA (#038): el cliente envía su lista local de
  // paquetes al cerrar. Cualquiera que no esté ya en la sesión del servidor
  // (p.ej. su POST /scan no llegó a persistir por un 502) se añade AQUÍ antes
  // de crear el palet. Así ningún paquete escaneado se pierde al cerrar.
  let reconciled = 0;
  if (Array.isArray(clientPackages) && clientPackages.length > 0) {
    if (!targetSession) targetSession = createNewSession(carrierUpper);
    const existing = new Set(targetSession.packages.map(p => (p.tracking || '').toUpperCase().trim()));
    for (const cp of clientPackages) {
      const trk = String(cp && cp.tracking || '').toUpperCase().trim();
      if (!trk || existing.has(trk)) continue;
      const pkg = {
        tracking: trk,
        pickingId: cp.pickingId || null,
        orderRef: cp.orderRef && cp.orderRef !== '…' ? cp.orderRef : '',
        clientName: cp.clientName && cp.clientName !== 'Procesando…' ? cp.clientName : '',
        scannedAt: cp.scannedAt || new Date().toISOString(),
        reconciledAtClose: true
      };
      targetSession.packages.push(pkg);
      _addPackageToGlobalSets(pkg);
      existing.add(trk);
      reconciled++;
    }
    if (reconciled > 0) { targetSession.lastUpdate = new Date().toISOString(); saveData(); console.log('   🛟 Reconciliados ' + reconciled + ' paquetes del cliente al cerrar (no perdidos por 502)'); }
  }

  if (!targetSession) return res.status(404).json({ error: 'Sesión no encontrada' });
  if (!targetSession.packages || targetSession.packages.length === 0) {
    return res.status(400).json({ error: 'No hay paquetes para crear el palet' });
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const count = Object.keys(database.pallets).filter(id => id.startsWith(carrierUpper + '-' + dateStr)).length + 1;
  const palletId = carrierUpper + '-' + dateStr + '-' + String(count).padStart(3, '0');

  const pallet = {
    id: palletId,
    carrier: carrierUpper,
    packages: [...targetSession.packages],
    trackings: targetSession.packages.map(p => p.tracking),
    totalPackages: targetSession.packages.length,
    createdAt: now.toISOString(),
    date: now.toISOString().split('T')[0],
    status: 'pending',
    sessionLetter: targetSession.letter || 'A'
  };

  database.pallets[palletId] = pallet;
  clearSession(carrierUpper, targetSession.id);
  console.log('\n📦 PALET CREADO: ' + palletId + ' (Sesión ' + (targetSession.letter || 'A') + ') - ' + pallet.totalPackages + ' paquetes');
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

// Reabrir un palet cerrado: crea una nueva sesión activa con sus paquetes
app.post('/api/pallets/:id/reopen', (req, res) => {
  const palletId = req.params.id;
  const pallet = database.pallets[palletId];
  if (!pallet) return res.status(404).json({ error: 'Palet no encontrado' });

  if (pallet.status === 'picked_up') {
    return res.status(400).json({ error: 'No se puede reabrir un palet ya recogido' });
  }

  const carrierUpper = (pallet.carrier || '').toUpperCase();
  if (!CARRIERS.includes(carrierUpper)) {
    return res.status(400).json({ error: 'Carrier inválido en el palet' });
  }

  // Verificar duplicados contra otras sesiones abiertas (no debería pasar, pero por seguridad)
  const existingSessions = getSessionsArray(carrierUpper);
  const trackingsInOtherSessions = new Set();
  for (const s of existingSessions) {
    for (const p of s.packages) trackingsInOtherSessions.add(p.tracking);
  }

  // Filtrar paquetes que NO estén en sesiones abiertas (evita doble conteo)
  const packagesToRestore = (pallet.packages || []).filter(p => !trackingsInOtherSessions.has(p.tracking));

  // Crear nueva sesión con los paquetes restaurados
  const newSession = createNewSession(carrierUpper, {
    packages: packagesToRestore,
    fromPalletId: palletId
  });

  // Reconstruir Sets globales (los trackings ya estaban allí, pero por consistencia)
  rebuildGlobalScans();

  // Marcar el palet como reabierto en el histórico para audit trail
  pallet.status = 'reopened';
  pallet.reopenedAt = new Date().toISOString();
  pallet.reopenedToSessionId = newSession.id;
  pallet.reopenedToSessionLetter = newSession.letter;

  // Guardar también el conteo original para referencia
  if (!pallet.originalTotalPackages) pallet.originalTotalPackages = pallet.totalPackages;

  saveData();

  console.log('\n🔄 PALET REABIERTO: ' + palletId + ' → Sesión ' + newSession.letter + ' (' + carrierUpper + ') con ' + packagesToRestore.length + ' paquetes');

  res.json({
    success: true,
    carrier: carrierUpper,
    sessionId: newSession.id,
    sessionLetter: newSession.letter,
    packages: newSession.packages,
    count: newSession.packages.length,
    originalPalletId: palletId,
    skipped: (pallet.packages || []).length - packagesToRestore.length
  });
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
  
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Manifiesto ' + pickup.id + '</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;padding:20px;max-width:210mm;margin:0 auto}.header{border-bottom:3px solid #000;padding-bottom:15px;margin-bottom:20px}.company{font-size:22px;font-weight:bold}.company-address{font-size:12px;color:#666;margin-top:5px}.title{font-size:20px;margin-top:10px;color:#333}.carrier-badge{display:inline-block;background:#000;color:#fff;padding:8px 20px;font-size:18px;font-weight:bold;margin-top:10px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:20px 0;padding:15px;background:#f5f5f5}.info-item{font-size:14px}.info-item .label{color:#666;font-size:12px}.info-item .value{font-size:18px;font-weight:bold}.summary{display:flex;justify-content:space-around;background:#e0e0e0;padding:15px;margin:20px 0}.summary-item{text-align:center}.summary-item .number{font-size:32px;font-weight:bold}.summary-item .text{font-size:12px;color:#666}.pallet-section{margin:20px 0;border:1px solid #ccc}.pallet-header{background:#333;color:#fff;padding:10px 15px;display:flex;justify-content:space-between}.packages-table{width:100%;border-collapse:collapse;font-size:12px}.packages-table th{background:#f0f0f0;padding:8px;text-align:left;border-bottom:2px solid #ccc}.packages-table td{padding:6px 8px;border-bottom:1px solid #eee}.packages-table .tracking{font-family:monospace;font-weight:bold}.signature-section{margin-top:30px;padding:20px;border:2px solid #000}.signature-section h3{margin-bottom:10px}.signature-section.signed{background:#f0fff0;border-color:#22c55e}.signature-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:15px}.signature-box{text-align:center}.signature-box .label{font-size:12px;color:#666;margin-bottom:10px;font-weight:bold}.signature-canvas{border:1px solid #000;width:100%;height:120px;touch-action:none;background:#fff}.signature-img{border:1px solid #ccc;max-width:100%;height:120px;object-fit:contain}.clear-btn{margin-top:5px;padding:5px 15px;font-size:12px;cursor:pointer}.signer-input{width:100%;padding:8px;margin-top:8px;border:1px solid #ccc;font-size:14px}.signer-name{font-weight:bold;margin-top:10px}.signer-dni{font-size:12px;color:#666}.sign-btn{width:100%;padding:15px;margin-top:20px;background:#22c55e;color:white;border:none;font-size:18px;font-weight:bold;cursor:pointer}.sign-btn:hover{background:#16a34a}.sign-btn:disabled{background:#ccc;cursor:not-allowed}@media print{.no-print{display:none!important}.signature-section{page-break-inside:avoid}.signature-canvas{display:none}.packages-table thead{display:table-header-group}.packages-table tr{page-break-inside:avoid}.pallet-section{page-break-inside:auto}body{padding:0;max-width:none}.signature-img{display:block}}.action-buttons{position:fixed;bottom:20px;right:20px;display:flex;gap:10px;z-index:100}.action-btn{padding:15px 25px;background:#000;color:#fff;border:none;font-size:16px;cursor:pointer;border-radius:8px}.action-btn:hover{background:#333}.action-btn.download{background:#2563eb}.action-btn.download:hover{background:#1d4ed8}</style></head><body><div class="action-buttons no-print"><button class="action-btn" onclick="window.print()">🖨 Imprimir</button><button class="action-btn download" onclick="downloadPDF()" title="En el diálogo, elige destino Guardar como PDF">📄 Descargar PDF</button></div><div id="manifest-content"><div class="header"><div class="company">Illice Brands Group - White Division</div><div class="company-address">Calle Moros y Cristianos 10, Albatera, España</div><div class="title">MANIFIESTO DE RECOGIDA</div><div class="carrier-badge">' + pickup.carrier + '</div></div><div class="info-grid"><div class="info-item"><div class="label">FECHA</div><div class="value">' + dateStr + '</div></div><div class="info-item"><div class="label">HORA</div><div class="value">' + timeStr + '</div></div><div class="info-item"><div class="label">ID RECOGIDA</div><div class="value">' + pickup.id + '</div></div><div class="info-item"><div class="label">TRANSPORTISTA</div><div class="value">' + pickup.carrier + '</div></div></div><div class="summary"><div class="summary-item"><div class="number">' + pickup.totalPallets + '</div><div class="text">PALETS</div></div><div class="summary-item"><div class="number">' + pickup.totalPackages + '</div><div class="text">ENVÍOS TOTALES</div></div></div>' + palletsHtml + signatureSection + '</div><script>const canvases={};const contexts={};function initCanvas(id){const canvas=document.getElementById(id);if(!canvas)return;canvases[id]=canvas;contexts[id]=canvas.getContext("2d");canvas.width=canvas.offsetWidth;canvas.height=canvas.offsetHeight;let isDrawing=false;let lastX=0;let lastY=0;function getPos(e){const rect=canvas.getBoundingClientRect();const x=(e.touches?e.touches[0].clientX:e.clientX)-rect.left;const y=(e.touches?e.touches[0].clientY:e.clientY)-rect.top;return{x,y}}function startDrawing(e){isDrawing=true;const pos=getPos(e);lastX=pos.x;lastY=pos.y}function draw(e){if(!isDrawing)return;e.preventDefault();const pos=getPos(e);const ctx=contexts[id];ctx.beginPath();ctx.moveTo(lastX,lastY);ctx.lineTo(pos.x,pos.y);ctx.strokeStyle="#000";ctx.lineWidth=2;ctx.lineCap="round";ctx.stroke();lastX=pos.x;lastY=pos.y}function stopDrawing(){isDrawing=false}canvas.addEventListener("mousedown",startDrawing);canvas.addEventListener("mousemove",draw);canvas.addEventListener("mouseup",stopDrawing);canvas.addEventListener("mouseout",stopDrawing);canvas.addEventListener("touchstart",startDrawing);canvas.addEventListener("touchmove",draw);canvas.addEventListener("touchend",stopDrawing)}function clearSignature(id){const canvas=canvases[id];const ctx=contexts[id];if(canvas&&ctx)ctx.clearRect(0,0,canvas.width,canvas.height)}function isCanvasBlank(id){const canvas=canvases[id];if(!canvas)return true;const ctx=contexts[id];const pixelBuffer=new Uint32Array(ctx.getImageData(0,0,canvas.width,canvas.height).data.buffer);return!pixelBuffer.some(color=>color!==0)}async function signManifest(){const warehouseName=document.getElementById("warehouseName")?.value||"";const driverName=document.getElementById("driverName")?.value||"";const driverDNI=document.getElementById("driverDNI")?.value||"";if(!driverName||!driverDNI){alert("Por favor, introduce el nombre y DNI del transportista");return}if(isCanvasBlank("driverSignature")){alert("Por favor, el transportista debe firmar");return}const warehouseSignature=canvases["warehouseSignature"]?.toDataURL()||"";const driverSignature=canvases["driverSignature"]?.toDataURL()||"";const btn=document.getElementById("signBtn");btn.disabled=true;btn.textContent="Guardando...";try{const response=await fetch("/api/manifest/' + pickup.id + '/sign",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({warehouseName,warehouseSignature,driverName,driverDNI,driverSignature})});const result=await response.json();if(result.success){alert("Manifiesto firmado correctamente");location.reload()}else{alert("Error: "+result.error);btn.disabled=false;btn.textContent="FIRMAR Y GUARDAR MANIFIESTO"}}catch(err){alert("Error de conexión");btn.disabled=false;btn.textContent="FIRMAR Y GUARDAR MANIFIESTO"}}if(document.getElementById("warehouseSignature")){initCanvas("warehouseSignature");initCanvas("driverSignature")}function downloadPDF(){window.print()}</script></body></html>');
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

// Caché del informe: se invalida cada 30 segundos
const odooOutsCache = new Map();
const ODOO_OUTS_TTL = 30000; // 30 segundos

app.get('/api/odoo-outs', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Parámetros from y to requeridos (YYYY-MM-DD)' });

  // Cache hit: si tenemos resultado fresco para este rango, devolverlo
  const cacheKey = from + '|' + to;
  const cached = odooOutsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < ODOO_OUTS_TTL) {
    console.log('📊 ODOO-OUTS cache hit: ' + from + ' → ' + to + ' (age ' + ((Date.now() - cached.timestamp)/1000).toFixed(1) + 's)');
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached.data);
  }

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

    // ⚡ OPTIMIZACIÓN: Usar los Sets PRECOMPUTADOS globales
    // (antes iteraba 185k+ paquetes en cada llamada, ahora es O(1))
    const scannedTrackings = globalScannedTrackings;
    const scannedPickingIds = globalScannedPickingIds;

    // Reconstruir extractedOdooTrackings con patrones embebidos
    // Esta parte sí itera sobre los Sets, pero los Sets ya están construidos
    const extractedOdooTrackings = globalExtractedTrackings;

    // Matching avanzado: patrones extraídos + substring (devuelve el tipo de match)
    function matchAdvanced(odooTracking) {
      if (!odooTracking || odooTracking.length < 7) return null;
      const clean = odooTracking.toUpperCase().replace(/[^A-Z0-9]/g, '');
      // 1. Check si el tracking de Odoo está entre los extractedOdooTrackings (O(1))
      if (extractedOdooTrackings.has(clean)) return 'extractedTracking';
      // 2. Substring: solo iteramos los barcodes "largos" (>=15 chars) precomputados
      // (la gran mayoría de barcodes son cortos y se descartan en el precómputo)
      if (clean.length >= 7) {
        for (const scannedClean of globalLongScannedBarcodes) {
          if (scannedClean.includes(clean)) return 'substring';
        }
      }
      return null;
    }

    console.log('   🔍 Trackings en app: ' + scannedTrackings.size + ' | PickingIDs: ' + scannedPickingIds.size + ' | Extracted patterns: ' + extractedOdooTrackings.size);

    // (#034) Clasificación de los NO escaneados por estado Sendcloud (del índice, O(1)):
    //  - pendiente:       aún en almacén (Ready to send / Announced) → escaneable todavía
    //  - fugado:          ya en tránsito/entregado → salió SIN pasar por la app (pérdida real)
    //  - sin_seguimiento: ASENDIA (no reporta estados a Sendcloud, su "Ready to send" es perpetuo)
    //  - sin_datos:       tracking sin parcel en el índice/Sendcloud
    const PENDING_STATUSES = new Set(['READY TO SEND', 'ANNOUNCED', 'BEING ANNOUNCED', 'ANNOUNCEMENT FAILED']);
    function classifyMissing(carrierKey, trackingRef) {
      if (!trackingRef) return { scStatus: null, missingKind: 'sin_datos' };
      const tc = trackingRef.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const e = (trackingIndex.byTracking && trackingIndex.byTracking[tc]) ||
                (trackingIndex.byOdooTracking && trackingIndex.byOdooTracking[tc]);
      const st = e && e.sendcloudData && e.sendcloudData.status ? String(e.sendcloudData.status) : null;
      if (!st) return { scStatus: null, missingKind: 'sin_datos' };
      const isPending = PENDING_STATUSES.has(st.toUpperCase());
      if (carrierKey === 'ASENDIA' && isPending) return { scStatus: st, missingKind: 'sin_seguimiento' };
      return { scStatus: st, missingKind: isPending ? 'pendiente' : 'fugado' };
    }
    const missingBreakdown = { pendiente: 0, fugado: 0, sin_seguimiento: 0, sin_datos: 0 };

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
        else if (/^9300500/.test(t)) carrier = 'CORREOS EXPRESS';
        else if (/^Z89/.test(t)) carrier = 'GLS';
        else if (/^6C2[01]/.test(t)) carrier = 'ASENDIA'; // (#036) 6C21 = familia nueva; 6C16 NO (Sendcloud la clasifica SPRING)
        else if (/^H103/.test(t)) carrier = 'ASENDIA';
        else if (/^6A/.test(t)) carrier = 'SPRING';
        else if (/^LS\d{9}[A-Z]{2}$/.test(t)) carrier = 'ASENDIA';
        else if (/^LS|^LX|^LV|^LT|^3[A-Z]|^CP|^Z96|^XSMT|^0008|^0626/.test(t)) carrier = 'SPRING';
        else if (/^181\d{15}$/.test(t) || /^65480525\d{16}$/.test(t) || /^00373165\d{12}$/.test(t)) carrier = 'SPRING'; // (#035) familias numéricas nuevas
        else if (/^CTT|^EA/.test(t)) carrier = 'CTT';
        else if (/^C0/.test(t)) carrier = 'CORREOS';
        else if (/^\d{8}$/.test(t)) carrier = 'INPOST';
        else if (/^ES\d{10}$/.test(t)) carrier = 'AMAZON';
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
      // (#034) Estado Sendcloud de los no escaneados: pendiente vs fugado
      let scStatus = null, missingKind = null;
      if (!isScanned) {
        const cls = classifyMissing(key, picking.carrier_tracking_ref);
        scStatus = cls.scStatus; missingKind = cls.missingKind;
        missingBreakdown[missingKind]++;
        byCarrier[key].missingKinds = byCarrier[key].missingKinds || { pendiente: 0, fugado: 0, sin_seguimiento: 0, sin_datos: 0 };
        byCarrier[key].missingKinds[missingKind]++;
      }
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
        matchSource: matchSource,
        scStatus:    scStatus,
        missingKind: missingKind
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

    // (#034) Cobertura efectiva: excluye del denominador los que AÚN están en
    // almacén (pendientes) — mide lo que de verdad salió sin escanear.
    const stillPending = missingBreakdown.pendiente;
    const effDenom = totalAll - stillPending;
    const response = {
      from, to,
      total:    totalAll,
      scanned:  totalScanned,
      missing:  totalAll - totalScanned,
      coverage: totalAll > 0 ? Math.min(100, (totalScanned / totalAll) * 100) : 0,
      missingBreakdown,
      effectiveCoverage: effDenom > 0 ? Math.min(100, (totalScanned / effDenom) * 100) : 0,
      byCarrier: summary
    };

    // Guardar en caché para respuestas instantáneas en los próximos 30s
    odooOutsCache.set(cacheKey, { data: response, timestamp: Date.now() });
    // Limpiar caché viejo (evitar fugas de memoria)
    if (odooOutsCache.size > 50) {
      const oldestKey = odooOutsCache.keys().next().value;
      odooOutsCache.delete(oldestKey);
    }

    res.setHeader('X-Cache', 'MISS');
    res.json(response);

  } catch (err) {
    console.error('   ❌ Error:', err.message);
    res.status(500).json({ error: 'Error consultando Odoo: ' + err.message });
  }
});

// Invalidar caché cuando hay un escaneo nuevo
function invalidateOdooOutsCache() {
  if (odooOutsCache.size > 0) {
    odooOutsCache.clear();
  }
}

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
  
  const indexLoaded = await loadTrackingIndex();
  // Pre-serializar el índice de escaneo cliente al arrancar (evita que la 1ª
  // request del día bloquee el event loop serializando el índice).
  if (indexLoaded) {
    try { buildScanningIndexJson(); } catch (e) { console.error('⚠️ Error pre-serializando índice al arrancar:', e.message); }
  }

  try { const uid = await odooClient.authenticate(); console.log('✅ Odoo conectado (UID: ' + uid + ')'); }
  catch (err) { console.log('❌ Error Odoo:', err.message); }
  
  console.log('🔑 Sendcloud configurado');
  console.log('📊 Palets en memoria: ' + Object.keys(database.pallets).length);
  console.log('📋 Recogidas en memoria: ' + Object.keys(database.pickups).length);
  
  setupScheduledSync();
  
  if (!indexLoaded || !trackingIndex.lastSync) {
    console.log('\n⏳ Auto-sync inicial (completo) programado en 10 segundos...');
    setTimeout(() => { console.log('\n🚀 Ejecutando auto-sync inicial...'); runSync({ full: true }); }, 10000);
  } else {
    const ageHours = (Date.now() - new Date(trackingIndex.lastSync).getTime()) / 3600000;
    if (ageHours > 4) {
      console.log('\n⏳ Índice antiguo (' + Math.round(ageHours) + 'h), auto-sync completo en 10 segundos...');
      setTimeout(() => runSync({ full: true }), 10000);
    }
  }
});


