'use strict';

// ==========================================
// DAFTAR TOPIC MQTT
// ==========================================
const TOPICS = {
  DATA_ALL:      'bldc/data/#',
  STATUS_IP:     'bldc/status/ip',
  CTRL_START:    'bldc/control/start',
  CTRL_STOP:     'bldc/control/stop',
  CTRL_SETPOINT: 'bldc/control/setpoint',
  CTRL_FUZZY:    'bldc/control/fuzzy',
  CTRL_LEVEL:    'bldc/control/level'
};

// ==========================================
// STATE APLIKASI
// ==========================================
let mqttClient        = null;
let motorRunning      = false;
let activeLevelVal    = 'N';
let activeFuzzyVal    = 'sugeno';
let currentSetpointVal = 100;
let peakRPM           = 0;
let msgCount          = 0;

// Rise Time
let startTime   = 0;
let sysRiseTime = 0;
let isRising    = false;

// RPM min/max sesi berjalan
let rpmMinVal = Infinity;
let rpmMaxVal = 0;

// Chart references
let rpmChart, gaugeChart, miniChart;
let cMPage, cSPage, cCmpM, cCmpS, mfMChart, mfSChart;

// ==========================================
// BUFFER RECORDING TERPISAH PER TIPE FUZZY
//
// Setiap tipe fuzzy punya buffer sendiri.
// Buffer hanya diisi saat motor berjalan
// dengan tipe fuzzy yang bersangkutan aktif.
// Grafik TIDAK mereset saat motor stop —
// data sesi terakhir tetap tampil.
// ==========================================
let mamdaniRpm = [];  // data RPM sesi Mamdani terakhir
let mamdaniSp  = [];  // data Setpoint sesi Mamdani
let mamdaniLbl = [];  // label waktu sesi Mamdani

let sugenoRpm  = [];  // data RPM sesi Sugeno terakhir
let sugenoSp   = [];  // data Setpoint sesi Sugeno
let sugenoLbl  = [];  // label waktu sesi Sugeno

// Buffer grafik perbandingan (gabungan, pakai sesi terakhir tipe aktif)
// cCmpM menampilkan data Mamdani, cCmpS menampilkan data Sugeno

// Buffer dashboard (30 titik terakhir, real-time tanpa filter tipe)
const rpmHistory    = Array(30).fill(0);
const rpmTimeLabels = Array(30).fill('');
const miniHistory   = Array(15).fill(0);

// Semua data telemetry untuk tabel & export
const allData = [];

// ==========================================
// HELPER FUNCTIONS
// ==========================================
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

// ==========================================
// JAM REAL-TIME
// ==========================================
function updateClock() {
  const now = new Date();
  safeSet('clockDisplay', now.toLocaleTimeString('id-ID'));
  safeSet('dateDisplay', now.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }));
}
setInterval(updateClock, 1000);
updateClock();

// ==========================================
// NAVIGASI
// ==========================================
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

// Pindah ke sub-halaman Tipe Fuzzy
function showFuzzyMode(mode, navEl, event) {
  if (event) event.stopPropagation();

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-fuzzy').classList.add('active');

  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active', 'sub-open'));
  if (navEl) navEl.classList.add('active');
  
  // Baris document.getElementById('fuzzy-sub')... sudah dihapus dari sini

  document.querySelectorAll('.fuzzy-sub-page').forEach(p => p.style.display = 'none');

  if (mode === 'mamdani') {
    document.getElementById('fuzzy-mamdani').style.display = 'block';
    if (!cMPage) initFuzzyMamdani();
    else refreshFuzzyChart(cMPage, mamdaniRpm, mamdaniSp, mamdaniLbl);
  } else if (mode === 'sugeno') {
    document.getElementById('fuzzy-sugeno').style.display = 'block';
    if (!cSPage) initFuzzySugeno();
    else refreshFuzzyChart(cSPage, sugenoRpm, sugenoSp, sugenoLbl);
  } else if (mode === 'compare') {
    document.getElementById('fuzzy-compare').style.display = 'block';
    if (!cCmpM || !cCmpS) initCompareCharts();
    else {
      refreshFuzzyChart(cCmpM, mamdaniRpm, mamdaniSp, mamdaniLbl);
      refreshFuzzyChart(cCmpS, sugenoRpm,  sugenoSp,  sugenoLbl);
    }
    updateFuzzyMetricTables();
  }
}

// Helper: perbarui data chart tanpa destroy/reinit
function refreshFuzzyChart(chart, rpmArr, spArr, lblArr) {
  if (!chart) return;
  chart.data.labels            = lblArr;
  chart.data.datasets[0].data  = rpmArr;
  chart.data.datasets[1].data  = spArr;
  chart.update('none');
}

// ==========================================
// MEMBERSHIP FUNCTION (sesuai ESP32)
// ==========================================
function trimf(x, a, b, c) {
  if (x <= a || x >= c) return 0;
  if (x === b) return 1;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

function trapmf(x, a, b, c, d) {
  if (x <= a || x >= d) return 0;
  if (x >= b && x <= c) return 1;
  if (x > a && x < b) return (x - a) / (b - a);
  return (d - x) / (d - c);
}

// Warna sumbu menyesuaikan tema
function chartAxisColor() {
  return document.documentElement.classList.contains('light-mode')
    ? 'rgba(20,25,45,0.55)'
    : 'rgba(255,255,255,0.6)';
}
function chartGridColorSubtle() {
  return document.documentElement.classList.contains('light-mode')
    ? 'rgba(20,25,45,0.08)'
    : 'rgba(255,255,255,0.05)';
}

// ==========================================
// MEMBERSHIP FUNCTION (diperbaiki agar selalu runcing)
// ==========================================
function trimf(x, a, b, c) {
  if (x === b) return 1;                    // cek titik puncak LEBIH DULU
  if (x <= a || x >= c) return 0;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

// ==========================================
// MEMBERSHIP FUNCTION (fixed: puncak selalu runcing, sesuai MATLAB)
// ==========================================
function trimf(x, a, b, c) {
  if (x === b) return 1;                    // cek titik puncak LEBIH DULU
  if (x <= a || x >= c) return 0;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

// Parameter PERSIS sesuai BLDC_Fuzzy_Mamdani_Fix.fis dan BLDC_Fuzzy_Sugeno_Fix.fis
// (error & delta_error IDENTIK di kedua file .fis -> dipakai sama utk mamdani & sugeno)
// Catatan: NB & PB pakai trapmf (4 titik, bahu rata), NS/ZE/PS pakai trimf (3 titik)
const MF_PARAMS = {
  mamdani: {
    error: {
      NB: [-200, -200, -150, -75], NS: [-150, -75, 0], ZE: [-50, 0, 50],
      PS: [0, 75, 150],            PB: [75, 150, 200, 200]
    },
    delta_error: {
      NB: [-13333, -13333, -10000, -5000], NS: [-10000, -5000, 0], ZE: [-2500, 0, 2500],
      PS: [0, 5000, 10000],                PB: [5000, 10000, 13333, 13333]
    }
  },
  sugeno: {
    error: {
      NB: [-200, -200, -150, -75], NS: [-150, -75, 0], ZE: [-50, 0, 50],
      PS: [0, 75, 150],            PB: [75, 150, 200, 200]
    },
    delta_error: {   // identik dengan Mamdani (dikonfirmasi dari kedua file .fis)
      NB: [-13333, -13333, -10000, -5000], NS: [-10000, -5000, 0], ZE: [-2500, 0, 2500],
      PS: [0, 5000, 10000],                PB: [5000, 10000, 13333, 13333]
    }
  }
};

// Evaluasi MF generik: array 3 elemen -> trimf, array 4 elemen -> trapmf
function evalMF(x, p) {
  return p.length === 4 ? trapmf(x, p[0], p[1], p[2], p[3]) : trimf(x, p[0], p[1], p[2]);
}

// ==========================================
// GRAFIK MEMBERSHIP FUNCTION (generik untuk error & delta_error)
// ==========================================
function makeMFChart(canvasId, fuzzyType, inputName) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;

  const isDeltaError = inputName === 'delta_error';
  const domainMin = isDeltaError ? -13333 : -200;
  const domainMax = isDeltaError ?  13333 :  200;
  const step = isDeltaError ? 100 : 2;   // resolusi diperhalus supaya puncak tajam

  const labels = [];
  for (let x = domainMin; x <= domainMax; x += step) labels.push(x);

  const p = MF_PARAMS[fuzzyType][inputName];
  const dNB = labels.map(x => evalMF(x, p.NB));
  const dNS = labels.map(x => evalMF(x, p.NS));
  const dZE = labels.map(x => evalMF(x, p.ZE));
  const dPS = labels.map(x => evalMF(x, p.PS));
  const dPB = labels.map(x => evalMF(x, p.PB));

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'NB', data: dNB, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)',  fill: true, tension: 0, pointRadius: 0, borderWidth: 2 },
        { label: 'NS', data: dNS, borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.15)', fill: true, tension: 0, pointRadius: 0, borderWidth: 2 },
        { label: 'ZE', data: dZE, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)', fill: true, tension: 0, pointRadius: 0, borderWidth: 2 },
        { label: 'PS', data: dPS, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.15)', fill: true, tension: 0, pointRadius: 0, borderWidth: 2 },
        { label: 'PB', data: dPB, borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.15)', fill: true, tension: 0, pointRadius: 0, borderWidth: 2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { ticks: { color: chartAxisColor(), font: { size: 10 } }, grid: { color: chartGridColorSubtle() } },
        y: { min: 0, max: 1.05, ticks: { color: chartAxisColor(), font: { size: 10 } }, grid: { color: chartGridColorSubtle() } }
      }
    }
  });
}


const fuzzyChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 0 },
  plugins: { legend: { display: false } },
  scales: {
    x: {
      display: true,
      ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
      grid:  { display: false }
    },
    y: { min: 0, ticks: { color: '#4a5888', font: { size: 10 } }, grid: { color: 'rgba(80,140,255,0.07)' } }
  }
};

// Plugin teks KM/JAM di tengah gauge speedometer
const gaugePlugin = {
  id: 'gaugeCenterText',
  afterDraw(chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    
    // Ambil nilai RPM aktual dari elemen HTML, lalu konversi
    const rpmVal = parseFloat(document.getElementById('mRPM')?.textContent || '0');
    const kmhVal = (rpmVal * 0.0528).toFixed(2); // Dikalikan 0.0528 dan dibulatkan 2 desimal

    ctx.font      = '700 34px Rajdhani, sans-serif';
    ctx.fillStyle = '#93c5fd';
    ctx.textAlign = 'center';
    ctx.fillText(kmhVal, width / 2, height * 0.78);
    
    ctx.font      = '500 13px Rajdhani, sans-serif';
    ctx.fillStyle = '#94a3c8';
    ctx.fillText('km/jam', width / 2, height * 0.92); // Label diubah jadi km/jam
    ctx.restore();
  }
};

// ==========================================
// INISIALISASI CHART DASHBOARD
// ==========================================
function initDashboardCharts() {
  const ctxRpm = document.getElementById('rpmChart');
  if (ctxRpm) {
    rpmChart = new Chart(ctxRpm, {
      type: 'line',
      data: {
        labels: rpmTimeLabels,
        datasets: [
          { label: 'RPM',      data: rpmHistory,           borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
          { label: 'Setpoint', data: Array(30).fill(0),    borderColor: '#ef4444', borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: {
          x: { display: true, ticks: { color: '#4a5888', font: { size: 9 }, maxTicksLimit: 7 }, grid: { display: false } },
          y: { min: 0, ticks: { color: '#4a5888', font: { size: 10 } }, grid: { color: 'rgba(80,140,255,0.07)' } }
        }
      }
    });
  }

  const ctxGauge = document.getElementById('gaugeChart');
  if (ctxGauge) {
    gaugeChart = new Chart(ctxGauge, {
      type: 'doughnut',
      data: {
        // Skala 0 - 11 km/jam (11 km/jam ~ 208 RPM)
        datasets: [{ data: [0, 11], backgroundColor: ['#3b82f6', 'rgba(255,255,255,0.05)'], borderWidth: 0, circumference: 180, rotation: 270 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
        plugins: { tooltip: { enabled: false } }
      },
      plugins: [gaugePlugin]
    });
  }
}

function initMiniChart() {
  const ctx = document.getElementById('miniRpmChart');
  if (ctx) {
    miniChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(15).fill(''),
        datasets: [{ data: miniHistory, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.1)', fill: true, tension: 0.4, pointRadius: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { min: 0, ticks: { color: '#4a5888', font: { size: 10 } }, grid: { color: 'rgba(80,140,255,0.07)' } } }
      }
    });
  }
}

// ==========================================
// INISIALISASI CHART TIPE FUZZY
// Mamdani dan Sugeno punya buffer TERPISAH
// ==========================================
function initFuzzyMamdani() {
  const ctx = document.getElementById('chartMamdani');
  if (!ctx) return;
  cMPage = new Chart(ctx, {
    type: 'line',
    data: {
      labels: mamdaniLbl,
      datasets: [
        { label: 'RPM',      data: mamdaniRpm, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2.5 },
        { label: 'Setpoint', data: mamdaniSp,  borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    options: fuzzyChartOptions
  });
  mfMChart = makeMFChart('mfMamdani', 'mamdani', 'error'); 
}

function initFuzzySugeno() {
  const ctx = document.getElementById('chartSugeno');
  if (!ctx) return;
  cSPage = new Chart(ctx, {
    type: 'line',
    data: {
      labels: sugenoLbl,
      datasets: [
        { label: 'RPM',      data: sugenoRpm, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2.5 },
        { label: 'Setpoint', data: sugenoSp,  borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    options: fuzzyChartOptions
  });
  mfSChart = makeMFChart('mfSugeno',  'sugeno',  'error');
}

function initCompareCharts() {
  const ctxM = document.getElementById('chartCmpM');
  const ctxS = document.getElementById('chartCmpS');

  // Chart kiri (biru) = data Mamdani
  cCmpM = new Chart(ctxM, {
    type: 'line',
    data: {
      labels: mamdaniLbl,
      datasets: [
        { label: 'RPM',      data: mamdaniRpm, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
        { label: 'Setpoint', data: mamdaniSp,  borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    options: fuzzyChartOptions
  });

  // Chart kanan (hijau) = data Sugeno
  cCmpS = new Chart(ctxS, {
    type: 'line',
    data: {
      labels: sugenoLbl,
      datasets: [
        { label: 'RPM',      data: sugenoRpm, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
        { label: 'Setpoint', data: sugenoSp,  borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    options: fuzzyChartOptions
  });
}

// ==========================================
// UPDATE TAMPILAN PREVIEW MQTT
// ==========================================
function updatePreviewUI() {
  safeSet('prevSetpoint', currentSetpointVal);
  safeSet('prevFuzzy',    activeFuzzyVal);
  safeSet('prevLevel',    activeLevelVal);
}

// ==========================================
// SINKRONISASI INPUT SETPOINT
// ==========================================
function syncSliderUI() { document.getElementById('spRPMInput').value = document.getElementById('spRPM').value; }
function syncInputUI()  { document.getElementById('spRPM').value = document.getElementById('spRPMInput').value; }

function confirmSetpoint() {
  const val = parseInt(document.getElementById('spRPMInput').value) || 0;
  currentSetpointVal = val;
  peakRPM = 0;

  safeSet('spRPMVal', val);
  safeSet('mSetpoint', val);
  safeSet('activeSetpoint', val + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((val / 450 * 100), 100) + '%');

  updatePreviewUI();

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPICS.CTRL_SETPOINT, String(val), { qos: 1 });
  }
}

// ==========================================
// PILIH TIPE FUZZY (Mamdani / Sugeno)
// ==========================================
function selectFuzzyType(type) {
  activeFuzzyVal = type;
  document.getElementById('fuzzyType').value = type;

  const optM = document.getElementById('fuzzyOptM');
  const optS = document.getElementById('fuzzyOptS');
  const chkM = document.getElementById('checkM');
  const chkS = document.getElementById('checkS');

  if (type === 'mamdani') {
    optS.classList.remove('selected-green');
    optM.classList.add('selected-blue');
    optM.style.borderColor = 'rgba(59,130,246,0.45)'; optM.style.background = 'rgba(59,130,246,0.15)';
    optS.style.borderColor = 'transparent';           optS.style.background = 'transparent';
    chkM.style.opacity = '1'; chkS.style.opacity = '0';
    document.getElementById('foNameM').style.color = '#7dd3fc';
    document.getElementById('foNameS').style.color = 'var(--text-hi)';
  } else {
    optM.classList.remove('selected-blue');
    optS.classList.add('selected-green');
    optS.style.borderColor = 'rgba(16,185,129,0.45)'; optS.style.background = 'rgba(16,185,129,0.15)';
    optM.style.borderColor = 'transparent';           optM.style.background = 'transparent';
    chkS.style.opacity = '1'; chkM.style.opacity = '0';
    document.getElementById('foNameS').style.color = '#6ee7b7';
    document.getElementById('foNameM').style.color = 'var(--text-hi)';
  }

  safeSet('dashFuzzyBadge', 'Fuzzy: ' + (type === 'mamdani' ? 'Mamdani' : 'Sugeno'));
  safeSet('activeFuzzy', type === 'mamdani' ? 'Mamdani' : 'Sugeno');

  updatePreviewUI();

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPICS.CTRL_FUZZY, type, { qos: 1 });
  }
}

// ==========================================
// PILIH LEVEL BEBAN
// ==========================================
function selectLevel(n, btn) {
  activeLevelVal = n;
  document.querySelectorAll('.level-btns .level-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  safeSet('dashLevel', n);
  safeSet('activeLevel', n);
  updatePreviewUI();
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPICS.CTRL_LEVEL, String(n), { qos: 1 });
  }
}

// ==========================================
// START MOTOR
// Buffer tipe fuzzy yang aktif direset saat start,
// tipe yang tidak aktif TIDAK disentuh (data lama tetap tampil).
// ==========================================
function runMotor() {
  if (!mqttClient || !mqttClient.connected) return alert('MQTT Belum terhubung!');

  motorRunning = true;
  peakRPM = 0;
  rpmMinVal = Infinity;
  rpmMaxVal = 0;
  safeSet('rpmMin', '0');
  safeSet('rpmMax', '0');

  startTime   = Date.now();
  sysRiseTime = 0;
  isRising    = true;

  // Reset grafik dashboard
  rpmHistory.fill(0);
  rpmTimeLabels.fill('');
  miniHistory.fill(0);

  // Reset HANYA buffer tipe fuzzy yang sekarang aktif
  if (activeFuzzyVal === 'mamdani') {
    mamdaniRpm = []; mamdaniSp = []; mamdaniLbl = [];
  } else {
    sugenoRpm = []; sugenoSp = []; sugenoLbl = [];
  }

  // Baca setpoint dari input
  const val = parseInt(document.getElementById('spRPMInput').value) || 100;
  currentSetpointVal = val;
  safeSet('spRPMVal', val);
  safeSet('mSetpoint', val);
  safeSet('activeSetpoint', val + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((val / 450 * 100), 100) + '%');

  mqttClient.publish(TOPICS.CTRL_START,    '1',        { qos: 1 });
  mqttClient.publish(TOPICS.CTRL_SETPOINT, String(val), { qos: 1 });

  safeSet('prevStart', '1 (Start)');
  safeSet('motorStatusBadge', '● Running');
  document.getElementById('motorStatusBadge').className = 'badge badge-green';
  safeSet('dashStatusBadge', '● Running');
  document.getElementById('dashStatusBadge').className = 'badge badge-green';
  safeHTML('motorStatusText', '<span class="dot green"></span>Running');

  updatePreviewUI();
}

// ==========================================
// STOP MOTOR
// ==========================================
function askStop()    { document.getElementById('confirmOverlay').classList.add('show'); }
function closeConfirm() { document.getElementById('confirmOverlay').classList.remove('show'); }

function confirmStop() {
  closeConfirm();
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPICS.CTRL_STOP, '1', { qos: 1 });
  }
  motorRunning = false;

  safeSet('prevStart', '0 (Stop)');
  safeSet('motorStatusBadge', '● Stopped');
  document.getElementById('motorStatusBadge').className = 'badge badge-red';
  safeSet('dashStatusBadge', '● Stopped');
  document.getElementById('dashStatusBadge').className = 'badge badge-red';
  safeHTML('motorStatusText', '<span class="dot red"></span>Stopped');
}

// ==========================================
// RESET TELEMETRY
// ==========================================
function resetTelemetry() {
  if (!confirm('Hapus seluruh riwayat data Telemetry?')) return;
  allData.length = 0;
  const body = document.getElementById('dataTableBody');
  if (body) body.innerHTML = '';
  safeSet('statTotal', '0');
  safeSet('statAvgRPM', '0');
  safeSet('statErrM', '0%');
  safeSet('statErrS', '0%');
  safeSet('dataCount', '0 entri');
}

// ==========================================
// KONEKSI MQTT
// ==========================================
function connectMQTT() {
  if (mqttClient) mqttClient.end(true);

  const host = document.getElementById('mqttHost').value.trim();
  const port = document.getElementById('mqttPort').value.trim();
  const user = document.getElementById('mqttUser').value.trim();
  const pass = document.getElementById('mqttPass').value.trim();

  safeSet('mqttHostDisplay', `${host}:${port}`);
  safeSet('mqttStatusText', 'Menghubungkan...');

  mqttClient = mqtt.connect(`wss://${host}:${port}/mqtt`, {
    clientId: 'bldc_web_' + Math.random().toString(16).substr(2, 8),
    username: user,
    password: pass
  });

  mqttClient.on('connect', () => {
    document.getElementById('mqttDot').className  = 'mqtt-dot online';
    document.getElementById('mqttPill').className = 'mqtt-pill online';
    safeSet('mqttStatusText', 'MQTT Online');
    safeHTML('mqttBrokerStatus', '<span class="dot green"></span>Terhubung');
    mqttClient.subscribe(TOPICS.DATA_ALL);
    mqttClient.subscribe(TOPICS.STATUS_IP);
  });

  mqttClient.on('message', (topic, message) => {
    const raw = message.toString().trim();
    msgCount++;
    safeSet('mqttMsgCount', msgCount);
    safeSet('lastMsg', new Date().toLocaleTimeString('id-ID'));

    if (topic === TOPICS.STATUS_IP) {
      safeSet('espIpAddress', raw);
      const otaInput = document.getElementById('otaIpAddress');
      if (otaInput) otaInput.value = raw;
      return;
    }

    if (raw.includes(',')) {
      const parts = raw.split(',');
      if (parts.length >= 4) {
        // Ekstrak data utama ESP32
        const pRpm   = parseFloat(parts[0]);
        const pPwm   = parseFloat(parts[1]);
        const pError = parseFloat(parts[2]);
        const pLevel = parts[3];

        // SINKRONISASI STATE ESP32 KE SEMUA DEVICE (HP/Laptop)
        if (parts.length >= 7) {
          const espSetpoint = parseFloat(parts[4]);
          const espStatus   = (parts[5] === "1"); // true jika running
          const espFuzzy    = parts[6];           // 'mamdani' atau 'sugeno'

          // 1. Sinkronkan Setpoint & Garis Grafik
          if (currentSetpointVal !== espSetpoint) {
            currentSetpointVal = espSetpoint;
            safeSet('spRPMVal', espSetpoint);
            safeSet('mSetpoint', espSetpoint);
            safeSet('activeSetpoint', espSetpoint + ' RPM');
            safeStyle('barSetpoint', 'width', Math.min((espSetpoint / 450 * 100), 100) + '%');
            if (document.getElementById('spRPMInput')) document.getElementById('spRPMInput').value = espSetpoint;
          }

          // 2. Sinkronkan Status Start/Stop
          if (motorRunning !== espStatus) {
            if (espStatus) { // Jika mendadak start dari device lain
              peakRPM = 0; rpmMinVal = Infinity; rpmMaxVal = 0;
              startTime = Date.now(); sysRiseTime = 0; isRising = true;
              rpmHistory.fill(0); rpmTimeLabels.fill(''); miniHistory.fill(0);
              if (espFuzzy === 'mamdani') { mamdaniRpm = []; mamdaniSp = []; mamdaniLbl = []; }
              else { sugenoRpm = []; sugenoSp = []; sugenoLbl = []; }
              
              safeSet('motorStatusBadge', '● Running');
              document.getElementById('motorStatusBadge').className = 'badge badge-green';
              safeSet('dashStatusBadge', '● Running');
              document.getElementById('dashStatusBadge').className = 'badge badge-green';
              safeHTML('motorStatusText', '<span class="dot green"></span>Running');
            } else { // Jika mendadak stop dari device lain
              safeSet('motorStatusBadge', '● Stopped');
              document.getElementById('motorStatusBadge').className = 'badge badge-red';
              safeSet('dashStatusBadge', '● Stopped');
              document.getElementById('dashStatusBadge').className = 'badge badge-red';
              safeHTML('motorStatusText', '<span class="dot red"></span>Stopped');
            }
            motorRunning = espStatus;
          }

          // 3. Sinkronkan Tipe Fuzzy yang Aktif
          if (activeFuzzyVal !== espFuzzy) {
            activeFuzzyVal = espFuzzy;
            safeSet('dashFuzzyBadge', 'Fuzzy: ' + (espFuzzy === 'mamdani' ? 'Mamdani' : 'Sugeno'));
            safeSet('activeFuzzy', espFuzzy === 'mamdani' ? 'Mamdani' : 'Sugeno');
            const optM = document.getElementById('fuzzyOptM');
            const optS = document.getElementById('fuzzyOptS');
            const chkM = document.getElementById('checkM');
            const chkS = document.getElementById('checkS');
            
            if (espFuzzy === 'mamdani' && optM && optS) {
              optS.classList.remove('selected-green'); optM.classList.add('selected-blue');
              optM.style.borderColor = 'rgba(59,130,246,0.45)'; optM.style.background = 'rgba(59,130,246,0.15)';
              optS.style.borderColor = 'transparent'; optS.style.background = 'transparent';
              chkM.style.opacity = '1'; chkS.style.opacity = '0';
              document.getElementById('foNameM').style.color = '#7dd3fc';
              document.getElementById('foNameS').style.color = 'var(--text-hi)';
            } else if (espFuzzy === 'sugeno' && optM && optS) {
              optM.classList.remove('selected-blue'); optS.classList.add('selected-green');
              optS.style.borderColor = 'rgba(16,185,129,0.45)'; optS.style.background = 'rgba(16,185,129,0.15)';
              optM.style.borderColor = 'transparent'; optM.style.background = 'transparent';
              chkS.style.opacity = '1'; chkM.style.opacity = '0';
              document.getElementById('foNameS').style.color = '#6ee7b7';
              document.getElementById('foNameM').style.color = 'var(--text-hi)';
            }
          }

          // 4. Sinkronkan Tombol Level Beban
          if (activeLevelVal !== pLevel) {
            activeLevelVal = pLevel;
            safeSet('dashLevel', pLevel);
            safeSet('activeLevel', pLevel);
            document.querySelectorAll('.level-btns .level-btn').forEach(b => {
              b.classList.remove('active');
              if ((pLevel === 'N' && b.innerText.includes('0 Load')) || b.innerText.includes('Load ' + pLevel)) {
                b.classList.add('active');
              }
            });
          }
          
          updatePreviewUI();
        }

        processIncomingData(pRpm, pPwm, pError, pLevel);
      }
    }
  });

  mqttClient.on('error', () => safeSet('mqttStatusText', 'Error Koneksi'));
  mqttClient.on('close', () => safeSet('mqttStatusText', 'MQTT Offline'));
}

function disconnectMQTT() {
  if (mqttClient) mqttClient.end(true);
  document.getElementById('mqttDot').className  = 'mqtt-dot';
  document.getElementById('mqttPill').className = 'mqtt-pill';
  safeSet('mqttStatusText', 'MQTT Offline');
  safeHTML('mqttBrokerStatus', '<span class="dot red"></span>Offline');
}

// ==========================================
// PROSES DATA MASUK DARI ESP32
// ==========================================
function processIncomingData(rpm, pwm, error, level) {

  // 1. Update metrik dashboard
  safeSet('mRPM', rpm.toFixed(1));
  safeStyle('barRPM', 'width', Math.min((rpm / 450 * 100), 100) + '%');

  if (motorRunning) {
    if (rpm > peakRPM) peakRPM = rpm;
    if (rpm < rpmMinVal) { rpmMinVal = rpm; safeSet('rpmMin', rpm.toFixed(1)); }
    if (rpm > rpmMaxVal) { rpmMaxVal = rpm; safeSet('rpmMax', rpm.toFixed(1)); }
  }

  safeSet('mPWM', pwm.toFixed(2));
  safeSet('miniPwmVal', pwm.toFixed(2));
  let pwmPct = ((pwm - 103) / (255 - 103)) * 100;
  safeStyle('barPWM', 'width', Math.max(0, Math.min(pwmPct, 100)) + '%');

  // 2. Format waktu
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0') + ':' +
                  String(now.getSeconds()).padStart(2, '0');

  // 3. Geser array history dashboard
  rpmHistory.push(rpm);      rpmHistory.shift();
  rpmTimeLabels.push(timeStr); rpmTimeLabels.shift();
  miniHistory.push(rpm);     miniHistory.shift();

  // 4. Rise Time
  if (isRising && currentSetpointVal > 0) {
    if (rpm >= currentSetpointVal * 0.90) {
      sysRiseTime = (Date.now() - startTime) / 1000;
      isRising    = false;
    } else {
      sysRiseTime = (Date.now() - startTime) / 1000;
    }
  }
  safeSet('gaugeSetpointVal', currentSetpointVal);
  safeSet('gaugeRiseTimeVal', sysRiseTime.toFixed(1) + ' s');

  // 5. Steady-State Error
  let steadyStateError = error;
  if (peakRPM >= currentSetpointVal * 0.90 && currentSetpointVal > 0 && rpmHistory.length >= 5) {
    const last5  = rpmHistory.slice(-5);
    const avgRpm = last5.reduce((a, b) => a + b, 0) / 5;
    steadyStateError = currentSetpointVal - avgRpm;
  }
  safeSet('mError', Math.abs(steadyStateError).toFixed(1));
  safeStyle('barError', 'width', Math.min(Math.abs(steadyStateError), 100) + '%');

  // 6. Overshoot
  let overshoot = 0;
  if (currentSetpointVal > 0 && peakRPM > currentSetpointVal) {
    overshoot = ((peakRPM - currentSetpointVal) / currentSetpointVal) * 100;
  }
  safeSet('overshootVal', overshoot.toFixed(1));
  safeStyle('barOvershoot', 'width', Math.min(overshoot, 100) + '%');

  // 7. Speedometer (Dikonversi ke km/jam)
  if (gaugeChart) {
    let kmh = rpm * 0.0528;
    const val = Math.min(kmh, 11); // Mentok di 11 km/jam
    gaugeChart.data.datasets[0].data = [val, 11 - val];
    gaugeChart.update();
  }

  // 8. Auto-zoom sumbu Y
  let yMin = 0, yMax = 100;
  if (currentSetpointVal > 0) {
    yMin = isRising ? 0 : Math.max(0, currentSetpointVal - 70);
    yMax = currentSetpointVal + 70;
  }

  if (rpmChart) {
    rpmChart.options.scales.y.min    = yMin;
    rpmChart.options.scales.y.max    = yMax;
    rpmChart.data.labels              = rpmTimeLabels;
    rpmChart.data.datasets[0].data    = rpmHistory;
    rpmChart.data.datasets[1].data    = Array(30).fill(currentSetpointVal);
    rpmChart.update('none');
  }
  if (miniChart) {
    miniChart.options.scales.y.min = yMin;
    miniChart.options.scales.y.max = yMax;
    miniChart.update('none');
  }

  // 9. Rekam ke buffer tipe fuzzy yang SEDANG AKTIF saja
  //    (hanya saat motor berjalan)
  if (motorRunning) {
    if (activeFuzzyVal === 'mamdani') {
      mamdaniRpm.push(rpm);
      mamdaniSp.push(currentSetpointVal);
      mamdaniLbl.push(timeStr);

      // Update chart Mamdani jika sedang tampil
      [cMPage, cCmpM].forEach(chart => {
        if (chart) {
          chart.options.scales.y.min    = yMin;
          chart.options.scales.y.max    = yMax;
          chart.data.labels              = mamdaniLbl;
          chart.data.datasets[0].data    = mamdaniRpm;
          chart.data.datasets[1].data    = mamdaniSp;
          chart.update('none');
        }
      });

    } else {
      sugenoRpm.push(rpm);
      sugenoSp.push(currentSetpointVal);
      sugenoLbl.push(timeStr);

      // Update chart Sugeno jika sedang tampil
      [cSPage, cCmpS].forEach(chart => {
        if (chart) {
          chart.options.scales.y.min    = yMin;
          chart.options.scales.y.max    = yMax;
          chart.data.labels              = sugenoLbl;
          chart.data.datasets[0].data    = sugenoRpm;
          chart.data.datasets[1].data    = sugenoSp;
          chart.update('none');
        }
      });
    }
  }

  // 10. Error Instan
  let errorInstan = currentSetpointVal - rpm;
  safeSet('mErrorInstan', errorInstan.toFixed(1));
  safeStyle('barErrorInstan', 'width', Math.min(Math.abs(errorInstan) / (currentSetpointVal || 1) * 100, 100) + '%');

  // 11. Log ke telemetry
  logTelemetry(rpm, pwm, steadyStateError, overshoot, activeFuzzyVal, level);
}

// ==========================================
// TELEMETRY LOG
// ==========================================
function logTelemetry(rpm, pwm, err, os, fuzzy, level) {
  const timeStr = new Date().toLocaleTimeString('id-ID');
  allData.unshift({
    time:  timeStr,
    rpm:   rpm.toFixed(1),
    sp:    currentSetpointVal,
    pwm:   pwm.toFixed(2),
    err:   err.toFixed(1),
    os:    os.toFixed(1),
    type:  fuzzy === 'mamdani' ? 'Mamdani' : 'Sugeno',
    beban: level
  });

  // Throttle: render tabel maksimal 1× per detik
  if (!window.tableRenderPending) {
    window.tableRenderPending = true;
    setTimeout(() => {
      updateTelemetryUI();
      window.tableRenderPending = false;
    }, 1000);
  }
}

function updateTelemetryUI() {
  safeSet('statTotal', allData.length);
  if (allData.length === 0) return;

  const avgRpm = allData.reduce((s, d) => s + parseFloat(d.rpm), 0) / allData.length;
  safeSet('statAvgRPM', avgRpm.toFixed(1));

  const mamData = allData.filter(d => d.type === 'Mamdani');
  if (mamData.length > 0) {
    safeSet('statErrM', (mamData.reduce((s, d) => s + Math.abs(parseFloat(d.err)), 0) / mamData.length).toFixed(1) + '%');
  }
  const sugData = allData.filter(d => d.type === 'Sugeno');
  if (sugData.length > 0) {
    safeSet('statErrS', (sugData.reduce((s, d) => s + Math.abs(parseFloat(d.err)), 0) / sugData.length).toFixed(1) + '%');
  }

  const body = document.getElementById('dataTableBody');
  if (body) {
    body.innerHTML = allData.slice(0, 50).map((d, i) =>
      `<tr><td>${i + 1}</td><td>${d.time}</td><td><b>${d.rpm}</b></td><td>${d.sp}</td><td>${d.pwm}</td>` +
      `<td><span class="badge ${Math.abs(d.err) > 10 ? 'badge-amber' : 'badge-green'}">${d.err}</span></td>` +
      `<td>${d.os}</td><td><span class="badge ${d.type === 'Sugeno' ? 'badge-green' : 'badge-blue'}">${d.type}</span></td>` +
      `<td>${d.beban}</td></tr>`
    ).join('');
    safeSet('dataCount', Math.min(allData.length, 50) + ' entri');
  }

  updateFuzzyMetricTables();
}

function updateFuzzyMetricTables() {
  const levels = ['N', '1', '2', '3'];
  let mHTML = '', sHTML = '', cmpHTML = '';

  levels.forEach(lv => {
    const mRows = allData.filter(d => d.type === 'Mamdani' && String(d.beban) === lv);
    const sRows = allData.filter(d => d.type === 'Sugeno'  && String(d.beban) === lv);

    const getStats = (arr) => {
      if (arr.length === 0) return { os: '-', sse: '-' };
      return {
        os:  Math.max(...arr.map(d => parseFloat(d.os))).toFixed(1) + '%',
        sse: (arr.reduce((sum, d) => sum + Math.abs(parseFloat(d.err)), 0) / arr.length).toFixed(1)
      };
    };

    const sM = getStats(mRows);
    const sS = getStats(sRows);

    mHTML   += `<tr><td>Level ${lv}</td><td>—</td><td>${sM.os}</td><td>${sM.sse}</td><td><span class="badge badge-blue">Mamdani</span></td></tr>`;
    sHTML   += `<tr><td>Level ${lv}</td><td>—</td><td>${sS.os}</td><td>${sS.sse}</td><td><span class="badge badge-green">Sugeno</span></td></tr>`;

    let winner = '—';
    if (mRows.length && sRows.length) {
      const skM = (parseFloat(sM.os) || 0) + (parseFloat(sM.sse) || 0);
      const skS = (parseFloat(sS.os) || 0) + (parseFloat(sS.sse) || 0);
      winner = skS < skM ? 'Sugeno' : skM < skS ? 'Mamdani' : 'Seimbang';
    }
    cmpHTML += `<tr><td>Level ${lv}</td><td>${sM.os}</td><td>${sS.os}</td><td>${sM.sse}</td><td>${sS.sse}</td><td><span class="badge badge-gold">${winner}</span></td></tr>`;
  });

  safeHTML('metricMBody',   mHTML);
  safeHTML('metricSBody',   sHTML);
  safeHTML('metricCmpBody', cmpHTML);
}

// ==========================================
// EKSPOR CSV
// ==========================================
function exportCSV() {
  const headers = 'Waktu,RPM,Setpoint,PWM,Error,Overshoot(%),Tipe Fuzzy,Beban\n';
  const rows    = allData.map(d => `${d.time},${d.rpm},${d.sp},${d.pwm},${d.err},${d.os},${d.type},${d.beban}`).join('\n');
  const a       = document.createElement('a');
  a.href        = URL.createObjectURL(new Blob([headers + rows], { type: 'text/csv' }));
  a.download    = 'bldc_telemetry.csv';
  a.click();
}

// ==========================================
// BUKA PORTAL OTA
// ==========================================
function openOTAPortal() {
  const ipInput = document.getElementById('otaIpAddress').value.trim();
  if (!ipInput) return alert('Harap masukkan IP Address ESP32 terlebih dahulu!\n(Contoh: 192.168.1.15)');
  const cleanIp = ipInput.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  window.open(`http://${cleanIp}/update`, '_blank');
}

// ==========================================
// RENDER RULE BASE TABLE (25 aturan, sesuai ESP32 .ino)
// Nilai konstan Sugeno: -255, -127, 0, 127, 255
// Nilai Mamdani sama persis karena berbagi rule base
// ==========================================
function renderRuleBase() {
  // Matriks output (baris = Error: NB..PB, kolom = DeltaError: NB..PB)
  const rules = [
    [-255, -255, -127, -127,    0],  // Error NB
    [-255, -127, -127,    0,  127],  // Error NS
    [-127, -127,    0,  127,  127],  // Error ZE
    [-127,    0,  127,  127,  255],  // Error PS
    [   0,  127,  127,  255,  255]   // Error PB
  ];
  const headers = ['NB', 'NS', 'ZE', 'PS', 'PB'];

  const getBadgeClass = (val) => {
    if (val === -255) return 'rp-vr';
    if (val === -127) return 'rp-r';
    if (val ===    0) return 'rp-s';
    if (val ===  127) return 'rp-t';
    if (val ===  255) return 'rp-vt';
    return '';
  };

  let html = `<thead><tr><th>E \\ dE</th>`;
  headers.forEach(de => html += `<th>${de}</th>`);
  html += `</tr></thead><tbody>`;

  headers.forEach((e, i) => {
    html += `<tr><td>${e}</td>`;
    rules[i].forEach(val => html += `<td><span class="${getBadgeClass(val)}">${val}</span></td>`);
    html += `</tr>`;
  });
  html += `</tbody>`;

  safeHTML('ruleMamdani', html);
  safeHTML('ruleSugeno',  html);
}

// ==========================================
// TEMA LIGHT / DARK
// ==========================================
function applyTheme(theme) {
  const icon = document.getElementById('themeIcon');
  if (theme === 'light') {
    document.documentElement.classList.add('light-mode');
    if (icon) icon.textContent = '☀️';
  } else {
    document.documentElement.classList.remove('light-mode');
    if (icon) icon.textContent = '🌙';
  }
  localStorage.setItem('bldc-theme', theme);

  [mfMChart, mfSChart].forEach(ch => {
    if (!ch) return;
    ch.options.scales.x.ticks.color = chartAxisColor();
    ch.options.scales.x.grid.color  = chartGridColorSubtle();
    ch.options.scales.y.ticks.color = chartAxisColor();
    ch.options.scales.y.grid.color  = chartGridColorSubtle();
    ch.update();
  });
}

function toggleTheme() {
  applyTheme(document.documentElement.classList.contains('light-mode') ? 'dark' : 'light');
}

// ==========================================
// INISIALISASI SAAT HALAMAN DIBUKA
// ==========================================
window.onload = () => {
  applyTheme(document.documentElement.classList.contains('light-mode') ? 'light' : 'dark');

  initDashboardCharts();
  selectFuzzyType('sugeno');
  renderRuleBase();

  if (document.getElementById('spRPMInput')) document.getElementById('spRPMInput').value = 100;
  if (document.getElementById('spRPM'))      document.getElementById('spRPM').value      = 100;

  safeSet('spRPMVal',         100);
  safeSet('mSetpoint',        100);
  safeSet('activeSetpoint',   '100 RPM');
  safeSet('gaugeSetpointVal', 100);
  safeStyle('barSetpoint', 'width', (100 / 450 * 100) + '%');
  updatePreviewUI();
};

// Tutup sub-menu saat klik di luar
document.addEventListener('click', () => document.querySelectorAll('.sub-menu').forEach(m => m.classList.remove('open')));

// ==========================================
// EXPOSE FUNGSI KE WINDOW (dipanggil dari HTML onclick)
// ==========================================
window.showPage        = showPage;
window.toggleSubMenu   = toggleSubMenu;
window.showFuzzyMode   = showFuzzyMode;
window.syncSliderUI    = syncSliderUI;
window.syncInputUI     = syncInputUI;
window.confirmSetpoint = confirmSetpoint;
window.selectFuzzyType = selectFuzzyType;
window.selectLevel     = selectLevel;
window.runMotor        = runMotor;
window.askStop         = askStop;
window.closeConfirm    = closeConfirm;
window.confirmStop     = confirmStop;
window.resetTelemetry  = resetTelemetry;
window.connectMQTT     = connectMQTT;
window.disconnectMQTT  = disconnectMQTT;
window.exportCSV       = exportCSV;
window.toggleTheme     = toggleTheme;
window.openOTAPortal   = openOTAPortal;