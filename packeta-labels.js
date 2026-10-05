// =============================================================================
// (#054) Lector de códigos de barras de las ETIQUETAS PDF de Sendcloud
// =============================================================================
// Para los envíos ASENDIA "e-PAQ Select" que reparte la red Packeta (Speedy BG,
// ELTA GR, Overseas HR, HU, RO, SE, CZ…) la etiqueta es del transportista LOCAL y
// sus códigos de barras no están en Odoo/Sendcloud. Este módulo los LEE del propio
// PDF de la etiqueta para que la app aprenda "código local → nº Packeta → pedido".
//
// Sin dependencias (solo zlib). Soporta lo visto en las 57 etiquetas reales
// (05-oct-2026):
//  - barras vectoriales: rectángulos `re f` y trazados cerrados `m l l l h f`
//    (con color de relleno y transformaciones `cm`), en contenido de página o
//    Form XObjects;
//  - barras en imagen FlateDecode: 1 bit indexado, gris u RGB de 8 bits, con o
//    sin predictor PNG.
// Simbologías: Code128 (con checksum) y Code39 (con * de inicio/fin). Un código
// solo se acepta si decodifica entero y valida → nunca devuelve basura.
// Nunca lanza: ante cualquier problema devuelve lo que haya podido leer.
'use strict';
const zlib = require('zlib');

// ---------------------------------------------------------------- Code128 ----
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232'];
const C128_LOOK = new Map(C128.map((p, i) => [p, i]));

// ws: anchos alternos empezando por BARRA. Devuelve el texto o null.
function decode128(ws) {
  if (ws.length < 31) return null;
  const unit = (ws[0] + ws[1] + ws[2] + ws[3] + ws[4] + ws[5]) / 11;
  if (!(unit > 0)) return null;
  const mod = w => { const m = Math.round(w / unit); return m < 1 ? 1 : (m > 4 ? 4 : m); };
  const syms = [];
  let i = 0, stopped = false;
  while (i + 6 <= ws.length) {
    if (i + 7 <= ws.length) {
      let k7 = ''; for (let j = 0; j < 7; j++) k7 += mod(ws[i + j]);
      if (k7 === '2331112') { syms.push(106); stopped = true; break; }
    }
    let k = ''; for (let j = 0; j < 6; j++) k += mod(ws[i + j]);
    const v = C128_LOOK.get(k); if (v === undefined) return null;
    syms.push(v); i += 6;
  }
  if (!stopped || syms.length < 4 || syms[0] < 103 || syms[0] > 105) return null;
  const data = syms.slice(1, -2), chk = syms[syms.length - 2];
  let total = syms[0]; data.forEach((s, k) => { total += (k + 1) * s; });
  if (total % 103 !== chk) return null;
  // Tabla oficial: en el juego C los valores 0-99 son PARES DE DÍGITOS ("96"…"99" incluidos);
  // 100 → B, 101 → A, 102 = FNC1. En A/B: 0-95 caracteres, 96-98 FNC/Shift, 99 → C,
  // 100 → B (desde A) o FNC4 (en B), 101 → A (desde B) o FNC4 (en A), 102 = FNC1.
  let set = { 103: 'A', 104: 'B', 105: 'C' }[syms[0]], out = '';
  for (const s of data) {
    if (set === 'C') {
      if (s <= 99) { out += (s < 10 ? '0' : '') + s; continue; }
      if (s === 100) set = 'B'; else if (s === 101) set = 'A';
      continue; // 102 FNC1
    }
    if (s === 99) { set = 'C'; continue; }
    if (s === 100) { if (set === 'A') set = 'B'; continue; }
    if (s === 101) { if (set === 'B') set = 'A'; continue; }
    if (s >= 96) continue; // FNC1-4 / Shift: no aportan texto
    if (set === 'B') out += String.fromCharCode(s + 32);
    else out += s < 64 ? String.fromCharCode(s + 32) : String.fromCharCode(s - 64);
  }
  return out || null;
}

// ----------------------------------------------------------------- Code39 ----
const C39 = { '000110100':'0','100100001':'1','001100001':'2','101100000':'3','000110001':'4','100110000':'5',
  '001110000':'6','000100101':'7','100100100':'8','001100100':'9','100001001':'A','001001001':'B','101001000':'C',
  '000011001':'D','100011000':'E','001011000':'F','000001101':'G','100001100':'H','001001100':'I','000011100':'J',
  '100000011':'K','001000011':'L','101000010':'M','000010011':'N','100010010':'O','001010010':'P','000000111':'Q',
  '100000110':'R','001000110':'S','000010110':'T','110000001':'U','011000001':'V','111000000':'W','010010001':'X',
  '110010000':'Y','011010000':'Z','010000101':'-','110000100':'.','011000100':' ','010010100':'*','010101000':'$',
  '010100010':'/','010001010':'+','000101010':'%' };

function decode39(ws) {
  if (ws.length < 29) return null;
  let mn = Infinity, mx = 0; for (const w of ws) { if (w < mn) mn = w; if (w > mx) mx = w; }
  if (!(mx >= mn * 1.8)) return null;          // Code39 necesita anchos claramente distintos
  const th = (mn + mx) / 2;
  let out = '', i = 0;
  while (i + 9 <= ws.length) {
    let k = ''; for (let j = 0; j < 9; j++) k += ws[i + j] > th ? '1' : '0';
    const c = C39[k]; if (c === undefined) return null;
    out += c; i += 10;                          // 9 elementos + hueco entre caracteres
    if (c === '*' && out.length > 1) break;
  }
  if (out.length < 3 || out[0] !== '*' || out[out.length - 1] !== '*') return null;
  const body = out.slice(1, -1);
  return body.indexOf('*') >= 0 || !body ? null : body;
}

// Prueba todos los inicios posibles (en barra) y ambos sentidos.
function decodeRuns(ws, found) {
  for (const seq of [ws, ws.slice().reverse()]) {
    for (let s = 0; s + 29 <= seq.length; s += 2) {
      const a = decode128(seq.slice(s)); if (a) { found.add(a); break; }
    }
    for (let s = 0; s + 29 <= seq.length; s += 2) {
      const b = decode39(seq.slice(s)); if (b) { found.add(b); break; }
    }
  }
}

// --------------------------------------------------------------- PDF base ----
function readObjects(buf) {
  const s = buf.toString('latin1'), out = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(s))) {
    const objStart = m.index + m[0].length;
    const endObj = s.indexOf('endobj', objStart); if (endObj < 0) break;
    const body = s.slice(objStart, endObj);
    const si = body.search(/\bstream(\r\n|\n|\r)/);
    if (si < 0) { out.push({ num: +m[1], dict: body, data: null }); continue; }
    const dict = body.slice(0, si);
    let start = objStart + si + 6;
    if (s[start] === '\r') start++; if (s[start] === '\n') start++;
    let end = s.indexOf('endstream', start); if (end < 0) end = endObj;
    let raw = buf.subarray(start, end);
    let data = raw;
    if (/\/FlateDecode/.test(dict)) {
      data = null;
      for (const cut of [0, 1, 2]) { try { data = zlib.inflateSync(raw.subarray(0, raw.length - cut)); break; } catch (_) {} }
      if (!data) { try { data = zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (_) { data = null; } }
    }
    out.push({ num: +m[1], dict, data });
    re.lastIndex = endObj;
  }
  return out;
}
const dictNum = (d, k) => { const m = new RegExp('/' + k + '\\s+(\\d+)').exec(d); return m ? +m[1] : null; };

// ---------------------------------------------------------- barras vector ----
function barsFromContent(text) {
  const toks = text.match(/\/[^\s\/\[\]()<>{}%]+|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?|[A-Za-z'"*]+|\[|\]/g) || [];
  const st = []; let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; let dark = true;
  let path = []; let cur = null; let pts = [];
  const rects = [];
  const tx = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const addRect = (ptsA) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ptsA) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (isFinite(x0) && x1 > x0 && y1 > y0) rects.push({ x0, y0, x1, y1, dark });
  };
  for (const t of toks) {
    if (/^[-+]?\d*\.?\d/.test(t)) { st.push(+t); continue; }
    switch (t) {
      case 'q': stack.push([ctm.slice(), dark]); break;
      case 'Q': { const v = stack.pop(); if (v) { ctm = v[0]; dark = v[1]; } break; }
      case 'cm': if (st.length >= 6) { const [a, b, c, d, e, f] = st.slice(-6); const M = ctm;
        ctm = [a * M[0] + b * M[2], a * M[1] + b * M[3], c * M[0] + d * M[2], c * M[1] + d * M[3], e * M[0] + f * M[2] + M[4], e * M[1] + f * M[3] + M[5]]; } break;
      case 'rg': case 'RG': if (t === 'rg' && st.length >= 3) { const [r, g, b] = st.slice(-3); dark = (0.299 * r + 0.587 * g + 0.114 * b) < 0.5; } break;
      case 'g': if (st.length >= 1) dark = st[st.length - 1] < 0.5; break;
      case 'k': if (st.length >= 4) { const [c, m, y, k] = st.slice(-4); dark = (k > 0.5) || (c + m + y > 1.5); } break;
      case 're': if (st.length >= 4) { const [x, y, w, h] = st.slice(-4); path.push([tx(x, y), tx(x + w, y), tx(x, y + h), tx(x + w, y + h)]); } break;
      case 'm': if (st.length >= 2) { if (pts.length) path.push(pts); pts = [tx(st[st.length - 2], st[st.length - 1])]; } break;
      case 'l': if (st.length >= 2) pts.push(tx(st[st.length - 2], st[st.length - 1])); break;
      case 'h': break;
      case 'f': case 'F': case 'f*': case 'B': case 'b':
        if (pts.length) path.push(pts); for (const p of path) if (p.length >= 4 && p.length <= 6) addRect(p);
        path = []; pts = []; break;
      case 'n': case 'S': case 's': case 'W': path = []; pts = []; break;
      default: break;
    }
    st.length = 0;
  }
  return rects.filter(r => r.dark);
}

function decodeVectorRects(rects, found) {
  for (const horiz of [true, false]) {
    // agrupar barras que comparten franja (misma altura/posición en el eje perpendicular)
    const groups = new Map();
    for (const r of rects) {
      const span = horiz ? (r.y1 - r.y0) : (r.x1 - r.x0);
      const thick = horiz ? (r.x1 - r.x0) : (r.y1 - r.y0);
      if (span < 4 || thick > span) continue;
      const key = horiz ? (Math.round(r.y0) + ':' + Math.round(r.y1)) : (Math.round(r.x0) + ':' + Math.round(r.x1));
      (groups.get(key) || groups.set(key, []).get(key)).push(horiz ? [r.x0, r.x1] : [r.y0, r.y1]);
    }
    for (const bars of groups.values()) {
      if (bars.length < 10) continue;
      bars.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const b of bars) { const last = merged[merged.length - 1]; if (last && b[0] - last[1] < 0.01) last[1] = Math.max(last[1], b[1]); else merged.push(b.slice()); }
      const ws = [];
      merged.forEach((b, k) => { if (k) ws.push(b[0] - merged[k - 1][1]); ws.push(b[1] - b[0]); });
      decodeRuns(ws, found);
    }
  }
}

// --------------------------------------------------------- barras imagen ----
function pngUnfilter(data, rowBytes, bpp, height) {
  const out = Buffer.alloc(rowBytes * height); let prev = Buffer.alloc(rowBytes); let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = data[p++]; const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[p++] || 0, a = x >= bpp ? row[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      if (ft === 0) v = raw; else if (ft === 1) v = raw + a; else if (ft === 2) v = raw + b;
      else if (ft === 3) v = raw + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = raw + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)); }
      row[x] = v & 255;
    }
    prev = row;
  }
  return out;
}

function decodeImage(obj, found) {
  const d = obj.dict, data = obj.data; if (!data) return;
  const W = dictNum(d, 'Width'), H = dictNum(d, 'Height'), bpc = dictNum(d, 'BitsPerComponent') || 8;
  if (!W || !H || W * H > 12e6) return;
  const colors = /\/Indexed/.test(d) ? 1 : (/\/DeviceRGB/.test(d) ? 3 : (/\/DeviceCMYK/.test(d) ? 4 : 1));
  const rowBytes = Math.ceil(W * colors * bpc / 8);
  let pix = data;
  const pred = (/\/Predictor\s+(\d+)/.exec(d) || [])[1];
  if (pred && +pred >= 10) pix = pngUnfilter(data, rowBytes, Math.max(1, Math.ceil(colors * bpc / 8)), H);
  if (pix.length < rowBytes * H) return;
  // luminancia 0..255 por píxel
  const lum = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const off = y * rowBytes;
    for (let x = 0; x < W; x++) {
      let v;
      if (bpc === 1) v = (pix[off + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
      else if (colors === 3) { const i = off + x * 3; v = (pix[i] * 299 + pix[i + 1] * 587 + pix[i + 2] * 114) / 1000; }
      else if (colors === 4) { const i = off + x * 4; v = 255 - Math.min(255, pix[i + 3] + (pix[i] + pix[i + 1] + pix[i + 2]) / 3); }
      else v = pix[off + x];
      lum[y * W + x] = v;
    }
  }
  // polaridad: el fondo de una etiqueta es mayoritariamente claro
  let darkCount = 0; for (let i = 0; i < lum.length; i += 7) if (lum[i] < 128) darkCount++;
  const invert = darkCount > (lum.length / 7) / 2;
  const isDark = i => invert ? lum[i] >= 128 : lum[i] < 128;
  const runsOf = (getter, len) => {
    const ws = []; let cur = null, n = 0, started = false;
    for (let k = 0; k < len; k++) { const v = getter(k); if (!started) { if (v) { started = true; cur = true; n = 1; } continue; } if (v === cur) n++; else { ws.push(n); cur = v; n = 1; } }
    if (started && cur) ws.push(n);
    return ws;
  };
  const step = Math.max(2, Math.floor(Math.min(W, H) / 400));
  for (let y = 0; y < H; y += step) decodeRuns(runsOf(x => isDark(y * W + x), W), found);
  for (let x = 0; x < W; x += step) decodeRuns(runsOf(y => isDark(y * W + x), H), found);
}

// ------------------------------------------------------------------- API ----
// Devuelve un array de textos decodificados (sin duplicados) de todo el PDF.
function extractBarcodes(pdfBuffer) {
  const found = new Set();
  let objs;
  try { objs = readObjects(pdfBuffer); } catch (_) { return []; }
  for (const o of objs) {
    try {
      if (!o.data) continue;
      if (/\/Subtype\s*\/Image/.test(o.dict)) {
        if (/\/FlateDecode/.test(o.dict) && !/\/DCTDecode/.test(o.dict)) decodeImage(o, found);
        continue;
      }
      if (/\/Length1|\/Length2|\/Type\s*\/(XRef|ObjStm|Metadata)|\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)/.test(o.dict)) continue;
      const text = o.data.toString('latin1');
      // Código de barras dibujado con FUENTE Code39: texto literal entre asteriscos, p.ej.
      // ELTA (Grecia) escribe `(*YZ413823908GR*) Tj`; la pistola lee lo de dentro.
      const reFont = /\(\*([0-9A-Z\-. $\/+%]{4,})\*\)\s*Tj/g; let fm;
      while ((fm = reFont.exec(text))) found.add(fm[1]);
      if (!/\s(re|l)\s/.test(text)) continue;
      const rects = barsFromContent(text);
      if (rects.length >= 10) decodeVectorRects(rects, found);
    } catch (_) { /* un objeto raro no debe tumbar el resto */ }
  }
  return [...found];
}

module.exports = { extractBarcodes, decode128, decode39 };
