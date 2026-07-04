'use strict';

// ==========================================
// DAFTAR TOPIC MQTT
// Topic untuk baca data sensor (data/*) dan kirim perintah (control/*)
// ==========================================
const TOPICS = {
  DATA_ALL:        'bldc/data/#',
  DATA_RPM:        'bldc/data/rpm',
  STATUS_IP:       'bldc/status/ip',
  CTRL_START:      'bldc/control/start',
  CTRL_STOP:       'bldc/control/stop',
  CTRL_SETPOINT:   'bldc/control/setpoint',
  CTRL_FUZZY:      'bldc/control/fuzzy',
  CTRL_LEVEL:      'bldc/control/level'
};

// ==========================================
// VARIABEL GLOBAL / STATE APLIKASI
// ==========================================
let mqttClient         = null;   // objek koneksi MQTT
let motorRunning        = false; // status motor: jalan atau tidak
let activeLevelVal      = 'N';   // level beban aktif (1/2/3/N)
let activeFuzzyVal      = 'sugeno'; // tipe fuzzy aktif (mamdani/sugeno)
let currentSetpointVal  = 100;   // target RPM yang aktif sekarang
let peakRPM             = 0;     // RPM tertinggi yang pernah tercapai (buat hitung overshoot)
let msgCount            = 0;     // jumlah pesan MQTT yang sudah masuk

// Variabel untuk menghitung Rise Time & Steady-State Error secara real-time
let startTime    = 0;
let sysRiseTime   = 0;
let isRising      = false;

// Nilai RPM minimum & maksimum selama motor berjalan (1 sesi)
let rpmMinVal = Infinity;
let rpmMaxVal = 0;

// Referensi objek-objek chart (Chart.js)
let rpmChart, gaugeChart, miniChart;
let cMPage, cSPage, cCmpM, cCmpS, mfMChart, mfSChart;

// Variabel untuk perekaman grafik live selama 60 detik di halaman Tipe Fuzzy
let liveHistoryRpm   = [];
let liveHistorySp    = [];
let liveHistoryLbl   = [];
let isFuzzyRecording = false;
let fuzzyTimeCounter = 0;

// Array penyimpan history untuk grafik dashboard (30 titik terakhir)
const rpmHistory    = Array(30).fill(0);
const rpmTimeLabels = Array(30).fill(''); // label waktu di sumbu X, harus ada biar chart tidak error
const miniHistory   = Array(15).fill(0);
const allData       = []; // semua data telemetry yang sudah masuk (buat tabel & export CSV)

// Variabel pengukuran latensi
let latencyLog = [];       // menyimpan riwayat latensi untuk rata-rata
let lastCmdSentAt = 0;
let lastCmdTopic = '';

// ==========================================
// FUNGSI BANTUAN (HELPER)
// Supaya tidak perlu cek elemen null berulang-ulang di setiap pemanggilan
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
// JAM & TANGGAL REAL-TIME DI HEADER
// ==========================================
function updateClock() {
  const now = new Date();
  safeSet('clockDisplay', now.toLocaleTimeString('id-ID'));
  safeSet('dateDisplay', now.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }));
}
setInterval(updateClock, 1000);
updateClock();

// ==========================================
// NAVIGASI ANTAR HALAMAN
// ==========================================

// Pindah halaman utama (Dashboard, Telemetry, Pengaturan, Panduan)
function showPage(pageKey, navEl, event) {
  if (event) event.stopPropagation();

  // tutup semua sub-menu yang terbuka
  document.querySelectorAll('.sub-menu').forEach(m => m.classList.remove('open'));

  // sembunyikan semua halaman, lalu tampilkan halaman yang dipilih
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + pageKey).classList.add('active');

  // ubah menu yang aktif di navbar
  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active', 'sub-open'));
  if (navEl) navEl.classList.add('active');

  // kalau masuk ke halaman kontrol, baru inisialisasi mini chart (lazy init)
  if (pageKey === 'kontrol' && !miniChart) initMiniChart();
}

// Buka/tutup dropdown sub-menu (misal sub-menu "Tipe Fuzzy")
function toggleSubMenu(menuId, event) {
  if (event) event.stopPropagation();
  document.getElementById(menuId).classList.toggle('open');
}

// Pindah ke sub-halaman Tipe Fuzzy: Mamdani / Sugeno / Perbandingan
function showFuzzyMode(mode, navEl, event) {
  if (event) event.stopPropagation();

  startFuzzyCapture(); // Ini akan mengosongkan liveHistoryRpm dan reset counter

  // sembunyikan semua halaman, tampilkan halaman fuzzy
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-fuzzy').classList.add('active');

  // hapus status aktif dari semua menu di topbar, lalu aktifkan menu yang baru saja diklik
  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active', 'sub-open'));
  if (navEl) navEl.classList.add('active');

  // sembunyikan semua sub-halaman fuzzy dulu sebelum menampilkan salah satunya
  document.querySelectorAll('.fuzzy-sub-page').forEach(p => p.style.display = 'none');

  if (mode === 'mamdani') {
    document.getElementById('fuzzy-mamdani').style.display = 'block';
    if (!cMPage) initFuzzyMamdani();
    else cMPage.update(); // Update chart Mamdani
  } else if (mode === 'sugeno') {
    document.getElementById('fuzzy-sugeno').style.display = 'block';
    if (!cSPage) initFuzzySugeno();
    else cSPage.update(); // Update chart Sugeno
  }
  else if (mode === 'compare') {
    document.getElementById('fuzzy-compare').style.display = 'block';
    if (!cCmpM || !cCmpS) initCompareCharts();
    else { cCmpM.update(); cCmpS.update(); } // Update chart Perbandingan
  }
}

// ==========================================
// FUNGSI MEMBERSHIP FUNCTION (FUZZY)
// Sesuai dengan program ESP32 (Domain Error: -200 s.d 200)
// ==========================================

// Fungsi Keanggotaan Segitiga
function trimf(x, a, b, c) {
  if (x <= a || x >= c) return 0;
  if (x === b) return 1;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

// Fungsi Keanggotaan Trapesium
function trapmf(x, a, b, c, d) {
  if (x <= a || x >= d) return 0;
  if (x >= b && x <= c) return 1;
  if (x > a && x < b) return (x - a) / (b - a);
  return (d - x) / (d - c);
}

// Warna sumbu chart yang menyesuaikan tema aktif (terang/gelap)
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

// Membuat grafik membership function (NB, NS, ZE, PS, PB) untuk input Error
function makeMFChart(canvasId) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;

  // Sumbu X dari -200 sampai 200 (sesuai domain input error ESP32), loncat tiap 10 angka
  const labels = [];
  for (let i = -200; i <= 200; i += 10) labels.push(i);

  // Menghitung derajat keanggotaan persis seperti di .ino
  const dNB = labels.map(x => trapmf(x, -200, -200, -150, -75));
  const dNS = labels.map(x => trimf(x, -150, -75, 0));
  const dZE = labels.map(x => trimf(x, -50, 0, 50));
  const dPS = labels.map(x => trimf(x, 0, 75, 150));
  const dPB = labels.map(x => trapmf(x, 75, 150, 200, 200));

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'NB', data: dNB, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)', fill: true, tension: 0, pointRadius: 0, borderWidth: 2 },
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

// Konfigurasi khusus untuk grafik yang perlu menampilkan waktu di sumbu X
const fuzzyChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 0 },
  plugins: { legend: { display: false } },
  scales: {
    x: { 
      display: true, 
      ticks: { color: '#94a3b8', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, 
      grid: { display: false } 
    },
    y: { min: 0, ticks: { color: '#4a5888', font: { size: 10 } }, grid: { color: 'rgba(80,140,255,0.07)' } }
  }
};

// Plugin custom Chart.js: nulis angka RPM di tengah gauge speedometer
const gaugePlugin = {
  id: 'gaugeCenterText',
  afterDraw(chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    const rpmText = document.getElementById('mRPM')?.textContent || '0';
    ctx.font = '700 34px Rajdhani, sans-serif';
    ctx.fillStyle = '#93c5fd';
    ctx.textAlign = 'center';
    ctx.fillText(rpmText, width / 2, height * 0.78);
    ctx.font = '500 13px Rajdhani, sans-serif';
    ctx.fillStyle = '#94a3c8';
    ctx.fillText('RPM', width / 2, height * 0.92);
    ctx.restore();
  }
};

// ==========================================
// INISIALISASI CHART DI DASHBOARD
// (grafik RPM real-time + speedometer)
// ==========================================
function initDashboardCharts() {
  const ctxRpm = document.getElementById('rpmChart');
  if (ctxRpm) {
    rpmChart = new Chart(ctxRpm, {
      type: 'line',
      data: {
        labels: rpmTimeLabels, // label sumbu X berupa jam (HH:MM:SS)
        datasets: [
          { label: 'RPM', data: rpmHistory, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
          { label: 'Setpoint', data: Array(30).fill(0), borderColor: '#ef4444', borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, fill: false }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
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
        datasets: [{
          data: [0, 450],
          backgroundColor: ['#3b82f6', 'rgba(255,255,255,0.05)'],
          borderWidth: 0,
          circumference: 180, // setengah lingkaran, model speedometer
          rotation: 270
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: { tooltip: { enabled: false } }
      },
      plugins: [gaugePlugin] // plugin custom buat nulis angka RPM di tengah
    });
  }
}

// Inisialisasi mini chart (dipakai di halaman kontrol, kalau ada)
function initMiniChart() {
  const ctx = document.getElementById('miniRpmChart');
  if (ctx) {
    miniChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(15).fill(''),
        datasets: [{
          data: miniHistory,
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6,182,212,0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 0
        }]
      },
      options: chartDefaults
    });
  }
}

// ==========================================
// INISIALISASI CHART DI HALAMAN TIPE FUZZY
// (Mamdani, Sugeno, dan Perbandingan)
// ==========================================
function initFuzzyMamdani() {
  const ctx = document.getElementById('chartMamdani');
  cMPage = new Chart(ctx, {
    type: 'line',
    data: {
      labels: liveHistoryLbl,
      datasets: [
        { label: 'RPM', data: liveHistoryRpm, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2.5 },
        { label: 'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    options: fuzzyChartOptions // Gunakan config baru
  });
  mfMChart = makeMFChart('mfMamdani');
}

function initFuzzySugeno() {
  const ctx = document.getElementById('chartSugeno');
  cSPage = new Chart(ctx, {
    type: 'line',
    data: {
      labels: liveHistoryLbl,
      datasets: [
        { label: 'RPM', data: liveHistoryRpm, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2.5 },
        { label: 'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    options: fuzzyChartOptions // Gunakan config baru
  });
  mfSChart = makeMFChart('mfSugeno');
}

function initCompareCharts() {
  const ctxM = document.getElementById('chartCmpM');
  const ctxS = document.getElementById('chartCmpS');

  cCmpM = new Chart(ctxM, {
    type: 'line',
    data: {
      labels: liveHistoryLbl,
      datasets: [
        { label: 'RPM', data: liveHistoryRpm, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
        { label: 'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    // Ganti chartDefaults menjadi fuzzyChartOptions agar label waktu muncul
    options: fuzzyChartOptions 
  });

  cCmpS = new Chart(ctxS, {
    type: 'line',
    data: {
      labels: liveHistoryLbl,
      datasets: [
        { label: 'RPM', data: liveHistoryRpm, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
        { label: 'Setpoint', data: liveHistorySp, borderColor: '#ef4444', borderDash: [5, 5], pointRadius: 0, fill: false }
      ]
    },
    // Ganti chartDefaults menjadi fuzzyChartOptions agar label waktu muncul
    options: fuzzyChartOptions
  });
}

// Mulai rekam ulang grafik live 60 detik (dipanggil tiap setpoint/fuzzy/start berubah)
function startFuzzyCapture() {
  liveHistoryRpm = [];
  liveHistorySp  = [];
  liveHistoryLbl = [];
  fuzzyTimeCounter  = 0;
  isFuzzyRecording  = true;
}

// ==========================================
// UPDATE TAMPILAN PREVIEW MQTT PUBLISH
// ==========================================
function updatePreviewUI() {
  safeSet('prevSetpoint', currentSetpointVal);
  safeSet('prevFuzzy', activeFuzzyVal);
  safeSet('prevLevel', activeLevelVal);
}

// ==========================================
// SINKRONISASI SLIDER & INPUT MANUAL SETPOINT
// (kalau slider digeser, input angka ikut update, dan sebaliknya)
// ==========================================
function syncSliderUI() {
  document.getElementById('spRPMInput').value = document.getElementById('spRPM').value;
}
function syncInputUI() {
  document.getElementById('spRPM').value = document.getElementById('spRPMInput').value;
}

// Konfirmasi setpoint baru ditekan (tombol OK)
function confirmSetpoint() {
  const val = parseInt(document.getElementById('spRPMInput').value) || 0;
  currentSetpointVal = val;
  peakRPM = 0; // reset peak RPM karena target baru

  safeSet('spRPMVal', val);
  safeSet('mSetpoint', val);
  safeSet('activeSetpoint', val + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((val / 450 * 100), 100) + '%');

  updatePreviewUI();
  startFuzzyCapture(); // mulai rekam grafik baru karena target berubah

  // kirim setpoint baru ke ESP32 lewat MQTT (kalau sudah terhubung)
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPICS.CTRL_SETPOINT, String(val), { qos: 1 });
  }
}

// ==========================================
// PILIH TIPE FUZZY CONTROLLER (Mamdani / Sugeno)
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
    optM.style.borderColor = 'rgba(59,130,246,0.45)';
    optM.style.background  = 'rgba(59,130,246,0.15)';
    optS.style.borderColor  = 'transparent';
    optS.style.background  = 'transparent';
    
    chkM.style.opacity = '1';
    chkS.style.opacity = '0';
    document.getElementById('foNameM').style.color = '#7dd3fc';
    document.getElementById('foNameS').style.color = 'var(--text-hi)';
    
  } else {
    optM.classList.remove('selected-blue');
    optS.classList.add('selected-green');
    optS.style.borderColor = 'rgba(16,185,129,0.45)';
    optS.style.background  = 'rgba(16,185,129,0.15)';
    optM.style.borderColor  = 'transparent';
    optM.style.background  = 'transparent';
    
    chkS.style.opacity = '1';
    chkM.style.opacity = '0';
    document.getElementById('foNameS').style.color = '#6ee7b7';
    document.getElementById('foNameM').style.color = 'var(--text-hi)';
  }

  safeSet('dashFuzzyBadge', 'Fuzzy: ' + (type === 'mamdani' ? 'Mamdani' : 'Sugeno'));
  safeSet('activeFuzzy', type === 'mamdani' ? 'Mamdani' : 'Sugeno');

  updatePreviewUI();
  startFuzzyCapture();

  // kirim tipe fuzzy yang dipilih ke ESP32
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPICS.CTRL_FUZZY, type, { qos: 1 });
  }
}

// ==========================================
// PILIH LEVEL BEBAN (Load 1/2/3/N)
// ==========================================
function selectLevel(n, btn) {
  activeLevelVal = n;

  // hapus class active dari semua tombol level, lalu set tombol yang ditekan jadi active
  document.querySelectorAll('.level-btns .level-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  safeSet('dashLevel', n);
  safeSet('activeLevel', n);
  updatePreviewUI();

  // kirim level beban ke ESP32
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPICS.CTRL_LEVEL, String(n), { qos: 1 });
  }
}

// ==========================================
// START / STOP MOTOR
// ==========================================

// Menjalankan motor (tombol "Start Motor")
function runMotor() {
  if (!mqttClient || !mqttClient.connected) return alert('MQTT Belum terhubung!');

  motorRunning = true;
  peakRPM   = 0;
  rpmMinVal = Infinity;
  rpmMaxVal = 0;
  safeSet('rpmMin', '0');
  safeSet('rpmMax', '0');

  // reset penghitung rise time
  startTime   = Date.now();
  sysRiseTime = 0;
  isRising    = true;

  // ==========================================
  // RESET GRAFIK KE 0 setiap kali motor di-start ulang
  // ==========================================
  rpmHistory.fill(0);
  rpmTimeLabels.fill(''); // kosongkan label waktu biar tidak menumpuk dari sesi sebelumnya
  miniHistory.fill(0);

  // baca ulang nilai setpoint terbaru dari kotak input, jaga-jaga kalau belum ditekan OK
  const val = parseInt(document.getElementById('spRPMInput').value) || 100;
  currentSetpointVal = val;
  safeSet('spRPMVal', val);
  safeSet('mSetpoint', val);
  safeSet('activeSetpoint', val + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((val / 450 * 100), 100) + '%');

  startFuzzyCapture();

  // kirim perintah Start ke ESP32
  mqttClient.publish(TOPICS.CTRL_START, '1', { qos: 1 });

  lastCmdSentAt = performance.now();
  lastCmdTopic = TOPICS.CTRL_START;

  lastCmdSentAt = performance.now();
  lastCmdTopic = TOPICS.CTRL_STOP;

  // kirim juga nilai setpoint terbaru sesaat setelah start
  mqttClient.publish(TOPICS.CTRL_SETPOINT, String(currentSetpointVal), { qos: 1 });

  // update tampilan status jadi "Running"
  safeSet('prevStart', '1 (Start)');
  safeSet('motorStatusBadge', '● Running');
  document.getElementById('motorStatusBadge').className = 'badge badge-green';
  safeSet('dashStatusBadge', '● Running');
  document.getElementById('dashStatusBadge').className = 'badge badge-green';
  safeHTML('motorStatusText', '<span class="dot green"></span>Running');
}

// Tombol "Stop Motor" ditekan -> tampilkan popup konfirmasi dulu
function askStop() {
  document.getElementById('confirmOverlay').classList.add('show');
}

// Tombol "Batal" di popup konfirmasi -> tutup popup, motor tidak dihentikan
function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('show');
}

// Tombol "Ya, Stop Motor" di popup konfirmasi -> motor benar-benar dihentikan
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
// RESET DATA TELEMETRY
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
// KONEKSI MQTT (Connect / Disconnect)
// ==========================================
function connectMQTT() {
  if (mqttClient) mqttClient.end(true); // tutup koneksi lama dulu kalau ada

  const host = document.getElementById('mqttHost').value.trim();
  const port = document.getElementById('mqttPort').value.trim();
  const user = document.getElementById('mqttUser').value.trim();
  const pass = document.getElementById('mqttPass').value.trim();

  safeSet('mqttHostDisplay', `${host}:${port}`);
  safeSet('mqttStatusText', 'Menghubungkan...');

  // bikin koneksi baru ke broker MQTT lewat WebSocket (WSS/TLS)
  mqttClient = mqtt.connect(`wss://${host}:${port}/mqtt`, {
    clientId: 'bldc_web_' + Math.random().toString(16).substr(2, 8),
    username: user,
    password: pass
  });

  // saat berhasil terhubung
  mqttClient.on('connect', () => {
    document.getElementById('mqttDot').className  = 'mqtt-dot online';
    document.getElementById('mqttPill').className = 'mqtt-pill online';
    safeSet('mqttStatusText', 'MQTT Online');
    safeHTML('mqttBrokerStatus', '<span class="dot green"></span>Terhubung');

    // subscribe ke semua topic data (bldc/data/#)
    mqttClient.subscribe(TOPICS.DATA_ALL);
    mqttClient.subscribe(TOPICS.STATUS_IP);
  });

  // saat ada pesan data masuk dari ESP32
  mqttClient.on('message', (topic, message) => {
    const raw = message.toString().trim();
    // --- Ukur latensi saat data telemetry pertama masuk setelah command dikirim ---
    if (lastCmdSentAt && topic.includes('telemetry')) {
      const latencyMs = performance.now() - lastCmdSentAt;
      latencyLog.push(latencyMs);
      if (latencyLog.length > 50) latencyLog.shift(); // batasi riwayat

      const avgLatency = latencyLog.reduce((a, b) => a + b, 0) / latencyLog.length;
      // Memastikan elemen ada di HTML sebelum mengubahnya (opsional)
      safeSet('latencyNow', latencyMs.toFixed(1) + ' ms');
      safeSet('latencyAvg', avgLatency.toFixed(1) + ' ms');

      lastCmdSentAt = 0; // reset supaya tidak diukur berkali-kali
    }
    msgCount++;
    safeSet('mqttMsgCount', msgCount);
    safeSet('lastMsg', new Date().toLocaleTimeString('id-ID'));

    // ==========================================
    // TANGKAP IP ADDRESS
    // ==========================================
    if (topic === TOPICS.STATUS_IP) {
      safeSet('espIpAddress', raw); // Tampilkan di kotak status

      const otaInput = document.getElementById('otaIpAddress');
      if (otaInput) otaInput.value = raw;
      return; // Selesai proses pesan ini
    }
    // ==========================================
    // TANGKAP DATA TELEMETRY (RPM, PWM, ERROR, LEVEL)
    if (raw.includes(',')) {
      const parts = raw.split(',');
      if (parts.length >= 4) {
        processIncomingData(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]), parts[3]);
      }
    }
  });

  mqttClient.on('error', () => safeSet('mqttStatusText', 'Error Koneksi'));
  mqttClient.on('close', () => safeSet('mqttStatusText', 'MQTT Offline'));
}

// Putuskan koneksi MQTT secara manual
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
  
  // 1. Update Tampilan RPM Aktual
  safeSet('mRPM', rpm.toFixed(1));
  safeStyle('barRPM', 'width', Math.min((rpm / 450 * 100), 100) + '%');

  // 2. Track Peak RPM & Min/Max
  if (motorRunning) {
    if (rpm > peakRPM) peakRPM = rpm;
    if (rpm < rpmMinVal) { rpmMinVal = rpm; safeSet('rpmMin', rpm.toFixed(1)); }
    if (rpm > rpmMaxVal) { rpmMaxVal = rpm; safeSet('rpmMax', rpm.toFixed(1)); }
  }

  // 3. Update Tampilan PWM (2 desimal)
  safeSet('mPWM', pwm.toFixed(2));
  safeSet('miniPwmVal', pwm.toFixed(2)); 
  let pwmPct = ((pwm - 103) / (255 - 103)) * 100;
  safeStyle('barPWM', 'width', Math.max(0, Math.min(pwmPct, 100)) + '%');

  // 4. Format waktu untuk sumbu X grafik (HH:MM:SS)
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0') + ':' +
                  String(now.getSeconds()).padStart(2, '0');

  // 5. Geser array history grafik
  rpmHistory.push(rpm); rpmHistory.shift();
  rpmTimeLabels.push(timeStr); rpmTimeLabels.shift();
  miniHistory.push(rpm); miniHistory.shift();

  // 6. Hitung Rise Time
  if (isRising && currentSetpointVal > 0) {
    if (rpm >= currentSetpointVal * 0.90) {
      sysRiseTime = (Date.now() - startTime) / 1000;
      isRising = false; // sudah sampai target
    } else {
      sysRiseTime = (Date.now() - startTime) / 1000;
    }
  }
  safeSet('gaugeSetpointVal', currentSetpointVal);
  safeSet('gaugeRiseTimeVal', sysRiseTime.toFixed(1) + ' s');

  // 7. Hitung Steady-State Error (SSE) yang lebih akurat
  let steadyStateError = error;
  if (peakRPM >= currentSetpointVal * 0.90 && currentSetpointVal > 0 && rpmHistory.length >= 5) {
    const last5 = rpmHistory.slice(-5);
    const avgRpm = last5.reduce((a, b) => a + b, 0) / 5;
    steadyStateError = currentSetpointVal - avgRpm;
  }
  safeSet('mError', Math.abs(steadyStateError).toFixed(1));
  safeStyle('barError', 'width', Math.min(Math.abs(steadyStateError), 100) + '%');

  // 8. Hitung Overshoot (%)
  let overshoot = 0;
  if (currentSetpointVal > 0 && peakRPM > currentSetpointVal) {
    overshoot = ((peakRPM - currentSetpointVal) / currentSetpointVal) * 100;
  }
  safeSet('overshootVal', overshoot.toFixed(1));
  safeStyle('barOvershoot', 'width', Math.min(overshoot, 100) + '%');

  // 9. Update Speedometer
  if (gaugeChart) {
    const val = Math.min(rpm, 450);
    gaugeChart.data.datasets[0].data = [val, 450 - val];
    gaugeChart.update();
  }

  // 10. Auto-zoom Sumbu Y Grafik (+70 dan -70 dari Setpoint)
  let yMin = 0;
  let yMax = 100;
  if (currentSetpointVal > 0) {
    if (isRising) {
      yMin = 0;
      yMax = currentSetpointVal + 70; 
    } else {
      yMin = Math.max(0, currentSetpointVal - 70);
      yMax = currentSetpointVal + 70; 
    }
  }

  // Update grafik utama & mini chart
  if (rpmChart) {
    rpmChart.options.scales.y.min = yMin;
    rpmChart.options.scales.y.max = yMax;
    rpmChart.data.labels = rpmTimeLabels;
    rpmChart.data.datasets[0].data = rpmHistory;
    rpmChart.data.datasets[1].data = Array(30).fill(currentSetpointVal);
    rpmChart.update('none');
  }
  if (miniChart) {
    miniChart.options.scales.y.min = yMin;
    miniChart.options.scales.y.max = yMax;
    miniChart.update('none');
  }

  // 11. Rekam Grafik Live 60 Detik untuk Halaman Fuzzy
  if (isFuzzyRecording) {
    liveHistoryRpm.push(rpm);
    liveHistorySp.push(currentSetpointVal);
    liveHistoryLbl.push(fuzzyTimeCounter + 's');
    fuzzyTimeCounter++;

    if (fuzzyTimeCounter >= 60) isFuzzyRecording = false;

    [cMPage, cSPage, cCmpM, cCmpS].forEach(chart => {
      if (chart) {
        chart.options.scales.y.min = yMin; 
        chart.options.scales.y.max = yMax;
        chart.data.labels = liveHistoryLbl;
        chart.data.datasets[0].data = liveHistoryRpm;
        chart.data.datasets[1].data = liveHistorySp;
        chart.update('none');
      }
    });
  }

  // 12. Hitung Error Instan
  let errorInstan = currentSetpointVal - rpm;
  safeSet('mErrorInstan', errorInstan.toFixed(1));
  safeStyle('barErrorInstan', 'width', Math.min(Math.abs(errorInstan) / (currentSetpointVal || 1) * 100, 100) + '%');

  // 13. Log ke Telemetry
  logTelemetry(rpm, pwm, steadyStateError, overshoot, activeFuzzyVal, level);
}

// ==========================================
// PENCATATAN DATA TELEMETRY
// ==========================================

// Simpan satu baris data baru ke array allData, lalu jadwalkan render tabel
function logTelemetry(rpm, pwm, err, os, fuzzy, level) {
  const timeStr = new Date().toLocaleTimeString('id-ID');
  allData.unshift({
    time: timeStr,
    rpm: rpm.toFixed(1),
    sp: currentSetpointVal,
    pwm: pwm.toFixed(2),
    err: err.toFixed(1),
    os: os.toFixed(1),
    type: fuzzy === 'mamdani' ? 'Mamdani' : 'Sugeno',
    beban: level
  });

  // batasi render tabel maksimal 1x per detik biar tidak berat (throttle)
  if (!window.tableRenderPending) {
    window.tableRenderPending = true;
    setTimeout(() => {
      updateTelemetryUI();
      window.tableRenderPending = false;
    }, 1000);
  }
}

// Render ulang tabel telemetry + statistik ringkasan (total data, avg RPM, avg error)
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

  // render tabel log (maksimal 50 baris terbaru biar tidak berat)
  const body = document.getElementById('dataTableBody');
  if (body) {
    body.innerHTML = allData.slice(0, 50).map((d, i) => `<tr><td>${i + 1}</td><td>${d.time}</td><td><b>${d.rpm}</b></td><td>${d.sp}</td><td>${d.pwm}</td><td><span class="badge ${Math.abs(d.err) > 10 ? 'badge-amber' : 'badge-green'}">${d.err}</span></td><td>${d.os}</td><td><span class="badge ${d.type === 'Sugeno' ? 'badge-green' : 'badge-blue'}">${d.type}</span></td><td>${d.beban}</td></tr>`).join('');
    safeSet('dataCount', Math.min(allData.length, 50) + ' entri');
  }

  updateFuzzyMetricTables();
}

// Render ulang tabel metrik performa di halaman Tipe Fuzzy (Mamdani, Sugeno, Perbandingan)
function updateFuzzyMetricTables() {
  const levels = ['N', '1', '2', '3'];
  let mHTML = '', sHTML = '', cmpHTML = '';

  levels.forEach(lv => {
    // ambil data sesuai tipe fuzzy & level beban
    const mRows = allData.filter(d => d.type === 'Mamdani' && String(d.beban) === lv);
    const sRows = allData.filter(d => d.type === 'Sugeno' && String(d.beban) === lv);

    // hitung statistik: overshoot maksimum & rata-rata SSE
    const getStats = (arr) => {
      if (arr.length === 0) return { os: '-', sse: '-' };
      const maxOs = Math.max(...arr.map(d => parseFloat(d.os))).toFixed(1);
      const avgSse = (arr.reduce((sum, d) => sum + Math.abs(parseFloat(d.err)), 0) / arr.length).toFixed(1);
      return { os: maxOs + '%', sse: avgSse };
    };

    const sM = getStats(mRows);
    const sS = getStats(sRows);

    mHTML   += `<tr><td>Level ${lv}</td><td>—</td><td>${sM.os}</td><td>${sM.sse}</td><td><span class="badge badge-blue">Mamdani</span></td></tr>`;
    sHTML   += `<tr><td>Level ${lv}</td><td>—</td><td>${sS.os}</td><td>${sS.sse}</td><td><span class="badge badge-green">Sugeno</span></td></tr>`;

    // tentukan metode mana yang lebih stabil (skor = overshoot + SSE, lebih kecil lebih baik)
    let winner = '—';
    if (mRows.length && sRows.length) {
      const valOsM  = parseFloat(sM.os)  || 0;
      const valSseM = parseFloat(sM.sse) || 0;
      const valOsS  = parseFloat(sS.os)  || 0;
      const valSseS = parseFloat(sS.sse) || 0;
      const skorMamdani = valOsM + valSseM;
      const skorSugeno  = valOsS + valSseS;

      if (skorSugeno < skorMamdani) { winner = 'Sugeno'; }
      else if (skorMamdani < skorSugeno) { winner = 'Mamdani'; }
      else { winner = 'Seimbang'; }
    }

    cmpHTML += `<tr><td>Level ${lv}</td><td>${sM.os}</td><td>${sS.os}</td><td>${sM.sse}</td><td>${sS.sse}</td><td><span class="badge badge-gold">${winner}</span></td></tr>`;
  });

  safeHTML('metricMBody', mHTML);
  safeHTML('metricSBody', sHTML);
  safeHTML('metricCmpBody', cmpHTML);
}

// ==========================================
// EKSPOR DATA TELEMETRY KE FILE CSV
// ==========================================
function exportCSV() {
  const headers = 'Waktu,RPM,Setpoint,PWM,Error,Overshoot(%),Tipe Fuzzy,Beban\n';
  const rows = allData.map(d => `${d.time},${d.rpm},${d.sp},${d.pwm},${d.err},${d.os},${d.type},${d.beban}`).join('\n');

  // bikin file CSV secara dinamis lalu langsung di-download lewat browser
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([headers + rows], { type: 'text/csv' }));
  a.download = 'bldc_telemetry.csv';
  a.click();
}

// ==========================================
// BUKA PORTAL OTA (update firmware ESP32 lewat WiFi)
// ==========================================
function openOTAPortal() {
  const ipInput = document.getElementById('otaIpAddress').value.trim();

  if (!ipInput) {
    return alert('Harap masukkan IP Address ESP32 terlebih dahulu!\n(Contoh: 192.168.1.15)');
  }

  // bersihkan input kalau user tidak sengaja memasukkan http:// atau /update di awal/akhir
  let cleanIp = ipInput.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // buka tab baru langsung ke halaman OTA update ESP32
  window.open(`http://${cleanIp}/update`, '_blank');
}

// ==========================================
// RENDER MATRIKS RULE BASE (MAMDANI & SUGENO)
// Sesuai dengan 25 Aturan di ESP32 (Dalam bentuk angka PWM)
// ==========================================
function renderRuleBase() {
  // Matriks 5x5 berisi nilai numerik sesuai rule C++ (-800 s.d 800)
  const rules = [
    [-800, -800, -400, -400,    0], // Error NB
    [-800, -400, -400,    0,  400], // Error NS
    [-400, -400,    0,  400,  400], // Error ZE
    [-400,    0,  400,  400,  800], // Error PS
    [   0,  400,  400,  800,  800]  // Error PB
  ];
  
  const headers = ['NB', 'NS', 'ZE', 'PS', 'PB'];
  
  // Fungsi penentu class warna badge berdasarkan besaran angka
  const getBadgeClass = (val) => {
    if (val === -800) return 'rp-vr'; // Ungu/Merah Gelap (NB)
    if (val === -400) return 'rp-r';  // Biru (NS)
    if (val === 0)    return 'rp-s';  // Hijau (ZE)
    if (val === 400)  return 'rp-t';  // Kuning (PS)
    if (val === 800)  return 'rp-vt'; // Merah Terang (PB)
    return '';
  };

  // Susun HTML untuk tabel
  let html = `<thead><tr><th>E \\ dE</th>`;
  headers.forEach(de => html += `<th>${de}</th>`);
  html += `</tr></thead><tbody>`;

  headers.forEach((e, i) => {
    html += `<tr><td>${e}</td>`;
    rules[i].forEach(outVal => {
      // Masukkan angka ke dalam badge dengan warna yang sesuai
      html += `<td><span class="${getBadgeClass(outVal)}">${outVal}</span></td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody>`;

  // Terapkan ke tabel Mamdani dan Sugeno
  safeHTML('ruleMamdani', html);
  safeHTML('ruleSugeno', html);
}

// ==========================================
// SAAT HALAMAN PERTAMA KALI DIBUKA
// ==========================================
// ==========================================
// LIGHT MODE / DARK MODE
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

  // Perbarui warna sumbu grafik membership function yang sudah terlanjur dibuat,
  // supaya ikut menyesuaikan saat tema diganti di tengah pemakaian
  [typeof mfMChart !== 'undefined' ? mfMChart : null,
   typeof mfSChart !== 'undefined' ? mfSChart : null].forEach(ch => {
    if (!ch) return;
    ch.options.scales.x.ticks.color = chartAxisColor();
    ch.options.scales.x.grid.color = chartGridColorSubtle();
    ch.options.scales.y.ticks.color = chartAxisColor();
    ch.options.scales.y.grid.color = chartGridColorSubtle();
    ch.update();
  });
}

function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light-mode');
  applyTheme(isLight ? 'dark' : 'light');
}

window.onload = () => {
  // Sinkronkan ikon tema sesuai preferensi tersimpan (class sudah diset lebih awal di <head>)
  applyTheme(document.documentElement.classList.contains('light-mode') ? 'light' : 'dark');

  initDashboardCharts();
  selectFuzzyType('sugeno'); // default tipe fuzzy aktif: Sugeno

  // Tambahkan baris ini untuk merender matriks rule base!
  renderRuleBase();

  // paksa slider, input teks, dan indikator metrik langsung ke nilai default 100
  if (document.getElementById('spRPMInput')) document.getElementById('spRPMInput').value = 100;
  if (document.getElementById('spRPM')) document.getElementById('spRPM').value = 100;

  safeSet('spRPMVal', 100);
  safeSet('mSetpoint', 100);
  safeSet('activeSetpoint', '100 RPM');
  safeSet('gaugeSetpointVal', 100);
  safeStyle('barSetpoint', 'width', (100 / 450 * 100) + '%');
  updatePreviewUI();
};

// tutup sub-menu kalau user klik di luar area menu
document.addEventListener('click', () => document.querySelectorAll('.sub-menu').forEach(m => m.classList.remove('open')));

// ==========================================
// EKSPOR FUNGSI KE OBJEK WINDOW
// (supaya bisa dipanggil langsung lewat onclick di HTML)
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