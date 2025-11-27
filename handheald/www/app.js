// app.js v13 (limpio, consolidado)
console.log('APP JS ACTUAL v13');

// ===== Estado global =====
const state = {
  auto: true,
  animals: new Map(),    // id -> { last, history[] }
  markers: new Map(),    // id -> L.Marker
  map: null,
  wsOpen: false,         // reservado para WebSocket (si lo usas después)
  highlight: null,
  selectedId: null,

  aliases: new Map(),    // id -> alias
  ranchPoly: null,

  // Trail en vivo (independiente del CSV)
  trails: new Map(),         // id -> L.Polyline
  trailPoints: new Map(),    // id -> Array<[lat, lon, t_ms]>
  trailMinutes: 10,          // ventana visible del trail (minutos)
  trailMaxPts: 300,          // techo de puntos por seguridad

  // Muestreo de historial
  sampleEverySec: 300,       // 1 muestra cada 5 min
  keepHours: 24,             // conserva datos 24 h
  lastBucket: new Map(),     // id -> bucket usado

  // Geocerca
  geofenceOn: false,
  fenceMeters: 25,
  lastFenceStatus: new Map(),  // id -> 'ok' | 'edge' | 'out'
};

// ===== Constantes de batería =====
const V_FULL = 4.20;
const V_EMPTY = 3.60;
const BATT_LOW_V = 3.80;

// Clamp sencillo
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

// V -> %
const vToPct = v => (typeof v === 'number')
  ? Math.round(clamp((v - V_EMPTY) / (V_FULL - V_EMPTY) * 100, 0, 100))
  : null;

// ===== Rancho (polígono) =====
// (lat, lon) reales. El orden se corrige circularmente.
const RANCH_COORDS = [
  [19.2500061, -103.6982934], // arriba-izquierda
  [19.2490052, -103.6969552], // arriba-derecha
  [19.2482673, -103.6975558], // abajo-derecha
  [19.2492521, -103.6989217]  // abajo-izquierda
];

const IMAGE_BOUNDS = [
  [19.2482374, -103.6992475], // SW: abajo-izquierda
  [19.2501658, -103.6964777]  // NE: arriba-derecha
];

// ===== Handheld helpers (parsing y normalización) =====
function knotsToKmh(kn){
  return (typeof kn === 'number') ? kn * 1.852 : null;
}

function parseNumSafe(x){
  if (x == null) return null;
  const n = +String(x).replace(/[^\d.\-+eE]/g, '');
  return Number.isFinite(n) ? n : null;
}

/** Convierte date="DDMMYY" y time="HHMMSS(.sss)" a epoch (segundos) */
function parseNMEADateTime(dateStr, timeStr){
  // Si no hay date/time, usa ahora
  if (!dateStr && !timeStr) return Math.floor(Date.now() / 1000);

  const d = String(dateStr ?? '').replace(/\D/g,'');
  const t = String(timeStr ?? '').replace(/[^\d.]/g,'');

  const DD = parseInt(d.slice(0,2) || '01',10);
  const MM = parseInt(d.slice(2,4) || '01',10) - 1;
  const YY = parseInt(d.slice(4,6) || '70',10);
  const year = 2000 + (YY < 70 ? YY : YY);

  const hh = parseInt(t.slice(0,2) || '0',10);
  const mm = parseInt(t.slice(2,4) || '0',10);
  const ssFloat = parseFloat(t.slice(4) || '0');
  const ms = Math.floor((ssFloat - Math.floor(ssFloat)) * 1000);
  const ss = Math.floor(ssFloat);

  // IMPORTANTE: NMEA es UTC
  const msUTC = Date.UTC(year, MM, DD, hh, mm, ss, ms);
  return Math.floor(msUTC / 1000);
}

/** Regla simple de calidad: fix_ok si sats>=4 y hdop<=2.5 */
function fixFromQuality(sats, hdop){
  if (sats == null && hdop == null) return true;
  if (sats != null && sats < 4) return false;
  if (hdop != null && hdop > 2.5) return false;
  return true;
}

/** Normaliza un paquete "handheld" a tu esquema interno. */
function normalizeFromHandheld(raw, idFallback){
  if (!raw) return null;
  const id = (raw.id ?? idFallback ?? '').toString().trim().toUpperCase();
  if (!id) return null;

  const lat   = parseNumSafe(raw.lat);
  const lon   = parseNumSafe(raw.lon);
  const alt   = parseNumSafe(raw.alt);
  const sats  = parseNumSafe(raw.sats);
  const hdop  = parseNumSafe(raw.hdop);
  const spdKn = parseNumSafe(raw.spd_kn);
  const kmh   = knotsToKmh(spdKn);
  const crs   = parseNumSafe(raw.crs);
  const battV = parseNumSafe(raw.bat_v);
  const ts    = parseNMEADateTime(raw.date, raw.time);

  return {
    id,
    timestamp: ts,
    lat, lon,
    alt, sats, hdop,
    kmh, crs,
    batt: (battV ?? raw.batt ?? null),
    rssi: raw.rssi ?? null,
    snr:  raw.snr  ?? null,
    fix_ok: (raw.fix_ok != null) ? !!raw.fix_ok : fixFromQuality(sats, hdop),
  };
}

/** Detecta si un objeto luce “handheld”. */
function isHandheldShape(o){
  return o && (
    ('bat_v' in o) || ('batt' in o) ||
    ('sats' in o) || ('hdop' in o) || ('spd_kn' in o) ||
    ('date' in o) || ('time' in o)
  );
}

// ===== Alias (persistencia local) =====
function loadAliases(){
  try{
    const raw = localStorage.getItem('aliases_v1');
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)));
  }catch(_){
    return new Map();
  }
}
function saveAliases(map){
  const obj = Object.fromEntries(map.entries());
  localStorage.setItem('aliases_v1', JSON.stringify(obj));
}
function setAlias(id, alias){
  if (!id) return;
  if (!alias || !alias.trim()) state.aliases.delete(id);
  else state.aliases.set(id, alias.trim());
  saveAliases(state.aliases);
  render();
}

// ===== Formato de fechas y HTML =====
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

function dtFrom(value){
  if (typeof value === 'number') {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  return new Date(String(value));
}

function fmtHora(value){
  const d = dtFrom(value);
  return new Intl.DateTimeFormat('es-MX', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', hour12:true
  }).format(d);
}
function fmtFecha(value){
  return new Intl.DateTimeFormat('es-MX', {
    day:'2-digit', month:'2-digit', year:'numeric'
  }).format(dtFrom(value));
}
function fmtHoraLinea(value){
  return new Intl.DateTimeFormat('es-MX', {
    hour:'2-digit', minute:'2-digit', hour12:true
  }).format(dtFrom(value));
}

// ===== Iconos Leaflet =====
const ICON_OK = L.divIcon({
  className:'mk ok',
  html:'<div style="width:12px;height:12px;border-radius:50%;background:#10b981;border:2px solid white;box-shadow:0 0 0 2px rgba(16,185,129,.5)"></div>',
  iconSize:[12,12],
  iconAnchor:[6,6]
});
const ICON_BAD = L.divIcon({
  className:'mk bad',
  html:'<div style="width:12px;height:12px;border-radius:50%;background:#ef4444;border:2px solid white;box-shadow:0 0 0 2px rgba(239,68,68,.5)"></div>',
  iconSize:[12,12],
  iconAnchor:[6,6]
});
const ICON_WARN = L.divIcon({
  className:'mk warn',
  html:'<div style="width:12px;height:12px;border-radius:50%;background:#f59e0b;border:2px solid white;box-shadow:0 0 0 2px rgba(245,158,11,.5)"></div>',
  iconSize:[12,12],
  iconAnchor:[6,6]
});

// ===== Config de logging / DOM helpers =====
let renderedOnce = false;
const EL = sel => document.querySelector(sel);
let renameLock = false;
let rowClickTimer = null;

// ===== Arranque =====
window.addEventListener('resize', () => state.map?.invalidateSize());

let __started = false;
window.addEventListener('load', () => {
  if (__started) return;
  __started = true;
  init();
});

async function init(){
  // Tema inicial + alias
  document.body.classList.toggle('dark', localStorage.getItem('dark') === '1');
  state.aliases = loadAliases();

  // Tema
  EL('#btnDark')?.addEventListener('click', () => {
    const d = document.body.classList.toggle('dark');
    localStorage.setItem('dark', d ? '1' : '0');
    setDarkUI();
  });

  // Auto/Manual
  EL('#btnAuto')?.addEventListener('click', () => {
    state.auto = !state.auto;
    setAutoUI();
  });

  // CSV / WiFi / CRUD
  EL('#btnCSV')?.addEventListener('click', () => csvFromState());
  EL('#btnWifi')?.addEventListener('click', async () => {
    if (!confirm('¿Apagar Wi-Fi del handheld?')) return;
    try{ await fetch('/wifi/off', { method:'POST' }); }catch(_){}
  });
  EL('#btnAdd')?.addEventListener('click', addAnimalPrompt);
  EL('#btnDel')?.addEventListener('click', deleteAnimalSelected);
  EL('#filtro')?.addEventListener('input', renderList);

  // Lista: click vs dblclick (focus / renombrar)
  EL('#lista tbody')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const id = tr.dataset.id; if (!id) return;
    clearTimeout(rowClickTimer);
    rowClickTimer = setTimeout(() => {
      state.selectedId = id;
      const tbody = EL('#lista tbody');
      tbody.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
      tr.classList.add('sel');
      setTimeout(() => tr.classList.remove('sel'), 1000);
      focusAnimal(id);
    }, 220);
  });
  EL('#lista tbody')?.addEventListener('dblclick', (e) => {
    clearTimeout(rowClickTimer);
    e.preventDefault();
    e.stopPropagation();
    if (renameLock) return;
    renameLock = true;
    const tr = e.target.closest('tr'); if (!tr){ renameLock = false; return; }
    const id = tr.dataset.id; if (!id){ renameLock = false; return; }
    const current = state.aliases?.get(id) || '';
    const alias = prompt(`Alias para ${id} (vacío para quitar):`, current ?? '');
    if (alias !== null) setAlias(id, alias);
    setTimeout(() => { renameLock = false; }, 250);
  });

  // Menú “Más” (IDs esperados: #btnMore y #moreMenu)
  const moreBtn = EL('#btnMore');
  const moreMenu = EL('#moreMenu');
  if (moreBtn && moreMenu) {
    const openMenu = (open) => {
      moreMenu.hidden = !open;
      moreBtn.setAttribute('aria-expanded', String(open));
    };
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(moreMenu.hidden);
    });
    document.addEventListener('click', () => openMenu(false));
    EL('#mWifi')?.addEventListener('click', () => EL('#btnWifi')?.click());
    EL('#mAdd') ?.addEventListener('click', () => EL('#btnAdd') ?.click());
    EL('#mDel') ?.addEventListener('click', () => EL('#btnDel') ?.click());
  }

  // Botón Alertas (geocerca)
  EL('#btnFence')?.addEventListener('click', () => {
    state.geofenceOn = !state.geofenceOn;
    setFenceUI();
    if (state.geofenceOn && 'Notification' in window && Notification.permission === 'default'){
      Notification.requestPermission().catch(() => {});
    }
  });
  EL('#fenceDist')?.addEventListener('change', (e) => {
    const v = +e.target.value;
    if (Number.isFinite(v) && v > 0) state.fenceMeters = v;
  });

  // Inicializa UI
  setAutoUI();
  setDarkUI();
  setFenceUI();

  // Mapa
  await setupMap();
  const mapEl = document.getElementById('map');
  if (mapEl && 'ResizeObserver' in window) {
    const ro = new ResizeObserver(() => state.map?.invalidateSize());
    ro.observe(mapEl);
  }

  // Asegura configuración de muestreo estándar
  (function enforceSampling(){
    const wantSec = 300;
    const wantH   = 24;
    if (state.sampleEverySec !== wantSec || state.keepHours !== wantH) {
      console.warn('Enforce sampling', {
        from:{sec:state.sampleEverySec, h:state.keepHours},
        to:{sec:wantSec, h:wantH}
      });
      state.sampleEverySec = wantSec;
      state.keepHours = wantH;
      state.lastBucket.clear();
      try { state.animals.forEach(r => r.history = []); } catch(_) {}
    }
  })();

  // Datos iniciales
  await loadInitial();

  // Polling solo si no hay WebSocket activo
  if (window.__rgwPoll) {
    clearInterval(window.__rgwPoll);
    window.__rgwPoll = null;
  }
  window.__rgwPoll = setInterval(() => {
    if (!state.wsOpen) refresh();
  }, 5000);

  // Reset de historial
  EL('#btnReset')?.addEventListener('click', () => {
    resetLogs();
    alert('Historial y control de muestreo limpiados');
  });
}

// ===== Mapa y rancho =====
async function setupMap(){
  state.map = L.map('map', { zoomControl: true });

  L.imageOverlay('ranch.png', IMAGE_BOUNDS).addTo(state.map);

  // Ajusta para que se vea toda la imagen
  state.map.fitBounds(IMAGE_BOUNDS);

  // ⬇️ Truco: haz un zoom extra para que "llene" más el rectángulo gris
  const center = state.map.getCenter();
  const zoom   = state.map.getZoom();
  state.map.setView(center, zoom + 1, { animate: false });

  // Limita el movimiento al área de la imagen
  state.map.setMaxBounds(IMAGE_BOUNDS);

  drawRanch();
  setTimeout(() => state.map?.invalidateSize(), 0);
}


// Ordena un polígono por ángulo alrededor del centro
function centroidOf(coords){
  const n = coords.length;
  let lat = 0, lon = 0;
  coords.forEach(([la, lo]) => { lat += la; lon += lo; });
  return [lat / n, lon / n];
}
function sortPolygonCircular(coords){
  if (!Array.isArray(coords) || coords.length < 3) return coords;
  const [clat, clon] = centroidOf(coords);
  return [...coords].sort((a, b) => {
    const angA = Math.atan2(a[0] - clat, a[1] - clon);
    const angB = Math.atan2(b[0] - clat, b[1] - clon);
    return angA - angB;
  });
}

function getRanchCenter(){
  if (state.ranchPoly) return state.ranchPoly.getBounds().getCenter();
  return state.map?.getCenter() ?? L.latLng(19.245, -103.73);
}

// Dibuja el polígono del rancho
function drawRanch(){
  if (!state.map || !Array.isArray(RANCH_COORDS) || RANCH_COORDS.length < 3) return;
  if (state.ranchPoly) {
    try { state.map.removeLayer(state.ranchPoly); }catch(_){}
  }
  const ordered = sortPolygonCircular(RANCH_COORDS);
  state.ranchPoly = L.polygon(ordered, {
    color: '#0ea5a4',
    weight: 3,
    opacity: 0.9,
    fill: false,
    dashArray: '6 6'
  }).addTo(state.map);

  // Enfocar al polígono
  renderedOnce = true;
}

// ===== Geometría para geocerca =====

// Punto en polígono (ray casting). coords: [[lat,lon],...]
function pointInPolygon(lat, lon, coords){
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++){
    const xi = coords[i][1], yi = coords[i][0];
    const xj = coords[j][1], yj = coords[j][0];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi + 0.0) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Distancia de P a un segmento en metros (usando Web Mercator)
function distancePointToSegmentMeters(map, A, B, P){
  const z = map.getZoom();
  const pA = map.project(L.latLng(A[0],A[1]), z);
  const pB = map.project(L.latLng(B[0],B[1]), z);
  const pP = map.project(L.latLng(P[0],P[1]), z);
  const vx = pB.x - pA.x, vy = pB.y - pA.y;
  const wx = pP.x - pA.x, wy = pP.y - pA.y;
  const c1 = vx*wx + vy*wy;
  const c2 = vx*vx + vy*vy;
  let t = c2 ? (c1 / c2) : 0;
  t = Math.max(0, Math.min(1, t));
  const px = pA.x + t*vx, py = pA.y + t*vy;
  const dx = pP.x - px,  dy = pP.y - py;
  const distPx = Math.hypot(dx, dy);
  // metros por pixel
  const earth = 40075016.686;
  const mpp = Math.cos(P[0]*Math.PI/180) * earth / (256 * Math.pow(2, z));
  return distPx * mpp;
}

function distanceToPolygonEdgeMeters(map, coords, P){
  let minD = Infinity;
  for (let i = 0; i < coords.length; i++){
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    const d = distancePointToSegmentMeters(map, a, b, P);
    if (d < minD) minD = d;
  }
  return minD;
}

// Evalúa estado de geocerca para un punto
function fenceStatus(map, polyCoords, lat, lon, thresholdM){
  if (!map || !polyCoords || polyCoords.length < 3 || lat == null || lon == null) return 'ok';
  const inside = pointInPolygon(lat, lon, polyCoords);
  if (!inside) return 'out';
  const d = distanceToPolygonEdgeMeters(map, polyCoords, [lat, lon]);
  return (d <= thresholdM) ? 'edge' : 'ok';
}

// Aviso opcional (sonido / vibración / notificación) solo en transición
function alertOnce(id, status){
  const prev = state.lastFenceStatus.get(id);
  if (prev === status) return;
  state.lastFenceStatus.set(id, status);

  try{
    if (status !== 'ok' && window.AudioContext){
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = (status === 'out') ? 660 : 520;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
      o.start(); o.stop(ctx.currentTime + 0.20);
    }
  }catch(_){}

  if (navigator.vibrate && status !== 'ok'){
    navigator.vibrate(status === 'out' ? [180,100,180] : [120]);
  }

  if ('Notification' in window && Notification.permission === 'granted' && status !== 'ok'){
    const txt = (status === 'out') ? 'Fuera del rancho' : 'Cerca del borde';
    new Notification(`Alerta geocerca: ${id}`, { body: txt });
  }
}

// ===== Trail en vivo =====
function ensureTrailLayer(id){
  let line = state.trails.get(id);
  if (!line) {
    line = L.polyline([], { color:'#0ea5a4', weight:3, opacity:0.7 });
    line.addTo(state.map);
    state.trails.set(id, line);
  }
  return line;
}

function updateTrailPolyline(id){
  const arr = state.trailPoints.get(id);
  if (!arr || !arr.length) return;
  const line = ensureTrailLayer(id);
  line.setLatLngs(arr.map(p => [p[0], p[1]]));
}

/** Inserta posición al buffer del trail y hace poda por tiempo y tamaño */
function pushTrailPoint(id, lat, lon, tsSec){
  if (lat == null || lon == null) return;
  const tms = (typeof tsSec === 'number' ? tsSec * 1000 : Date.now());

  let arr = state.trailPoints.get(id);
  if (!arr) { arr = []; state.trailPoints.set(id, arr); }

  arr.push([lat, lon, tms]);

  // Poda por ventana de tiempo (últimos trailMinutes)
  const cutoff = Date.now() - state.trailMinutes * 60 * 1000;
  while (arr.length && arr[0][2] < cutoff) arr.shift();

  // Poda por cantidad (seguridad)
  if (arr.length > state.trailMaxPts) {
    arr.splice(0, arr.length - state.trailMaxPts);
  }

  updateTrailPolyline(id);
}

// ===== UI helpers =====
function setFenceUI(){
  const b = EL('#btnFence');
  if (!b) return;
  if (state.geofenceOn){
    b.classList.add('is-on'); b.classList.remove('is-off');
    b.textContent = 'Alertas: ON';
  }else{
    b.classList.add('is-off'); b.classList.remove('is-on');
    b.textContent = 'Alertas: OFF';
  }
}
function setDarkUI(){
  const btn = EL('#btnDark');
  if (!btn) return;
  const dark = document.body.classList.contains('dark');
  btn.textContent = dark ? '☀️' : '🌙';
}
function setAutoUI(){
  const btn = EL('#btnAuto');
  if (!btn) return;
  btn.innerHTML = `🔁 ${state.auto ? 'Auto' : 'Manual'}`;
}

// ===== Fuente de datos con fallback =====
async function fetchRecords(){
  // Solo usamos data.json en el ESP32 (no hay /data)
  const r = await fetch('data.json', { cache: 'no-store' });

  if (!r.ok) {
    throw new Error('HTTP ' + r.status);
  }
  
  const text = (await r.text()).trim();
  if (!text) return [];

  const lines = text.split('\n').filter(Boolean);

  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      console.warn('Línea inválida en data.json:', line, e);
    }
  }
  return records;
}

async function loadInitial(){
  try{
    const arr = await fetchRecords();
    if (!Array.isArray(arr) || arr.length === 0) {
      seedDemo();
    } else {
      arr.forEach(obj => {
        const pkt = isHandheldShape(obj) ? normalizeFromHandheld(obj, obj.id) : obj;
        upsertPacket(pkt);
      });
    }
    scheduleRender();
  }catch(e){
    console.warn('loadInitial:', e.message, '→ usando demo');
    seedDemo();
    scheduleRender();
  }
}
async function refresh(){
  try{
    const arr = await fetchRecords();
    arr.forEach(obj => {
      const pkt = isHandheldShape(obj) ? normalizeFromHandheld(obj, obj.id) : obj;
      upsertPacket(pkt);
    });
    if (state.auto) scheduleRender();
  }catch(_){}
}

// ===== Render (debounce) =====
const scheduleRender = (() => {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      render();
    }, 300);
  };
})();

// ===== Upsert de paquetes =====
function upsertPacket(pkt){
  if (!pkt || !pkt.id) return;

  // ID normalizado
  const id = String(pkt.id).trim().toUpperCase();

  // Registro en memoria
  const rec = state.animals.get(id) || { history: [], last: null };

  // Actualiza "last" SIEMPRE (mapa fluido)
  rec.last = { ...(rec.last || {}), ...pkt };

  // Alimenta el trail en vivo con TODOS los paquetes
  pushTrailPoint(
    id,
    rec.last.lat,
    rec.last.lon,
    rec.last.timestamp // en segundos
  );

  // Timestamp (segundos): preferimos el del paquete
  let ts = rec.last.timestamp;
  if (typeof ts !== 'number') {
    ts = Math.floor(Date.now() / 1000);
    rec.last.timestamp = ts;
  }

  // Muestreo por ventanas: 1 muestra por ventana de sampleEverySec
  const winSec = Math.max(1, state.sampleEverySec | 0);
  const bucket = Math.floor(ts / winSec);
  const prevBucket = state.lastBucket.get(id);

  if (prevBucket === undefined || bucket !== prevBucket) {
    const toSave = { ...rec.last };

    // Evita duplicado exacto (mismo ts consecutivo)
    const lastSaved = rec.history[rec.history.length - 1];
    if (!lastSaved || lastSaved.timestamp !== toSave.timestamp) {
      rec.history.push(toSave);
    }

    // Actualiza candado de ventana
    state.lastBucket.set(id, bucket);

    // Poda para mantener EXACTAMENTE la ventana temporal configurada
    const maxN = Math.max(1, Math.round((state.keepHours * 3600) / winSec));
    while (rec.history.length > maxN) rec.history.shift();
  }

  state.animals.set(id, rec);
}

// ===== Render general =====
function render(){
  renderMarkers();
  renderList();
}

// ===== Render: marcadores =====
function renderMarkers(){
  const latLngs = [];

  state.animals.forEach((rec, id) => {
    const { lat, lon, fix_ok, batt } = rec.last || {};
    if (lat == null || lon == null) return;

    const ll = [lat, lon];
    latLngs.push(ll);

    if (!state.markers.has(id)){
      const m = L.marker(ll, { icon: ICON_OK }).addTo(state.map);
      state.markers.set(id, m);
    }
    const mk = state.markers.get(id);

    const lowBatt = (typeof batt === 'number') &&
                    (batt > 5 ? batt < 20 : batt < BATT_LOW_V);

    // Geocerca
    let fence = 'ok';
    if (state.geofenceOn && state.ranchPoly){
      const polyCoords = state.ranchPoly.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
      fence = fenceStatus(state.map, polyCoords, ll[0], ll[1], state.fenceMeters);
      if (fence !== 'ok') alertOnce(id, fence);
    }

    // Icono final: fuera > sin fix > borde/batt baja > ok
    let icon = ICON_OK;
    if (fence === 'out')           icon = ICON_BAD;
    else if (fix_ok === false)     icon = ICON_BAD;
    else if (fence === 'edge')     icon = ICON_WARN;
    else if (lowBatt)              icon = ICON_WARN;

    mk.setIcon(icon);
    mk.setLatLng(ll);

    const alias = state.aliases.get(id);
    const name = alias
      ? escapeHtml(alias)        // SOLO alias en popup
      : id;

    const p = rec.last || {};
    const velTxt = (typeof p.kmh === 'number') ? ` • ${p.kmh.toFixed(1)} km/h` : '';
    const qTxt   = (p.sats != null || p.hdop != null)
      ? ` • sats:${p.sats ?? '-'} hdop:${p.hdop ?? '-'}`
      : '';

    mk.bindPopup(
      `<div class="mk-popup">
         <div class="mk-title">${name}</div>
         <div class="mk-meta">${fmtHora(p.timestamp)}</div>
         <div class="mk-row">batt: ${formatBatt(p.batt)}${velTxt}${qTxt}</div>
         ${ state.geofenceOn ? `<div class="mk-row">zona: ${fence}</div>` : '' }
       </div>`,
      { maxWidth: 260, closeButton: false, autoPan: true, className: 'rgw-popup' }
    );
  });

  if (!renderedOnce && latLngs.length){
    renderedOnce = true;
    state.map.fitBounds(L.latLngBounds(latLngs), { padding:[30,30] });
  }
}

// ===== Render: lista =====
function renderList(){
  const tbody = EL('#lista tbody');
  if (!tbody) return;

  const q = EL('#filtro')?.value?.trim().toLowerCase();
  const items = Array.from(state.animals.entries())
    .map(([id, rec]) => {
      const alias = state.aliases.get(id) || '';
      return { id, alias, ...rec.last };
    })
    .filter(r =>
      !q ||
      r.id.toLowerCase().includes(q) ||
      r.alias.toLowerCase().includes(q)
    )
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  tbody.innerHTML = items.map(r => {
    const isVolt  = (typeof r.batt === 'number' && r.batt <= 5);
    const voltTip = isVolt ? `${(+r.batt).toFixed(2)} V` : '';
    const idCell = r.alias
      ? `<div class="id-strong">${escapeHtml(r.alias)}</div>`   /* SOLO alias en la tabla */
      : `<div class="id-strong">${r.id}</div>`;

    const lowBatt = (typeof r.batt === 'number') &&
                    (r.batt > 5 ? r.batt < 20 : r.batt < BATT_LOW_V);

    let estadoHtml = '<span class="badge ok">fix OK</span>';
    if (r.fix_ok === false) estadoHtml = '<span class="badge nofix">sin fix</span>';
    else if (lowBatt)       estadoHtml = '<span class="badge warn">batería baja</span>';

    if (state.geofenceOn && state.ranchPoly && r.lat != null && r.lon != null){
      const polyCoords = state.ranchPoly.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
      const f = fenceStatus(state.map, polyCoords, r.lat, r.lon, state.fenceMeters);
      if (f === 'edge') estadoHtml += ' <span class="badge warn">borde</span>';
      if (f === 'out')  estadoHtml += ' <span class="badge nofix">fuera</span>';
    }

    return `
      <tr data-id="${r.id}">
        <td class="cell-id">${idCell}</td>
        <td class="col-hora">
          <span class="fecha">${fmtFecha(r.timestamp)}</span>
          <span class="hora">${fmtHoraLinea(r.timestamp)}</span>
        </td>
        <td class="batt" data-volt="${voltTip}">${formatBatt(r.batt)}</td>
        <td>${r.rssi ?? ''}</td>
        <td>${estadoHtml}</td>
      </tr>`;
  }).join('');
}

// ===== Focus en una vaca =====
function focusAnimal(id, { zoom = 17 } = {}){
  const rec = state.animals.get(id);
  const mk  = state.markers.get(id);
  if (!rec?.last || !mk) return;
  const ll = [rec.last.lat, rec.last.lon];

  state.map.flyTo(ll, zoom, { duration:0.75 });
  mk.openPopup();

  if (state.highlight){
    try { state.map.removeLayer(state.highlight); }catch(_){}
  }
  state.highlight = L.circle(ll, {
    radius:25, color:'#0ea5a4', weight:2,
    fillColor:'#0ea5a4', fillOpacity:0.15
  }).addTo(state.map);

  setTimeout(() => {
    if (state.highlight){
      try { state.map.removeLayer(state.highlight); }catch(_){}
      state.highlight = null;
    }
  }, 2000);
}

// ===== CRUD (demo) =====
const nowEpoch = () => Math.floor(Date.now() / 1000);

function makePkt(id, lat, lon){
  const c = getRanchCenter();
  const latOk = Number.isFinite(lat);
  const lonOk = Number.isFinite(lon);
  const useLat = latOk ? lat : (c?.lat ?? 19.245);
  const useLon = lonOk ? lon : (c?.lng ?? -103.73);
  return {
    id,
    timestamp: nowEpoch(),
    lat:+useLat, lon:+useLon,
    batt:3.95, rssi:-110, snr:7.0, fix_ok:true
  };
}

function addAnimalPrompt(){
  let id = prompt('ID de la vaca (ej. VAC-004):');
  if (!id) return;
  id = id.trim().toUpperCase();
  if (state.animals.has(id)) return alert('Ese ID ya existe.');

  const latStr = prompt('Latitud (ENTER = centro del rancho):');
  const lonStr = (latStr != null && latStr.trim() !== '') ? prompt('Longitud:') : null;

  const lat = (latStr != null && latStr.trim() !== '' && Number.isFinite(+latStr)) ? +latStr : undefined;
  const lon = (lonStr != null && lonStr.trim() !== '' && Number.isFinite(+lonStr)) ? +lonStr : undefined;

  const pkt = makePkt(id, lat, lon);
  upsertPacket(pkt);
  render();
  state.selectedId = id;
  focusAnimal(id);
}

function deleteAnimalSelected(){
  let id = state.selectedId || prompt('ID a eliminar:')?.trim().toUpperCase();
  if (!id) return;
  if (!state.animals.has(id)) return alert('ID no existe.');

  const mk = state.markers.get(id);
  if (mk){
    try { state.map.removeLayer(mk); }catch(_){}
  }

  // Trails asociados
  const line = state.trails.get(id);
  if (line){
    try { state.map.removeLayer(line); }catch(_){}
  }
  state.trails.delete(id);
  state.trailPoints.delete(id);

  state.markers.delete(id);
  state.animals.delete(id);
  if (state.selectedId === id) state.selectedId = null;

  render();
}

// ===== Util =====
function iso(t){
  try{
    return new Date((t * 1000) || t).toLocaleString();
  }catch(e){
    return '';
  }
}
function formatBatt(b){
  if (b == null) return '';
  if (b > 5) return `${Math.round(b)} %`;
  const pct = vToPct(+b);
  return `${pct} %`;
}

// Distancia rápida en metros entre dos puntos {lat,lon}
function distMeters(a, b){
  if (!a || !b || a.lat == null || a.lon == null || b.lat == null || b.lon == null) return 0;
  if (state.map?.distance) {
    return state.map.distance([a.lat, a.lon], [b.lat, b.lon]);
  }
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const la1 = a.lat * toRad;
  const la2 = b.lat * toRad;
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function resetLogs(){
  state.animals.forEach(rec => { rec.history = []; });
  state.lastBucket.clear();
  console.log('Reset: history y buckets por vaca limpiados');
  render();
}

// ===== CSV =====
function csvFromState(){
  const header = 'id,alias,timestamp,iso_time,lat,lon,batt,rssi,snr,fix_ok';
  const rows = [];

  state.animals.forEach((rec, id) => {
    rec.history.forEach(p => {
      rows.push([
        id,
        (state.aliases.get(id) || '').replace(/,/g,' '),
        p.timestamp ?? '',
        iso(p.timestamp).replace(/,/g,''),
        p.lat ?? '', p.lon ?? '',
        p.batt ?? '', p.rssi ?? '', p.snr ?? '', p.fix_ok ?? ''
      ].join(','));
    });
  });

  const blob = new Blob([[header, ...rows].join('\n')], {
    type:'text/csv;charset=utf-8;'
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'session_local.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===== Demo =====
function seedDemo(){
  const t = nowEpoch();
  [
    {
      id:'VAC-001',
      timestamp: t,
      lat: 19.2491367,       // ← dentro de tu ranch.png
      lon: -103.69793845,    // ← dentro de tu ranch.png
      batt: 3.95,
      rssi: -110,
      snr: 7.5,
      fix_ok: true
    },
  ].forEach(upsertPacket);
}
