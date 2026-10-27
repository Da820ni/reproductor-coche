'use strict';

// Prueba mínima: comprueba en un iPhone real
//  1. paso automático a la siguiente canción con la pantalla bloqueada
//  2. controles de la pantalla de bloqueo y del volante (Media Session)
//  3. recuperación tras llamadas o avisos del GPS
// Todo queda en un registro que se puede leer después de conducir.

const $ = (id) => document.getElementById(id);
const audio = $('audio');

const LOG_KEY = 'prueba-log';
const POS_KEY = 'prueba-posicion';
const LOG_MAX = 400;

let tracks = [];      // [{ id, name, size, blob }]
let index = 0;
let currentUrl = null;
let wakeLock = null;

// ---------- registro ----------

let logLines = [];
try { logLines = JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch (e) { logLines = []; }

function log(msg, level = 'info') {
  const t = new Date();
  const stamp = t.toLocaleTimeString('es-ES', { hour12: false }) + '.' + String(t.getMilliseconds()).padStart(3, '0');
  const vis = document.visibilityState === 'visible' ? 'V' : 'O';  // V = en pantalla, O = oculta/bloqueada
  logLines.push({ s: `${stamp} [${vis}] ${msg}`, l: level });
  if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(logLines)); } catch (e) { /* sin almacenamiento */ }
  renderLog();
}

function renderLog() {
  const box = $('log');
  box.innerHTML = '';
  for (const line of logLines) {
    const div = document.createElement('div');
    div.textContent = line.s;
    if (line.l !== 'info') div.className = line.l;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

// ---------- IndexedDB ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('prueba-reproductor', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('tracks').objectStore('tracks').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.order - b.order));
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(track) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').put(track);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- estado y almacenamiento ----------

async function updateStatus() {
  const parts = [];
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  parts.push(standalone ? 'Instalada' : 'EN SAFARI: instálala antes de importar');
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      parts.push(`${(usage / 1048576).toFixed(0)} MB usados de ${(quota / 1073741824).toFixed(1)} GB`);
    } catch (e) { /* no disponible */ }
  }
  if (navigator.storage && navigator.storage.persisted) {
    try { parts.push((await navigator.storage.persisted()) ? 'persistente' : 'no persistente'); } catch (e) { /* no disponible */ }
  }
  const el = $('status');
  el.textContent = parts.join(' · ');
  el.classList.toggle('warn', !standalone);
}

async function requestPersist() {
  if (!navigator.storage || !navigator.storage.persist) {
    log('storage.persist() no existe', 'warn');
    return;
  }
  try {
    const ok = await navigator.storage.persist();
    log(`storage.persist() → ${ok}`, ok ? 'info' : 'warn');
  } catch (e) {
    log(`storage.persist() error: ${e.message}`, 'error');
  }
}

function savePosition() {
  if (!tracks.length) return;
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ id: tracks[index].id, time: audio.currentTime || 0 }));
  } catch (e) { /* sin almacenamiento */ }
}

function loadPosition() {
  try { return JSON.parse(localStorage.getItem(POS_KEY)); } catch (e) { return null; }
}

// ---------- reproducción ----------

function loadTrack(i, startAt = 0) {
  index = (i + tracks.length) % tracks.length;
  const t = tracks[index];
  // Siempre el mismo <audio>: cambiar de elemento en segundo plano es lo que suele fallar en iOS.
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(t.blob);
  audio.src = currentUrl;
  if (startAt > 0) {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  }
  updateMetadata();
  renderList();
}

async function play(reason) {
  if (!tracks.length) return;
  try {
    await audio.play();
    log(`play() OK (${reason})`);
  } catch (e) {
    log(`play() FALLA (${reason}): ${e.name} ${e.message}`, 'error');
  }
}

function go(delta, reason) {
  if (!tracks.length) return;
  loadTrack(index + delta);
  log(`→ pista ${index + 1}: ${tracks[index].name} (${reason})`);
  play(reason);
}

function togglePlay(reason) {
  if (!tracks.length) return;
  if (audio.paused) play(reason);
  else { audio.pause(); log(`pause() (${reason})`); }
}

// ---------- Media Session ----------

function updateMetadata() {
  const t = tracks[index];
  $('title').textContent = t ? t.name : 'Sin canciones';
  $('sub').textContent = t ? `Pista ${index + 1} de ${tracks.length}` : 'Importa 3 o más MP3 desde Archivos';
  if (!('mediaSession' in navigator) || !t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.name,
    artist: 'Prueba reproductor',
    album: `Pista ${index + 1} de ${tracks.length}`,
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch (e) { /* valores fuera de rango durante la carga */ }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) {
    log('Media Session no disponible', 'error');
    return;
  }
  const handlers = {
    play: () => play('pantalla bloqueo / volante'),
    pause: () => { audio.pause(); log('pause() (pantalla bloqueo / volante)'); },
    previoustrack: () => go(-1, 'anterior desde bloqueo / volante'),
    nexttrack: () => go(1, 'siguiente desde bloqueo / volante'),
    seekto: (d) => { audio.currentTime = d.seekTime; log(`seekto ${d.seekTime.toFixed(0)} s`); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, (details) => {
        log(`Media Session: ${action}`);
        fn(details);
      });
    } catch (e) {
      log(`setActionHandler(${action}) no soportado`, 'warn');
    }
  }
  log('Media Session configurada');
}

// ---------- eventos del audio ----------

audio.addEventListener('ended', () => {
  log(`ended: fin de pista ${index + 1}`);
  go(1, 'automático tras ended');
});
audio.addEventListener('playing', () => {
  $('play').textContent = '⏸';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  log('evento playing');
});
audio.addEventListener('pause', () => {
  $('play').textContent = '▶';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  // Si no lo pidió nadie (ni tú ni el volante), es una interrupción del sistema: llamada, Siri, GPS…
  if (!audio.ended) log(`evento pause en ${audio.currentTime.toFixed(1)} s`, 'warn');
  savePosition();
});
audio.addEventListener('loadedmetadata', updatePositionState);
audio.addEventListener('stalled', () => log('evento stalled', 'warn'));
audio.addEventListener('error', () => {
  const err = audio.error;
  log(`error de audio: código ${err && err.code} ${err && err.message}`, 'error');
});

let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastSave > 5000) {
    lastSave = now;
    savePosition();
    updatePositionState();
  }
});

document.addEventListener('visibilitychange', () => {
  log(`visibilidad: ${document.visibilityState}`);
  if (document.visibilityState === 'visible') {
    updateStatus();
    if (wakeLock !== null) requestWakeLock();  // iOS suelta el bloqueo al ocultarse
  } else {
    savePosition();
  }
});
window.addEventListener('pagehide', () => { savePosition(); log('pagehide'); });

// ---------- importación ----------

$('import').addEventListener('click', () => $('file').click());

$('file').addEventListener('change', async (ev) => {
  const files = Array.from(ev.target.files || []);
  ev.target.value = '';
  if (!files.length) return;
  log(`Importando ${files.length} archivo(s)…`);
  const base = tracks.length;
  let ok = 0;
  for (const [i, f] of files.entries()) {
    const track = {
      id: `${Date.now()}-${i}-${f.name}`,
      name: f.name.replace(/\.[^.]+$/, ''),
      size: f.size,
      type: f.type,
      order: base + i,
      // Se guarda el Blob tal cual: nunca se lee entero en memoria.
      blob: new Blob([f], { type: f.type || 'audio/mpeg' }),
    };
    try {
      await dbPut(track);
      tracks.push(track);
      ok++;
      log(`guardado: ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`);
    } catch (e) {
      log(`NO guardado: ${f.name}: ${e.name} ${e.message}`, 'error');
    }
  }
  log(`Importación terminada: ${ok}/${files.length}`);
  await requestPersist();
  if (base === 0 && tracks.length) loadTrack(0);
  renderList();
  updateMetadata();
  updateStatus();
});

// ---------- interfaz ----------

function renderList() {
  const list = $('list');
  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.textContent = t.name;
    if (i === index) li.className = 'current';
    li.addEventListener('click', () => { loadTrack(i); log(`→ pista ${i + 1} (toque en lista)`); play('toque en lista'); });
    list.appendChild(li);
  });
}

$('play').addEventListener('click', () => togglePlay('botón en pantalla'));
$('prev').addEventListener('click', () => go(-1, 'botón en pantalla'));
$('next').addEventListener('click', () => go(1, 'botón en pantalla'));

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    log('Wake Lock no disponible', 'warn');
    return false;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('Wake Lock activo');
    return true;
  } catch (e) {
    log(`Wake Lock error: ${e.name} ${e.message}`, 'error');
    wakeLock = null;
    return false;
  }
}

$('wake').addEventListener('click', async () => {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (e) { /* ya liberado */ }
    wakeLock = null;
    log('Wake Lock liberado');
  } else {
    await requestWakeLock();
  }
  $('wake').textContent = `Pantalla encendida: ${wakeLock ? 'sí' : 'no'}`;
});

$('copylog').addEventListener('click', async () => {
  const text = logLines.map((l) => l.s).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('Registro copiado al portapapeles');
  } catch (e) {
    log(`No se pudo copiar: ${e.message}`, 'error');
  }
});

$('clearlog').addEventListener('click', () => {
  logLines = [];
  try { localStorage.removeItem(LOG_KEY); } catch (e) { /* sin almacenamiento */ }
  renderLog();
});

$('clearall').addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las canciones guardadas en esta prueba?')) return;
  audio.pause();
  audio.removeAttribute('src');
  await dbClear();
  tracks = [];
  index = 0;
  try { localStorage.removeItem(POS_KEY); } catch (e) { /* sin almacenamiento */ }
  log('Canciones borradas');
  renderList();
  updateMetadata();
  updateStatus();
});

// ---------- arranque ----------

async function init() {
  renderLog();
  log('--- app abierta ---');

  // Pide a iOS que trate esto como reproducción de música (Safari 17+).
  if (navigator.audioSession) {
    try {
      navigator.audioSession.type = 'playback';
      log('audioSession.type = playback');
    } catch (e) {
      log(`audioSession error: ${e.message}`, 'warn');
    }
  } else {
    log('audioSession no disponible', 'warn');
  }

  setupMediaSession();

  try {
    tracks = await dbAll();
    log(`${tracks.length} canción(es) en IndexedDB`);
  } catch (e) {
    log(`IndexedDB error: ${e.name} ${e.message}`, 'error');
  }

  if (tracks.length) {
    const pos = loadPosition();
    const i = pos ? tracks.findIndex((t) => t.id === pos.id) : -1;
    if (i >= 0) {
      loadTrack(i, pos.time);
      log(`Retomando pista ${i + 1} en ${pos.time.toFixed(0)} s (toca ▶)`);
    } else {
      loadTrack(0);
    }
  }
  renderList();
  updateMetadata();
  updateStatus();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      log(`Service worker error: ${e.message}`, 'error');
    }
  }
}

init();
