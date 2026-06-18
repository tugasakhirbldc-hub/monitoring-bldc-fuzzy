/* ════════════════════════════════════════════
   BLDC IoT Monitor — app.js
   Monitoring dan Kontrol Motor BLDC
   Fuzzy Logic Adaptive Control System

   MQTT Topic Structure:
   bldc/data/rpm        ← RPM aktual dari ESP32
   bldc/data/pwm        ← PWM output dari ESP32
   bldc/data/error      ← Steady-state error dari ESP32
   bldc/data/setpoint   ← Setpoint aktif di ESP32
   bldc/data/fuzzy      ← Tipe fuzzy aktif di ESP32
   bldc/data/level      ← Level beban aktif di ESP32
   bldc/data/overshoot  ← Overshoot dari ESP32

   bldc/control/start   ← Publish: jalankan motor (JSON)
   bldc/control/stop    ← Publish: stop motor (JSON)
   bldc/control/setpoint← Publish: setpoint saja (nilai)
   bldc/control/fuzzy   ← Publish: tipe fuzzy (string)
   bldc/control/level   ← Publish: level beban (int)

   bldc/status/heartbeat← Subscribe: heartbeat ESP32
   bldc/status/online   ← Subscribe: status online ESP32
════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────
   MQTT TOPIC CONSTANTS
────────────────────────────────────────── */
const TOPICS = {

  /* =========================================
     DATA DARI ESP32 → DASHBOARD
     ========================================= */
  DATA_RPM:        'bldc/data/rpm',
  DATA_PWM:        'bldc/data/pwm',
  DATA_ERROR:      'bldc/data/error',
  DATA_SETPOINT:   'bldc/data/setpoint',
  DATA_FUZZY:      'bldc/data/fuzzy',
  DATA_LEVEL:      'bldc/data/level',
  DATA_OVERSHOOT:  'bldc/data/overshoot',
  DATA_TIMESTAMP:  'bldc/data/timestamp',

  /* wildcard subscribe */
  DATA_ALL:        'bldc/data/#',


  /* =========================================
     STATUS ESP32
     ========================================= */
  STATUS_HEARTBEAT: 'bldc/status/heartbeat',
  STATUS_ONLINE:    'bldc/status/online',

  /* wildcard subscribe */
  STATUS_ALL:       'bldc/status/#',


  /* =========================================
     DASHBOARD → ESP32
     ========================================= */
  CTRL_START:      'bldc/control/start',
  CTRL_STOP:       'bldc/control/stop',
  CTRL_SETPOINT:   'bldc/control/setpoint',
  CTRL_FUZZY:      'bldc/control/fuzzy',
  CTRL_LEVEL:      'bldc/control/level',

  /* tambahan */
  CTRL_RESET:      'bldc/control/reset',
  CTRL_EMERGENCY:  'bldc/control/emergency',


  /* =========================================
     wildcard kontrol
     ========================================= */
  CTRL_ALL:        'bldc/control/#'
};

/* ──────────────────────────────────────────
   GLOBAL STATE
────────────────────────────────────────── */
let mqttClient       = null;
let motorRunning     = false;
let activeLevelVal   = 1;
let activeFuzzyVal   = 'mamdani';
let rpmMinVal        = Infinity;
let rpmMaxVal        = 0;
let peakRPM          = 0;
let currentSetpointVal = 0;
let msgCount         = 0;
let miniChart        = null;
let heartbeatTimer   = null;

/* data logger */
const allData = [];

/* ──────────────────────────────────────────
   CLOCK & DATE
────────────────────────────────────────── */
function updateClock() {
  const now = new Date();
  safeSet('clockDisplay', now.toLocaleTimeString('id-ID'));
  safeSet('dateDisplay',  now.toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }));
}
setInterval(updateClock, 1000);
updateClock();

/* ──────────────────────────────────────────
   PAGE ROUTING
────────────────────────────────────────── */
function showPage(pageKey, navEl, event) {
  if (event) event.stopPropagation();
  closeAllSubMenus();

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + pageKey);
  if (target) target.classList.add('active');

  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => {
    n.classList.remove('active', 'sub-open');
  });
  if (navEl) navEl.classList.add('active');

  if (pageKey === 'kontrol') setTimeout(initMiniChart, 60);
}

/* ──────────────────────────────────────────
   SUB-MENU TOGGLE
────────────────────────────────────────── */
function toggleSubMenu(menuId, navId, event) {
  event.stopPropagation();
  const menu  = document.getElementById(menuId);
  const nav   = document.getElementById(navId);
  const isOpen = menu.classList.contains('open');
  closeAllSubMenus();
  if (!isOpen) {
    menu.classList.add('open');
    nav.classList.add('sub-open', 'active');
  }
}

function closeAllSubMenus() {
  document.querySelectorAll('.sub-menu').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.nav-item.has-sub').forEach(n => n.classList.remove('sub-open'));
}

document.addEventListener('click', closeAllSubMenus);

/* ──────────────────────────────────────────
   TIPE FUZZY PAGE ROUTING
────────────────────────────────────────── */
let fuzzyChartsInited = { m: false, s: false, compare: false };

function showFuzzyMode(mode, event) {
  if (event) event.stopPropagation();
  closeAllSubMenus();

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-fuzzy').classList.add('active');

  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active','sub-open'));
  document.getElementById('nav-fuzzy').classList.add('active');

  document.getElementById('fuzzy-selector').style.display = 'none';
  document.querySelectorAll('.fuzzy-sub-page').forEach(p => p.style.display = 'none');

  if (mode === 'mamdani') {
    document.getElementById('fuzzy-mamdani').style.display = 'block';
    if (!fuzzyChartsInited.m) { initFuzzySubCharts(); fuzzyChartsInited.m = true; }
  } else if (mode === 'sugeno') {
    document.getElementById('fuzzy-sugeno').style.display = 'block';
    if (!fuzzyChartsInited.s) { initFuzzySubCharts(); fuzzyChartsInited.s = true; }
  } else {
    document.getElementById('fuzzy-compare').style.display = 'block';
    if (!fuzzyChartsInited.compare) { initCompareCharts(); fuzzyChartsInited.compare = true; }
  }
}

function backToFuzzySelector() {
  document.querySelectorAll('.fuzzy-sub-page').forEach(p => p.style.display = 'none');
  document.getElementById('fuzzy-selector').style.display = '';
}

/* ──────────────────────────────────────────
   FUZZY DATASET (static reference data)
────────────────────────────────────────── */
const fuzzyDataSet = {
  all: {
    m: [0.25,0.45,0.70,0.92,1.08,1.05,1.02,1.00,1.00,1.00],
    s: [0.40,0.65,0.85,0.98,1.04,1.02,1.00,1.00,1.00,1.00],
    metaM: 'Rise Time: 1.5s | Overshoot: 8% | SSE: 2.5%',
    metaS: 'Rise Time: 0.97s | Overshoot: 4% | SSE: 1.4%'
  },
  1: {
    m: [0.20,0.45,0.72,0.95,1.08,1.04,1.02,1.00,1.00,1.00],
    s: [0.35,0.62,0.84,0.98,1.02,1.01,1.00,1.00,1.00,1.00],
    metaM: 'Rise Time: 1.2s | Overshoot: 8% | SSE: 2.1%',
    metaS: 'Rise Time: 0.7s | Overshoot: 2% | SSE: 0.8%'
  },
  2: {
    m: [0.15,0.38,0.62,0.90,1.10,1.06,1.03,1.01,1.00,1.00],
    s: [0.30,0.55,0.78,0.96,1.04,1.02,1.01,1.00,1.00,1.00],
    metaM: 'Rise Time: 1.5s | Overshoot: 10% | SSE: 3.0%',
    metaS: 'Rise Time: 0.9s | Overshoot: 4% | SSE: 1.5%'
  },
  3: {
    m: [0.12,0.28,0.48,0.72,0.92,1.07,1.04,1.02,1.00,1.00],
    s: [0.20,0.42,0.65,0.82,0.96,1.07,1.03,1.01,1.00,1.00],
    metaM: 'Rise Time: 1.8s | Overshoot: 7% | SSE: 2.5%',
    metaS: 'Rise Time: 1.3s | Overshoot: 7% | SSE: 3.0%'
  }
};
const tLabels = ['0','0.3','0.6','0.9','1.2','1.5','1.8','2.1','2.4','2.7'];

const metricRows = [
  { beban:'Level 1', rtM:'1.2s', rtS:'0.7s', osM:'8%',  osS:'2%', sseM:'2.1%', sseS:'0.8%', win:'sugeno'  },
  { beban:'Level 2', rtM:'1.5s', rtS:'0.9s', osM:'10%', osS:'4%', sseM:'3.0%', sseS:'1.5%', win:'sugeno'  },
  { beban:'Level 3', rtM:'1.8s', rtS:'1.3s', osM:'7%',  osS:'7%', sseM:'2.5%', sseS:'3.0%', win:'mamdani' }
];

/* ──────────────────────────────────────────
   CHART FACTORY
────────────────────────────────────────── */
const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color:'#94a3c8', font:{ size:11 }, boxWidth:12 } } },
  scales: {
    x: { ticks:{ color:'#4a5888', font:{ size:10 }, maxRotation:0 }, grid:{ color:'rgba(80,140,255,0.07)' } },
    y: { ticks:{ color:'#4a5888', font:{ size:10 } },                 grid:{ color:'rgba(80,140,255,0.07)' }, beginAtZero: true }
  }
};

function makeFuzzyLineChart(canvasId, color, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  return new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: tLabels,
      datasets: [
        { label:'RPM',      data: data.map(v => v*100), borderColor:color, backgroundColor:color+'18', fill:true, tension:0.45, pointRadius:3, borderWidth:2.5 },
        { label:'Setpoint', data: Array(tLabels.length).fill(95),          borderColor:'#ef4444', borderDash:[5,4], borderWidth:1.5, pointRadius:0, fill:false }
      ]
    },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x },
        y: { ...chartDefaults.scales.y, beginAtZero:false, min:0, max:115, title:{ display:true, text:'RPM (%)', color:'#4a5888', font:{ size:10 } } }
      }
    }
  });
}

function makeMFChart(canvasId, gaussian = false) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  const colors  = ['#ef4444','#f97316','#10b981','#3b82f6','#8b5cf6'];
  const labels  = [];
  for (let i = -1; i <= 1.001; i += 0.04) labels.push(i.toFixed(2));
  const centers = [-1,-0.5,0,0.5,1];

  function tri(x, a, b, c) {
    if (x <= a || x >= c) return 0;
    return x <= b ? (x-a)/(b-a) : (c-x)/(c-b);
  }
  function gauss(x, c, s) { return Math.exp(-0.5*((x-c)/s)**2); }

  const names    = ['NB','NS','Z','PS','PB'];
  const datasets = names.map((n, i) => ({
    label: n,
    data: labels.map(x => {
      const xf = parseFloat(x);
      return gaussian ? gauss(xf, centers[i], 0.28) : tri(xf, centers[i]-0.5, centers[i], centers[i]+0.5);
    }),
    borderColor: colors[i], backgroundColor: colors[i]+'25',
    fill: true, tension: gaussian ? 0.5 : 0.1, pointRadius: 0, borderWidth: 2
  }));

  return new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...chartDefaults,
      scales: {
        x: { ...chartDefaults.scales.x, title:{ display:true, text:'Error (e)', color:'#4a5888', font:{ size:10 } } },
        y: { ...chartDefaults.scales.y, beginAtZero:false, min:0, max:1.05, title:{ display:true, text:'μ (derajat)', color:'#4a5888', font:{ size:10 } } }
      }
    }
  });
}

/* ──────────────────────────────────────────
   RULE MATRIX
────────────────────────────────────────── */
const errL = ['NB','NS','Z','PS','PB'];
const delL = ['NB','NS','Z','PS','PB'];
const ruleData = [
  ['VR','VR','R','R','S'],
  ['VR','R','R','S','T'],
  ['R','R','S','T','T'],
  ['R','S','T','T','VT'],
  ['S','T','T','VT','VT']
];
const ruleClass = { VR:'rp-vr', R:'rp-r', S:'rp-s', T:'rp-t', VT:'rp-vt' };

function buildRuleMatrix(tableId) {
  const tbl = document.getElementById(tableId);
  if (!tbl) return;
  let h = '<thead><tr><th>Error \\ ΔError</th>';
  delL.forEach(d => h += `<th>${d}</th>`);
  h += '</tr></thead><tbody>';
  ruleData.forEach((row, ri) => {
    h += `<tr><td>${errL[ri]}</td>`;
    row.forEach(c => h += `<td><span class="${ruleClass[c]}">${c}</span></td>`);
    h += '</tr>';
  });
  h += '</tbody>';
  tbl.innerHTML = h;
}

/* ──────────────────────────────────────────
   METRIC TABLES
────────────────────────────────────────── */
function renderMetricSingle(bodyId, filter, type) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const rows = filter === 'all' ? metricRows : metricRows.filter((_,i) => String(i+1) === filter);
  body.innerHTML = rows.map(d => `
    <tr>
      <td><b>${d.beban}</b></td>
      <td>${type === 'm' ? d.rtM  : d.rtS}</td>
      <td>${type === 'm' ? d.osM  : d.osS}</td>
      <td>${type === 'm' ? d.sseM : d.sseS}</td>
      <td><span class="badge ${type === 'm' ? 'badge-blue' : 'badge-green'}">${type === 'm' ? 'Mamdani' : 'Sugeno'}</span></td>
    </tr>`).join('');
}

function renderMetricCompare(bodyId, filter) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const rows = filter === 'all' ? metricRows : metricRows.filter((_,i) => String(i+1) === filter);
  body.innerHTML = rows.map(d => `
    <tr>
      <td><b>${d.beban}</b></td>
      <td>${d.rtM}</td><td>${d.rtS}</td>
      <td>${d.osM}</td><td>${d.osS}</td>
      <td>${d.sseM}</td><td>${d.sseS}</td>
      <td><span class="badge ${d.win === 'sugeno' ? 'badge-green' : 'badge-blue'}">${d.win === 'sugeno' ? 'Sugeno' : 'Mamdani'}</span></td>
    </tr>`).join('');
}

/* ──────────────────────────────────────────
   FUZZY SUB-PAGE CHARTS
────────────────────────────────────────── */
let cMPage = null, mfMChart = null;
let cSPage = null, mfSChart = null;

function initFuzzySubCharts() {
  if (!cMPage) {
    cMPage   = makeFuzzyLineChart('chartMamdani', '#3b82f6', fuzzyDataSet.all.m);
    mfMChart = makeMFChart('mfMamdani', false);
    buildRuleMatrix('ruleMamdani');
    renderMetricSingle('metricMBody', 'all', 'm');
  }
  if (!cSPage) {
    cSPage   = makeFuzzyLineChart('chartSugeno', '#10b981', fuzzyDataSet.all.s);
    mfSChart = makeMFChart('mfSugeno', true);
    buildRuleMatrix('ruleSugeno');
    renderMetricSingle('metricSBody', 'all', 's');
  }
}

function filterFuzzyPage(level, btn, type) {
  const groupId = type === 'm' ? 'filterM' : 'filterS';
  document.querySelectorAll(`#${groupId} .fbtn`).forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const d   = fuzzyDataSet[level === 'all' ? 'all' : level];
  const key = level === 'all' ? 'all' : level;

  if (type === 'm' && cMPage) {
    cMPage.data.datasets[0].data = d.m.map(v => v*100);
    cMPage.update();
    safeSet('metaMamdani', d.metaM);
    renderMetricSingle('metricMBody', key, 'm');
  }
  if (type === 's' && cSPage) {
    cSPage.data.datasets[0].data = d.s.map(v => v*100);
    cSPage.update();
    safeSet('metaSugeno', d.metaS);
    renderMetricSingle('metricSBody', key, 's');
  }
}

/* ──────────────────────────────────────────
   COMPARE CHARTS
────────────────────────────────────────── */
let cCmpM = null, cCmpS = null;

function initCompareCharts() {
  if (cCmpM) return;
  cCmpM = makeFuzzyLineChart('chartCmpM', '#3b82f6', fuzzyDataSet.all.m);
  cCmpS = makeFuzzyLineChart('chartCmpS', '#10b981', fuzzyDataSet.all.s);
  renderMetricCompare('metricCmpBody', 'all');
}

function filterCompare(level, btn) {
  document.querySelectorAll('#filterC .fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const d = fuzzyDataSet[level === 'all' ? 'all' : level];
  if (cCmpM) { cCmpM.data.datasets[0].data = d.m.map(v => v*100); cCmpM.update(); }
  if (cCmpS) { cCmpS.data.datasets[0].data = d.s.map(v => v*100); cCmpS.update(); }
  safeSet('metaCmpM', d.metaM);
  safeSet('metaCmpS', d.metaS);
  renderMetricCompare('metricCmpBody', level === 'all' ? 'all' : level);
}

/* ──────────────────────────────────────────
   DASHBOARD CHARTS
────────────────────────────────────────── */
const rpmHistory = [];
let rpmChart = null;

const rpmCanvas = document.getElementById('rpmChart');
if (rpmCanvas) {
  rpmChart = new Chart(rpmCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: ['','','','','','','','','',''],
      datasets: [
        {
          label: 'RPM Aktual',
          data: [0,0,0,0,0,0,0,0,0,0],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.08)',
          fill: true, tension: 0.45, pointRadius: 3,
          pointBackgroundColor: '#3b82f6', borderWidth: 2.5
        },
        {
          label: 'Setpoint',
          data: [0,0,0,0,0,0,0,0,0,0],
          borderColor: '#ef4444',
          borderDash: [5,4], borderWidth: 1.5, pointRadius: 0, fill: false
        }
      ]
    },
    options: chartDefaults
  });
}

/* Speedometer */
let gaugeChart = null;
const gaugeCanvas = document.getElementById('gaugeChart');
if (gaugeCanvas) {
  gaugeChart = new Chart(gaugeCanvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [1, 99],
        backgroundColor: ['#3b82f6', 'rgba(255,255,255,0.05)'],
        borderWidth: 0, circumference: 180, rotation: 270, cutout: '75%'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    },
    plugins: [{
      id: 'gaugeLabel',
      afterDraw(chart) {
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = '700 36px Rajdhani';
        ctx.fillStyle = '#93c5fd';
        ctx.textAlign = 'center';
        ctx.fillText(document.getElementById('mRPM')?.textContent || '0', chart.width/2, chart.height/1.26);
        ctx.font = '13px Rajdhani';
        ctx.fillStyle = '#94a3c8';
        ctx.fillText('RPM', chart.width/2, chart.height/1.12);
        ctx.restore();
      }
    }]
  });
}

/* ──────────────────────────────────────────
   MINI RPM CHART (kontrol page)
────────────────────────────────────────── */
const miniHistory = [];

function initMiniChart() {
  if (miniChart) return;
  const ctx = document.getElementById('miniRpmChart');
  if (!ctx) return;
  miniChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: ['','','','','','','','','',''],
      datasets: [{
        data: [0,0,0,0,0,0,0,0,0,0],
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6,182,212,0.08)',
        fill: true, tension: 0.45, pointRadius: 2, borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { ticks:{ color:'#4a5888', font:{ size:9 } }, grid:{ color:'rgba(80,140,255,0.07)' } }
      }
    }
  });
}

/* ──────────────────────────────────────────
   MQTT INTEGRATION
   Menggunakan WSS (port 8884) untuk HiveMQ Cloud
────────────────────────────────────────── */
function setMqttUI(online) {
  const dot    = document.getElementById('mqttDot');
  const pill   = document.getElementById('mqttPill');
  const text   = document.getElementById('mqttStatusText');
  const brokerS = document.getElementById('mqttBrokerStatus');
  const connS   = document.getElementById('mqttConnStatus');

  if (online) {
    dot.className    = 'mqtt-dot online';
    pill.className   = 'mqtt-pill online';
    text.textContent = 'MQTT Online';
    if (brokerS) brokerS.innerHTML = '<span class="dot green"></span>Terhubung';
    if (connS)   connS.innerHTML   = '<span class="dot green"></span>Online';
  } else {
    dot.className    = 'mqtt-dot';
    pill.className   = 'mqtt-pill';
    text.textContent = 'MQTT Offline';
    if (brokerS) brokerS.innerHTML = '<span class="dot red"></span>Offline';
    if (connS)   connS.innerHTML   = '<span class="dot red"></span>Offline';
  }
}

function connectMQTT() {
  if (mqttClient) {
    try { mqttClient.end(true); } catch(e) {}
    mqttClient = null;
  }

  const host = document.getElementById('mqttHost').value.trim();
  const port = parseInt(document.getElementById('mqttPort').value.trim()) || 8884;
  const user = document.getElementById('mqttUser').value.trim();
  const pass = document.getElementById('mqttPass').value.trim();

  /* HiveMQ Cloud memerlukan WSS (WebSocket Secure) */
  const brokerUrl = `wss://${host}:${port}/mqtt`;

  /* Update display info */
  safeSet('mqttHostDisplay', `${host}:${port}`);
  safeSet('mqttConnBroker', `${host}:${port}`);
  safeSet('mqttStatusText', 'Menghubungkan...');

  const clientId = 'bldc_web_' + Math.random().toString(16).substr(2, 8);

  mqttClient = mqtt.connect(brokerUrl, {
    clientId:        clientId,
    username:        user,
    password:        pass,
    reconnectPeriod: 5000,
    connectTimeout:  10000,
    clean:           true
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] Connected to', brokerUrl);
    setMqttUI(true);

    /* Subscribe ke semua data dan status */
    const subscribeTopics = [
      TOPICS.DATA_ALL,
      TOPICS.STATUS_ALL
    ];
    subscribeTopics.forEach(t => {
      mqttClient.subscribe(t, { qos: 1 }, (err) => {
        if (err) {
          console.error('[MQTT] Subscribe error:', t, err);
        } else {
          console.log('[MQTT] Subscribed to:', t);
        }
      });
    });

    addMqttLog(`✓ Connected → ${host}:${port} | Client: ${clientId}`);
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
    setMqttUI(false);
    addMqttLog(`✗ Error: ${err.message}`);
  });

  mqttClient.on('offline', () => {
    setMqttUI(false);
    addMqttLog('⚠ Koneksi terputus — mencoba reconnect...');
  });

  mqttClient.on('reconnect', () => {
    safeSet('mqttStatusText', 'Reconnecting...');
    addMqttLog('↻ Reconnecting...');
  });

  mqttClient.on('close', () => {
    setMqttUI(false);
  });

  mqttClient.on('message', handleMqttMessage);
}

function disconnectMQTT() {
  if (mqttClient) {
    try { mqttClient.end(true); } catch(e) {}
    mqttClient = null;
  }
  setMqttUI(false);
  addMqttLog('○ Disconnected by user');
}

/* ──────────────────────────────────────────
   MQTT MESSAGE HANDLER
   Routing berdasarkan topic structure:
   bldc/data/rpm, bldc/data/pwm, dst.
────────────────────────────────────────── */
function handleMqttMessage(topic, message) {
  const raw = message.toString().trim();

  msgCount++;
  const timeStr = new Date().toLocaleTimeString('id-ID');

  safeSet('mqttMsgCount',     msgCount);
  safeSet('mqttConnMsgCount', msgCount);
  safeSet('lastMsg',          timeStr);
  safeSet('mqttConnLastTime', timeStr);
  safeSet('lastUpdate',       timeStr);

  addMqttLog(`↓ [${topic}] ${raw.length > 60 ? raw.substring(0,60)+'...' : raw}`);

  /* ── Route berdasarkan topic ── */
  switch (topic) {

    /* Data dari ESP32 */
    case TOPICS.DATA_RPM:
      processRPM(parseFloat(raw));
      break;

    case TOPICS.DATA_PWM:
      processPWM(parseFloat(raw));
      break;

    case TOPICS.DATA_ERROR:
      processError(parseFloat(raw));
      break;

    case TOPICS.DATA_SETPOINT:
      processSetpoint(parseFloat(raw));
      break;

    case TOPICS.DATA_OVERSHOOT:
      processOvershoot(parseFloat(raw));
      break;
    
    case TOPICS.DATA_TIMESTAMP:
      processTimestamp(raw);
      break;

    case TOPICS.DATA_FUZZY:
      processFuzzyType(raw);
      break;

    case TOPICS.DATA_LEVEL:
      processLevel(parseInt(raw));
      break;

    /* Status ESP32 */
    case TOPICS.STATUS_HEARTBEAT:
      processHeartbeat(raw);
      break;

    case TOPICS.STATUS_ONLINE:
      processOnlineStatus(raw);
      break;

    default:
      /* Fallback: coba parse JSON jika topic bldc/data (tanpa sub) */
      if (topic.startsWith('bldc/data') && raw.startsWith('{')) {
        try {
          const obj = JSON.parse(raw);
          if (obj.rpm       !== undefined) processRPM(parseFloat(obj.rpm));
          if (obj.pwm       !== undefined) processPWM(parseFloat(obj.pwm));
          if (obj.error     !== undefined) processError(parseFloat(obj.error));
          if (obj.setpoint  !== undefined) processSetpoint(parseFloat(obj.setpoint));
          if (obj.overshoot !== undefined) processOvershoot(parseFloat(obj.overshoot));
          if (obj.fuzzy     !== undefined) processFuzzyType(obj.fuzzy);
          if (obj.level     !== undefined) processLevel(parseInt(obj.level));
          if (obj.timestamp !== undefined) processTimestamp(obj.timestamp);
        } catch(e) {
          console.warn('[MQTT] JSON parse failed for topic:', topic);
        }
      }
      break;
  }
}

/* ──────────────────────────────────────────
   TOPIC PROCESSORS
────────────────────────────────────────── */

function processRPM(rpm) {
  if (isNaN(rpm)) return;

  /* Peak tracking */
  if (rpm > peakRPM) peakRPM = rpm;

  /* Update UI cards */
  safeSet('mRPM', rpm.toFixed(1));
  safeSet('miniRpmVal', rpm.toFixed(1));
  safeStyle('barRPM', 'width', Math.min((rpm / 450 * 100), 100).toFixed(1) + '%');

  /* RPM Min/Max */
  if (rpm < rpmMinVal) { rpmMinVal = rpm; safeSet('rpmMin', rpm.toFixed(1)); }
  if (rpm > rpmMaxVal) { rpmMaxVal = rpm; safeSet('rpmMax', rpm.toFixed(1)); }

  /* Speedometer */
  if (gaugeChart) {
    const pct = Math.min((rpm / 450) * 100, 100);
    gaugeChart.data.datasets[0].data = [pct, 100 - pct];
    gaugeChart.update();
  }

  /* Main RPM chart */
  rpmHistory.push(rpm);
  if (rpmHistory.length > 25) rpmHistory.shift();
  if (rpmChart) {
    rpmChart.data.labels        = rpmHistory.map((_, i) => i);
    rpmChart.data.datasets[0].data = [...rpmHistory];
    rpmChart.data.datasets[1].data = Array(rpmHistory.length).fill(currentSetpointVal);
    rpmChart.update();
  }

  /* Mini chart */
  miniHistory.push(rpm);
  if (miniHistory.length > 15) miniHistory.shift();
  if (miniChart) {
    miniChart.data.datasets[0].data = [...miniHistory];
    miniChart.data.labels           = miniHistory.map((_, i) => i);
    miniChart.update('none');
  }

  /* Data logger */
  logData(rpm);
}

function processPWM(pwm) {
  if (isNaN(pwm)) return;
  safeSet('mPWM', pwm.toFixed(0));
  safeSet('miniPwmVal', pwm.toFixed(0));
  safeStyle('barPWM', 'width', Math.min((pwm / 255 * 100), 100).toFixed(1) + '%');
}

function processError(error) {
  if (isNaN(error)) return;
  safeSet('mError', error.toFixed(1));
  safeStyle('barError', 'width', Math.min(Math.abs(error), 100) + '%');
}

function processSetpoint(setpoint) {
  if (isNaN(setpoint)) return;
  currentSetpointVal = setpoint;
  peakRPM = 0; /* reset peak saat setpoint berubah */
  safeSet('mSetpoint', setpoint.toFixed(0));
  safeSet('activeSetpoint', setpoint.toFixed(0) + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((setpoint / 450 * 100), 100).toFixed(1) + '%');
}

function processOvershoot(overshoot) {
  if (isNaN(overshoot)) return;
  safeSet('overshootVal', overshoot.toFixed(1));
  safeSet('miniOvershootVal', overshoot.toFixed(1));
  safeStyle('barOvershoot', 'width', Math.min(overshoot, 100) + '%');
}

function processFuzzyType(fuzzyType) {
  if (!fuzzyType) return;
  const display = fuzzyType.charAt(0).toUpperCase() + fuzzyType.slice(1);
  activeFuzzyVal = fuzzyType.toLowerCase();
  safeSet('dashFuzzyBadge', 'Fuzzy: ' + display);
  safeSet('activeFuzzy', display);
}

function processLevel(level) {
  if (isNaN(level)) return;
  safeSet('dashLevel', level);
  safeSet('activeLevel', 'Level ' + level);
}

function processTimestamp(timestamp) {
  if (!timestamp) return;
  safeSet('espTimestamp', timestamp);
  window.lastTimestamp = timestamp;
}

/* ESP32 Status */
function processHeartbeat(raw) {
  safeHTML('esp32Heartbeat', '<span class="dot green"></span>Active');
  safeSet('esp32LastBeat', new Date().toLocaleTimeString('id-ID'));

  /* Reset heartbeat timeout */
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    safeHTML('esp32Heartbeat', '<span class="dot amber"></span>Timeout');
  }, 10000); /* 10 detik tanpa heartbeat = timeout */
}

function processOnlineStatus(raw) {
  const isOnline = raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'online';
  if (isOnline) {
    safeHTML('esp32Online', '<span class="dot green"></span>Online');
  } else {
    safeHTML('esp32Online', '<span class="dot red"></span>Offline');
  }
}

/* ──────────────────────────────────────────
   DATA LOGGER
────────────────────────────────────────── */
function logData(rpm) {
  const fuzzy = document.getElementById('activeFuzzy')?.textContent || 'Mamdani';
  const sp    = document.getElementById('mSetpoint')?.textContent  || '0';
  const pwm   = document.getElementById('mPWM')?.textContent       || '0';
  const err   = document.getElementById('mError')?.textContent     || '0';
  const os    = document.getElementById('overshootVal')?.textContent || '0';
  const level = 'L' + activeLevelVal;

  allData.unshift({
  time: window.lastTimestamp ||
        new Date().toLocaleTimeString('id-ID'),
    rpm:       rpm.toFixed(1),
    sp, pwm, err, overshoot: os,
    type:      fuzzy,
    beban:     level
  });

  if (allData.length > 100) allData.pop();
  renderDataTable(allData);
  updateStats();
}

/* ──────────────────────────────────────────
   MQTT LOG
────────────────────────────────────────── */
const mqttLogLines = [];

function addMqttLog(msg) {
  const timeStr = new Date().toLocaleTimeString('id-ID');
  mqttLogLines.unshift(`${timeStr} — ${msg}`);
  if (mqttLogLines.length > 5) mqttLogLines.pop();

  const logEl = document.getElementById('mqttLog');
  if (!logEl) return;
  logEl.innerHTML = mqttLogLines.map(l =>
    `<div class="log-line">${l}</div>`
  ).join('');
}

/* ──────────────────────────────────────────
   KONTROL — SETPOINT SYNC
────────────────────────────────────────── */
function syncSlider() {
  const val = document.getElementById('spRPM').value;
  safeSet('spRPMVal', val);
  const inp = document.getElementById('spRPMInput');
  if (inp) inp.value = val;
  updatePreview();
}

function syncSliderInput() {
  const raw = document.getElementById('spRPMInput').value;
  const val = Math.min(450, Math.max(0, parseInt(raw) || 0));
  const slider = document.getElementById('spRPM');
  if (slider) slider.value = val;
  safeSet('spRPMVal', val);
  updatePreview();
}

/* ──────────────────────────────────────────
   KONTROL — FUZZY TYPE SELECTOR
────────────────────────────────────────── */
function selectFuzzyType(type) {
  activeFuzzyVal = type;
  document.getElementById('fuzzyType').value = type;

  const optM = document.getElementById('fuzzyOptM');
  const optS = document.getElementById('fuzzyOptS');
  const chkM = document.getElementById('checkM');
  const chkS = document.getElementById('checkS');

  if (type === 'mamdani') {
    optM.style.borderColor = 'rgba(59,130,246,0.45)';
    optM.style.background  = 'rgba(59,130,246,0.15)';
    optS.style.borderColor = 'var(--border)';
    optS.style.background  = 'transparent';
    if (chkM) chkM.style.opacity = '1';
    if (chkS) chkS.style.opacity = '0';
    optM.querySelector('.fo-name').style.color = '#93c5fd';
    optS.querySelector('.fo-name').style.color = 'var(--text-hi)';
  } else {
    optS.style.borderColor = 'rgba(16,185,129,0.45)';
    optS.style.background  = 'rgba(16,185,129,0.12)';
    optM.style.borderColor = 'var(--border)';
    optM.style.background  = 'transparent';
    if (chkS) chkS.style.opacity = '1';
    if (chkM) chkM.style.opacity = '0';
    optS.querySelector('.fo-name').style.color = '#6ee7b7';
    optM.querySelector('.fo-name').style.color = 'var(--text-hi)';
  }

  updatePreview();
}

/* ──────────────────────────────────────────
   KONTROL — LEVEL SELECTOR
────────────────────────────────────────── */
function selectLevel(n, btn) {
  activeLevelVal = n;
  document.querySelectorAll('.level-btns .level-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  safeSet('dashLevel', n);
  updatePreview();
}

/* ──────────────────────────────────────────
   MQTT PREVIEW UPDATE
────────────────────────────────────────── */
function updatePreview() {
  const sp  = document.getElementById('spRPM')?.value     || '0';
  const ft  = document.getElementById('fuzzyType')?.value || 'mamdani';

  /* Preview untuk bldc/control/start */
  safeSet('prevSetpoint',  sp);
  safeSet('prevFuzzy',    `"${ft}"`);
  safeSet('prevLevel',     activeLevelVal);

  /* Preview untuk individual topics */
  safeSet('prevSetpoint2', sp);
  safeSet('prevFuzzy2',   `"${ft}"`);
  safeSet('prevLevel2',    activeLevelVal);
}

/* ──────────────────────────────────────────
   MOTOR CONTROL
────────────────────────────────────────── */
function runMotor() {

  if (!mqttClient || !mqttClient.connected) {
    alert('MQTT belum terhubung!');
    return;
  }

  peakRPM = 0;

  const setpoint = parseInt(document.getElementById('spRPM').value) || 0;
  const fuzzy = document.getElementById('fuzzyType').value || 'mamdani';

  /* kirim parameter */
  mqttClient.publish(
    TOPICS.CTRL_SETPOINT,
    String(setpoint),
    { qos: 1, retain: true }
  );

  mqttClient.publish(
    TOPICS.CTRL_FUZZY,
    fuzzy,
    { qos: 1, retain: true }
  );

  mqttClient.publish(
    TOPICS.CTRL_LEVEL,
    String(activeLevelVal),
    { qos: 1, retain: true }
  );

  /* perintah start */
  mqttClient.publish(
    TOPICS.CTRL_START,
    '1',
    { qos: 1 }
  );

  addMqttLog(`↑ [${TOPICS.CTRL_SETPOINT}] ${setpoint}`);
  addMqttLog(`↑ [${TOPICS.CTRL_FUZZY}] ${fuzzy}`);
  addMqttLog(`↑ [${TOPICS.CTRL_LEVEL}] ${activeLevelVal}`);
  addMqttLog(`↑ [${TOPICS.CTRL_START}] 1`);

  motorRunning = true;

  safeSet('motorStatusBadge', '● Running');
  setElem('motorStatusBadge', el => el.className = 'badge badge-green');

  safeHTML('motorStatusText',
    '<span class="dot green"></span>Running'
  );

  safeSet('activeSetpoint', setpoint + ' RPM');

  safeSet(
    'activeFuzzy',
    fuzzy.charAt(0).toUpperCase() + fuzzy.slice(1)
  );

  safeSet(
    'activeLevel',
    'Level ' + activeLevelVal
  );

  safeSet(
    'dashFuzzyBadge',
    'Fuzzy: ' +
    fuzzy.charAt(0).toUpperCase() +
    fuzzy.slice(1)
  );

  safeSet('dashStatusBadge', '● Running');
}

function confirmStop() {

  closeConfirm();

  if (mqttClient && mqttClient.connected) {

    mqttClient.publish(
      TOPICS.CTRL_STOP,
      '1',
      { qos: 1 }
    );

    addMqttLog(`↑ [${TOPICS.CTRL_STOP}] 1`);
  }

  peakRPM = 0;
  motorRunning = false;

  safeSet('motorStatusBadge', '● Stopped');

  setElem(
    'motorStatusBadge',
    el => el.className = 'badge badge-red'
  );

  safeHTML(
    'motorStatusText',
    '<span class="dot red"></span>Stopped'
  );

  safeSet('activeSetpoint', '—');
  safeSet('activeFuzzy', '—');
  safeSet('activeLevel', '—');
  safeSet('dashStatusBadge', '● Stopped');
}

/* ──────────────────────────────────────────
   TELEMETRY
────────────────────────────────────────── */
function renderDataTable(data) {
  const body = document.getElementById('dataTableBody');
  if (!body) return;

  body.innerHTML = data.slice(0, 100).map((d, i) => `
    <tr>
      <td style="color:var(--text-lo)">${i+1}</td>
      <td style="font-family:'Rajdhani',sans-serif">${d.time}</td>
      <td><b>${d.rpm}</b></td>
      <td>${d.sp}</td>
      <td>${d.pwm}</td>
      <td><span class="badge ${parseFloat(d.err) > 20 ? 'badge-red' : parseFloat(d.err) > 10 ? 'badge-amber' : 'badge-green'}">${d.err}</span></td>
      <td><span class="badge ${parseFloat(d.overshoot || 0) > 10 ? 'badge-amber' : 'badge-green'}">${d.overshoot || '0'}</span></td>
      <td><span class="badge ${d.type === 'Sugeno' ? 'badge-green' : 'badge-blue'}">${d.type}</span></td>
      <td><span class="badge badge-cyan">${d.beban}</span></td>
    </tr>`).join('');

  safeSet('dataCount', data.length + ' entri');
}

function updateStats() {
  const total = allData.length;
  safeSet('statTotal', total);
  if (total === 0) return;

  const avgRPM = allData.reduce((s,d) => s + parseFloat(d.rpm), 0) / total;
  safeSet('statAvgRPM', avgRPM.toFixed(1));

  const mRows = allData.filter(d => d.type.toLowerCase() === 'mamdani');
  const sRows = allData.filter(d => d.type.toLowerCase() === 'sugeno');

  if (mRows.length) {
    const avgM = mRows.reduce((s,d) => s + Math.abs(parseFloat(d.err)), 0) / mRows.length;
    safeSet('statErrM', avgM.toFixed(1) + '%');
  }
  if (sRows.length) {
    const avgS = sRows.reduce((s,d) => s + Math.abs(parseFloat(d.err)), 0) / sRows.length;
    safeSet('statErrS', avgS.toFixed(1) + '%');
  }
}

function applyFilter() {
  const beban  = document.getElementById('filterBeban')?.value || 'all';
  const fuzzyF = document.getElementById('filterFuzzy')?.value || 'all';

  let filtered = [...allData];
  if (beban  !== 'all') filtered = filtered.filter(d => d.beban === beban);
  if (fuzzyF !== 'all') filtered = filtered.filter(d => d.type.toLowerCase() === fuzzyF.toLowerCase());
  renderDataTable(filtered);
}

function resetFilter() {
  ['filterBeban','filterFuzzy','filterDateStart','filterDateEnd'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = el.tagName === 'SELECT' ? 'all' : '';
  });
  renderDataTable(allData);
}

function triggerImport() { document.getElementById('csvImport').click(); }

function handleImport(e) {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const lines = ev.target.result.split('\n').slice(1);
    let imported = 0;
    lines.forEach(line => {
      const cols = line.split(',');
      if (cols.length >= 7) {
        allData.push({
          time:      cols[0]?.trim() || '--',
          rpm:       cols[1]?.trim() || '0',
          sp:        cols[2]?.trim() || '0',
          pwm:       cols[3]?.trim() || '0',
          err:       cols[4]?.trim() || '0',
          overshoot: cols[5]?.trim() || '0',
          type:      cols[6]?.trim() || 'Mamdani',
          beban:     cols[7]?.trim() || 'L1'
        });
        imported++;
      }
    });
    renderDataTable(allData);
    updateStats();
    alert(`Import berhasil: ${imported} data dari "${f.name}"`);
  };
  reader.readAsText(f);
}

function exportCSV() {
  const headers = 'Waktu,RPM,Setpoint,PWM,Error,Overshoot,Tipe Fuzzy,Beban\n';
  const rows    = allData.map(d =>
    `${d.time},${d.rpm},${d.sp},${d.pwm},${d.err},${d.overshoot || '0'},${d.type},${d.beban}`
  ).join('\n');
  const blob = new Blob([headers + rows], { type:'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'bldc_data_logger.csv';
  a.click();
}

/* ──────────────────────────────────────────
   MQTT CONFIG SAVE / LOAD
────────────────────────────────────────── */
function saveMQTTConfig() {
  ['mqttHost','mqttPort','mqttUser','mqttPass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) localStorage.setItem('bldc_' + id, el.value);
  });
  alert('Konfigurasi MQTT tersimpan!');
}

window.addEventListener('load', () => {
  /* Load saved config */
  ['mqttHost','mqttPort','mqttUser','mqttPass'].forEach(id => {
    const saved = localStorage.getItem('bldc_' + id);
    const el    = document.getElementById(id);
    if (saved && el) el.value = saved;
  });

  updatePreview();
  initFuzzySubCharts();
  initCompareCharts();

  /* Auto-connect jika config tersimpan */
  if (localStorage.getItem('bldc_mqttHost')) {
    setTimeout(() => {
      try { connectMQTT(); } catch(e) { console.warn('Auto-connect failed:', e); }
    }, 800);
  }
});

/* ──────────────────────────────────────────
   HELPER UTILITIES
────────────────────────────────────────── */
function safeSet(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
function safeHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
function safeStyle(id, prop, val) {
  const el = document.getElementById(id);
  if (el) el.style[prop] = val;
}
function setElem(id, fn) {
  const el = document.getElementById(id);
  if (el) fn(el);
}

/* ──────────────────────────────────────────
   EXPOSE GLOBALS (untuk onclick handlers di HTML)
────────────────────────────────────────── */
window.showPage            = showPage;
window.toggleSubMenu       = toggleSubMenu;
window.showFuzzyMode       = showFuzzyMode;
window.backToFuzzySelector = backToFuzzySelector;
window.filterFuzzyPage     = filterFuzzyPage;
window.filterCompare       = filterCompare;
window.selectFuzzyType     = selectFuzzyType;
window.selectLevel         = selectLevel;
window.syncSlider          = syncSlider;
window.syncSliderInput     = syncSliderInput;
window.runMotor            = runMotor;
window.askStop             = askStop;
window.closeConfirm        = closeConfirm;
window.confirmStop         = confirmStop;
window.connectMQTT         = connectMQTT;
window.disconnectMQTT      = disconnectMQTT;
window.saveMQTTConfig      = saveMQTTConfig;
window.applyFilter         = applyFilter;
window.resetFilter         = resetFilter;
window.triggerImport       = triggerImport;
window.handleImport        = handleImport;
window.exportCSV           = exportCSV;