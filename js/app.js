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
let activeFuzzyVal     = 'sugeno'; // Default
let currentSetpointVal = 0;
let peakRPM            = 0;
let msgCount           = 0;

let rpmChart, gaugeChart, miniChart;
let cMPage, cSPage, cCmpM, cCmpS, mfMChart, mfSChart;

const rpmHistory  = Array(30).fill(0);
const miniHistory = Array(15).fill(0);
const mamdaniHist = Array(30).fill(0);
const sugenoHist  = Array(30).fill(0);
const setpointHist= Array(30).fill(0);
const allData = [];

// ==========================================
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
  const menu = document.getElementById(menuId);
  menu.classList.toggle('open');
}

function showFuzzyMode(mode, event) {
  if (event) event.stopPropagation();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-fuzzy').classList.add('active');
  
  // Memastikan garis indikator aktif ada di menu "Tipe Fuzzy"
  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active', 'sub-open'));
  document.getElementById('nav-fuzzy').classList.add('active');
  document.getElementById('fuzzy-sub').classList.remove('open'); // Tutup dropdown

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

// ==========================================
const chartDefaults = {
  responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
  plugins: { legend: { display: false } },
  scales: { x: { display: false }, y: { min: 0, suggestedMax: 300, ticks:{color:'#4a5888', font:{size:10}}, grid:{color:'rgba(80,140,255,0.07)'} } }
};

function initDashboardCharts() {
  const ctxRpm = document.getElementById('rpmChart');
  if (ctxRpm) rpmChart = new Chart(ctxRpm, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ label: 'RPM', data: rpmHistory, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, { label: 'Setpoint', data: setpointHist, borderColor: '#ef4444', borderDash: [5,5], borderWidth: 1.5, pointRadius: 0, fill: false }] }, options: chartDefaults });
  
  const ctxGauge = document.getElementById('gaugeChart');
  if (ctxGauge) {
    gaugeChart = new Chart(ctxGauge, { 
      type: 'doughnut', 
      data: { datasets: [{ data: [0, 300], backgroundColor: ['#3b82f6', 'rgba(255,255,255,0.05)'], borderWidth: 0, circumference: 180, rotation: 270 }] }, 
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, plugins: { tooltip: { enabled: false } } },
      // PLUGIN INI YANG MEMBUAT ANGKA MUNCUL DI TENGAH GAUGE
      plugins: [{
        id: 'gaugeLabel',
        afterDraw(chart) {
          const ctx = chart.ctx; ctx.save();
          ctx.font = '700 36px Rajdhani'; ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'center';
          ctx.fillText(document.getElementById('mRPM')?.textContent || '0', chart.width / 2, chart.height / 1.25);
          ctx.font = '13px Rajdhani'; ctx.fillStyle = '#94a3c8';
          ctx.fillText('RPM', chart.width / 2, chart.height / 1.10);
          ctx.restore();
        }
      }]
    });
  }
}

function initMiniChart() {
  const ctx = document.getElementById('miniRpmChart');
  if (ctx) miniChart = new Chart(ctx, { type: 'line', data: { labels: Array(15).fill(''), datasets: [{ data: miniHistory, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.1)', fill: true, tension: 0.4, pointRadius: 0 }] }, options: chartDefaults });
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
  const dNB = labels.map(x => trimf(x, -100, -50, -20));
  const dNS = labels.map(x => trimf(x, -30, -10, 0));
  const dZE = labels.map(x => trimf(x, -5, 0, 5));
  const dPS = labels.map(x => trimf(x, 0, 10, 30));
  const dPB = labels.map(x => trimf(x, 20, 50, 100));

  return new Chart(ctx, {
    type: 'line', data: { labels: labels, datasets: [
      { label: 'NB', data: dNB, borderColor: '#ef4444', backgroundColor: '#ef444422', fill: true, tension: 0.1, pointRadius: 0 },
      { label: 'NS', data: dNS, borderColor: '#f97316', backgroundColor: '#f9731622', fill: true, tension: 0.1, pointRadius: 0 },
      { label: 'ZE', data: dZE, borderColor: '#10b981', backgroundColor: '#10b98122', fill: true, tension: 0.1, pointRadius: 0 },
      { label: 'PS', data: dPS, borderColor: '#3b82f6', backgroundColor: '#3b82f622', fill: true, tension: 0.1, pointRadius: 0 },
      { label: 'PB', data: dPB, borderColor: '#8b5cf6', backgroundColor: '#8b5cf622', fill: true, tension: 0.1, pointRadius: 0 }
    ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#4a5888', font: { size: 10 } } }, y: { min: 0, max: 1.05, ticks: { color: '#4a5888', font: { size: 10 } } } } }
  });
}

function initFuzzyMamdani() {
  const ctx = document.getElementById('chartMamdani');
  cMPage = new Chart(ctx, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ label:'RPM', data: mamdaniHist, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, { label:'Setpoint', data: setpointHist, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
  mfMChart = makeMFChart('mfMamdani');
}

function initFuzzySugeno() {
  const ctx = document.getElementById('chartSugeno');
  cSPage = new Chart(ctx, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ label:'RPM', data: sugenoHist, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, { label:'Setpoint', data: setpointHist, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
  mfSChart = makeMFChart('mfSugeno');
}

function initCompareCharts() {
  const ctxM = document.getElementById('chartCmpM');
  const ctxS = document.getElementById('chartCmpS');
  cCmpM = new Chart(ctxM, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ label:'RPM', data: mamdaniHist, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, { label:'Setpoint', data: setpointHist, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
  cCmpS = new Chart(ctxS, { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ label:'RPM', data: sugenoHist, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 0 }, { label:'Setpoint', data: setpointHist, borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] }, options: chartDefaults });
}

// ==========================================
function updatePreviewUI() {
  safeSet('prevSetpoint', currentSetpointVal);
  safeSet('prevFuzzy', activeFuzzyVal);
  safeSet('prevLevel', activeLevelVal);
}

function syncSliderUI() { document.getElementById('spRPMInput').value = document.getElementById('spRPM').value; }
function syncInputUI() { document.getElementById('spRPM').value = document.getElementById('spRPMInput').value; }

function confirmSetpoint() {
  const val = parseInt(document.getElementById('spRPMInput').value) || 0;
  currentSetpointVal = val; peakRPM = 0;
  safeSet('spRPMVal', val); safeSet('mSetpoint', val); safeSet('activeSetpoint', val + ' RPM');
  safeStyle('barSetpoint', 'width', Math.min((val / 300 * 100), 100) + '%');
  updatePreviewUI();
  if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_SETPOINT, String(val), { qos: 1 });
}

function selectFuzzyType(type) {
  activeFuzzyVal = type; document.getElementById('fuzzyType').value = type;
  const optM = document.getElementById('fuzzyOptM'); const optS = document.getElementById('fuzzyOptS');
  const chkM = document.getElementById('checkM'); const chkS = document.getElementById('checkS');

  if (type === 'mamdani') {
    optM.style.borderColor = 'rgba(59,130,246,0.45)'; optM.style.background = 'rgba(59,130,246,0.15)'; optS.style.borderColor = 'transparent'; optS.style.background = 'transparent';
    chkM.style.opacity = '1'; chkS.style.opacity = '0';
    document.getElementById('foNameM').style.color = '#7dd3fc'; document.getElementById('foNameS').style.color = 'var(--text-hi)';
  } else {
    optS.style.borderColor = 'rgba(16,185,129,0.45)'; optS.style.background = 'rgba(16,185,129,0.15)'; optM.style.borderColor = 'transparent'; optM.style.background = 'transparent';
    chkS.style.opacity = '1'; chkM.style.opacity = '0';
    document.getElementById('foNameS').style.color = '#6ee7b7'; document.getElementById('foNameM').style.color = 'var(--text-hi)';
  }
  safeSet('dashFuzzyBadge', 'Fuzzy: ' + (type === 'mamdani' ? 'Mamdani' : 'Sugeno'));
  safeSet('activeFuzzy', type === 'mamdani' ? 'Mamdani' : 'Sugeno');
  updatePreviewUI();
  if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_FUZZY, type, { qos: 1 });
}

function selectLevel(n, btn) {
  activeLevelVal = n;
  document.querySelectorAll('.level-btns .level-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  safeSet('dashLevel', n); safeSet('activeLevel', n);
  updatePreviewUI();
  if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_LEVEL, String(n), { qos: 1 });
}

function runMotor() {
  if (!mqttClient || !mqttClient.connected) return alert('MQTT Belum terhubung!');
  motorRunning = true; peakRPM = 0;
  mqttClient.publish(TOPICS.CTRL_START, '1', { qos: 1 });
  safeSet('prevStart', '1 (Start Motor)');
  safeSet('motorStatusBadge', '● Running'); document.getElementById('motorStatusBadge').className = 'badge badge-green';
  safeSet('dashStatusBadge', '● Running'); document.getElementById('dashStatusBadge').className = 'badge badge-green';
  safeHTML('motorStatusText', '<span class="dot green"></span>Running');
}

function askStop() { document.getElementById('confirmOverlay').classList.add('show'); }
function closeConfirm() { document.getElementById('confirmOverlay').classList.remove('show'); }
function confirmStop() {
  closeConfirm();
  if (mqttClient && mqttClient.connected) mqttClient.publish(TOPICS.CTRL_STOP, '1', { qos: 1 });
  motorRunning = false;
  safeSet('prevStart', '0 (Stop Motor)');
  safeSet('motorStatusBadge', '● Stopped'); document.getElementById('motorStatusBadge').className = 'badge badge-red';
  safeSet('dashStatusBadge', '● Stopped'); document.getElementById('dashStatusBadge').className = 'badge badge-red';
  safeHTML('motorStatusText', '<span class="dot red"></span>Stopped');
}

// ==========================================
function connectMQTT() {
  if (mqttClient) mqttClient.end(true);
  const host = document.getElementById('mqttHost').value.trim();
  const port = document.getElementById('mqttPort').value.trim();
  const user = document.getElementById('mqttUser').value.trim();
  const pass = document.getElementById('mqttPass').value.trim();
  
  safeSet('mqttHostDisplay', `${host}:${port}`); safeSet('mqttStatusText', 'Menghubungkan...');
  
  mqttClient = mqtt.connect(`wss://${host}:${port}/mqtt`, { clientId: 'bldc_web_' + Math.random().toString(16).substr(2, 8), username: user, password: pass });
  mqttClient.on('connect', () => {
    document.getElementById('mqttDot').className = 'mqtt-dot online'; document.getElementById('mqttPill').className = 'mqtt-pill online';
    safeSet('mqttStatusText', 'MQTT Online'); safeHTML('mqttBrokerStatus', '<span class="dot green"></span>Terhubung');
    mqttClient.subscribe(TOPICS.DATA_ALL);
  });

  mqttClient.on('message', (topic, message) => {
    const raw = message.toString().trim();
    msgCount++; safeSet('mqttMsgCount', msgCount); safeSet('lastMsg', new Date().toLocaleTimeString('id-ID'));
    if (raw.includes(',')) {
      const parts = raw.split(',');
      if (parts.length >= 4) processIncomingData(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]), parts[3]);
    }
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
  safeStyle('barRPM', 'width', Math.min((rpm / 300 * 100), 100) + '%');
  
  safeSet('mPWM', pwm.toFixed(0)); safeSet('miniPwmVal', pwm.toFixed(0));
  let pwmPct = ((pwm - 103) / (255 - 103)) * 100;
  safeStyle('barPWM', 'width', Math.max(0, Math.min(pwmPct, 100)) + '%');

  safeSet('mError', error.toFixed(1)); safeStyle('barError', 'width', Math.min(Math.abs(error), 100) + '%');
  safeSet('overshootVal', overshoot.toFixed(1)); safeSet('miniOvershootVal', overshoot.toFixed(1));
  safeStyle('barOvershoot', 'width', Math.min(overshoot, 100) + '%');

  if (gaugeChart) {
    const val = Math.min(rpm, 300);
    gaugeChart.data.datasets[0].data = [val, 300 - val];
    gaugeChart.update();
  }

  rpmHistory.push(rpm); rpmHistory.shift();
  miniHistory.push(rpm); miniHistory.shift();
  setpointHist.push(currentSetpointVal); setpointHist.shift();

  if (activeFuzzyVal === 'mamdani') { mamdaniHist.push(rpm); mamdaniHist.shift(); if (cMPage) cMPage.update(); if (cCmpM) cCmpM.update(); } 
  else { sugenoHist.push(rpm); sugenoHist.shift(); if (cSPage) cSPage.update(); if (cCmpS) cCmpS.update(); }

  if (rpmChart) rpmChart.update();
  if (miniChart) miniChart.update();

  logTelemetry(rpm, pwm, error, overshoot, activeFuzzyVal, level);
}

function logTelemetry(rpm, pwm, err, os, fuzzy, level) {
  allData.unshift({ time: new Date().toLocaleTimeString('id-ID'), rpm: rpm.toFixed(1), sp: currentSetpointVal, pwm: pwm.toFixed(0), err: err.toFixed(1), os: os.toFixed(1), type: fuzzy === 'mamdani' ? 'Mamdani' : 'Sugeno', beban: level });
  if (allData.length > 200) allData.pop();
  updateTelemetryUI();
}

function updateTelemetryUI() {
  safeSet('statTotal', allData.length);
  if (allData.length === 0) return;
  const avgRpm = allData.reduce((s,d) => s + parseFloat(d.rpm), 0) / allData.length; safeSet('statAvgRPM', avgRpm.toFixed(1));
  const mamData = allData.filter(d => d.type === 'Mamdani');
  if (mamData.length > 0) safeSet('statErrM', (mamData.reduce((s,d) => s + Math.abs(parseFloat(d.err)), 0) / mamData.length).toFixed(1));
  const sugData = allData.filter(d => d.type === 'Sugeno');
  if (sugData.length > 0) safeSet('statErrS', (sugData.reduce((s,d) => s + Math.abs(parseFloat(d.err)), 0) / sugData.length).toFixed(1));

  const body = document.getElementById('dataTableBody');
  if (body) {
    body.innerHTML = allData.slice(0, 50).map((d, i) => `<tr><td>${i+1}</td><td>${d.time}</td><td><b>${d.rpm}</b></td><td>${d.sp}</td><td>${d.pwm}</td><td><span class="badge ${Math.abs(d.err)>10?'badge-amber':'badge-green'}">${d.err}</span></td><td>${d.os}</td><td><span class="badge ${d.type==='Sugeno'?'badge-green':'badge-blue'}">${d.type}</span></td><td>${d.beban}</td></tr>`).join('');
    safeSet('dataCount', Math.min(allData.length, 50) + ' entri');
  }
  updateFuzzyMetricTables();
}

function updateFuzzyMetricTables() {
  const levels = ['N', '1', '2', '3'];
  let mHTML = '', sHTML = '', cmpHTML = '';
  levels.forEach(lv => {
    const mRows = allData.filter(d => d.type === 'Mamdani' && String(d.beban) === lv);
    const sRows = allData.filter(d => d.type === 'Sugeno' && String(d.beban) === lv);
    const getStats = (arr) => { if(arr.length === 0) return { os: '-', sse: '-' }; const maxOs = Math.max(...arr.map(d => parseFloat(d.os))).toFixed(1); const avgSse = (arr.reduce((sum, d) => sum + Math.abs(parseFloat(d.err)), 0) / arr.length).toFixed(1); return { os: maxOs + '%', sse: avgSse }; };
    const sM = getStats(mRows), sS = getStats(sRows);
    mHTML += `<tr><td>Level ${lv}</td><td>${sM.os}</td><td>${sM.sse}</td><td><span class="badge badge-blue">Mamdani</span></td></tr>`;
    sHTML += `<tr><td>Level ${lv}</td><td>${sS.os}</td><td>${sS.sse}</td><td><span class="badge badge-green">Sugeno</span></td></tr>`;
    let winner = '—'; if(mRows.length && sRows.length) winner = parseFloat(sS.sse) < parseFloat(sM.sse) ? 'Sugeno' : 'Mamdani';
    cmpHTML += `<tr><td>Level ${lv}</td><td>${sM.os}</td><td>${sS.os}</td><td>${sM.sse}</td><td>${sS.sse}</td><td><span class="badge badge-gold">${winner}</span></td></tr>`;
  });
  safeHTML('metricMBody', mHTML); safeHTML('metricSBody', sHTML); safeHTML('metricCmpBody', cmpHTML);
}

function exportCSV() {
  const headers = 'Waktu,RPM,Setpoint,PWM,Error,Overshoot(%),Tipe Fuzzy,Beban\n';
  const rows = allData.map(d => `${d.time},${d.rpm},${d.sp},${d.pwm},${d.err},${d.os},${d.type},${d.beban}`).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([headers + rows], { type: 'text/csv' })); a.download = 'bldc_telemetry.csv'; a.click();
}

window.onload = () => { initDashboardCharts(); selectFuzzyType('sugeno'); };
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
window.connectMQTT = connectMQTT; 
window.disconnectMQTT = disconnectMQTT; 
window.exportCSV = exportCSV;