const express = require('express');
const cors = require('cors');
const xmlrpc = require('xmlrpc');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Para las firmas en base64

// ============================================
// CONFIGURACIÓN (variables de entorno o valores por defecto)
// ============================================
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

// Archivo de persistencia
const DATA_FILE = path.join(__dirname, 'data.json');

// Servir frontend estático (carpeta public en Railway)
const FRONTEND_DIR = path.join(__dirname, 'public');
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// ============================================
// MAPEO DE TRANSPORTISTAS SENDCLOUD
// ============================================
const SENDCLOUD_CARRIER_MAP = {
  'correos': 'CORREOS',
  'correos_express': 'CORREOS',
  'correos_de_espana': 'CORREOS',
  'ctt': 'CTT',
  'ctt_express': 'CTT',
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

const CARRIERS = ['ASENDIA', 'CORREOS', 'CTT', 'GLS', 'INPOST', 'SPRING'];

// ============================================
// BASE DE DATOS CON PERSISTENCIA
// ============================================
let database = {
  activeSessions: {},
  pallets: {},
  pickups: {},
  manifests: {} // Manifiestos firmados
};

// Cargar datos al iniciar
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      database = JSON.parse(data);
      console.log('📂 Datos cargados desde archivo');
    }
  } catch (err) {
    console.error('Error cargando datos:', err.message);
  }
}

// Guardar datos
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(database, null, 2));
  } catch (err) {
    console.error('Error guardando datos:', err.message);
  }
}

// Cargar al iniciar
loadData();

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

  async findPickingByTracking(tracking) {
    try {
      const pickings = await this.execute('stock.picking', 'search_read', [[['carrier_tracking_ref', 'ilike', tracking]]], { 
        fields: ['id', 'name', 'carrier_tracking_ref', 'manual_expedition_date', 'state', 'partner_id', 'origin'], 
        limit: 1 
      });
      return pickings[0] || null;
    } catch { return null; }
  }

  async findPickingsByClientName(clientName, limit = 15) {
    try {
      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
      const dateFilter = fiveDaysAgo.toISOString().split('T')[0];
      
      const pickings = await this.execute('stock.picking', 'search_read', [
        [
          ['partner_id.name', 'ilike', clientName],
          ['state', '=', 'done'],
          ['picking_type_code', '=', 'outgoing'],
          ['carrier_tracking_ref', '!=', false],
          ['scheduled_date', '>=', dateFilter]
        ]
      ], { 
        fields: ['id', 'name', 'carrier_tracking_ref', 'partner_id', 'origin', 'scheduled_date', 'manual_expedition_date'],
        order: 'scheduled_date desc',
        limit: limit
      });
      return pickings;
    } catch (err) {
      console.error('Error buscando por cliente:', err.message);
      return [];
    }
  }

  async updateExpeditionDate(pickingIds, date) {
    return await this.execute('stock.picking', 'write', [pickingIds, { manual_expedition_date: date }]);
  }
}

const odooClient = new OdooClient(CONFIG.odoo);

// ============================================
// CLIENTE SENDCLOUD
// ============================================
class SendcloudClient {
  constructor(config) {
    this.config = config;
    this.authHeader = 'Basic ' + Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');
  }

  async getParcelByTracking(tracking) {
    try {
      const response = await fetch(`${this.config.apiUrl}/tracking/${tracking}`, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Sendcloud API error: ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      console.error('   ❌ Sendcloud error:', err.message);
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
// FUNCIONES AUXILIARES
// ============================================

function getSession(carrier) {
  const carrierUpper = carrier.toUpperCase();
  if (!database.activeSessions[carrierUpper]) {
    database.activeSessions[carrierUpper] = {
      packages: [],
      lastUpdate: new Date().toISOString()
    };
  }
  return database.activeSessions[carrierUpper];
}

function addPackageToSession(carrier, packageData) {
  const session = getSession(carrier);
  const exists = session.packages.find(p => p.tracking === packageData.tracking);
  if (exists) return { added: false, reason: 'duplicate' };
  
  session.packages.push(packageData);
  session.lastUpdate = new Date().toISOString();
  saveData();
  return { added: true };
}

function clearSession(carrier) {
  const carrierUpper = carrier.toUpperCase();
  database.activeSessions[carrierUpper] = {
    packages: [],
    lastUpdate: new Date().toISOString()
  };
  saveData();
}

async function getCarrierFromTracking(tracking) {
  const picking = await odooClient.findPickingByTracking(tracking);
  
  if (!picking) {
    return { carrier: null, picking: null, source: 'not_found' };
  }

  const sendcloudData = await sendcloudClient.getParcelByTracking(tracking);
  
  if (sendcloudData && sendcloudData.carrier_code) {
    const carrier = sendcloudClient.normalizeCarrier(sendcloudData.carrier_code);
    return { carrier, picking, source: 'sendcloud' };
  }

  return { carrier: null, picking, source: 'no_sendcloud' };
}

// Generar ID de recogida legible
function generatePickupId(carrier) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const todayPickups = Object.keys(database.pickups).filter(id => id.includes(dateStr) && id.startsWith(carrier));
  const count = todayPickups.length + 1;
  return `${carrier}-REC-${dateStr}-${String(count).padStart(3, '0')}`;
}

// ============================================
// ENDPOINTS API
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/carriers', (req, res) => {
  res.json({ carriers: CARRIERS });
});

app.get('/api/test-odoo', async (req, res) => {
  try {
    const uid = await odooClient.authenticate();
    res.json({ success: true, uid });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/test-sendcloud', async (req, res) => {
  try {
    const response = await fetch(`${CONFIG.sendcloud.apiUrl}/user`, {
      method: 'GET',
      headers: {
        'Authorization': sendcloudClient.authHeader,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      res.json({ success: true, user: data });
    } else {
      res.json({ success: false, error: `HTTP ${response.status}` });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// SESIONES
// ============================================

app.get('/api/session/:carrier', (req, res) => {
  const carrier = req.params.carrier.toUpperCase();
  const session = getSession(carrier);
  
  res.json({
    carrier,
    packages: session.packages,
    count: session.packages.length,
    lastUpdate: session.lastUpdate
  });
});

app.get('/api/sessions', (req, res) => {
  const sessions = {};
  
  for (const carrier of CARRIERS) {
    const session = database.activeSessions[carrier];
    if (session && session.packages.length > 0) {
      sessions[carrier] = {
        count: session.packages.length,
        lastUpdate: session.lastUpdate
      };
    }
  }
  
  res.json({ sessions });
});

app.delete('/api/session/:carrier', (req, res) => {
  const carrier = req.params.carrier.toUpperCase();
  clearSession(carrier);
  res.json({ success: true, message: `Sesión de ${carrier} limpiada` });
});

app.delete('/api/session/:carrier/package/:tracking', (req, res) => {
  const carrier = req.params.carrier.toUpperCase();
  const tracking = req.params.tracking.toUpperCase();
  
  const session = getSession(carrier);
  const initialLength = session.packages.length;
  session.packages = session.packages.filter(p => p.tracking !== tracking);
  
  if (session.packages.length < initialLength) {
    session.lastUpdate = new Date().toISOString();
    saveData();
    res.json({ success: true, message: `Paquete ${tracking} eliminado` });
  } else {
    res.json({ success: false, message: 'Paquete no encontrado' });
  }
});

// ============================================
// ESCANEO
// ============================================

app.post('/api/scan', async (req, res) => {
  const { tracking, expectedCarrier } = req.body;
  if (!tracking || !expectedCarrier) return res.status(400).json({ error: 'Faltan datos' });

  const clean = tracking.trim().toUpperCase();
  const expected = expectedCarrier.toUpperCase();
  
  console.log(`\n📦 SCAN: ${clean} → ${expected}`);
  
  const session = getSession(expected);
  const alreadyScanned = session.packages.find(p => p.tracking === clean);
  if (alreadyScanned) {
    return res.json({
      success: false,
      error: 'DUPLICADO',
      message: `Este paquete ya está escaneado`,
      tracking: clean
    });
  }
  
  const det = await getCarrierFromTracking(clean);
  
  if (!det.picking) {
    console.log(`   ❌ No existe en Odoo`);
    return res.json({
      success: false,
      error: 'NO_ENCONTRADO',
      message: `El tracking ${clean} no existe en Odoo`,
      tracking: clean
    });
  }
  
  if (det.carrier && det.carrier !== expected) {
    console.log(`   ❌ Es ${det.carrier}, no ${expected}`);
    return res.json({
      success: false,
      error: 'TRANSPORTISTA_INCORRECTO',
      message: `Este paquete es de ${det.carrier}, no de ${expected}`,
      detectedCarrier: det.carrier
    });
  }
  
  if (!det.carrier) {
    console.log(`   ⚠️ No se pudo verificar transportista en Sendcloud`);
    return res.json({
      success: false,
      error: 'NO_VERIFICADO',
      message: `No se pudo verificar el transportista en Sendcloud. Busca por nombre de cliente.`,
      tracking: clean,
      picking: det.picking
    });
  }
  
  const packageData = {
    tracking: clean,
    pickingId: det.picking.id,
    orderRef: det.picking.origin || '',
    clientName: det.picking.partner_id ? det.picking.partner_id[1] : '',
    scannedAt: new Date().toISOString()
  };
  
  addPackageToSession(expected, packageData);
  
  console.log(`   ✅ ${det.carrier} | Pedido: ${packageData.orderRef} | Cliente: ${packageData.clientName}`);
  
  res.json({ 
    success: true, 
    tracking: clean, 
    detectedCarrier: det.carrier,
    package: packageData,
    sessionCount: getSession(expected).packages.length
  });
});

app.post('/api/add-tracking', async (req, res) => {
  const { tracking, carrier, pickingId, orderRef, clientName } = req.body;
  
  if (!tracking || !carrier) {
    return res.status(400).json({ error: 'Tracking y carrier requeridos' });
  }
  
  const clean = tracking.trim().toUpperCase();
  const carrierUpper = carrier.toUpperCase();
  
  const session = getSession(carrierUpper);
  const alreadyScanned = session.packages.find(p => p.tracking === clean);
  if (alreadyScanned) {
    return res.json({
      success: false,
      error: 'DUPLICADO',
      message: `Este paquete ya está escaneado`
    });
  }
  
  const det = await getCarrierFromTracking(clean);
  
  if (det.carrier && det.carrier !== carrierUpper) {
    return res.json({
      success: false,
      error: 'TRANSPORTISTA_INCORRECTO',
      message: `Este paquete es de ${det.carrier}, no de ${carrierUpper}`,
      detectedCarrier: det.carrier
    });
  }
  
  const packageData = {
    tracking: clean,
    pickingId: pickingId || det.picking?.id,
    orderRef: orderRef || det.picking?.origin || '',
    clientName: clientName || (det.picking?.partner_id ? det.picking.partner_id[1] : ''),
    scannedAt: new Date().toISOString(),
    addedManually: true
  };
  
  addPackageToSession(carrierUpper, packageData);
  
  res.json({
    success: true,
    tracking: clean,
    carrier: carrierUpper,
    package: packageData,
    sessionCount: getSession(carrierUpper).packages.length
  });
});

app.get('/api/detect-carrier/:tracking', async (req, res) => {
  const tracking = req.params.tracking.trim();
  const startTime = Date.now();
  const result = await getCarrierFromTracking(tracking);
  const time = Date.now() - startTime;
  
  res.json({
    carrier: result.carrier,
    picking: result.picking,
    source: result.source,
    time
  });
});

app.get('/api/search-client/:name', async (req, res) => {
  const clientName = req.params.name.trim();
  
  if (clientName.length < 3) {
    return res.status(400).json({ error: 'Nombre muy corto (mínimo 3 caracteres)' });
  }
  
  const pickings = await odooClient.findPickingsByClientName(clientName);
  
  const results = pickings.map(p => ({
    id: p.id,
    name: p.name,
    tracking: p.carrier_tracking_ref,
    client: p.partner_id ? p.partner_id[1] : 'Sin cliente',
    origin: p.origin,
    date: p.scheduled_date,
    expedited: !!p.manual_expedition_date
  }));
  
  res.json({ 
    query: clientName,
    count: results.length,
    results 
  });
});

// ============================================
// BÚSQUEDA GLOBAL
// ============================================

app.get('/api/search', (req, res) => {
  const query = (req.query.q || '').trim().toUpperCase();
  
  if (query.length < 3) {
    return res.status(400).json({ error: 'Mínimo 3 caracteres' });
  }
  
  const results = {
    pallets: [],
    packages: [],
    pickups: []
  };
  
  // Buscar en palets
  for (const pallet of Object.values(database.pallets)) {
    if (pallet.id.toUpperCase().includes(query)) {
      results.pallets.push(pallet);
    } else {
      // Buscar en paquetes del palet
      const matchingPkg = pallet.packages.find(p => 
        p.tracking.toUpperCase().includes(query) || 
        (p.orderRef && p.orderRef.toUpperCase().includes(query))
      );
      if (matchingPkg) {
        results.packages.push({ pallet, package: matchingPkg });
      }
    }
  }
  
  // Buscar en recogidas
  for (const pickup of Object.values(database.pickups)) {
    if (pickup.id.toUpperCase().includes(query)) {
      results.pickups.push(pickup);
    }
  }
  
  res.json({
    query,
    results,
    totalResults: results.pallets.length + results.packages.length + results.pickups.length
  });
});

// ============================================
// PALLETS
// ============================================

app.post('/api/pallets', (req, res) => {
  const { carrier } = req.body;
  
  if (!carrier) {
    return res.status(400).json({ error: 'Carrier requerido' });
  }
  
  const carrierUpper = carrier.toUpperCase();
  const session = getSession(carrierUpper);
  
  if (session.packages.length === 0) {
    return res.status(400).json({ error: 'No hay paquetes para crear el palet' });
  }
  
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const count = Object.keys(database.pallets).filter(id => id.startsWith(`${carrierUpper}-${dateStr}`)).length + 1;
  const palletId = `${carrierUpper}-${dateStr}-${String(count).padStart(3, '0')}`;
  
  const pallet = {
    id: palletId,
    carrier: carrierUpper,
    packages: [...session.packages],
    trackings: session.packages.map(p => p.tracking),
    totalPackages: session.packages.length,
    createdAt: now.toISOString(),
    date: now.toISOString().split('T')[0],
    status: 'pending'
  };
  
  database.pallets[palletId] = pallet;
  clearSession(carrierUpper);
  
  console.log(`\n📦 PALET CREADO: ${palletId} - ${pallet.totalPackages} paquetes`);
  
  res.json({ success: true, pallet });
});

app.get('/api/pallets', (req, res) => {
  const dateFilter = req.query.date || new Date().toISOString().split('T')[0];
  
  const filteredPallets = Object.values(database.pallets).filter(p => p.date === dateFilter);
  
  const grouped = {};
  
  for (const carrier of CARRIERS) {
    const carrierPallets = filteredPallets.filter(p => p.carrier === carrier);
    
    if (carrierPallets.length > 0) {
      const pending = carrierPallets.filter(p => p.status === 'pending');
      const pickedUp = carrierPallets.filter(p => p.status === 'picked_up');
      
      grouped[carrier] = {
        total: carrierPallets.length,
        totalPackages: carrierPallets.reduce((sum, p) => sum + p.totalPackages, 0),
        pending: pending.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
        pickedUp: pickedUp.sort((a, b) => new Date(b.pickedUpAt || b.createdAt) - new Date(a.pickedUpAt || a.createdAt))
      };
    }
  }
  
  res.json({ 
    date: dateFilter,
    carriers: grouped,
    summary: {
      totalPallets: filteredPallets.length,
      totalPackages: filteredPallets.reduce((sum, p) => sum + p.totalPackages, 0),
      pendingPallets: filteredPallets.filter(p => p.status === 'pending').length,
      pickedUpPallets: filteredPallets.filter(p => p.status === 'picked_up').length
    }
  });
});

app.get('/api/pallets/:id', (req, res) => {
  const pallet = database.pallets[req.params.id];
  
  if (!pallet) {
    return res.status(404).json({ error: 'Palet no encontrado' });
  }
  
  res.json({ pallet });
});

app.delete('/api/pallets/:id', (req, res) => {
  const palletId = req.params.id;
  
  if (!database.pallets[palletId]) {
    return res.status(404).json({ error: 'Palet no encontrado' });
  }
  
  delete database.pallets[palletId];
  saveData();
  console.log(`\n🗑️ PALET ELIMINADO: ${palletId}`);
  
  res.json({ success: true, message: `Palet ${palletId} eliminado` });
});

// Etiqueta de palet
app.get('/api/pallets/:id/label', (req, res) => {
  const pallet = database.pallets[req.params.id];
  
  if (!pallet) {
    return res.status(404).json({ error: 'Palet no encontrado' });
  }
  
  const createdDate = new Date(pallet.createdAt);
  const dateStr = createdDate.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = createdDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Etiqueta Palet ${pallet.id}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: 100mm 150mm; margin: 5mm; }
    body { font-family: Arial, sans-serif; width: 100mm; padding: 5mm; }
    .label { border: 3px solid #000; padding: 10px; text-align: center; }
    .carrier { font-size: 28px; font-weight: bold; background: #000; color: #fff; padding: 10px; margin: -10px -10px 10px -10px; }
    .pallet-id { font-size: 20px; font-weight: bold; margin: 10px 0; font-family: monospace; }
    .barcode { margin: 15px auto; padding: 10px; }
    .barcode svg { width: 80mm; height: 20mm; }
    .info { display: flex; justify-content: space-around; margin: 15px 0; font-size: 14px; }
    .info-box { border: 1px solid #000; padding: 8px 15px; }
    .info-box .label-text { font-size: 10px; color: #666; }
    .info-box .value { font-size: 24px; font-weight: bold; }
    .datetime { font-size: 12px; color: #333; margin-top: 10px; }
    .footer { margin-top: 15px; padding-top: 10px; border-top: 1px dashed #000; font-size: 10px; color: #666; }
    @media print { body { width: 100mm; } .no-print { display: none; } }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
</head>
<body>
  <div class="label">
    <div class="carrier">${pallet.carrier}</div>
    <div class="pallet-id">${pallet.id}</div>
    <div class="barcode"><svg id="barcode"></svg></div>
    <div class="info">
      <div class="info-box">
        <div class="label-text">ENVÍOS</div>
        <div class="value">${pallet.totalPackages}</div>
      </div>
      <div class="info-box">
        <div class="label-text">PALET</div>
        <div class="value">#${pallet.id.split('-').pop()}</div>
      </div>
    </div>
    <div class="datetime">📅 ${dateStr} &nbsp; 🕐 ${timeStr}</div>
    <div class="footer">ILLICE INTERNACIONAL S.A.</div>
  </div>
  <div class="no-print" style="margin-top: 20px; text-align: center;">
    <button onclick="window.print()" style="padding: 10px 30px; font-size: 16px; cursor: pointer;">🖨️ Imprimir</button>
  </div>
  <script>
    JsBarcode("#barcode", "${pallet.id}", { format: "CODE128", width: 2, height: 60, displayValue: false });
  </script>
</body>
</html>`;
  
  res.send(html);
});

// ============================================
// RECOGIDAS
// ============================================

app.post('/api/pickup/scan-pallet', (req, res) => {
  const { palletId, expectedCarrier } = req.body;
  const pallet = database.pallets[palletId];
  
  if (!pallet) return res.json({ success: false, message: 'Palet no encontrado' });
  if (pallet.carrier !== expectedCarrier.toUpperCase()) {
    return res.json({ success: false, message: `Este palet es de ${pallet.carrier}, no de ${expectedCarrier}` });
  }
  if (pallet.status === 'picked_up') {
    return res.json({ success: false, message: 'Este palet ya fue recogido' });
  }
  
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
      
      pallet.packages.forEach(pkg => {
        if (pkg.pickingId) pickingIds.push(pkg.pickingId);
      });
    }
  }
  
  // Actualizar Odoo
  if (pickingIds.length > 0) {
    try {
      const today = now.toISOString().split('T')[0];
      await odooClient.updateExpeditionDate(pickingIds, today);
      console.log(`✅ Actualizada fecha expedición para ${pickingIds.length} albaranes`);
    } catch (err) {
      console.error('Error actualizando Odoo:', err.message);
    }
  }
  
  database.pickups[pickupId] = {
    id: pickupId,
    carrier: carrier.toUpperCase(),
    palletIds: pallets.map(p => p.id),
    pallets: pallets,
    totalPackages,
    totalPallets: pallets.length,
    createdAt: now.toISOString(),
    date: now.toISOString().split('T')[0],
    status: 'pending_signature' // Pendiente de firma
  };
  
  saveData();
  console.log(`\n🚚 RECOGIDA: ${pickupId} - ${pallets.length} palets, ${totalPackages} paquetes`);
  
  res.json({ 
    success: true, 
    message: `Recogida creada: ${pallets.length} palets, ${totalPackages} paquetes`,
    pickup: database.pickups[pickupId]
  });
});

// ============================================
// MANIFIESTOS
// ============================================

// Obtener manifiesto interactivo (para firmar)
app.get('/api/manifest/:pickupId', (req, res) => {
  const pickup = database.pickups[req.params.pickupId];
  
  if (!pickup) {
    return res.status(404).json({ error: 'Recogida no encontrada' });
  }
  
  const manifest = database.manifests[req.params.pickupId];
  const isSigned = manifest && manifest.signedAt;
  
  const createdDate = new Date(pickup.createdAt);
  const dateStr = createdDate.toLocaleDateString('es-ES', { 
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' 
  });
  const timeStr = createdDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  
  let palletsHtml = '';
  pickup.pallets.forEach((pallet, idx) => {
    palletsHtml += `
      <div class="pallet-section">
        <div class="pallet-header">
          <strong>PALET ${idx + 1}: ${pallet.id}</strong>
          <span>${pallet.totalPackages} envíos</span>
        </div>
        <table class="packages-table">
          <thead><tr><th>#</th><th>Tracking</th><th>Pedido</th><th>Cliente</th></tr></thead>
          <tbody>
            ${pallet.packages.map((pkg, i) => `
              <tr>
                <td>${i + 1}</td>
                <td class="tracking">${pkg.tracking}</td>
                <td>${pkg.orderRef || '-'}</td>
                <td>${pkg.clientName || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  });
  
  const signatureSection = isSigned ? `
    <div class="signature-section signed">
      <h3>✅ MANIFIESTO FIRMADO</h3>
      <p>Firmado el ${new Date(manifest.signedAt).toLocaleString('es-ES')}</p>
      <div class="signature-grid">
        <div class="signature-box">
          <div class="label">ENTREGADO POR (Almacén)</div>
          <img src="${manifest.warehouseSignature}" class="signature-img">
          <div class="signer-name">${manifest.warehouseName || ''}</div>
        </div>
        <div class="signature-box">
          <div class="label">RECIBIDO POR (Transportista)</div>
          <img src="${manifest.driverSignature}" class="signature-img">
          <div class="signer-name">${manifest.driverName || ''}</div>
          <div class="signer-dni">DNI: ${manifest.driverDNI || ''}</div>
        </div>
      </div>
    </div>
  ` : `
    <div class="signature-section" id="signatureSection">
      <h3>CONFORMIDAD DE ENTREGA</h3>
      <p style="font-size: 12px; color: #666; margin: 10px 0;">
        El transportista confirma haber recibido los palets y envíos detallados.
      </p>
      
      <div class="signature-grid">
        <div class="signature-box">
          <div class="label">ENTREGADO POR (Almacén)</div>
          <canvas id="warehouseSignature" class="signature-canvas"></canvas>
          <button class="clear-btn" onclick="clearSignature('warehouseSignature')">Limpiar</button>
          <input type="text" id="warehouseName" placeholder="Nombre" class="signer-input">
        </div>
        <div class="signature-box">
          <div class="label">RECIBIDO POR (Transportista)</div>
          <canvas id="driverSignature" class="signature-canvas"></canvas>
          <button class="clear-btn" onclick="clearSignature('driverSignature')">Limpiar</button>
          <input type="text" id="driverName" placeholder="Nombre" class="signer-input">
          <input type="text" id="driverDNI" placeholder="DNI" class="signer-input">
        </div>
      </div>
      
      <button id="signBtn" class="sign-btn" onclick="signManifest()">
        ✅ FIRMAR Y GUARDAR MANIFIESTO
      </button>
    </div>
  `;
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manifiesto ${pickup.id}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 20px; max-width: 210mm; margin: 0 auto; }
    .header { border-bottom: 3px solid #000; padding-bottom: 15px; margin-bottom: 20px; }
    .company { font-size: 24px; font-weight: bold; }
    .title { font-size: 20px; margin-top: 10px; color: #333; }
    .carrier-badge { display: inline-block; background: #000; color: #fff; padding: 8px 20px; font-size: 18px; font-weight: bold; margin-top: 10px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; padding: 15px; background: #f5f5f5; }
    .info-item { font-size: 14px; }
    .info-item .label { color: #666; font-size: 12px; }
    .info-item .value { font-size: 18px; font-weight: bold; }
    .summary { display: flex; justify-content: space-around; background: #e0e0e0; padding: 15px; margin: 20px 0; }
    .summary-item { text-align: center; }
    .summary-item .number { font-size: 32px; font-weight: bold; }
    .summary-item .text { font-size: 12px; color: #666; }
    .pallet-section { margin: 20px 0; border: 1px solid #ccc; }
    .pallet-header { background: #333; color: #fff; padding: 10px 15px; display: flex; justify-content: space-between; }
    .packages-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .packages-table th { background: #f0f0f0; padding: 8px; text-align: left; border-bottom: 2px solid #ccc; }
    .packages-table td { padding: 6px 8px; border-bottom: 1px solid #eee; }
    .packages-table .tracking { font-family: monospace; font-weight: bold; }
    
    .signature-section { margin-top: 30px; padding: 20px; border: 2px solid #000; }
    .signature-section h3 { margin-bottom: 10px; }
    .signature-section.signed { background: #f0fff0; border-color: #22c55e; }
    .signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 15px; }
    .signature-box { text-align: center; }
    .signature-box .label { font-size: 12px; color: #666; margin-bottom: 10px; font-weight: bold; }
    .signature-canvas { border: 1px solid #000; width: 100%; height: 120px; touch-action: none; background: #fff; }
    .signature-img { border: 1px solid #ccc; max-width: 100%; height: 120px; object-fit: contain; }
    .clear-btn { margin-top: 5px; padding: 5px 15px; font-size: 12px; cursor: pointer; }
    .signer-input { width: 100%; padding: 8px; margin-top: 8px; border: 1px solid #ccc; font-size: 14px; }
    .signer-name { font-weight: bold; margin-top: 10px; }
    .signer-dni { font-size: 12px; color: #666; }
    .sign-btn { 
      width: 100%; padding: 15px; margin-top: 20px; 
      background: #22c55e; color: white; border: none; 
      font-size: 18px; font-weight: bold; cursor: pointer; 
    }
    .sign-btn:hover { background: #16a34a; }
    .sign-btn:disabled { background: #ccc; cursor: not-allowed; }
    
    @media print { 
      .no-print { display: none !important; } 
      .signature-section { page-break-inside: avoid; }
      .signature-canvas { display: none; }
    }
    
    .print-btn { 
      position: fixed; bottom: 20px; right: 20px; 
      padding: 15px 30px; background: #000; color: #fff; 
      border: none; font-size: 16px; cursor: pointer; z-index: 100;
    }
  </style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">🖨️ Imprimir</button>
  
  <div class="header">
    <div class="company">ILLICE INTERNACIONAL S.A.</div>
    <div class="title">MANIFIESTO DE RECOGIDA</div>
    <div class="carrier-badge">${pickup.carrier}</div>
  </div>
  
  <div class="info-grid">
    <div class="info-item">
      <div class="label">FECHA</div>
      <div class="value">${dateStr}</div>
    </div>
    <div class="info-item">
      <div class="label">HORA</div>
      <div class="value">${timeStr}</div>
    </div>
    <div class="info-item">
      <div class="label">ID RECOGIDA</div>
      <div class="value">${pickup.id}</div>
    </div>
    <div class="info-item">
      <div class="label">TRANSPORTISTA</div>
      <div class="value">${pickup.carrier}</div>
    </div>
  </div>
  
  <div class="summary">
    <div class="summary-item">
      <div class="number">${pickup.totalPallets}</div>
      <div class="text">PALETS</div>
    </div>
    <div class="summary-item">
      <div class="number">${pickup.totalPackages}</div>
      <div class="text">ENVÍOS TOTALES</div>
    </div>
  </div>
  
  ${palletsHtml}
  
  ${signatureSection}
  
  <script>
    // Signature pad logic
    const canvases = {};
    const contexts = {};
    
    function initCanvas(id) {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      
      canvases[id] = canvas;
      contexts[id] = canvas.getContext('2d');
      
      // Set canvas size
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      
      let isDrawing = false;
      let lastX = 0;
      let lastY = 0;
      
      function getPos(e) {
        const rect = canvas.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
        return { x, y };
      }
      
      function startDrawing(e) {
        isDrawing = true;
        const pos = getPos(e);
        lastX = pos.x;
        lastY = pos.y;
      }
      
      function draw(e) {
        if (!isDrawing) return;
        e.preventDefault();
        
        const pos = getPos(e);
        const ctx = contexts[id];
        
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(pos.x, pos.y);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();
        
        lastX = pos.x;
        lastY = pos.y;
      }
      
      function stopDrawing() {
        isDrawing = false;
      }
      
      canvas.addEventListener('mousedown', startDrawing);
      canvas.addEventListener('mousemove', draw);
      canvas.addEventListener('mouseup', stopDrawing);
      canvas.addEventListener('mouseout', stopDrawing);
      
      canvas.addEventListener('touchstart', startDrawing);
      canvas.addEventListener('touchmove', draw);
      canvas.addEventListener('touchend', stopDrawing);
    }
    
    function clearSignature(id) {
      const canvas = canvases[id];
      const ctx = contexts[id];
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    
    function isCanvasBlank(id) {
      const canvas = canvases[id];
      if (!canvas) return true;
      const ctx = contexts[id];
      const pixelBuffer = new Uint32Array(
        ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer
      );
      return !pixelBuffer.some(color => color !== 0);
    }
    
    async function signManifest() {
      const warehouseName = document.getElementById('warehouseName')?.value || '';
      const driverName = document.getElementById('driverName')?.value || '';
      const driverDNI = document.getElementById('driverDNI')?.value || '';
      
      if (!driverName || !driverDNI) {
        alert('Por favor, introduce el nombre y DNI del transportista');
        return;
      }
      
      if (isCanvasBlank('driverSignature')) {
        alert('Por favor, el transportista debe firmar');
        return;
      }
      
      const warehouseSignature = canvases['warehouseSignature']?.toDataURL() || '';
      const driverSignature = canvases['driverSignature']?.toDataURL() || '';
      
      const btn = document.getElementById('signBtn');
      btn.disabled = true;
      btn.textContent = 'Guardando...';
      
      try {
        const response = await fetch('/api/manifest/${pickup.id}/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            warehouseName,
            warehouseSignature,
            driverName,
            driverDNI,
            driverSignature
          })
        });
        
        const result = await response.json();
        
        if (result.success) {
          alert('✅ Manifiesto firmado correctamente');
          location.reload();
        } else {
          alert('Error: ' + result.error);
          btn.disabled = false;
          btn.textContent = '✅ FIRMAR Y GUARDAR MANIFIESTO';
        }
      } catch (err) {
        alert('Error de conexión');
        btn.disabled = false;
        btn.textContent = '✅ FIRMAR Y GUARDAR MANIFIESTO';
      }
    }
    
    // Initialize canvases
    if (document.getElementById('warehouseSignature')) {
      initCanvas('warehouseSignature');
      initCanvas('driverSignature');
    }
  </script>
</body>
</html>`;
  
  res.send(html);
});

// Firmar manifiesto
app.post('/api/manifest/:pickupId/sign', (req, res) => {
  const pickupId = req.params.pickupId;
  const pickup = database.pickups[pickupId];
  
  if (!pickup) {
    return res.status(404).json({ error: 'Recogida no encontrada' });
  }
  
  const { warehouseName, warehouseSignature, driverName, driverDNI, driverSignature } = req.body;
  
  if (!driverName || !driverDNI || !driverSignature) {
    return res.status(400).json({ error: 'Faltan datos del transportista' });
  }
  
  const now = new Date();
  
  database.manifests[pickupId] = {
    pickupId,
    warehouseName: warehouseName || '',
    warehouseSignature: warehouseSignature || '',
    driverName,
    driverDNI,
    driverSignature,
    signedAt: now.toISOString()
  };
  
  pickup.status = 'signed';
  pickup.signedAt = now.toISOString();
  
  saveData();
  
  console.log(`\n✍️ MANIFIESTO FIRMADO: ${pickupId} - ${driverName} (${driverDNI})`);
  
  res.json({ success: true, message: 'Manifiesto firmado' });
});

// ============================================
// DOCUMENTACIÓN / HISTÓRICO
// ============================================

app.get('/api/documents', (req, res) => {
  const dateFilter = req.query.date;
  
  let pickups = Object.values(database.pickups);
  
  if (dateFilter) {
    pickups = pickups.filter(p => p.date === dateFilter);
  }
  
  // Ordenar por fecha descendente
  pickups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  // Añadir info de firma
  const documents = pickups.map(p => ({
    ...p,
    manifest: database.manifests[p.id] || null,
    isSigned: !!database.manifests[p.id]
  }));
  
  res.json({ documents });
});

// ============================================
// ESTADÍSTICAS
// ============================================

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayPallets = Object.values(database.pallets).filter(p => p.date === today);
  const todayPickups = Object.values(database.pickups).filter(p => p.date === today);
  
  let packagesInProgress = 0;
  for (const carrier of CARRIERS) {
    const session = database.activeSessions[carrier];
    if (session) {
      packagesInProgress += session.packages.length;
    }
  }
  
  res.json({
    totalPallets: todayPallets.length,
    totalPackages: todayPallets.reduce((sum, p) => sum + p.totalPackages, 0),
    packagesInProgress,
    palletsPending: todayPallets.filter(p => p.status === 'pending').length,
    palletsPickedUp: todayPallets.filter(p => p.status === 'picked_up').length,
    totalPickups: todayPickups.length,
    signedManifests: todayPickups.filter(p => database.manifests[p.id]).length
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  📦 CLASIFICADOR DE EXPEDICIONES v8.0                         ║
║  🔗 Sendcloud + Odoo | Persistencia | Firmas Digitales        ║
╠═══════════════════════════════════════════════════════════════╣
║  🌐 Puerto: ${PORT}                                              ║
║  🏷️  Etiqueta: /api/pallets/{id}/label                        ║
║  📋 Manifiesto: /api/manifest/{pickupId}                      ║
╚═══════════════════════════════════════════════════════════════╝`);
  
  try {
    const uid = await odooClient.authenticate();
    console.log(`✅ Odoo conectado (UID: ${uid})`);
  } catch (err) {
    console.log('❌ Error conectando Odoo:', err.message);
  }
  
  console.log(`🔑 Sendcloud configurado`);
  console.log(`📊 Palets en memoria: ${Object.keys(database.pallets).length}`);
  console.log(`📋 Recogidas en memoria: ${Object.keys(database.pickups).length}`);
});