'use strict';

const TOPICS = {
  DATA_ALL:        'bldc/data/#',
  DATA_RPM:        'bldc/data/rpm',
  CTRL_START:      'bldc/control/start',
  CTRL_STOP:       'bldc/control/stop',
  CTRL_SETPOINT:   'bldc/control/setpoint',
  CTRL_FUZZY:      'bldc/control/fuzzy',
  CTRL_LEVEL:      'bldc/control/level'
};

let mqttClient         = null;
let motorRunning       = false;
let activeLevelVal     = 'N';
let activeFuzzyVal     = 'sugeno'; 
let currentSetpointVal = 100;
let peakRPM            = 0;
let msgCount           = 0;

// Variabel Real-Time (Rise Time & SSE)
let startTime          = 0;
let sysRiseTime        = 0;
let isRising           = false;

let rpmMinVal = Infinity;
let rpmMaxVal = 0;

let rpmChart, gaugeChart, miniChart;
let cMPage, cSPage, cCmpM, cCmpS, mfMChart, mfSChart;

// Variabel Perekam 60-Detik Fuzzy
let liveHistoryRpm = [];
let liveHistorySp  = [];
let liveHistoryLbl = [];
let isFuzzyRecording = false;
let fuzzyTimeCounter = 0;

// Array History Grafik (DENGAN PENAMPUNG WAKTU)
const rpmHistory  = Array(30).fill(0);
const rpmTimeLabels = Array(30).fill(''); // <-- Ini yang menyebabkan crash sebelumnya jika hilang!
const miniHistory = Array(15).fill(0);
const allData = [];

function safeSet(id, value) { const el=document.getElementById(id); if(el) el.textContent=value; }
function safeHTML(id, html) { const el=document.getElementById(id); if(el) el.innerHTML=html; }
function safeStyle(id, prop, val) { const el=document.getElementById(id); if(el) el.style[prop]=val; }

function updateClock() {
  const now = new Date();
  safeSet('clockDisplay', now.toLocaleTimeString('id-ID'));
  safeSet('dateDisplay',  now.toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }));
}
setInterval(updateClock, 1000); updateClock();

function showPage(pageKey, navEl, event) {
  if (event) event.stopPropagation();
  document.querySelectorAll('.sub-menu').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageKey).classList.add('active');
  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active', 'sub-open'));
  if (navEl) navEl.classList.add('active');
  if (pageKey === 'kontrol' && !miniChart) initMiniChart();
}

function toggleSubMenu(menuId, event) {
  if (event) event.stopPropagation();
  document.getElementById(menuId).classList.toggle('open');
}

function showFuzzyMode(mode, event) {
  if (event) event.stopPropagation();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-fuzzy').classList.add('active');
  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active', 'sub-open'));
  document.getElementById('nav-fuzzy').classList.add('active');
  document.getElementById('fuzzy-sub').classList.remove('open');
  document.querySelectorAll('.fuzzy-sub-page').forEach(p => p.style.display = 'none');
  
  if (mode === 'mamdani') {
    document.getElementById('fuzzy-mamdani').style.display = 'block';
    if (!cMPage) initFuzzyMamdani();
  } else if (mode === 'sugeno') {
    document.getElementById('fuzzy-sugeno').style.display = 'block';
    if (!cSPage) initFuzzySugeno();
  } else {
    document.getElementById('fuzzy-compare').style.display = 'block';
    if (!cCmpM) initCompareCharts();
    updateFuzzyMetricTables();
  }
}

function trimf(x, a, b, c) {
  if (x <= a || x >= c) return 0;
  if (x === b) return 1;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

function makeMFChart(canvasId) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  const labels = [];
  for (let i = -100; i <= 100; i += 5) labels.push(i);

  const dNB = labels.map(x => (x <= -50) ? 1 : trimf(x, -100, -50, -20));
  const dNS = labels.map(x => trimf(x, -30, -10, 0));
  const dZE = labels.map(x => trimf(x, -5, 0, 5));
  const dPS = labels.map(x => trimf(x, 0, 10, 30));
  const dPB = labels.map(x => (x >= 50)  ? 1 : trimf(x, 20, 50, 100));

  return new Chart(ctx, {
    type: 'line', data: { labels: labels, datasets: [
      { label: 'NB', data: dNB, borderColor: '#ef4444', backgroundColor: '#ef444422', fill: true, tension: 0.1, pointRadius: 0, borderWidth: 2 },
      { label: 'NS', data: dNS, borderColor: '#f97316', backgroundColor: '#f9731622', fill: true, tension: 0.1, pointRadius: 0, borderWidth: 2 },
      { label: 'ZE', data: dZE, borderColor: '#10b981', backgroundColor: '#10b98122', fill: true, tension: 0.1, pointRadius: 0, borderWidth: 2 },
      { label: 'PS', data: dPS, borderColor: '#3b82f6', backgroundColor: '#3b82f622', fill: true, tension: 0.1, pointRadius: 0, borderWidth: 2 },
      { label: 'PB', data: dPB, borderColor: '#8b5cf6', backgroundColor: '#8b5cf622', fill: true, tension: 0.1, pointRadius: 0, borderWidth: 2 }
    ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#4a5888', font: { size: 10 } }, grid:{color:'rgba(80,140,255,0.07)'} }, y: { min: 0, max: 1.05, ticks: { color: '#4a5888', font: { size: 10 } }, grid:{color:'rgba(80,140,255,0.07)'} } } }
  });
}

// Opsi default chart tanpa waktu X (untuk mini chart dan compare)
const chartDefaults = {
  responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
  plugins: { legend: { display: false } },
  scales: { x: { display: false }, y: { min: 0, ticks:{color:'#4a5888', font:{size:10}}, grid:{color:'rgba(80,140,255,0.07)'} } }
};

const gaugePlugin = {
  id: 'gaugeCenterText',
  afterDraw(chart) {
    const { ctx, width, height } = chart; ctx.save();
    const rpmText = document.getElementById('mRPM')?.textContent || '0';
    ctx.font = '700 34px Rajdhani, sans-serif'; ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'center';
    ctx.fillText(rpmText, width / 2, height * 0.78);
    ctx.font = '500 13px Rajdhani, sans-serif'; ctx.fillStyle = '#94a3c8';
    ctx.fillText('RPM', width / 2, height * 0.92);
    ctx.restore();
  }
};

function initDashboardCharts() {
  const ctxRpm = document.getElementById('rpmChart');
  if (ctxRpm) {
    rpmChart = new Chart(ctxRpm, { 
      type: 'line', 
      data: { 
        labels: rpmTimeLabels, // Label X-Axis dengan Jam Aktif
        datasets: [
          { label: 'RPM', data: rpmHistory, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, 
          { label: 'Setpoint', data: Array(30).fill(0), borderColor: '#ef4444', borderDash: [5,5], borderWidth: 1.5, pointRadius: 0, fill: false }
        ] 
      }, 
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: { 
          x: { display: true, ticks: { color: '#4a5888', font: { size: 9 }, maxTicksLimit: 7 }, grid: { display: false } }, 
          y: { min: 0, ticks:{color:'#4a5888', font:{size:10}}, grid:{color:'rgba(80,140,255,0.07)'} } 
        }
      }
    });
  }
  const ctxGauge = document.getElementById('gaugeChart');
  if (ctxGauge) gaugeChart = new Chart(ctxGauge, { type: 'doughnut', data: { datasets: [{ data: [0, 450], backgroundColor: ['#3b82f6', 'rgba(255,255,255,0.05)'], borderWidth: 0, circumference: 180, rotation: 270 }] }, options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, plugins: { tooltip: { enabled: false } } }, plugins: [gaugePlugin] });
}

function initMiniChart() {
  const ctx = document.getElementById('miniRpmChart');
  if (ctx) miniChart = new Chart(ctx, { type: 'line', data: { labels: Array(15).fill(''), datasets: [{ data: miniHistory, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.1)', fill: true, tension: 0.4, pointRadius: 0 }] }, options: chartDefaults });
}

function initFuzzyMamdani() {
  const ctx = document.getElementById('chartMamdani');
  cMPage = new Chart(ctx, { type: 'line', data: { labels: liveHistoryLbl, datasets: [{ label:'RPM', data: liveHistoryRpm, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth:2.5 }, { label:'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
  mfMChart = makeMFChart('mfMamdani');
}

function initFuzzySugeno() {
  const ctx = document.getElementById('chartSugeno');
  cSPage = new Chart(ctx, { type: 'line', data: { labels: liveHistoryLbl, datasets: [{ label:'RPM', data: liveHistoryRpm, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth:2.5 }, { label:'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
  mfSChart = makeMFChart('mfSugeno');
}

function initCompareCharts() {
  const ctxM = document.getElementById('chartCmpM'); const ctxS = document.getElementById('chartCmpS');
  cCmpM = new Chart(ctxM, { type: 'line', data: { labels: liveHistoryLbl, datasets: [{ label:'RPM', data: liveHistoryRpm, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, { label:'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
  cCmpS = new Chart(ctxS, { type: 'line', data: { labels: liveHistoryLbl, datasets: [{ label:'RPM', data: liveHistoryRpm, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, { label:'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
}

function startFuzzyCapture() {
  liveHistoryRpm = []; liveHistorySp  = []; liveHistoryLbl = [];
  fuzzyTimeCounter = 0; isFuzzyRecording = true;
}

function updatePreviewUI() {
  safeSet('prevSetpoint', currentSetpointVal); safeSet('prevFuzzy', activeFuzzyVal); safeSet('prevLevel', activeLevelVal);
}

function syncSliderUI() { document.getElementById('spRPMInput').value = document.getElementById('spRPM').value; }
function syncInputUI() { document.getElementById('spRPM').value = document.getElementById('spRPMInput').value; }

function confirmSetpoint() {
  const val = parseInt(document.getElementById('spRPMInput').value) || 0;
  currentSetpointVal = val; peakRPM = 0;
  safeSet('spRPMVal', val); safeSet('mSetpoint', val); safeSet('activeSetpoint', val + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((val / 450 * 100), 100) + '%');
  
  updatePreviewUI();
  startFuzzyCapture();

  if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_SETPOINT, String(val), { qos: 1 });
}

function selectFuzzyType(type) {
  activeFuzzyVal = type; document.getElementById('fuzzyType').value = type;
  const optM = document.getElementById('fuzzyOptM'), optS = document.getElementById('fuzzyOptS'), chkM = document.getElementById('checkM'), chkS = document.getElementById('checkS');
  if (type === 'mamdani') { optM.style.borderColor = 'rgba(59,130,246,0.45)'; optM.style.background = 'rgba(59,130,246,0.15)'; optS.style.borderColor = 'transparent'; optS.style.background = 'transparent'; chkM.style.opacity = '1'; chkS.style.opacity = '0'; document.getElementById('foNameM').style.color = '#7dd3fc'; document.getElementById('foNameS').style.color = 'var(--text-hi)'; } 
  else { optS.style.borderColor = 'rgba(16,185,129,0.45)'; optS.style.background = 'rgba(16,185,129,0.15)'; optM.style.borderColor = 'transparent'; optM.style.background = 'transparent'; chkS.style.opacity = '1'; chkM.style.opacity = '0'; document.getElementById('foNameS').style.color = '#6ee7b7'; document.getElementById('foNameM').style.color = 'var(--text-hi)'; }
  safeSet('dashFuzzyBadge', 'Fuzzy: ' + (type === 'mamdani' ? 'Mamdani' : 'Sugeno')); safeSet('activeFuzzy', type === 'mamdani' ? 'Mamdani' : 'Sugeno');
  
  updatePreviewUI(); 
  startFuzzyCapture();

  if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_FUZZY, type, { qos: 1 });
}

function selectLevel(n, btn) {
  activeLevelVal = n; document.querySelectorAll('.level-btns .level-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
  safeSet('dashLevel', n); safeSet('activeLevel', n);
  updatePreviewUI(); if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_LEVEL, String(n), { qos: 1 });
}

function runMotor() {
  if (!mqttClient || !mqttClient.connected) return alert('MQTT Belum terhubung!');
  
  motorRunning = true; 
  peakRPM = 0;
  rpmMinVal = Infinity; 
  rpmMaxVal = 0; 
  safeSet('rpmMin', '0'); 
  safeSet('rpmMax', '0');

  startTime = Date.now();
  sysRiseTime = 0;
  isRising = true;

  // ==========================================
  // FITUR BARU: RESET GRAFIK KE 0 
  // ==========================================
  rpmHistory.fill(0); 
  rpmTimeLabels.fill(''); // Kosongkan label waktu agar tidak menumpuk
  miniHistory.fill(0);

  // Paksa membaca ulang nilai setpoint dari kotak input
  const val = parseInt(document.getElementById('spRPMInput').value) || 100;
  currentSetpointVal = val;
  safeSet('spRPMVal', val); 
  safeSet('mSetpoint', val); 
  safeSet('activeSetpoint', val + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((val / 450 * 100), 100) + '%');

  startFuzzyCapture();

  // Kirim perintah Start ke ESP32
  mqttClient.publish(TOPICS.CTRL_START, '1', { qos: 1 });
  
  // Kirim angka setpoint otomatis ke ESP32 sesaat setelah start
  mqttClient.publish(TOPICS.CTRL_SETPOINT, String(currentSetpointVal), { qos: 1 });
  
  safeSet('prevStart', '1 (Start)');
  safeSet('motorStatusBadge', '● Running'); 
  document.getElementById('motorStatusBadge').className = 'badge badge-green';
  safeSet('dashStatusBadge', '● Running'); 
  document.getElementById('dashStatusBadge').className = 'badge badge-green';
  safeHTML('motorStatusText', '<span class="dot green"></span>Running');
}

function askStop() { document.getElementById('confirmOverlay').classList.add('show'); }
function closeConfirm() { document.getElementById('confirmOverlay').classList.remove('show'); }
function confirmStop() {
  closeConfirm(); if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_STOP, '1', { qos: 1 }); motorRunning = false;
  safeSet('prevStart', '0 (Stop)');
  safeSet('motorStatusBadge', '● Stopped'); document.getElementById('motorStatusBadge').className = 'badge badge-red';
  safeSet('dashStatusBadge', '● Stopped'); document.getElementById('dashStatusBadge').className = 'badge badge-red';
  safeHTML('motorStatusText', '<span class="dot red"></span>Stopped');
}

function resetTelemetry() {
  if (!confirm('Hapus seluruh riwayat data Telemetry?')) return;
  allData.length = 0;
  const body = document.getElementById('dataTableBody'); if(body) body.innerHTML = '';
  safeSet('statTotal', '0'); safeSet('statAvgRPM', '0'); safeSet('statErrM', '0%'); safeSet('statErrS', '0%'); safeSet('dataCount', '0 entri');
}

function connectMQTT() {
  if (mqttClient) mqttClient.end(true);
  const host = document.getElementById('mqttHost').value.trim(), port = document.getElementById('mqttPort').value.trim(), user = document.getElementById('mqttUser').value.trim(), pass = document.getElementById('mqttPass').value.trim();
  safeSet('mqttHostDisplay', `${host}:${port}`); safeSet('mqttStatusText', 'Menghubungkan...');
  
  mqttClient = mqtt.connect(`wss://${host}:${port}/mqtt`, { clientId: 'bldc_web_' + Math.random().toString(16).substr(2, 8), username: user, password: pass });
  mqttClient.on('connect', () => {
    document.getElementById('mqttDot').className = 'mqtt-dot online'; document.getElementById('mqttPill').className = 'mqtt-pill online';
    safeSet('mqttStatusText', 'MQTT Online'); safeHTML('mqttBrokerStatus', '<span class="dot green"></span>Terhubung');
    mqttClient.subscribe(TOPICS.DATA_ALL);
  });

  mqttClient.on('message', (topic, message) => {
    const raw = message.toString().trim(); msgCount++; safeSet('mqttMsgCount', msgCount); safeSet('lastMsg', new Date().toLocaleTimeString('id-ID'));
    if (raw.includes(',')) { const parts = raw.split(','); if (parts.length >= 4) processIncomingData(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]), parts[3]); }
  });

  mqttClient.on('error', () => safeSet('mqttStatusText', 'Error Koneksi'));
  mqttClient.on('close', () => safeSet('mqttStatusText', 'MQTT Offline'));
}

function disconnectMQTT() {
  if (mqttClient) mqttClient.end(true);
  document.getElementById('mqttDot').className = 'mqtt-dot'; document.getElementById('mqttPill').className = 'mqtt-pill';
  safeSet('mqttStatusText', 'MQTT Offline'); safeHTML('mqttBrokerStatus', '<span class="dot red"></span>Offline');
}

function processIncomingData(rpm, pwm, error, level) {
  if (rpm > peakRPM) peakRPM = rpm;
  let overshoot = 0;
  if (currentSetpointVal > 0 && peakRPM > currentSetpointVal) overshoot = ((peakRPM - currentSetpointVal) / currentSetpointVal) * 100;
  
  safeSet('mRPM', rpm.toFixed(1)); safeSet('miniRpmVal', rpm.toFixed(1));
  safeStyle('barRPM', 'width', Math.min((rpm / 450 * 100), 100) + '%');
  
  if (motorRunning) {
    if (rpm < rpmMinVal) { rpmMinVal = rpm; safeSet('rpmMin', rpm.toFixed(1)); }
    if (rpm > rpmMaxVal) { rpmMaxVal = rpm; safeSet('rpmMax', rpm.toFixed(1)); }
  }
  
  safeSet('mPWM', pwm.toFixed(0)); safeSet('miniPwmVal', pwm.toFixed(0));
  let pwmPct = ((pwm - 103) / (255 - 103)) * 100;
  safeStyle('barPWM', 'width', Math.max(0, Math.min(pwmPct, 100)) + '%');

  // ==========================================
  // FITUR BARU: FORMAT WAKTU X-AXIS (HH:MM:SS)
  // ==========================================
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0') + ':' +
                  String(now.getSeconds()).padStart(2, '0');

  rpmHistory.push(rpm); rpmHistory.shift();
  rpmTimeLabels.push(timeStr); rpmTimeLabels.shift();
  miniHistory.push(rpm); miniHistory.shift();

  // Logika Rise Time Real-time
  if (isRising && currentSetpointVal > 0) {
    if (rpm >= currentSetpointVal * 0.90) {
      sysRiseTime = (Date.now() - startTime) / 1000;
      isRising = false;
    } else {
      sysRiseTime = (Date.now() - startTime) / 1000;
    }
  }
  safeSet('gaugeSetpointVal', currentSetpointVal);
  safeSet('gaugeRiseTimeVal', sysRiseTime.toFixed(1) + ' s');

  // Logika Steady State Error (SSE) Nyata
  let steadyStateError = error;
  if (peakRPM >= currentSetpointVal * 0.90 && currentSetpointVal > 0 && rpmHistory.length >= 5) {
    const last5 = rpmHistory.slice(-5);
    const avgRpm = last5.reduce((a, b) => a + b, 0) / 5;
    steadyStateError = currentSetpointVal - avgRpm;
  }

  safeSet('mError', Math.abs(steadyStateError).toFixed(1));
  safeStyle('barError', 'width', Math.min(Math.abs(steadyStateError), 100) + '%');

  safeSet('overshootVal', overshoot.toFixed(1)); safeSet('miniOvershootVal', overshoot.toFixed(1));
  safeStyle('barOvershoot', 'width', Math.min(overshoot, 100) + '%');

  if (gaugeChart) { const val = Math.min(rpm, 450); gaugeChart.data.datasets[0].data = [val, 450 - val]; gaugeChart.update(); }

// ==========================================
  // AUTO-ZOOM Y-AXIS (TRANSIEN VS STABIL)
  // ==========================================
  let yMin = 0;
  let yMax = 100;

  if (currentSetpointVal > 0) {
    if (isRising) {
      // Fase Transien (Mendaki): Grafik terlihat penuh dari 0
      yMin = 0;
      yMax = currentSetpointVal + 50;
    } else {
      // Fase Stabil: Auto-Zoom pada area Setpoint +- 50 RPM (Diperlebar agar visual lebih mulus)
      yMin = Math.max(0, currentSetpointVal - 50); // Pastikan tidak minus
      yMax = currentSetpointVal + 50;
    }
  }

  // Terapkan Zoom ke Grafik Utama
  if (rpmChart) {
    rpmChart.options.scales.y.min = yMin;
    rpmChart.options.scales.y.max = yMax;
    rpmChart.data.labels = rpmTimeLabels; // Sumbu X mendapat waktu
    rpmChart.data.datasets[0].data = rpmHistory;
    rpmChart.data.datasets[1].data = Array(30).fill(currentSetpointVal);
    rpmChart.update('none');
  }
  
  // Terapkan Zoom ke Mini Chart
  if (miniChart) {
    miniChart.options.scales.y.min = yMin;
    miniChart.options.scales.y.max = yMax;
    miniChart.update('none');
  }

  // Terapkan Zoom ke Grafik Perekaman 60-Detik Fuzzy
  if (isFuzzyRecording) {
    liveHistoryRpm.push(rpm);
    liveHistorySp.push(currentSetpointVal);
    liveHistoryLbl.push(fuzzyTimeCounter + 's');
    fuzzyTimeCounter++;

    if (fuzzyTimeCounter >= 60) {
      isFuzzyRecording = false; // Membekukan chart setelah 60 detik
    }

    if (cMPage) { cMPage.options.scales.y.min = yMin; cMPage.options.scales.y.max = yMax; cMPage.data.labels = liveHistoryLbl; cMPage.data.datasets[0].data = liveHistoryRpm; cMPage.data.datasets[1].data = liveHistorySp; cMPage.update('none'); }
    if (cSPage) { cSPage.options.scales.y.min = yMin; cSPage.options.scales.y.max = yMax; cSPage.data.labels = liveHistoryLbl; cSPage.data.datasets[0].data = liveHistoryRpm; cSPage.data.datasets[1].data = liveHistorySp; cSPage.update('none'); }
    if (cCmpM)  { cCmpM.options.scales.y.min = yMin; cCmpM.options.scales.y.max = yMax; cCmpM.data.labels = liveHistoryLbl; cCmpM.data.datasets[0].data = liveHistoryRpm; cCmpM.data.datasets[1].data = liveHistorySp; cCmpM.update('none'); }
    if (cCmpS)  { cCmpS.options.scales.y.min = yMin; cCmpS.options.scales.y.max = yMax; cCmpS.data.labels = liveHistoryLbl; cCmpS.data.datasets[0].data = liveHistoryRpm; cCmpS.data.datasets[1].data = liveHistorySp; cCmpS.update('none'); }
  }

  // Perhitungan Error Instan (Setpoint - RPM Aktual)
  let errorInstan = currentSetpointVal - rpm;

  // Update UI
  safeSet('mErrorInstan', errorInstan.toFixed(1));
  // Memetakan error ke lebar bar (gunakan Math.abs agar bar tetap muncul jika error minus)
  safeStyle('barErrorInstan', 'width', Math.min(Math.abs(errorInstan) / (currentSetpointVal || 1) * 100, 100) + '%');

  
  logTelemetry(rpm, pwm, steadyStateError, overshoot, activeFuzzyVal, level);
}

function logTelemetry(rpm, pwm, err, os, fuzzy, level) {
  const timeStr = new Date().toLocaleTimeString('id-ID'); 
  allData.unshift({ 
    time: timeStr, 
    rpm: rpm.toFixed(1), 
    sp: currentSetpointVal, 
    pwm: pwm.toFixed(0), 
    err: err.toFixed(1),           
    os: os.toFixed(1),        
    type: fuzzy === 'mamdani' ? 'Mamdani' : 'Sugeno', 
    beban: level 
  });
  
  if (!window.tableRenderPending) {
    window.tableRenderPending = true;
    setTimeout(() => {
      updateTelemetryUI();
      window.tableRenderPending = false;
    }, 1000); 
  }
}

function updateTelemetryUI() {
  safeSet('statTotal', allData.length); if (allData.length === 0) return;
  const avgRpm = allData.reduce((s,d) => s + parseFloat(d.rpm), 0) / allData.length; safeSet('statAvgRPM', avgRpm.toFixed(1));
  const mamData = allData.filter(d => d.type === 'Mamdani'); if (mamData.length > 0) safeSet('statErrM', (mamData.reduce((s,d) => s + Math.abs(parseFloat(d.err)), 0) / mamData.length).toFixed(1) + '%');
  const sugData = allData.filter(d => d.type === 'Sugeno'); if (sugData.length > 0) safeSet('statErrS', (sugData.reduce((s,d) => s + Math.abs(parseFloat(d.err)), 0) / sugData.length).toFixed(1) + '%');

  const body = document.getElementById('dataTableBody');
  if (body) { body.innerHTML = allData.slice(0, 50).map((d, i) => `<tr><td>${i+1}</td><td>${d.time}</td><td><b>${d.rpm}</b></td><td>${d.sp}</td><td>${d.pwm}</td><td><span class="badge ${Math.abs(d.err)>10?'badge-amber':'badge-green'}">${d.err}</span></td><td>${d.os}</td><td><span class="badge ${d.type==='Sugeno'?'badge-green':'badge-blue'}">${d.type}</span></td><td>${d.beban}</td></tr>`).join(''); safeSet('dataCount', Math.min(allData.length, 50) + ' entri'); }
  updateFuzzyMetricTables();
}

function updateFuzzyMetricTables() {
  const levels = ['N', '1', '2', '3']; let mHTML = '', sHTML = '', cmpHTML = '';
  levels.forEach(lv => {
    const mRows = allData.filter(d => d.type === 'Mamdani' && String(d.beban) === lv);
    const sRows = allData.filter(d => d.type === 'Sugeno' && String(d.beban) === lv);
    const getStats = (arr) => { if(arr.length === 0) return { os: '-', sse: '-' }; const maxOs = Math.max(...arr.map(d => parseFloat(d.os))).toFixed(1); const avgSse = (arr.reduce((sum, d) => sum + Math.abs(parseFloat(d.err)), 0) / arr.length).toFixed(1); return { os: maxOs + '%', sse: avgSse }; };
    
    const sM = getStats(mRows);
    const sS = getStats(sRows);
    
    mHTML += `<tr><td>Level ${lv}</td><td>—</td><td>${sM.os}</td><td>${sM.sse}</td><td><span class="badge badge-blue">Mamdani</span></td></tr>`;
    sHTML += `<tr><td>Level ${lv}</td><td>—</td><td>${sS.os}</td><td>${sS.sse}</td><td><span class="badge badge-green">Sugeno</span></td></tr>`;
    
    let winner = '—'; 
    if(mRows.length && sRows.length) {
      const valOsM = parseFloat(sM.os) || 0;
      const valSseM = parseFloat(sM.sse) || 0;
      const valOsS = parseFloat(sS.os) || 0;
      const valSseS = parseFloat(sS.sse) || 0;
      const skorMamdani = valOsM + valSseM;
      const skorSugeno = valOsS + valSseS;
      if (skorSugeno < skorMamdani) { winner = 'Sugeno'; } else if (skorMamdani < skorSugeno) { winner = 'Mamdani'; } else { winner = 'Seimbang'; }
    }
    
    cmpHTML += `<tr><td>Level ${lv}</td><td>${sM.os}</td><td>${sS.os}</td><td>${sM.sse}</td><td>${sS.sse}</td><td><span class="badge badge-gold">${winner}</span></td></tr>`;
  });
  safeHTML('metricMBody', mHTML); safeHTML('metricSBody', sHTML); safeHTML('metricCmpBody', cmpHTML);
}

function exportCSV() {
  const headers = 'Waktu,RPM,Setpoint,PWM,Error,Overshoot(%),Tipe Fuzzy,Beban\n';
  const rows = allData.map(d => `${d.time},${d.rpm},${d.sp},${d.pwm},${d.err},${d.os},${d.type},${d.beban}`).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([headers + rows], { type: 'text/csv' })); a.download = 'bldc_telemetry.csv'; a.click();
}

// ==========================================
// BUKA PORTAL OTA
// ==========================================
function openOTAPortal() {
  const ipInput = document.getElementById('otaIpAddress').value.trim();
  
  if (!ipInput) {
    return alert('Harap masukkan IP Address ESP32 terlebih dahulu!\n(Contoh: 192.168.1.15)');
  }
  
  // Membersihkan input jika user tidak sengaja memasukkan http:// atau /update
  let cleanIp = ipInput.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  
  // Membuka tab baru yang langsung mengarah ke halaman OTA ESP32
  window.open(`http://${cleanIp}/update`, '_blank');
}

window.onload = () => { 
  initDashboardCharts(); 
  selectFuzzyType('sugeno'); 
  
  // Memaksa slider, input teks, dan indikator metrik langsung ke 100
  if(document.getElementById('spRPMInput')) document.getElementById('spRPMInput').value = 100;
  if(document.getElementById('spRPM')) document.getElementById('spRPM').value = 100;
  
  safeSet('spRPMVal', 100); 
  safeSet('mSetpoint', 100); 
  safeSet('activeSetpoint', '100 RPM');
  safeSet('gaugeSetpointVal', 100);
  safeStyle('barSetpoint', 'width', (100 / 450 * 100) + '%');
  updatePreviewUI();
};
document.addEventListener('click', () => document.querySelectorAll('.sub-menu').forEach(m => m.classList.remove('open')));

window.showPage = showPage; 
window.toggleSubMenu = toggleSubMenu; 
window.showFuzzyMode = showFuzzyMode; 
window.syncSliderUI = syncSliderUI; 
window.syncInputUI = syncInputUI; 
window.confirmSetpoint = confirmSetpoint; 
window.selectFuzzyType = selectFuzzyType; 
window.selectLevel = selectLevel; 
window.runMotor = runMotor; 
window.askStop = askStop; 
window.closeConfirm = closeConfirm; 
window.confirmStop = confirmStop; 
window.resetTelemetry = resetTelemetry; 
window.connectMQTT = connectMQTT; 
window.disconnectMQTT = disconnectMQTT; 
window.exportCSV = exportCSV;
window.openOTAPortal = openOTAPortal;