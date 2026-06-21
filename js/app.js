'use strict';
const TOPICS = {
  DATA_RPM:        'bldc/data/rpm',
  DATA_PWM:        'bldc/data/pwm',
  DATA_ERROR:      'bldc/data/error',
  DATA_SETPOINT:   'bldc/data/setpoint',
  DATA_FUZZY:      'bldc/data/fuzzy',
  DATA_LEVEL:      'bldc/data/level',
  DATA_OVERSHOOT:  'bldc/data/overshoot',
  DATA_TIMESTAMP:  'bldc/data/timestamp',
  DATA_ALL:        'bldc/data/#',
  CTRL_START:      'bldc/control/start',
  CTRL_STOP:       'bldc/control/stop',
  CTRL_SETPOINT:   'bldc/control/setpoint',
  CTRL_FUZZY:      'bldc/control/fuzzy',
  CTRL_LEVEL:      'bldc/control/level',
  CTRL_NEUTRAL:    'bldc/control/neutral',
  CTRL_ALL:        'bldc/control/#'
};

let mqttClient         = null;
let motorRunning       = false;
let activeLevelVal     = 1;
let activeFuzzyVal     = 'mamdani';
let rpmMinVal          = Infinity;
let rpmMaxVal          = 0;
let peakRPM            = 0;
let currentSetpointVal = 0;
let msgCount           = 0;
let miniChart          = null;
let heartbeatTimer     = null;
let tableRenderPending = false;

/* Data Telemetri & Oscilloscope Fuzzy */
const allData = [];
const liveM = { labels: [], rpm: [], sp: [], time: 0 };
const liveS = { labels: [], rpm: [], sp: [], time: 0 };

function updateClock() {
  const now = new Date();
  safeSet('clockDisplay', now.toLocaleTimeString('id-ID'));
  safeSet('dateDisplay',  now.toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }));
}
setInterval(updateClock, 1000); updateClock();

function showPage(pageKey, navEl, event) {
  if (event) event.stopPropagation();
  closeAllSubMenus();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + pageKey);
  if (target) target.classList.add('active');
  document.querySelectorAll('.topbar-nav .nav-item').forEach(n => n.classList.remove('active', 'sub-open'));
  if (navEl) navEl.classList.add('active');
  if (pageKey === 'kontrol') setTimeout(initMiniChart, 60);
}

function toggleSubMenu(menuId, navId, event) {
  event.stopPropagation();
  const menu  = document.getElementById(menuId);
  const nav   = document.getElementById(navId);
  const isOpen = menu.classList.contains('open');
  closeAllSubMenus();
  if (!isOpen) { menu.classList.add('open'); nav.classList.add('sub-open', 'active'); }
}
function closeAllSubMenus() {
  document.querySelectorAll('.sub-menu').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.nav-item.has-sub').forEach(n => n.classList.remove('sub-open'));
}
document.addEventListener('click', closeAllSubMenus);

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
    refreshFuzzyFromTelemetry('m');
  } else if (mode === 'sugeno') {
    document.getElementById('fuzzy-sugeno').style.display = 'block';
    if (!fuzzyChartsInited.s) { initFuzzySubCharts(); fuzzyChartsInited.s = true; }
    refreshFuzzyFromTelemetry('s');
  } else {
    document.getElementById('fuzzy-compare').style.display = 'block';
    if (!fuzzyChartsInited.compare) { initCompareCharts(); fuzzyChartsInited.compare = true; }
    refreshCompareFromTelemetry();
  }
}

function backToFuzzySelector() {
  document.querySelectorAll('.fuzzy-sub-page').forEach(p => p.style.display = 'none');
  document.getElementById('fuzzy-selector').style.display = '';
}

let metricRows = [
  { beban:'Level 1', rtM:'—', rtS:'—', osM:'—', osS:'—', sseM:'—', sseS:'—', win:'—' },
  { beban:'Level 2', rtM:'—', rtS:'—', osM:'—', osS:'—', sseM:'—', sseS:'—', win:'—' },
  { beban:'Level 3', rtM:'—', rtS:'—', osM:'—', osS:'—', sseM:'—', sseS:'—', win:'—' }
];

function refreshFuzzyFromTelemetry(type) {
  if (allData.length === 0) return; 
  const levels = ['L1','L2','L3'];
  const types  = type === 'm' ? ['mamdani','Mamdani'] : ['sugeno','Sugeno'];
  levels.forEach((lv, idx) => {
    const rows = allData.filter(d => d.beban === lv && types.some(t => d.type.toLowerCase() === t.toLowerCase()));
    if (rows.length === 0) return;
    const avgSSE = (rows.reduce((s,d) => s + Math.abs(parseFloat(d.err)||0), 0) / rows.length).toFixed(1);
    const avgOS  = (rows.reduce((s,d) => s + Math.abs(parseFloat(d.overshoot)||0), 0) / rows.length).toFixed(1);
    if (type === 'm') { metricRows[idx].sseM = avgSSE + '%'; metricRows[idx].osM  = avgOS  + '%'; } 
    else { metricRows[idx].sseS = avgSSE + '%'; metricRows[idx].osS  = avgOS  + '%'; }
    const mSSE = parseFloat(metricRows[idx].sseM) || Infinity;
    const sSSE = parseFloat(metricRows[idx].sseS) || Infinity;
    metricRows[idx].win = sSSE <= mSSE ? 'sugeno' : 'mamdani';
  });
  renderMetricSingle(type === 'm' ? 'metricMBody' : 'metricSBody', 'all', type);
}

function refreshCompareFromTelemetry() {
  if (allData.length > 0) { refreshFuzzyFromTelemetry('m'); refreshFuzzyFromTelemetry('s'); }
  renderMetricCompare('metricCmpBody', 'all');
}

const chartDefaults = {
  responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, 
  plugins: { legend: { labels: { color:'#94a3c8', font:{ size:11 }, boxWidth:12 } } },
  scales: {
    x: { ticks:{ color:'#4a5888', font:{ size:10 } }, grid:{ color:'rgba(80,140,255,0.07)' } },
    y: { ticks:{ color:'#4a5888', font:{ size:10 } }, grid:{ color:'rgba(80,140,255,0.07)' }, beginAtZero: true }
  }
};

function makeFuzzyLineChart(canvasId, color, dataRpm, dataSp, labelsArr) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  return new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: { labels: labelsArr, datasets: [
        { label:'RPM', data: dataRpm, borderColor:color, backgroundColor:color+'18', fill:true, tension:0.45, pointRadius:2, borderWidth:2.5 },
        { label:'Setpoint', data: dataSp, borderColor:'#ef4444', borderDash:[5,4], borderWidth:1.5, pointRadius:0, fill:false }
    ]},
    options: { ...chartDefaults, scales: { x: { ...chartDefaults.scales.x, display:false }, y: { ...chartDefaults.scales.y, beginAtZero:true, min:0, suggestedMax:300, title:{ display:true, text:'RPM Aktual', color:'#4a5888', font:{ size:10 } } } } }
  });
}

function makeMFChart(canvasId, gaussian = false) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  const colors  = ['#ef4444','#f97316','#10b981','#3b82f6','#8b5cf6'];
  const labels  = []; for (let i = -100; i <= 100; i += 5) labels.push(i);
  const centers = [-100,-50,0,50,100];
  function tri(x, a, b, c) { if (x <= a || x >= c) return 0; return x <= b ? (x-a)/(b-a) : (c-x)/(c-b); }
  function gauss(x, c, s) { return Math.exp(-0.5*((x-c)/s)**2); }
  const names = ['NB','NS','Z','PS','PB'];
  const datasets = names.map((n, i) => ({
    label: n, data: labels.map(x => gaussian ? gauss(x, centers[i], 20) : tri(x, centers[i]-50, centers[i], centers[i]+50)),
    borderColor: colors[i], backgroundColor: colors[i]+'25', fill: true, tension: gaussian ? 0.5 : 0.1, pointRadius: 0, borderWidth: 2
  }));
  return new Chart(ctx.getContext('2d'), { type: 'line', data: { labels, datasets }, options: { ...chartDefaults, scales: { x: { ...chartDefaults.scales.x, title:{ display:true, text:'Error (e)', color:'#4a5888', font:{ size:10 } } }, y: { ...chartDefaults.scales.y, beginAtZero:false, min:0, max:1.05, title:{ display:true, text:'μ (derajat)', color:'#4a5888', font:{ size:10 } } } } } });
}

const errL = ['NB','NS','Z','PS','PB']; const delL = ['NB','NS','Z','PS','PB'];
const ruleData = [['VR','VR','R','R','S'],['VR','R','R','S','T'],['R','R','S','T','T'],['R','S','T','T','VT'],['S','T','T','VT','VT']];
const ruleClass = { VR:'rp-vr', R:'rp-r', S:'rp-s', T:'rp-t', VT:'rp-vt' };
function buildRuleMatrix(tableId) {
  const tbl = document.getElementById(tableId); if (!tbl) return;
  let h = '<thead><tr><th>Error \\ ΔError</th>'; delL.forEach(d => h += `<th>${d}</th>`); h += '</tr></thead><tbody>';
  ruleData.forEach((row, ri) => { h += `<tr><td>${errL[ri]}</td>`; row.forEach(c => h += `<td><span class="${ruleClass[c]}">${c}</span></td>`); h += '</tr>'; });
  h += '</tbody>'; tbl.innerHTML = h;
}

function renderMetricSingle(bodyId, filter, type) {
  const body = document.getElementById(bodyId); if (!body) return;
  const rows = filter === 'all' ? metricRows : metricRows.filter((_,i) => String(i+1) === filter.replace('L',''));
  body.innerHTML = rows.map(d => `<tr><td><b>${d.beban}</b></td><td>${type === 'm' ? d.rtM  : d.rtS}</td><td>${type === 'm' ? d.osM  : d.osS}</td><td>${type === 'm' ? d.sseM : d.sseS}</td><td><span class="badge ${type === 'm' ? 'badge-blue' : 'badge-green'}">${type === 'm' ? 'Mamdani' : 'Sugeno'}</span></td></tr>`).join('');
}

function renderMetricCompare(bodyId, filter) {
  const body = document.getElementById(bodyId); if (!body) return;
  const rows = filter === 'all' ? metricRows : metricRows.filter((_,i) => String(i+1) === filter.replace('L',''));
  body.innerHTML = rows.map(d => `<tr><td><b>${d.beban}</b></td><td>${d.rtM}</td><td>${d.rtS}</td><td>${d.osM}</td><td>${d.osS}</td><td>${d.sseM}</td><td>${d.sseS}</td><td><span class="badge ${d.win === 'sugeno' ? 'badge-green' : d.win === 'mamdani' ? 'badge-blue' : 'badge-cyan'}">${d.win === 'sugeno' ? 'Sugeno' : d.win === 'mamdani' ? 'Mamdani' : '—'}</span></td></tr>`).join('');
}

let cMPage = null, mfMChart = null, cSPage = null, mfSChart = null;
function initFuzzySubCharts() {
  if (!cMPage) {
    cMPage   = makeFuzzyLineChart('chartMamdani', '#3b82f6', liveM.rpm, liveM.sp, liveM.labels);
    mfMChart = makeMFChart('mfMamdani', false); buildRuleMatrix('ruleMamdani'); renderMetricSingle('metricMBody', 'all', 'm');
  }
  if (!cSPage) {
    cSPage   = makeFuzzyLineChart('chartSugeno', '#10b981', liveS.rpm, liveS.sp, liveS.labels);
    mfSChart = makeMFChart('mfSugeno', true); buildRuleMatrix('ruleSugeno'); renderMetricSingle('metricSBody', 'all', 's');
  }
}

function filterFuzzyPage(level, btn, type) {
  const groupId = type === 'm' ? 'filterM' : 'filterS';
  document.querySelectorAll(`#${groupId} .fbtn`).forEach(b => b.classList.remove('active')); btn.classList.add('active');
  const key = level === 'all' ? 'all' : level;
  if (type === 'm') renderMetricSingle('metricMBody', key, 'm');
  if (type === 's') renderMetricSingle('metricSBody', key, 's');
}

let cCmpM = null, cCmpS = null;
function initCompareCharts() {
  if (cCmpM) return;
  cCmpM = makeFuzzyLineChart('chartCmpM', '#3b82f6', liveM.rpm, liveM.sp, liveM.labels);
  cCmpS = makeFuzzyLineChart('chartCmpS', '#10b981', liveS.rpm, liveS.sp, liveS.labels);
  renderMetricCompare('metricCmpBody', 'all');
}
function filterCompare(level, btn) {
  document.querySelectorAll('#filterC .fbtn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
  renderMetricCompare('metricCmpBody', level === 'all' ? 'all' : level);
}

const rpmHistory = []; let rpmChart = null;
const rpmCanvas = document.getElementById('rpmChart');
if (rpmCanvas) rpmChart = new Chart(rpmCanvas.getContext('2d'), { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ label:'RPM Aktual', data:[], borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.08)', fill:true, tension:0.45, pointRadius:3, pointBackgroundColor:'#3b82f6', borderWidth:2.5 }, { label:'Setpoint', data:[], borderColor:'#ef4444', borderDash:[5,4], borderWidth:1.5, pointRadius:0, fill:false }] }, options: { ...chartDefaults, scales: { x: { display: false }, y: { beginAtZero:true } } } });

let gaugeChart = null; const gaugeCanvas = document.getElementById('gaugeChart');
if (gaugeCanvas) gaugeChart = new Chart(gaugeCanvas, { type: 'doughnut', data: { datasets:[{ data:[1,99], backgroundColor:['#3b82f6','rgba(255,255,255,0.05)'], borderWidth:0, circumference:180, rotation:270, cutout:'75%' }] }, options: { responsive:true, maintainAspectRatio:false, animation:{ duration:0 }, plugins:{ legend:{display:false}, tooltip:{enabled:false} } }, plugins:[{ id:'gaugeLabel', afterDraw(chart) { const ctx = chart.ctx; ctx.save(); ctx.font = '700 36px Rajdhani'; ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'center'; ctx.fillText(document.getElementById('mRPM')?.textContent || '0', chart.width/2, chart.height/1.26); ctx.font = '13px Rajdhani'; ctx.fillStyle = '#94a3c8'; ctx.fillText('RPM', chart.width/2, chart.height/1.12); ctx.restore(); } }] });

const miniHistory = [];
function initMiniChart() {
  if (miniChart) return; const ctx = document.getElementById('miniRpmChart'); if (!ctx) return;
  miniChart = new Chart(ctx.getContext('2d'), { type: 'line', data: { labels: Array(15).fill(''), datasets: [{ data:[], borderColor:'#06b6d4', backgroundColor:'rgba(6,182,212,0.08)', fill:true, tension:0.45, pointRadius:2, borderWidth:2 }] }, options: { responsive:true, maintainAspectRatio:false, animation:{ duration:0 }, plugins:{ legend:{display:false} }, scales:{ x:{display:false}, y:{ticks:{color:'#4a5888',font:{size:9}}, grid:{color:'rgba(80,140,255,0.07)'}} } } });
}

function setMqttUI(online) {
  const dot = document.getElementById('mqttDot'), pill = document.getElementById('mqttPill'), text = document.getElementById('mqttStatusText'), brokerS = document.getElementById('mqttBrokerStatus'), connS = document.getElementById('mqttConnStatus');
  if (online) {
    if(dot) dot.className = 'mqtt-dot online'; if(pill) pill.className = 'mqtt-pill online'; if(text) text.textContent = 'MQTT Online';
    if(brokerS) brokerS.innerHTML = '<span class="dot green"></span>Terhubung'; if(connS) connS.innerHTML = '<span class="dot green"></span>Online';
  } else {
    if(dot) dot.className = 'mqtt-dot'; if(pill) pill.className = 'mqtt-pill'; if(text) text.textContent = 'MQTT Offline';
    if(brokerS) brokerS.innerHTML = '<span class="dot red"></span>Offline'; if(connS) connS.innerHTML = '<span class="dot red"></span>Offline';
  }
}

function connectMQTT() {
  if (mqttClient) { try { mqttClient.end(true); } catch(e) {} mqttClient = null; }
  const host = document.getElementById('mqttHost').value.trim(), port = parseInt(document.getElementById('mqttPort').value.trim()) || 8884, user = document.getElementById('mqttUser').value.trim(), pass = document.getElementById('mqttPass').value.trim();
  const brokerUrl = `wss://${host}:${port}/mqtt`;
  safeSet('mqttHostDisplay', `${host}:${port}`); safeSet('mqttConnBroker', `${host}:${port}`); safeSet('mqttStatusText', 'Menghubungkan...');
  const clientId = 'bldc_web_' + Math.random().toString(16).substr(2, 8);
  mqttClient = mqtt.connect(brokerUrl, { clientId, username:user, password:pass, reconnectPeriod:5000, connectTimeout:10000, clean:true });
  mqttClient.on('connect', () => {
    setMqttUI(true);
    ['bldc/data/#', 'bldc/status/#'].forEach(t => mqttClient.subscribe(t, { qos:1 }, err => { if (!err) console.log('Subscribed:', t); }));
    addMqttLog(`✓ Connected → ${host}:${port}`);
  });
  mqttClient.on('error', err => { setMqttUI(false); addMqttLog(`✗ Error: ${err.message}`); });
  mqttClient.on('offline', () => { setMqttUI(false); addMqttLog('⚠ Reconnecting...'); });
  mqttClient.on('reconnect', () => { safeSet('mqttStatusText','Reconnecting...'); });
  mqttClient.on('close', () => setMqttUI(false));
  mqttClient.on('message', handleMqttMessage);
}

function disconnectMQTT() {
  if (mqttClient) { try { mqttClient.end(true); } catch(e) {} mqttClient = null; }
  setMqttUI(false); addMqttLog('○ Disconnected');
}

function handleMqttMessage(topic, message) {
  const raw = message.toString().trim(); msgCount++; const timeStr = new Date().toLocaleTimeString('id-ID');
  safeSet('mqttMsgCount', msgCount); safeSet('mqttConnMsgCount', msgCount); safeSet('lastMsg', timeStr); safeSet('mqttConnLastTime', timeStr); safeSet('lastUpdate', timeStr);
  addMqttLog(`↓ [${topic}] ${raw}`);
  switch (topic) {
    case TOPICS.DATA_RPM: processRPM(parseFloat(raw)); break;
    case TOPICS.DATA_PWM: processPWM(parseFloat(raw)); break;
    case TOPICS.DATA_ERROR: processError(parseFloat(raw)); break;
    case TOPICS.DATA_SETPOINT: processSetpoint(parseFloat(raw)); break;
    case TOPICS.DATA_OVERSHOOT: processOvershoot(parseFloat(raw)); break;
    case TOPICS.DATA_TIMESTAMP: processTimestamp(raw); break;
    case TOPICS.DATA_FUZZY: processFuzzyType(raw); break;
    case TOPICS.DATA_LEVEL: processLevel(parseInt(raw)); break;
    case 'bldc/status/heartbeat': processHeartbeat(raw); break;
  }
}

function processRPM(rpm) {
  if (isNaN(rpm)) return;
  if (rpm > peakRPM) peakRPM = rpm;
  safeSet('mRPM', rpm.toFixed(1)); safeSet('miniRpmVal', rpm.toFixed(1));
  safeStyle('barRPM', 'width', Math.min((rpm / 450 * 100), 100).toFixed(1) + '%');
  
  // FIX: Force set text untuk RPM Min/Max agar selalu update UI
  if (rpm < rpmMinVal || rpmMinVal === Infinity) { rpmMinVal = rpm; safeSet('rpmMin', rpm.toFixed(1)); }
  if (rpm > rpmMaxVal) { rpmMaxVal = rpm; safeSet('rpmMax', rpm.toFixed(1)); }
  
  if (gaugeChart) { const pct = Math.min((rpm / 450) * 100, 100); gaugeChart.data.datasets[0].data = [pct, 100 - pct]; gaugeChart.update('none'); }
  
  rpmHistory.push(rpm); if (rpmHistory.length > 30) rpmHistory.shift();
  if (rpmChart) { rpmChart.data.labels = rpmHistory.map((_, i) => i); rpmChart.data.datasets[0].data = [...rpmHistory]; rpmChart.data.datasets[1].data = Array(rpmHistory.length).fill(currentSetpointVal); rpmChart.update('none'); }
  
  miniHistory.push(rpm); if (miniHistory.length > 15) miniHistory.shift();
  if (miniChart) { miniChart.data.datasets[0].data = [...miniHistory]; miniChart.data.labels = miniHistory.map((_, i) => i); miniChart.update('none'); }
  
  // Merekam data ke Oscilloscope Fuzzy (100 detik terakhir)
  let target = (activeFuzzyVal === 'mamdani') ? liveM : liveS;
  target.labels.push(target.time++);
  target.rpm.push(rpm);
  target.sp.push(currentSetpointVal);

  if(target.labels.length > 100) { target.labels.shift(); target.rpm.shift(); target.sp.shift(); }

  if(activeFuzzyVal === 'mamdani' && cMPage) { cMPage.update('none'); if(cCmpM) cCmpM.update('none'); } 
  else if (activeFuzzyVal === 'sugeno' && cSPage) { cSPage.update('none'); if(cCmpS) cCmpS.update('none'); }
  
  logData(rpm);
}

function processPWM(pwm) { if (isNaN(pwm)) return; safeSet('mPWM', pwm.toFixed(0)); safeSet('miniPwmVal', pwm.toFixed(0)); safeStyle('barPWM', 'width', Math.min((pwm / 255 * 100), 100).toFixed(1) + '%'); }
function processError(error) { if (isNaN(error)) return; safeSet('mError', error.toFixed(2)); safeStyle('barError', 'width', Math.min(Math.abs(error), 100) + '%'); }
function processSetpoint(setpoint) { if (isNaN(setpoint)) return; currentSetpointVal = setpoint; peakRPM = 0; safeSet('mSetpoint', setpoint.toFixed(0)); safeSet('activeSetpoint', setpoint.toFixed(0) + ' RPM'); safeStyle('barSetpoint', 'width', Math.min((setpoint / 450 * 100), 100).toFixed(1) + '%'); }
function processOvershoot(overshoot) { if (isNaN(overshoot)) return; safeSet('overshootVal', overshoot.toFixed(2)); safeSet('miniOvershootVal', overshoot.toFixed(2)); safeStyle('barOvershoot', 'width', Math.min(overshoot, 100) + '%'); }
function processFuzzyType(fuzzyType) { if (!fuzzyType) return; const display = fuzzyType.charAt(0).toUpperCase() + fuzzyType.slice(1); activeFuzzyVal = fuzzyType.toLowerCase(); safeSet('dashFuzzyBadge', 'Fuzzy: ' + display); safeSet('activeFuzzy', display); }
function processLevel(level) { if (isNaN(level)) return; activeLevelVal = level; safeSet('dashLevel', level); safeSet('activeLevel', 'Level ' + level); }
function processTimestamp(timestamp) { if (!timestamp) return; window.lastTimestamp = timestamp; }
function processHeartbeat(raw) { safeHTML('esp32Heartbeat', '<span class="dot green"></span>Active'); safeSet('esp32LastBeat', new Date().toLocaleTimeString('id-ID')); safeHTML('esp32Online', '<span class="dot green"></span>Online'); if (heartbeatTimer) clearTimeout(heartbeatTimer); heartbeatTimer = setTimeout(() => { safeHTML('esp32Heartbeat', '<span class="dot amber"></span>Timeout'); safeHTML('esp32Online', '<span class="dot red"></span>Offline'); }, 10000); }

function logData(rpm) {
  const fuzzy = document.getElementById('activeFuzzy')?.textContent || 'Mamdani', sp = document.getElementById('mSetpoint')?.textContent || '0', pwm = document.getElementById('mPWM')?.textContent || '0', err = document.getElementById('mError')?.textContent || '0', os = document.getElementById('overshootVal')?.textContent || '0', level = 'L' + activeLevelVal;
  allData.unshift({ time: window.lastTimestamp || new Date().toLocaleTimeString('id-ID'), rpm: rpm.toFixed(1), sp, pwm, err, overshoot: os, type: fuzzy, beban: level });
  if (allData.length > 200) allData.pop();
  if (!tableRenderPending) { tableRenderPending = true; setTimeout(() => { renderDataTable(allData); updateStats(); tableRenderPending = false; }, 1000); }
}

const mqttLogLines = [];
function addMqttLog(msg) { const timeStr = new Date().toLocaleTimeString('id-ID'); mqttLogLines.unshift(`${timeStr} — ${msg}`); if (mqttLogLines.length > 5) mqttLogLines.pop(); const logEl = document.getElementById('mqttLog'); if (!logEl) return; logEl.innerHTML = mqttLogLines.map(l => `<div class="log-line">${l}</div>`).join(''); }

function syncSlider() { const val = document.getElementById('spRPM').value; safeSet('spRPMVal', val); const inp = document.getElementById('spRPMInput'); if (inp) inp.value = val; updatePreview(); }
function syncSliderInput() { const raw = document.getElementById('spRPMInput').value, val = Math.min(450, Math.max(0, parseInt(raw) || 0)), slider = document.getElementById('spRPM'); if (slider) slider.value = val; safeSet('spRPMVal', val); updatePreview(); }

function selectFuzzyType(type) {
  activeFuzzyVal = type; document.getElementById('fuzzyType').value = type;
  const optM = document.getElementById('fuzzyOptM'), optS = document.getElementById('fuzzyOptS'), chkM = document.getElementById('checkM'), chkS = document.getElementById('checkS');
  if (type === 'mamdani') { optM.style.borderColor = 'rgba(59,130,246,0.45)'; optM.style.background = 'rgba(59,130,246,0.15)'; optS.style.borderColor = 'var(--border)'; optS.style.background = 'transparent'; if(chkM) chkM.style.opacity = '1'; if(chkS) chkS.style.opacity = '0'; optM.querySelector('.fo-name').style.color = '#93c5fd'; optS.querySelector('.fo-name').style.color = 'var(--text-hi)'; } 
  else { optS.style.borderColor = 'rgba(16,185,129,0.45)'; optS.style.background = 'rgba(16,185,129,0.12)'; optM.style.borderColor = 'var(--border)'; optM.style.background = 'transparent'; if(chkS) chkS.style.opacity = '1'; if(chkM) chkM.style.opacity = '0'; optS.querySelector('.fo-name').style.color = '#6ee7b7'; optM.querySelector('.fo-name').style.color = 'var(--text-hi)'; }
  updatePreview();
}

function selectLevel(n, btn) { activeLevelVal = n; document.querySelectorAll('.level-btns .level-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); safeSet('dashLevel', n); updatePreview(); if (mqttClient && mqttClient.connected) { mqttClient.publish(TOPICS.CTRL_LEVEL, String(n), { qos:1, retain:true }); addMqttLog(`↑ [${TOPICS.CTRL_LEVEL}] ${n}`); } }
function setServoNeutral() { if (!mqttClient || !mqttClient.connected) { alert('MQTT belum terhubung!'); return; } mqttClient.publish(TOPICS.CTRL_NEUTRAL, '1', { qos:1 }); addMqttLog(`↑ [${TOPICS.CTRL_NEUTRAL}] 1`); }
function updatePreview() { const sp = document.getElementById('spRPM')?.value || '0', ft = document.getElementById('fuzzyType')?.value || 'mamdani'; safeSet('prevSetpoint', sp); safeSet('prevFuzzy', `"${ft}"`); safeSet('prevLevel', activeLevelVal); safeSet('prevSetpoint2', sp); safeSet('prevFuzzy2', `"${ft}"`); safeSet('prevLevel2', activeLevelVal); }

function runMotor() {
  if (!mqttClient || !mqttClient.connected) { alert('MQTT belum terhubung!'); return; }
  
  // FIX: Reset Min Max Session saat motor baru di Start
  rpmMinVal = Infinity; rpmMaxVal = 0; safeSet('rpmMin', '0'); safeSet('rpmMax', '0');
  
  peakRPM = 0; const setpoint = parseInt(document.getElementById('spRPM').value) || 0, fuzzy = document.getElementById('fuzzyType').value || 'mamdani';
  mqttClient.publish(TOPICS.CTRL_SETPOINT, String(setpoint), { qos:1}); mqttClient.publish(TOPICS.CTRL_FUZZY, fuzzy, { qos:1}); mqttClient.publish(TOPICS.CTRL_LEVEL, String(activeLevelVal), { qos:1}); mqttClient.publish(TOPICS.CTRL_START, '1', { qos:1 });
  addMqttLog(`↑ [${TOPICS.CTRL_START}] 1`); motorRunning = true;
  safeSet('motorStatusBadge', '● Running'); setElem('motorStatusBadge', el => el.className = 'badge badge-green'); safeHTML('motorStatusText', '<span class="dot green"></span>Running'); safeSet('activeSetpoint', setpoint + ' RPM'); safeSet('activeFuzzy', fuzzy.charAt(0).toUpperCase() + fuzzy.slice(1)); safeSet('activeLevel', 'Level ' + activeLevelVal); safeSet('dashFuzzyBadge', 'Fuzzy: ' + fuzzy.charAt(0).toUpperCase() + fuzzy.slice(1)); safeSet('dashStatusBadge', '● Running');
}

function askStop() { const overlay = document.getElementById('confirmOverlay'); if (overlay) overlay.classList.add('show'); }
function closeConfirm() { const overlay = document.getElementById('confirmOverlay'); if (overlay) overlay.classList.remove('show'); }
function confirmStop() { closeConfirm(); if (mqttClient && mqttClient.connected) { mqttClient.publish(TOPICS.CTRL_STOP, '1', { qos:1 }); addMqttLog(`↑ [${TOPICS.CTRL_STOP}] 1`); } peakRPM = 0; motorRunning = false; safeSet('motorStatusBadge', '● Stopped'); setElem('motorStatusBadge', el => el.className = 'badge badge-red'); safeHTML('motorStatusText', '<span class="dot red"></span>Stopped'); safeSet('activeSetpoint', '—'); safeSet('activeFuzzy', '—'); safeSet('activeLevel', '—'); safeSet('dashStatusBadge', '● Stopped'); }

function renderDataTable(data) { const body = document.getElementById('dataTableBody'); if (!body) return; body.innerHTML = data.slice(0, 100).map((d, i) => `<tr><td style="color:var(--text-lo)">${i+1}</td><td style="font-family:'Rajdhani',sans-serif">${d.time}</td><td><b>${d.rpm}</b></td><td>${d.sp}</td><td>${d.pwm}</td><td><span class="badge ${parseFloat(d.err)>20?'badge-red':parseFloat(d.err)>10?'badge-amber':'badge-green'}">${d.err}</span></td><td><span class="badge ${parseFloat(d.overshoot||0)>10?'badge-amber':'badge-green'}">${d.overshoot||'0'}</span></td><td><span class="badge ${d.type.toLowerCase()==='sugeno'?'badge-green':'badge-blue'}">${d.type}</span></td><td><span class="badge badge-cyan">${d.beban}</span></td></tr>`).join(''); safeSet('dataCount', data.length + ' entri'); }

function updateStats() {
  const total = allData.length; safeSet('statTotal', total); if (total === 0) return;
  const avgRPM = allData.reduce((s,d) => s + parseFloat(d.rpm)||0, 0) / total; safeSet('statAvgRPM', avgRPM.toFixed(1));
  const mRows = allData.filter(d => d.type.toLowerCase() === 'mamdani'), sRows = allData.filter(d => d.type.toLowerCase() === 'sugeno');
  if (mRows.length) safeSet('statErrM', (mRows.reduce((s,d) => s + (Math.abs(parseFloat(d.err))||0), 0) / mRows.length).toFixed(2) + '%'); else safeSet('statErrM', '—');
  if (sRows.length) safeSet('statErrS', (sRows.reduce((s,d) => s + (Math.abs(parseFloat(d.err))||0), 0) / sRows.length).toFixed(2) + '%'); else safeSet('statErrS', '—');
}

// FIX: Fungsi Reset Telemetry
function resetTelemetry() {
  if (!confirm('Apakah Anda yakin ingin menghapus semua data Telemetry?')) return;
  allData.length = 0; 
  renderDataTable(allData);
  safeSet('statTotal', 0); safeSet('statAvgRPM', 0); safeSet('statErrM', '—'); safeSet('statErrS', '—');
  metricRows.forEach(r => { r.rtM='—'; r.rtS='—'; r.osM='—'; r.osS='—'; r.sseM='—'; r.sseS='—'; r.win='—'; });
  renderMetricSingle('metricMBody', 'all', 'm'); renderMetricSingle('metricSBody', 'all', 's'); renderMetricCompare('metricCmpBody', 'all');
  alert('Data Telemetry berhasil direset!');
}

function applyFilter() { const beban = document.getElementById('filterBeban')?.value || 'all', fuzzyF = document.getElementById('filterFuzzy')?.value || 'all'; let filtered = [...allData]; if (beban !== 'all') filtered = filtered.filter(d => d.beban === beban); if (fuzzyF !== 'all') filtered = filtered.filter(d => d.type.toLowerCase() === fuzzyF.toLowerCase()); renderDataTable(filtered); }
function resetFilter() { ['filterBeban','filterFuzzy','filterDateStart','filterDateEnd'].forEach(id => { const el = document.getElementById(id); if (el) el.value = el.tagName === 'SELECT' ? 'all' : ''; }); renderDataTable(allData); }
function triggerImport() { document.getElementById('csvImport').click(); }
function handleImport(e) { const f = e.target.files[0]; if (!f) return; const reader = new FileReader(); reader.onload = (ev) => { const lines = ev.target.result.split('\n').slice(1); let imported = 0; lines.forEach(line => { const cols = line.split(','); if (cols.length >= 7) { allData.push({ time: cols[0]?.trim() || '--', rpm: cols[1]?.trim() || '0', sp: cols[2]?.trim() || '0', pwm: cols[3]?.trim() || '0', err: cols[4]?.trim() || '0', overshoot: cols[5]?.trim() || '0', type: cols[6]?.trim() || 'Mamdani', beban: cols[7]?.trim() || 'L1' }); imported++; } }); renderDataTable(allData); updateStats(); alert(`Import berhasil: ${imported} data dari "${f.name}"`); }; reader.readAsText(f); }
function exportCSV() { const headers = 'Waktu,RPM,Setpoint,PWM,Error(%),Overshoot(%),Tipe Fuzzy,Beban\n'; const rows = allData.map(d => `${d.time},${d.rpm},${d.sp},${d.pwm},${d.err},${d.overshoot||'0'},${d.type},${d.beban}`).join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([headers + rows], { type:'text/csv' })); a.download = 'bldc_data_logger.csv'; a.click(); }
function saveMQTTConfig() { ['mqttHost','mqttPort','mqttUser','mqttPass'].forEach(id => { const el = document.getElementById(id); if (el) localStorage.setItem('bldc_' + id, el.value); }); alert('Konfigurasi MQTT tersimpan!'); }

window.addEventListener('load', () => { ['mqttHost','mqttPort','mqttUser','mqttPass'].forEach(id => { const saved = localStorage.getItem('bldc_' + id), el = document.getElementById(id); if (saved && el) el.value = saved; }); updatePreview(); initFuzzySubCharts(); initCompareCharts(); if (localStorage.getItem('bldc_mqttHost')) { setTimeout(() => { try { connectMQTT(); } catch(e) {} }, 800); } });

function safeSet(id, value) { const el=document.getElementById(id); if(el) el.textContent=value; } function safeHTML(id, html) { const el=document.getElementById(id); if(el) el.innerHTML=html; } function safeStyle(id, prop, val) { const el=document.getElementById(id); if(el) el.style[prop]=val; } function setElem(id, fn) { const el=document.getElementById(id); if(el) fn(el); }

window.showPage = showPage; window.toggleSubMenu = toggleSubMenu; window.showFuzzyMode = showFuzzyMode; window.backToFuzzySelector = backToFuzzySelector; window.filterFuzzyPage = filterFuzzyPage; window.filterCompare = filterCompare; window.selectFuzzyType = selectFuzzyType; window.selectLevel = selectLevel; window.syncSlider = syncSlider; window.syncSliderInput = syncSliderInput; window.runMotor = runMotor; window.askStop = askStop; window.closeConfirm = closeConfirm; window.confirmStop = confirmStop; window.setServoNeutral = setServoNeutral; window.connectMQTT = connectMQTT; window.disconnectMQTT = disconnectMQTT; window.saveMQTTConfig = saveMQTTConfig; window.applyFilter = applyFilter; window.resetFilter = resetFilter; window.triggerImport = triggerImport; window.handleImport = handleImport; window.exportCSV = exportCSV; window.resetTelemetry = resetTelemetry;