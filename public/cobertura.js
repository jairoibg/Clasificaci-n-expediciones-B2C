/* ============================================================
   Informe de Cobertura · Terminal Pro · Controller
   ============================================================

   Endpoints del backend (server.js del repo):
     GET  /api/health
     GET  /api/odoo-outs?from=YYYY-MM-DD&to=YYYY-MM-DD
     GET  /api/scan-counts
     GET  /api/detect-carrier/<barcode>

   Datos de entrada esperados (sin cambios respecto al informe
   actual): la respuesta de /api/odoo-outs trae total, scanned,
   missing, coverage y byCarrier (records[]). El controller se
   limita a alimentar los componentes del nuevo diseño.
   ============================================================ */

(() => {
  'use strict';

  // ─── Config ───
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3001'
    : location.origin;

  const CARRIERS_ORDER = ['ASENDIA','CORREOS','CORREOS EXPRESS','CTT','GLS','INPOST','SPRING'];
  const CARRIER_COLOR = {
    'GLS':             '#10b981',
    'ASENDIA':         '#a78bfa',
    'CTT':             '#60a5fa',
    'CORREOS':         '#f59e0b',
    'INPOST':          '#fb923c',
    'CORREOS EXPRESS': '#f87171',
    'SPRING':          '#e879f9',
    'DESCONOCIDO':     '#6b6b80',
  };
  const PAGE_SIZE = 50;

  // ─── State ───
  const state = {
    report: null,
    allRecs: [],
    filtered: [],
    sortCol: 'dateDone', sortDir: 'desc',
    page: 1,
    prevWeek: null,    // para deltas vs semana anterior
  };

  // ─── DOM utils ───
  const $ = id => document.getElementById(id);
  const fmtDate = d => d.toISOString().split('T')[0];
  const fmtNum = n => (n || 0).toLocaleString('es-ES');
  const fmtPct = n => (n || 0).toFixed(1) + '%';
  const fmtDT = s => {
    if (!s) return '—';
    const d = new Date(s.replace(' ','T') + (s.includes('T') || s.includes('Z') ? '' : 'Z'));
    if (isNaN(d)) return s;
    return d.toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit' }) + ' ' +
           d.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });
  };

  // ─── Init ───
  document.addEventListener('DOMContentLoaded', () => {
    setQuickPeriod(7);
    bindControls();
    checkAPI();
    loadLiveCounts();
    setInterval(loadLiveCounts, 30000);
    updateReportMeta();
    setInterval(updateReportMeta, 60000);
    // Auto-refresh del informe cada 45 segundos (silencioso)
    setInterval(silentRefresh, 45000);
  });

  // ─── Auto-refresh silencioso ───
  let lastSilentRefresh = null;
  async function silentRefresh() {
    if (!state.report || !state.report.from || !state.report.to) return;
    // No interrumpir si el usuario está cargando manualmente
    if ($('loadBtn').disabled) return;
    try {
      const data = await apiGet('/api/odoo-outs?from=' + state.report.from + '&to=' + state.report.to);
      state.report = { ...data, from: state.report.from, to: state.report.to };
      state.allRecs = [];
      for (const info of Object.values(data.byCarrier || {})) {
        state.allRecs.push(...(info.records || []));
      }
      renderAll();
      lastSilentRefresh = new Date();
      const t = lastSilentRefresh.toLocaleTimeString('es-ES');
      setApiStatus('ok', 'OK · ' + fmtNum(state.allRecs.length) + ' OUTs · auto ' + t);
    } catch (e) {
      // silencioso, no molestar al operario
      console.warn('Auto-refresh fallido:', e.message);
    }
  }

  function bindControls() {
    document.querySelectorAll('#periodSeg button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#periodSeg button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        setQuickPeriod(+btn.dataset.period);
      };
    });
    $('loadBtn').onclick = loadReport;
    $('exportBtn').onclick = exportExcel;
    $('verifyBtn').onclick = verifyBarcode;
    $('verifyClear').onclick = () => { $('verifyInput').value = ''; $('verifyResult').innerHTML = ''; };
    $('verifyInput').addEventListener('keydown', e => { if (e.key === 'Enter') verifyBarcode(); });
    $('searchInput').addEventListener('input', () => { state.page = 1; renderTable(); });
    $('filterCarrier').addEventListener('change', () => { state.page = 1; renderTable(); });
    $('filterStatus').addEventListener('change', () => { state.page = 1; renderTable(); });
    if ($('filterDivision')) $('filterDivision').addEventListener('change', () => { state.page = 1; renderTable(); });
    if ($('filterTracking')) $('filterTracking').addEventListener('change', () => { state.page = 1; renderTable(); });

    document.querySelectorAll('.va-th').forEach(th => {
      th.onclick = () => sortBy(th.dataset.sort);
    });
  }

  function setQuickPeriod(days) {
    const t = new Date();
    const f = new Date(t);
    if (days > 0) f.setDate(f.getDate() - days);
    $('dateFrom').value = fmtDate(f);
    $('dateTo').value = fmtDate(t);
  }

  function updateReportMeta() {
    const now = new Date();
    const stamp = now.toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'2-digit' }) +
                  ' · ' + now.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    $('reportDate').textContent = stamp + ' UTC' + (now.getTimezoneOffset() < 0 ? '+' : '-') +
      Math.abs(now.getTimezoneOffset()/60);
    $('reportId').textContent = 'BATCH-COV-' + String(now.getDate()).padStart(2,'0') +
                                String(now.getHours()).padStart(2,'0');
  }

  // ─── API ───
  async function apiGet(path) {
    const r = await fetch(API_BASE + path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function checkAPI() {
    try {
      const r = await fetch(API_BASE + '/api/health', { signal: AbortSignal.timeout(4000) });
      setApiStatus(r.ok ? 'ok' : 'error', r.ok ? 'API live' : 'API down');
    } catch {
      setApiStatus('error', 'API offline');
    }
  }

  function setApiStatus(status, label) {
    const el = $('apiStatus');
    el.className = 'va-status ' + status;
    el.innerHTML = '<span class="dot"></span>' + label;
    $('reportSync').textContent = 'Sync ' + (status === 'ok' ? 'healthy' : status) +
                                  ' · ' + new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });
  }

  // ─── Load report ───
  async function loadReport() {
    const from = $('dateFrom').value;
    const to = $('dateTo').value;
    if (!from || !to) { alert('Selecciona fechas válidas'); return; }
    if (from > to) { alert('La fecha de inicio no puede ser posterior al fin'); return; }

    $('loadBtn').disabled = true;
    $('loadBtn').innerHTML = '<span class="spinner"></span> Cargando...';
    setApiStatus('loading', 'Cargando OUTs ' + from + ' → ' + to);

    try {
      const data = await apiGet('/api/odoo-outs?from=' + from + '&to=' + to);
      state.report = { ...data, from, to };
      state.allRecs = [];
      for (const info of Object.values(data.byCarrier || {})) {
        state.allRecs.push(...(info.records || []));
      }

      // Comparativa con semana anterior (deltas) — opcional
      await loadPrevWeek(from, to).catch(() => { state.prevWeek = null; });

      renderAll();
      setApiStatus('ok', 'OK · ' + fmtNum(state.allRecs.length) + ' OUTs');
      $('exportBtn').style.display = 'inline-flex';
    } catch (e) {
      setApiStatus('error', 'Error · ' + e.message);
      console.error(e);
    } finally {
      $('loadBtn').disabled = false;
      $('loadBtn').innerHTML = '▶ Cargar informe';
    }
  }

  async function loadPrevWeek(fromStr, toStr) {
    const from = new Date(fromStr); const to = new Date(toStr);
    const span = (to - from) / 86400000;
    const prevTo = new Date(from); prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - span);
    state.prevWeek = await apiGet('/api/odoo-outs?from=' + fmtDate(prevFrom) + '&to=' + fmtDate(prevTo));
  }

  // ─── Render principal ───
  function renderAll() {
    renderHero();
    renderKPIs();
    renderCarrierRanking();
    renderDailyChart();
    renderAlerts();
    renderTable();
    populateCarrierFilter();
    $('tableSection').style.display = 'block';
  }

  // Hero number + ring
  function renderHero() {
    const d = state.report;
    const days = Math.round((new Date(d.to) - new Date(d.from)) / 86400000) + 1;
    $('heroPeriod').textContent = 'últimos ' + days + ' días';
    $('heroPct').textContent = fmtPct(d.coverage).replace('%', '');
    $('ringPct').innerHTML = fmtPct(d.coverage).replace('%', '') +
      '<span style="font-size:18px;color:rgba(255,255,255,0.4)">%</span>';
    const dash = 502 * (1 - d.coverage / 100);
    $('ringFill').setAttribute('stroke-dashoffset', dash);

    $('heroTotal').textContent = fmtNum(d.total);
    $('heroScanned').textContent = fmtNum(d.scanned);
    $('heroMissing').innerHTML = fmtNum(d.missing) +
      ' <small>(' + (d.total ? (d.missing*100/d.total).toFixed(1) : 0) + '%)</small>';

    // Delta vs semana anterior
    if (state.prevWeek) {
      const delta = d.coverage - state.prevWeek.coverage;
      const cls = delta >= 0 ? 'up' : 'down';
      const sym = delta >= 0 ? '▲' : '▼';
      const heroDelta = $('heroDelta');
      heroDelta.textContent = sym + ' ' + Math.abs(delta).toFixed(1) + ' pp';
      heroDelta.className = 'v ' + cls;
    } else {
      $('heroDelta').textContent = '—';
    }

    // Mejor día
    const byDay = {};
    state.allRecs.forEach(r => {
      const day = (r.dateDone || '').split(' ')[0].split('T')[0]; if (!day) return;
      byDay[day] = byDay[day] || { total: 0, scanned: 0 };
      byDay[day].total++;
      if (r.scanned) byDay[day].scanned++;
    });
    let bestDay = null, bestPct = -1;
    Object.entries(byDay).forEach(([day, v]) => {
      if (v.total < 10) return;
      const pct = (v.scanned * 100) / v.total;
      if (pct > bestPct) { bestPct = pct; bestDay = day; }
    });
    $('heroBest').textContent = bestDay
      ? bestDay.slice(5).replace('-', '/') + ' · ' + bestPct.toFixed(1) + '%'
      : '—';
  }

  function renderKPIs() {
    const d = state.report;
    $('kpiTotal').textContent = fmtNum(d.total);
    $('kpiScanned').textContent = fmtNum(d.scanned);
    $('kpiMissing').textContent = fmtNum(d.missing);

    if (state.prevWeek) {
      const dt = d.total - state.prevWeek.total;
      const ds = d.scanned - state.prevWeek.scanned;
      const dm = d.missing - state.prevWeek.missing;
      $('kpiTotalDelta').innerHTML = deltaStr(dt) + ' vs sem. anterior';
      $('kpiScannedDelta').innerHTML = deltaStr(ds) + ' · ' + fmtPct(d.coverage) + ' coverage';
      $('kpiMissingDelta').innerHTML = deltaStr(-dm, true) + ' · objetivo &lt; 200';
    } else {
      $('kpiTotalDelta').textContent = '— vs sem. anterior';
      $('kpiScannedDelta').textContent = '— coverage: ' + fmtPct(d.coverage);
      $('kpiMissingDelta').textContent = '— · objetivo < 200';
    }
    // Velocidad media estimada (escaneados / horas con actividad)
    const hours = estimateActiveHours();
    const v = hours > 0 ? Math.round(d.scanned / hours) : 0;
    $('kpiVelocity').innerHTML = fmtNum(v) +
      ' <span style="font-size:14px;color:rgba(245,245,247,0.5)">pkg/h</span>';
  }

  function deltaStr(n, inverted = false) {
    if (n === 0) return '—';
    const positive = inverted ? n >= 0 : n >= 0;
    const cls = positive ? 'va-delta-up' : 'va-delta-down';
    const sym = n > 0 ? '▲ +' : '▼ ';
    return '<span class="' + cls + '">' + sym + Math.abs(n).toLocaleString('es-ES') + '</span>';
  }

  function estimateActiveHours() {
    // Heurística: cuenta horas distintas con al menos un escaneo en allRecs
    const hours = new Set();
    state.allRecs.forEach(r => {
      if (!r.scanned || !r.dateDone) return;
      const d = new Date((r.dateDone + '').replace(' ', 'T'));
      hours.add(d.toISOString().slice(0, 13));
    });
    return Math.max(1, hours.size);
  }

  // ─── Carrier ranking ───
  function renderCarrierRanking() {
    const byCarrier = state.report.byCarrier || {};
    const rows = Object.entries(byCarrier)
      .filter(([c, d]) => d.total > 0 && c !== 'DESCONOCIDO')
      .map(([c, d]) => ({
        carrier: c,
        pct: d.pct,
        total: d.total,
        scanned: d.scanned,
        missing: d.missing,
      }))
      .sort((a, b) => b.pct - a.pct);

    const totalAll = rows.reduce((s, r) => s + r.total, 0);
    $('carrierCount').textContent = rows.length + ' carriers · ' + fmtNum(totalAll) + ' envíos';

    if (!rows.length) {
      $('carrierRows').innerHTML = '<div class="empty-state">Sin OUTs en el periodo.</div>';
      return;
    }

    $('carrierRows').innerHTML = rows.map((r, i) => {
      const color = CARRIER_COLOR[r.carrier] || '#888';
      const pctColor = r.pct >= 95 ? '#10b981' : r.pct >= 85 ? '#f59e0b' : '#ef4444';
      const missColor = r.pct >= 95 ? 'inherit' : r.pct >= 85 ? '#f59e0b' : '#ef4444';
      const spark = sparklineSVG(carrierDailyTrend(r.carrier), pctColor);
      return `
        <div class="va-rank-row">
          <div class="va-rank-num">${String(i+1).padStart(2,'0')}</div>
          <div class="va-rank-name">
            <span class="va-rank-dot" style="background:${color}"></span>${r.carrier}
          </div>
          <div class="va-rank-pct" style="color:${pctColor}">${r.pct.toFixed(1)}%</div>
          <div class="va-rank-vol">${fmtNum(r.total)}</div>
          <div class="va-rank-miss" style="color:${missColor}">${fmtNum(r.missing)}</div>
          <div class="va-rank-bar">
            <div class="va-rank-bar-fill" style="width:${r.pct}%;background:${color}"></div>
          </div>
          <div class="va-rank-spark">${spark}</div>
        </div>
      `;
    }).join('');
  }

  function carrierDailyTrend(carrier) {
    // Devuelve array de %cobertura diaria del carrier en el periodo
    const byDay = {};
    state.allRecs.forEach(r => {
      if (r.carrier !== carrier) return;
      const day = (r.dateDone || '').split(' ')[0].split('T')[0]; if (!day) return;
      byDay[day] = byDay[day] || { total: 0, scanned: 0 };
      byDay[day].total++;
      if (r.scanned) byDay[day].scanned++;
    });
    const days = Object.keys(byDay).sort();
    return days.map(d => byDay[d].total ? byDay[d].scanned * 100 / byDay[d].total : 0);
  }

  function sparklineSVG(values, color) {
    if (!values.length) return '';
    const w = 130, h = 28, p = 4;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = Math.max(1, max - min);
    const xS = i => p + (i / Math.max(1, values.length - 1)) * (w - 2*p);
    const yS = v => h - p - ((v - min) / range) * (h - 2*p);
    const points = values.map((v, i) => `${xS(i)} ${yS(v)}`).join(' L ');
    const last = values[values.length - 1];
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <path d="M ${points}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${xS(values.length-1)}" cy="${yS(last)}" r="3" fill="${color}"/>
    </svg>`;
  }

  // ─── Daily chart ───
  function renderDailyChart() {
    const from = $('dateFrom').value, to = $('dateTo').value;
    const days = [];
    const cur = new Date(from); const end = new Date(to);
    while (cur <= end) { days.push(fmtDate(cur)); cur.setDate(cur.getDate() + 1); }
    const totalDay = {}, scannedDay = {};
    state.allRecs.forEach(r => {
      const d = (r.dateDone || '').split(' ')[0].split('T')[0]; if (!d) return;
      totalDay[d] = (totalDay[d] || 0) + 1;
      if (r.scanned) scannedDay[d] = (scannedDay[d] || 0) + 1;
    });
    const maxV = Math.max(1, ...days.map(d => totalDay[d] || 0));
    const W = 1000, H = 240, pL = 60, pR = 30, pT = 30, pB = 50;
    const iW = W - pL - pR, iH = H - pT - pB;
    const xS = i => pL + (days.length <= 1 ? iW/2 : (i / (days.length - 1)) * iW);
    const yS = v => pT + iH - (v / maxV) * iH;

    const svg = $('dailyChart');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    function buildArea(vals) {
      const pts = days.map((d,i) => ({ x: xS(i), y: yS(vals[d] || 0) }));
      let line = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const cx = (pts[i-1].x + pts[i].x) / 2;
        line += ` C ${cx} ${pts[i-1].y} ${cx} ${pts[i].y} ${pts[i].x} ${pts[i].y}`;
      }
      const area = `M ${pts[0].x} ${pT+iH} L ${pts[0].x} ${pts[0].y}` +
        line.slice(line.indexOf(' ', 2)) + ` L ${pts[pts.length-1].x} ${pT+iH} Z`;
      return { line, area, pts };
    }

    let out = `
      <defs>
        <linearGradient id="dcA" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="dcB" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
        </linearGradient>
      </defs>`;

    for (let i = 0; i <= 4; i++) {
      const y = pT + (i/4) * iH;
      const v = Math.round(maxV * (1 - i/4));
      out += `<line x1="${pL}" y1="${y}" x2="${W-pR}" y2="${y}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`;
      out += `<text x="${pL-8}" y="${y+4}" text-anchor="end" fill="rgba(245,245,247,0.4)" font-family="IBM Plex Mono" font-size="10">${v}</text>`;
    }

    const t = buildArea(totalDay);
    const s = buildArea(scannedDay);
    out += `<path d="${t.area}" fill="url(#dcB)"/>`;
    out += `<path d="${t.line}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-dasharray="6 4" opacity="0.7"/>`;
    out += `<path d="${s.area}" fill="url(#dcA)"/>`;
    out += `<path d="${s.line}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

    const nth = Math.max(1, Math.ceil(days.length / 10));
    days.forEach((d,i) => {
      const sv = scannedDay[d] || 0;
      const tv = totalDay[d] || 0;
      if (tv > 0) out += `<circle cx="${xS(i)}" cy="${yS(tv)}" r="3" fill="#3b82f6" stroke="#0b0d12" stroke-width="2" opacity="0.8"/>`;
      if (sv > 0) out += `<circle cx="${xS(i)}" cy="${yS(sv)}" r="4" fill="#10b981" stroke="#0b0d12" stroke-width="2"/>`;
      if (i % nth === 0 || i === days.length-1)
        out += `<text x="${xS(i)}" y="${H-25}" text-anchor="middle" fill="rgba(245,245,247,0.4)" font-family="IBM Plex Mono" font-size="10">${d.slice(5)}</text>`;
    });

    // Hoy marker
    const todayIdx = days.indexOf(fmtDate(new Date()));
    if (todayIdx >= 0) {
      const x = xS(todayIdx);
      out += `<line x1="${x}" y1="${pT-10}" x2="${x}" y2="${pT+iH+5}" stroke="#ec4899" stroke-width="1" stroke-dasharray="2 3"/>`;
      out += `<text x="${x}" y="${pT-16}" fill="#ec4899" font-family="IBM Plex Mono" font-size="9" text-anchor="middle" letter-spacing="0.1em">HOY</text>`;
    }
    svg.innerHTML = out;
  }

  // ─── Alertas operacionales ───
  function renderAlerts() {
    const alerts = [];
    const byCarrier = state.report.byCarrier || {};
    Object.entries(byCarrier).forEach(([c, d]) => {
      if (d.total < 30) return;
      if (d.pct < 80) {
        alerts.push({ level:'err', title: c + ' bajo 80%',
          desc: fmtNum(d.missing) + ' albaranes sin lectura — revisar zona de embalaje.' });
      } else if (d.pct < 90) {
        alerts.push({ level:'warn', title: c + ' bajo objetivo',
          desc: 'Cobertura ' + fmtPct(d.pct) + ' · ' + fmtNum(d.missing) + ' sin escanear.' });
      }
    });
    // OUTs sin tracking
    const noTrack = state.allRecs.filter(r => !r.tracking || r.tracking.trim() === '').length;
    if (noTrack > 0) {
      alerts.push({ level:'warn', title: noTrack + ' OUTs sin tracking',
        desc: 'Validados en Odoo sin código de barras asignado.' });
    }
    if (!alerts.length) {
      $('alertsList').innerHTML = '<div class="empty-state" style="padding:20px 8px;font-size:11.5px">Todo en orden. Sin alertas activas.</div>';
      return;
    }
    $('alertsList').innerHTML = alerts.slice(0, 5).map(a => `
      <div class="va-alert ${a.level}">
        <div class="icn">!</div>
        <div>
          <div class="ttl">${escapeHtml(a.title)}</div>
          <div class="desc">${escapeHtml(a.desc)}</div>
        </div>
      </div>
    `).join('');
  }

  // ─── Table ───
  function populateCarrierFilter() {
    const carriers = [...new Set(state.allRecs.map(r => r.carrier))].sort();
    const sel = $('filterCarrier');
    sel.innerHTML = '<option value="">Todos los transportistas</option>' +
      carriers.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  function renderTable() {
    const q = $('searchInput').value.toLowerCase();
    const carrier = $('filterCarrier').value;
    const status = $('filterStatus').value;
    const division = $('filterDivision') ? $('filterDivision').value : '';
    const trackingFilter = $('filterTracking') ? $('filterTracking').value : '';

    state.filtered = state.allRecs.filter(r => {
      if (carrier && r.carrier !== carrier) return false;
      if (status === 'scanned' && !r.scanned) return false;
      if (status === 'missing' && r.scanned) return false;
      // Filtro por compañía/division: extraer prefijo del albarán (CLABD, CLAGD, CLAWD)
      if (division) {
        const name = r.name || '';
        if (!name.startsWith(division + '/')) return false;
      }
      // Filtro por tracking presente o ausente
      if (trackingFilter === 'with' && (!r.tracking || r.tracking.trim() === '')) return false;
      if (trackingFilter === 'without' && r.tracking && r.tracking.trim() !== '') return false;
      if (q) {
        const hay = ((r.tracking||'') + (r.origin||'') + (r.client||'') + (r.name||'')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    state.filtered.sort((a,b) => {
      let va = a[state.sortCol] ?? '', vb = b[state.sortCol] ?? '';
      if (typeof va === 'boolean') va = va ? 1 : 0;
      if (typeof vb === 'boolean') vb = vb ? 1 : 0;
      if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
      if (va > vb) return state.sortDir === 'asc' ?  1 : -1;
      return 0;
    });

    const total = state.filtered.length;
    const pages = Math.ceil(total / PAGE_SIZE) || 1;
    if (state.page > pages) state.page = pages;
    const slice = state.filtered.slice((state.page-1)*PAGE_SIZE, state.page*PAGE_SIZE);

    const sc = state.filtered.filter(r => r.scanned).length;
    $('tableSubtitle').textContent =
      fmtNum(total) + ' registros · ' + fmtNum(sc) + ' escaneados · ' +
      fmtNum(total - sc) + ' sin escanear';

    $('tableBody').innerHTML = slice.length === 0
      ? '<tr><td colspan="8" style="text-align:center;color:var(--ink-3);padding:32px">Sin resultados</td></tr>'
      : slice.map(r => {
          const col = CARRIER_COLOR[r.carrier] || '#888';
          const ms = r.matchSource;
          const matchPill = ms === 'pickingId' ? '<span class="va-pill blue">pickingId</span>'
            : ms === 'exactTracking' ? '<span class="va-pill green">tracking exacto</span>'
            : ms === 'extractedTracking' ? '<span class="va-pill purple">extraído</span>'
            : ms === 'substring' ? '<span class="va-pill blue">substring</span>'
            : '<span style="color:var(--ink-4);font-size:11px">—</span>';
          return `<tr>
            <td>
              <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600">
                <span style="width:7px;height:7px;border-radius:50%;background:${col}"></span>${r.carrier}
              </span>
            </td>
            <td class="mono" style="color:var(--ink-3)">${escapeHtml(r.name || '—')}</td>
            <td class="mono">${escapeHtml(r.tracking || '—')}</td>
            <td class="mono">${escapeHtml(r.origin || '—')}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(r.client||'')}">${escapeHtml(r.client || '—')}</td>
            <td class="mono" style="color:var(--ink-3)">${fmtDT(r.dateDone)}</td>
            <td>${matchPill}</td>
            <td><span class="va-pill ${r.scanned ? 'green' : 'red'}">${r.scanned ? '✓ Escaneado' : '✗ Sin escanear'}</span></td>
          </tr>`;
        }).join('');

    // Pagination
    $('pagInfo').textContent = 'Mostrando ' + ((state.page-1)*PAGE_SIZE + 1) + '–' +
      Math.min(state.page*PAGE_SIZE, total) + ' de ' + fmtNum(total);

    let btns = `<button class="pag-btn" data-p="${state.page-1}" ${state.page<=1?'disabled':''}>‹</button>`;
    const range = [...new Set([1, state.page-1, state.page, state.page+1, pages]
      .filter(p => p >= 1 && p <= pages))].sort((a,b)=>a-b);
    let prev = null;
    for (const p of range) {
      if (prev !== null && p - prev > 1)
        btns += `<span style="color:var(--ink-4);padding:0 2px">…</span>`;
      btns += `<button class="pag-btn ${p===state.page?'active':''}" data-p="${p}">${p}</button>`;
      prev = p;
    }
    btns += `<button class="pag-btn" data-p="${state.page+1}" ${state.page>=pages?'disabled':''}>›</button>`;
    $('pagBtns').innerHTML = btns;
    $('pagBtns').querySelectorAll('button[data-p]').forEach(b => {
      b.onclick = () => { state.page = +b.dataset.p; renderTable(); };
    });

    // Sort indicators
    document.querySelectorAll('.va-th').forEach(th => {
      th.classList.remove('asc','desc');
      if (th.dataset.sort === state.sortCol) th.classList.add(state.sortDir);
    });
  }

  function sortBy(col) {
    state.sortDir = (state.sortCol === col)
      ? (state.sortDir === 'asc' ? 'desc' : 'asc')
      : (col === 'dateDone' ? 'desc' : 'asc');
    state.sortCol = col;
    state.page = 1;
    renderTable();
  }

  // ─── Live counts ───
  async function loadLiveCounts() {
    try {
      const data = await apiGet('/api/scan-counts');
      let html = '';
      const rows = [];
      rows.push({ l: 'Total escaneados hoy', v: data.grandTotal, color: '#10b981' });
      rows.push({ l: 'En sesión activa', v: data.totalSession, color: '#3b82f6' });
      rows.push({ l: 'En palets cerrados', v: data.totalPallets });
      for (const [c, x] of Object.entries(data.byCarrier || {})) {
        if (!x || x.total === 0) continue;
        rows.push({ l: c, v: x.total, color: CARRIER_COLOR[c] });
      }
      html = rows.map(r => `
        <div class="va-live-row">
          <span class="l">${escapeHtml(r.l)}</span>
          <span class="v" ${r.color ? 'style="color:'+r.color+'"' : ''}>${fmtNum(r.v)}</span>
        </div>
      `).join('');
      $('liveGrid').innerHTML = html;
      $('liveTime').textContent = 'actualizado · ' + new Date().toLocaleTimeString('es-ES');
    } catch (e) {
      $('liveTime').textContent = 'error · ' + e.message;
    }
  }

  // ─── Verify barcode ───
  async function verifyBarcode() {
    const input = $('verifyInput').value.trim();
    if (!input) return;
    const out = $('verifyResult');
    out.innerHTML = '<span class="spinner"></span> Verificando…';
    try {
      const data = await apiGet('/api/detect-carrier/' + encodeURIComponent(input));
      let html = '';
      const row = (l, v, color) => `<div style="display:flex;gap:8px"><span style="color:var(--ink-3);min-width:90px">${l}</span><span ${color?'style="color:'+color+'"':''}>${v}</span></div>`;
      if (data.carrier) {
        const c = data.carrier;
        html += row('Carrier', `<strong>${c}</strong>`, CARRIER_COLOR[c]);
      } else {
        html += row('Carrier', 'No detectado', 'var(--red)');
      }
      if (data.picking) {
        const p = data.picking;
        const client = p.partner_id ? (Array.isArray(p.partner_id) ? p.partner_id[1] : p.partner_id) : '—';
        html += row('Picking ID', p.id || '—');
        html += row('Albarán', p.name || '—');
        html += row('Pedido', p.origin || '—');
        html += row('Cliente', client);
        html += row('Tracking', p.carrier_tracking_ref || '—');
      } else {
        html += row('Picking', 'No encontrado', 'var(--red)');
      }
      if (data.source) html += row('Fuente', data.source, 'var(--ink-3)');
      out.innerHTML = html;
    } catch (e) {
      out.innerHTML = '<span style="color:var(--red)">Error: ' + escapeHtml(e.message) + '</span>';
    }
  }

  // ─── Export Excel (mantiene formato SpreadsheetML existente) ───
  function exportExcel() {
    if (!state.report) return;
    const d = state.report;

    const sheet = rows => rows.map(row =>
      '<Row>' + row.map(cell => {
        const v = String(cell ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const t = (isNaN(cell) || cell === '') ? 'String' : 'Number';
        return `<Cell><Data ss:Type="${t}">${v}</Data></Cell>`;
      }).join('') + '</Row>'
    ).join('');

    const resumen = [
      ['INFORME DE COBERTURA · ILLICE BRANDS GROUP'],
      ['Periodo', d.from + ' → ' + d.to],
      ['Generado', new Date().toLocaleString('es-ES')],
      [],
      ['RESUMEN GLOBAL'],
      ['OUTs Odoo B2C', d.total],
      ['Escaneados', d.scanned],
      ['Sin escanear', d.missing],
      ['% Cobertura global', d.coverage.toFixed(2) + '%'],
      [],
      ['POR TRANSPORTISTA'],
      ['Carrier','OUTs','Escaneados','Sin escanear','% Cobertura'],
      ...Object.entries(d.byCarrier || {})
        .filter(([_, x]) => x.total > 0)
        .sort((a,b) => b[1].pct - a[1].pct)
        .map(([c, x]) => [c, x.total, x.scanned, x.missing, x.pct.toFixed(2) + '%']),
    ];

    const sinEscanear = [
      ['Carrier','Albarán','Pedido','Tracking','Cliente','Validado en Odoo'],
      ...state.allRecs.filter(r => !r.scanned).map(r =>
        [r.carrier, r.name||'', r.origin||'', r.tracking||'', r.client||'', r.dateDone||'']),
    ];

    const todos = [
      ['Carrier','Albarán','Pedido','Tracking','Cliente','Validado','Match','Estado'],
      ...state.allRecs.map(r => [
        r.carrier, r.name||'', r.origin||'', r.tracking||'', r.client||'',
        r.dateDone||'', r.matchSource||'', r.scanned ? 'Escaneado' : 'Sin escanear'
      ]),
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Resumen"><Table>${sheet(resumen)}</Table></Worksheet>
  <Worksheet ss:Name="Sin escanear"><Table>${sheet(sinEscanear)}</Table></Worksheet>
  <Worksheet ss:Name="Todos"><Table>${sheet(todos)}</Table></Worksheet>
</Workbook>`;
    const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cobertura-' + d.from + '-' + d.to + '.xls';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ─── Utils ───
  function escapeHtml(s) {
    return (s + '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

})();
