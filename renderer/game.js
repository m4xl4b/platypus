'use strict';
/* Platypus — palazzo pixel-art anni '80 con le sessioni di Claude Code.
   Atrio con il tabellone delle sessioni; un piano per sessione, organizzato come un organigramma:
   in alto l'ufficio a vetri del capo (CLAUDE), sotto le sale (una per tipo di sottoagente) e i
   reparti dei capi reparto (sottoagenti che hanno lanciato altri agenti).
   Il disegno è fatto a rettangoli su un canvas a bassa risoluzione; testi e fumetti sono HTML. */

// ================================================================ costanti
const C = {
  black: '#000000', navy: '#1D2B53', plum: '#7E2553', dgreen: '#008751', brown: '#AB5236',
  dgrey: '#5F574F', lgrey: '#C2C3C7', white: '#FFF1E8', red: '#FF004D', orange: '#FFA300',
  yellow: '#FFEC27', green: '#00E436', blue: '#29ADFF', lav: '#83769C', pink: '#FF77A8', peach: '#FFCCAA',
};
const SESSION_COLORS = [C.pink, C.blue, C.yellow, C.green, C.orange, C.lav, C.red, C.peach];
const GROUP_COLORS = [C.green, C.blue, C.orange, C.pink, C.lav, C.yellow, C.peach, C.red];
const TYPE_SHIRTS = { 'Explore': C.green, 'Plan': C.lav, 'general-purpose': C.blue };
const SKINS = ['#FFCCAA', '#E8B48A', '#C68A5E', '#8D5A3B'];
const HAIRS = ['#1a1a1a', '#5F3A1E', '#AB5236', '#FFEC27', '#C2C3C7', '#7E2553', '#2b2b3a'];
const KIND_LABEL = { cli: tr('TERMINALE'), ide: 'IDE', desktop: 'DESKTOP', sdk: 'SDK', remote: tr('REMOTO'), cowork: 'COWORK', other: tr('ALTRO'), unknown: 'CODE' };
const KIND_COLOR = { cli: C.green, ide: C.blue, desktop: C.pink, sdk: C.orange, remote: C.lav, cowork: C.yellow, other: C.lgrey, unknown: C.lgrey };

const WALL_H = 58, ROW_H = 62, PITCH = 72, LM = 40, MAX_SEATS = 8, SPEED = 52;
const OFF_W = 156, OFF_H = 88;
const ELEV = { x: 20, y: WALL_H + 5 };
const BUSY = ['working', 'thinking', 'writing', 'supervising'];
const IDLE_TO_BREAK_MS = 8000;

// ================================================================ stato
const $ = s => document.querySelector(s);
const LOCALE = (window.AO_I18N && AO_I18N.locale) || 'it-IT';
const LANG = (window.AO_I18N && AO_I18N.lang) || 'it';
const canvas = $('#world');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');
const stage = $('#stage');
const wrap = $('#world-wrap');
const isApp = !!window.officeApp;
if (isApp) document.body.classList.add('app');

let snap = null;
let viewSid = null;           // null = atrio
let viewReady = false;
let transitioning = false;
let W = 480, H = 270, scale = 2;
let floor = null;             // disposizione del piano corrente
const chars = new Map();      // agentId -> personaggio (solo piano corrente)
const roomSeats = new Map();  // "sid|room" -> [agentId|null]
const roomFirstSeen = new Map();
const managersSeen = new Set();
const sessionColor = new Map();
const labels = new Map();     // targhette HTML del piano
let colorCursor = 0;
let lastLogT = Date.now();
let soundOn = load('sound', false);
let crtOn = load('crt', true);
let allBalloons = load('balloons', false);
let follow = load('follow', false);
let zoom = load('zoom', 1);
let focusId = null;
let instantPlace = true;      // al primo disegno di un piano tutti sono già seduti
let receptionist = null;
const waitingSeen = new Set();

function load(k, d) { try { const v = localStorage.getItem('ao.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem('ao.' + k, JSON.stringify(v)); } catch {} }
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function colorFor(sid) {
  if (!sessionColor.has(sid)) sessionColor.set(sid, SESSION_COLORS[colorCursor++ % SESSION_COLORS.length]);
  return sessionColor.get(sid);
}
function groupColor(key) { return GROUP_COLORS[hash(key) % GROUP_COLORS.length]; }
function R(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function p2(n) { return String(n).padStart(2, '0'); }
function agentName(a) {
  if (!a) return '';
  if (a.kind === 'main') return 'CLAUDE';
  return String(a.name || a.type || tr('AGENTE')).toUpperCase() + (!a.name && a.seq > 1 ? '-' + a.seq : '');
}
function agoText(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? tr('ora') : m < 60 ? tr('{m} min', { m }) : tr('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
}

// ================================================================ dati dal server
// l'ultimo stato ricevuto, senza l'orologio: serve a riconoscere gli aggiornamenti a vuoto
let lastPayload = null;
function connect() {
  const es = new EventSource('/events');
  es.onmessage = ev => {
    $('#offline').hidden = true;
    // ogni 2 secondi il server ripubblica lo stato anche se non è successo niente: l'unica
    // differenza è "now", che la pagina non usa mai (qui si guarda l'orologio del browser).
    // Se il resto è identico non c'è niente da rifare. Se il formato non è quello atteso il
    // replace non aggancia e si ricalcola come sempre: meglio un giro in più che dati vecchi.
    const key = ev.data.replace(/^\{"now":\d+,/, '{');
    if (key !== ev.data && key === lastPayload) return;
    lastPayload = key;
    try { snap = JSON.parse(ev.data); } catch { return; }
    if (snap.lang && snap.lang !== LANG) { location.reload(); return; } // lingua cambiata nelle opzioni
    reconcile();
  };
  es.addEventListener('replay', ev => { let d = null; try { d = JSON.parse(ev.data); } catch {} onReplayFrame(d); });
  es.onerror = () => { $('#offline').hidden = false; };
}

function sessions() { return snap ? snap.sessions : []; }
// per Cowork la cartella dice poco: meglio il titolo della sessione
function projName(s) { return s.wing === 'cowork' ? (s.title || s.project) : s.project; }
const THEMES = {
  code: { wall: '#1D2B53', stripe: '#22325f', trim: '#3a4a7a', carpetA: '#2f2840', carpetB: '#352d48', corridor: '#3b3350' },
  cowork: { wall: '#3b1f4a', stripe: '#47275a', trim: '#6a3d80', carpetA: '#1f2f36', carpetB: '#25373f', corridor: '#2c4049' },
};
function themeOf(s) { return THEMES[s && s.wing === 'cowork' ? 'cowork' : 'code']; }
function sessionById(id) { return sessions().find(s => s.id === id) || null; }
function floorNo(id) { return sessions().findIndex(s => s.id === id) + 1; }
// vista corrente: null = atrio, 'archive' = seminterrato, 'relax' = area relax, 'replay' = piano in replay, altrimenti id di sessione
function isSpecial(v) { return v === 'archive' || v === 'replay' || v === 'relax'; }
function getSession(sid) {
  if (viewSid === 'replay' && replayFrame && replayFrame.session && replayFrame.session.id === sid) return replayFrame.session;
  return sessionById(sid);
}
function floorLabel(s) { return s && s._replay ? 'S' : floorNo(s.id); }
function money(v) { return v == null ? '—' : aoMoney(v, v >= 100 ? 0 : v >= 10 ? 1 : 2); }
// numero con la virgola in italiano, con il punto nelle altre lingue
function dec(x) { return LANG === 'it' ? String(x).replace('.', ',') : String(x); }
function tokText(n) { return n >= 1e6 ? dec((n / 1e6).toFixed(1)) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n || 0); }
function budget() { return (snap && snap.settings && snap.settings.budgetUSD) || 0; }
function costClass(v) { const b = budget(); if (!b) return ''; return v > b ? 'over' : v > b * 0.8 ? 'near' : ''; }
function alertsOf(s) { return (s && s.alerts) || []; }
function agentAlert(s, aid) { return alertsOf(s).find(a => a.agentId === aid && a.kind !== 'budget' && a.kind !== 'idle'); }
function toast(msg, ok = true) {
  const el = $('#toast');
  el.textContent = msg; el.className = ok ? 'ok' : 'ko'; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 3500);
}
// SQUADRE: workflow, squadre e messaggi tra agenti della sessione (solo se ce ne sono)
function teamsButton(s) {
  const ti = window.teamsInfo ? teamsInfo(s) : null;
  if (!ti || !ti.any) return '';
  return '<button data-do="teams" title="' + esc(tr('Workflow, squadre e messaggi tra agenti (W)')) + '">' + tr('SQUADRE') + (ti.workflows ? ' · ' + ti.workflows : '') + '</button>';
}
async function sessionAction(what, sid) {
  if (what === 'book') return window.openBottega && openBottega(sid);
  if (what === 'teams') return window.openTeams && openTeams(sid);
  if (what === 'focus') {
    const r = await api('/api/focus', { sid });
    toast(r.ok ? (r.approx ? tr('Ho portato in primo piano {app} (non sono sicuro della finestra esatta)', { app: r.app || tr('l\'app') }) : tr('Finestra in primo piano: {app}', { app: r.app || '' })) : (r.reason || tr('Non trovata')), r.ok);
  } else if (what === 'folder') {
    const r = await api('/api/open-folder', { sid });
    if (!r.ok) toast(r.reason || tr('Cartella non trovata'), false);
  }
}
async function api(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { return { ok: false, reason: tr('Server non raggiungibile') }; }
}
function sessionCounts(s) {
  let agents = 0, busy = 0, wait = 0;
  for (const a of [s.main, ...s.subs]) {
    if (a.finished) continue;
    agents++;
    if (BUSY.includes(a.status)) busy++;
    if (a.status === 'waiting') wait++;
  }
  return { agents, busy, wait, done: s.completed || 0 };
}

// ================================================================ grafico dell'ultima ora
// colonne: in basso chi lavora (verde), sopra chi è presente ma fermo (grigio), in cima chi aspetta (rosso);
// sotto la linea, un trattino giallo per ogni minuto in cui qualcuno ha finito.
function historySvg(hist, w, h, opts = {}) {
  hist = hist || [];
  const n = hist.length || 60;
  const bw = w / n;
  const top = opts.axis ? 2 : 0, base = h - (opts.axis ? 6 : 3);
  let max = 1, maxD = 1;
  for (const x of hist) if (x) { max = Math.max(max, x[0]); maxD = Math.max(maxD, x[3]); }
  const sc = (base - top) / max;
  let r = '';
  hist.forEach((x, i) => {
    const xx = (i * bw).toFixed(1), ww = Math.max(1, bw - (bw > 3 ? 1 : 0)).toFixed(1);
    if (!x) return;
    const [a, b, wt, d] = x;
    const hb = b * sc, hw = wt * sc, hi = Math.max(0, a - b - wt) * sc;
    let y = base;
    if (hb) { y -= hb; r += `<rect x="${xx}" y="${y.toFixed(1)}" width="${ww}" height="${hb.toFixed(1)}" fill="${C.green}"/>`; }
    if (hi) { y -= hi; r += `<rect x="${xx}" y="${y.toFixed(1)}" width="${ww}" height="${hi.toFixed(1)}" fill="#5f5a78"/>`; }
    if (hw) { y -= hw; r += `<rect x="${xx}" y="${y.toFixed(1)}" width="${ww}" height="${hw.toFixed(1)}" fill="${C.red}"/>`; }
    if (d) { const dh = Math.max(1, Math.round(d / maxD * (h - base - 1))); r += `<rect x="${xx}" y="${base + 1}" width="${ww}" height="${dh}" fill="${C.yellow}"/>`; }
  });
  r += `<rect x="0" y="${base}" width="${w}" height="0.6" fill="#4a4266"/>`;
  return `<svg class="hist" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-label="${esc(tr('Attività dell\'ultima ora'))}">${r}</svg>`;
}
function historyPeak(hist) { let m = 0; for (const x of hist || []) if (x) m = Math.max(m, x[0]); return m; }
function historyDone(hist) { let d = 0; for (const x of hist || []) if (x) d += x[3]; return d; }

// ================================================================ navigazione tra i piani
function goTo(sid, instant) {
  if (transitioning) return;
  if (sid === viewSid && viewReady) return;
  const apply = () => {
    viewSid = sid;
    viewReady = true;
    if (sid !== 'replay') save('view', sid || 'lobby');
    resetFloor();
    reconcile();
    stage.scrollTop = 0;
  };
  if (instant) { apply(); return; }
  transitioning = true;
  const doors = $('#doors');
  doors.classList.add('shut');
  beep([880, 660], 0.06, 'triangle', 0.04);
  setTimeout(() => {
    apply();
    setTimeout(() => { doors.classList.remove('shut'); transitioning = false; beep([1320], 0.12, 'sine', 0.05); }, 160);
  }, 240);
}

function resetFloor() {
  for (const c of chars.values()) if (c.el) c.el.remove();
  chars.clear();
  for (const el of labels.values()) el.remove();
  labels.clear();
  floor = null;
  instantPlace = true;
  boards = newBoards();
  resetNpcs();
  dropRelax();
  confetti = [];
  hideInfo();
  $('#roomlist').hidden = true;
}

function stepFloor(dir) {
  const list = sessions();
  if (isSpecial(viewSid)) { goTo(null); return; }
  const idx = viewSid ? list.findIndex(s => s.id === viewSid) : -1;
  const next = idx + dir;
  if (next < 0) goTo(null);
  else if (next < list.length) goTo(list[next].id);
}

// ================================================================ riconciliazione
function reconcile() {
  if (!snap) return;
  // quale vista mostrare
  if (!viewReady) {
    const saved = load('view', 'lobby');
    const list = sessions();
    let target = null;
    if (saved === 'archive' || saved === 'relax') target = saved;
    else if (saved !== 'lobby' && sessionById(saved)) target = saved;
    else if (list.length === 1) target = list[0].id;
    viewSid = target; viewReady = true;
  } else if (viewSid && !isSpecial(viewSid) && !sessionById(viewSid) && !transitioning) {
    goTo(null); // la sessione è stata chiusa
  }
  noteNewest();
  followWaiting();
  checkParties();
  if (widgetOn) renderWidget();
  updateHud();
  updateElevator();
  updateTicker();
  maybeSound();
  const archive = viewSid === 'archive', inReplay = viewSid === 'replay', inRelax = viewSid === 'relax';
  const s = inReplay ? (replayFrame && replayFrame.session) : (viewSid && !archive && !inRelax ? sessionById(viewSid) : null);
  const lobby = !s && !archive && !inReplay && !inRelax;
  $('#board').hidden = !lobby || sessions().length === 0;
  $('#empty').hidden = !lobby || sessions().length > 0;
  $('#archive').hidden = !archive;
  $('#vcr').hidden = !inReplay;
  $('#empty-cowork').textContent = coworkNote();
  if (archive) { layoutLobby(); refreshArchive(); }
  else if (inRelax) layoutRelax();
  else if (inReplay) { if (s) { layoutFloor(s); syncChars(s); } updateVcr(); }
  else if (lobby) { layoutLobby(); updateBoard(); }
  else { layoutFloor(s); syncChars(s); }
}

// ================================================================ replay (seminterrato)
let replayFrame = null, lastVt = 0;
function onReplayFrame(d) {
  if (!d) { replayFrame = null; if (viewSid === 'replay') goTo('archive'); return; }
  if (d.session) d.session._replay = true;
  const jump = replayFrame && (d.vt < lastVt - 1000 || d.vt - lastVt > 15 * 60000);
  replayFrame = d; lastVt = d.vt;
  if (viewSid !== 'replay') return;
  if (jump) resetFloor();
  if (d.session) { layoutFloor(d.session); syncChars(d.session); }
  updateVcr();
}
function fmtClock(t) { return new Date(t).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
let vcrDragging = false;
function updateVcr() {
  const f = replayFrame;
  if (!f) return;
  const v = $('#vcr');
  if (!v._built) {
    v._built = true;
    v.innerHTML = `<button data-a="restart" title="${esc(tr('Dall\'inizio'))}">|&lt;</button><button data-a="toggle" class="pp"></button>` +
      `<span class="speeds">${[10, 30, 120, 600].map(x => `<button data-s="${x}">${x}×</button>`).join('')}</span>` +
      `<input type="range" min="0" max="1000" value="0" class="seek" aria-label="${esc(tr('Posizione nel replay'))}">` +
      `<span class="time"></span><button data-a="close" title="${esc(tr('Chiudi il replay'))}">X</button>`;
    v.querySelector('[data-a=restart]').onclick = () => api('/api/replay', { action: 'seek', value: 0 });
    v.querySelector('[data-a=toggle]').onclick = () => api('/api/replay', { action: replayFrame && replayFrame.playing ? 'pause' : 'play' });
    v.querySelector('[data-a=close]').onclick = () => api('/api/replay', { action: 'stop' });
    for (const b of v.querySelectorAll('[data-s]')) b.onclick = () => api('/api/replay', { action: 'speed', value: Number(b.dataset.s) });
    const sk = v.querySelector('.seek');
    sk.oninput = () => { vcrDragging = true; };
    sk.onchange = () => { vcrDragging = false; api('/api/replay', { action: 'seek', value: sk.value / 1000 }); };
  }
  v.querySelector('.pp').textContent = f.playing ? '||' : '>';
  for (const b of v.querySelectorAll('[data-s]')) b.classList.toggle('on', Number(b.dataset.s) === f.speed);
  if (!vcrDragging) v.querySelector('.seek').value = Math.round(Math.max(0, Math.min(1, f.progress)) * 1000);
  v.querySelector('.time').textContent = `${fmtClock(f.vt)} · ${Math.round(Math.max(0, Math.min(1, f.progress)) * 100)}%${f.done ? ' · ' + tr('FINE') : ''}`;
}

// ================================================================ archivio
let archiveData = null, archiveT = 0, archiveSig = '';
async function refreshArchive(force) {
  if (!force && archiveData && Date.now() - archiveT < 10000) return renderArchive();
  archiveT = Date.now();
  try { archiveData = await (await fetch('/api/archive')).json(); } catch { archiveData = []; }
  renderArchive();
}
function dur(ms) { const m = Math.round(ms / 60000); return m < 60 ? tr('{m} min', { m }) : tr('{h} h {mm}', { h: Math.floor(m / 60), mm: p2(m % 60) }); }
function renderArchive() {
  const list = Array.isArray(archiveData) ? archiveData : [];
  const sig = JSON.stringify(list.map(x => [x.key, x.end, x.live, x.title, x.workflows]));
  if (sig === archiveSig) return;
  archiveSig = sig;
  const el = $('#archive');
  el.innerHTML = `<h2>${tr('ARCHIVIO SESSIONI')} <span>${esc(trn('seminterrato · {n} sessione', 'seminterrato · {n} sessioni', list.length))}</span></h2>` +
    (list.length ? `<table><thead><tr><th>${tr('QUANDO')}</th><th>${tr('DURATA')}</th><th>${tr('PROGETTO')}</th><th>${tr('ORIGINE')}</th><th>${tr('SOTTOAG.')}</th><th></th></tr></thead><tbody>` +
    list.map(x => {
      const kind = x.kind || 'unknown';
      const name = kind === 'cowork' ? (x.title || x.project) : x.project;
      return `<tr data-key="${esc(x.key)}"><td class="when">${esc(new Date(x.start).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td>` +
        `<td class="num">${dur(x.end - x.start)}</td>` +
        `<td class="proj">${esc(name)}${x.live ? ' <b class="live">' + tr('IN CORSO') + '</b>' : ''}<small>${esc(kind === 'cowork' ? x.project : x.title)}</small></td>` +
        `<td><span class="kind" style="color:${KIND_COLOR[kind]}">${KIND_LABEL[kind]}</span></td><td class="num">${p2(x.subagents)}${x.workflows ? ` <b class="wfn" title="${esc(trn('{n} workflow: i suoi agenti sono contati qui; nel replay si vedono con SQUADRE (W)', '{n} workflow: i loro agenti sono contati qui; nel replay si vedono con SQUADRE (W)', x.workflows))}">${esc(tr('{n} WF', { n: x.workflows }))}</b>` : ''}</td>` +
        `<td class="acts"><button data-do="replay">${tr('REPLAY')}</button>` +
        (kind !== 'cowork' && !x.live ? `<button data-do="resume" title="${esc(tr('Apre un terminale con claude --resume'))}">${tr('RIPRENDI')}</button>` : '') +
        `<button data-do="folder">${tr('CARTELLA')}</button></td></tr>`;
    }).join('') + '</tbody></table>' : '<div class="none">' + esc(tr('Nessuna sessione trovata in .claude/projects')) + '</div>') +
    `<div class="foot">${tr('Il replay ricostruisce il piano dai transcript, minuto per minuto, saltando le pause lunghe. RIPRENDI apre un nuovo terminale con <code>claude --resume</code>.')}</div>`;
  for (const row of el.querySelectorAll('tr[data-key]')) {
    const key = row.dataset.key;
    row.querySelector('[data-do=replay]').onclick = async () => {
      toast(tr('Preparo il replay…'));
      const r = await api('/api/replay', { action: 'start', key, speed: 30 });
      if (r.ok) goTo('replay'); else toast(r.error || tr('Replay non disponibile'), false);
    };
    const rs = row.querySelector('[data-do=resume]');
    if (rs) rs.onclick = async () => { const r = await api('/api/resume', { key }); toast(r.ok ? tr('Apro un terminale con la sessione ripresa') : r.reason, r.ok); };
    row.querySelector('[data-do=folder]').onclick = async () => { const r = await api('/api/open-folder', { key }); if (!r.ok) toast(r.reason, false); };
  }
}

function drawBasement(t) {
  // cemento, tubi, scaffali con le scatole dell'archivio
  for (let y = 0; y < H; y += 10) for (let x = 0; x < W; x += 20) R(x + ((y / 10) % 2) * 10, y, 20, 10, ((x + y) / 10) % 3 ? '#3a3a44' : '#34343e');
  R(0, 0, W, WALL_H, '#2a2a33');
  for (let x = 0; x < W; x += 16) R(x, 0, 1, WALL_H, '#24242c');
  R(0, 14, W, 4, '#5F574F'); R(0, 14, W, 1, '#83769C'); R(0, 26, W, 3, '#6d6878');
  for (let x = 30; x < W; x += 140) { R(x, 10, 6, 12, '#83769C'); R(x + 60, 22, 6, 10, '#6d6878'); }
  const flick = Math.sin(t / 130) > -0.92;
  for (let x = 80; x < W; x += 220) { R(x, 0, 2, 8, C.dgrey); R(x - 6, 8, 14, 3, flick ? C.yellow : '#7a6a20'); }
  for (let x = 20; x + 60 < W; x += 120) {
    R(x, WALL_H - 10, 60, H - WALL_H, '#5F574F');
    for (let y = WALL_H; y < H - 10; y += 26) {
      R(x, y, 60, 2, '#83769C');
      for (let k = 0; k < 4; k++) { const c = [C.brown, '#c27c4e', '#8a4a2a', '#d9a066'][(x + y + k) % 4]; R(x + 4 + k * 14, y - 12, 12, 12, c); R(x + 8 + k * 14, y - 9, 4, 2, C.white); }
    }
  }
  pixText(tr('ARCHIVIO'), 12, 34, C.yellow, 7);
}

function coworkNote() {
  const n = snap && snap.hiddenCowork;
  if (!n) return '';
  return trn('{n} sessione Cowork è nascosta (la puoi mostrare dal menu dell\'icona).', '{n} sessioni Cowork sono nascoste (le puoi mostrare dal menu dell\'icona).', n);
}

function followWaiting() {
  for (const s of sessions()) {
    for (const a of [s.main, ...s.subs]) {
      const k = s.id + ':' + a.id;
      if (a.status === 'waiting' && !a.finished) {
        if (!waitingSeen.has(k)) {
          waitingSeen.add(k);
          if (follow && s.id !== viewSid && !transitioning && !(window.arcadeOpen && arcadeOpen())) goTo(s.id);
        }
      } else waitingSeen.delete(k);
    }
  }
}

// ================================================================ dimensioni
// La scala cresce con la finestra, ma senza gradini: a scatti, attraversare una soglia
// ridimensionando faceva saltare tutto il piano del 25-50% di colpo. Alle larghezze qui sotto
// il valore è quello di sempre, in mezzo si interpola.
const SCALE_STOPS = [[360, 1], [600, 1.5], [900, 2], [1500, 2.5], [2400, 3]];
function baseScale() {
  const sw = stage.clientWidth || 800;
  let t = SCALE_STOPS[0][1];
  for (let i = 1; i < SCALE_STOPS.length; i++) {
    const [w0, s0] = SCALE_STOPS[i - 1], [w1, s1] = SCALE_STOPS[i];
    if (sw <= w0) break;
    t = sw >= w1 ? s1 : s0 + (s1 - s0) * (sw - w0) / (w1 - w0);
  }
  return Math.max(0.75, Math.min(4, t * zoom));
}
function applySize(contentH) {
  const sw = stage.clientWidth || 800, sh = stage.clientHeight || 500;
  W = Math.max(360, Math.floor(sw / scale));
  H = Math.max(contentH || 0, Math.floor(sh / scale));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const cw = W * scale, chh = H * scale;
  canvas.style.width = cw + 'px'; canvas.style.height = chh + 'px';
  overlay.style.width = cw + 'px'; overlay.style.height = chh + 'px';
  wrap.style.width = cw + 'px'; wrap.style.height = chh + 'px';
  const fpx = Math.max(12, Math.min(22, Math.round(scale * 7)));
  document.documentElement.style.setProperty('--bubble-font', fpx + 'px');
  // con una soglia secca la classe sfarfalla quando la scala si ferma sul confine: qui
  // si accende sotto 1.35 e si spegne solo sopra 1.45
  document.body.classList.toggle('tiny', scale < (document.body.classList.contains('tiny') ? 1.45 : 1.35));
}

// ================================================================ atrio
function layoutLobby() {
  scale = baseScale();
  applySize(0);
  // altezza esatta della finestra: niente scorrimento nell'atrio
  H = Math.floor((stage.clientHeight || 500) / scale);
  if (canvas.height !== H) { canvas.height = H; canvas.style.height = H * scale + 'px'; overlay.style.height = H * scale + 'px'; wrap.style.height = H * scale + 'px'; }
  if (!receptionist) receptionist = { key: 'reception', x: 0, y: 0, phase: 'seated', alpha: 1, dir: 'down', moving: false, data: { status: 'idle', kind: 'sub' }, look: { skin: '#E8B48A', hair: '#7E2553', style: 1, shirt: C.red, pants: C.navy, acc: 'headset' } };
  receptionist.x = Math.round(W / 2) - 8;
  receptionist.y = H - 26;
}

// nel tabellone: quanti workflow sono in corso sul piano (il dettaglio è nel pannello SQUADRE)
function wfChip(s) {
  const live = (s.workflows || []).filter(r => r.status === 'running');
  if (!live.length) return '';
  const phase = r => { const p = r.phases.find(x => x.running) || r.phases.find(x => x.total && x.done + x.failed < x.total); return p ? p.title : ''; };
  return ` <b class="wfn" title="${esc(live.map(r => r.name + (phase(r) ? ' · ' + phase(r) : '')).join(' / '))}">${esc(tr('{n} WF', { n: live.length }))}</b>`;
}
let boardSig = '';
function updateBoard() {
  const list = sessions();
  const rows = list.map((s, i) => {
    const c = sessionCounts(s);
    const col = colorFor(s.id);
    const kind = s.kind || 'unknown';
    return { s, i, c, col, kind };
  });
  if (boardTab !== 'sessions') return renderBoardTab();
  const sig = JSON.stringify(rows.map(r => [r.s.id, r.s.project, r.s.title, r.kind, r.c, r.s.main.action, r.s.ended, r.s.history, Math.round((r.s.cost || 0) * 100), alertsOf(r.s).map(a => a.text), wfChip(r.s)]));
  if (sig === boardSig) return;
  boardSig = sig;
  const tot = rows.reduce((t, r) => ({ a: t.a + r.c.agents, b: t.b + r.c.busy, w: t.w + r.c.wait, d: t.d + r.c.done }), { a: 0, b: 0, w: 0, d: 0 });
  $('#board').innerHTML = boardTabs() +
    `<h2>${tr('TABELLONE SESSIONI')} <span>${trn('{n} PIANO', '{n} PIANI', list.length, { n: p2(list.length) })} · ${trn('{n} AGENTE', '{n} AGENTI', tot.a, { n: p2(tot.a) })} · ${tr('{n} AL LAVORO', { n: p2(tot.b) })}${tot.w ? ' · ' + tr('{n} IN ATTESA', { n: p2(tot.w) }) : ''}</span></h2>` +
    (rows.length ? `<table><thead><tr><th>${tr('PIANO')}</th><th>${tr('PROGETTO')}</th><th>${tr('ORIGINE')}</th><th>${tr('AGENTI')}</th><th>${tr('LAVORO')}</th><th>${tr('ATTESA')}</th><th>${tr('FATTI')}</th><th>${tr('COSTO')}</th><th class="c-hist">${tr('ULTIMA ORA')}</th><th class="c-act">${tr('CLAUDE STA…')}</th></tr></thead><tbody>` +
      rows.map((r, j) => (rows.some(x => x.s.wing === 'cowork') && (j === 0 || rows[j - 1].s.wing !== r.s.wing)
          ? `<tr class="sec"><td colspan="11">${r.s.wing === 'cowork' ? 'COWORK' : 'CLAUDE CODE'}</td></tr>` : '') +
        `<tr data-sid="${esc(r.s.id)}" class="${r.c.wait ? 'wait' : ''}">` +
        `<td class="fl" style="background:${r.col}">${r.i + 1}</td>` +
        `<td class="proj">${esc(projName(r.s))}${r.s.demo ? ' [DEMO]' : ''}${wfChip(r.s)}<small>${esc(r.s.wing === 'cowork' ? r.s.project : (r.s.title || ''))}</small></td>` +
        `<td><span class="kind" style="color:${KIND_COLOR[r.kind]}">${KIND_LABEL[r.kind]}</span></td>` +
        `<td class="num">${p2(r.c.agents)}</td><td class="num">${p2(r.c.busy)}</td>` +
        `<td class="num" style="color:${r.c.wait ? C.red : ''}">${p2(r.c.wait)}</td><td class="num">${p2(r.c.done)}</td>` +
        `<td class="num cost ${costClass(r.s.cost)}">${money(r.s.cost)}${alertsOf(r.s).length ? `<span class="alc" title="${esc(alertsOf(r.s).map(a => a.text).join('\n'))}">!${alertsOf(r.s).length}</span>` : ''}</td>` +
        `<td class="c-hist">${historySvg(r.s.history, 120, 22)}</td>` +
        `<td class="act c-act">${esc(r.s.main.action)}</td></tr>`).join('') +
      `</tbody></table>` : `<div class="none">${tr('Nessuna sessione attiva')}</div>`) +
    `<div class="foot">${tr('Clic su una riga o premi il numero del piano per salire.')}` +
    (snap.hiddenCowork ? ' ' + coworkNote() : '') + `</div>`;
  for (const row of $('#board').querySelectorAll('tr[data-sid]')) row.onclick = () => goTo(row.dataset.sid);
  bindBoardTabs();
}

// ---- schede del tabellone: sessioni, costi nel tempo, onori
let boardTab = 'sessions', costsData = null, costsT = 0, honorsData = null, honorsT = 0;
function boardTabs() {
  return `<div class="tabs">${[['sessions', tr('SESSIONI')], ['costs', tr('COSTI')], ['honors', tr('ONORI')], ['bottega', tr('BOTTEGA')]].map(([k, l]) => `<button data-tab="${k}" class="${boardTab === k ? 'on' : ''}">${l}</button>`).join('')}<button data-do="report" title="${esc(tr('Apre il report di oggi'))}">${tr('REPORT DI OGGI')}</button></div>`;
}
function bindBoardTabs() {
  for (const b of $('#board').querySelectorAll('[data-tab]')) b.onclick = () => { boardTab = b.dataset.tab; boardSig = ''; updateBoard(); };
  const r = $('#board').querySelector('[data-do=report]');
  if (r) r.onclick = () => window.open('/report', '_blank');
}
// mappa contro territorio del piano che stai guardando: chiesta al massimo ogni 10 s (il disco si guarda solo lì)
const ground = { sid: null, t: 0, busy: false, stale: new Set(), claim: new Map(), bang: new Map(), puzzled: new Set(), seen: new Map() };
async function loadGrounding() {
  const replay = viewSid === 'replay';
  const s = replay ? (replayFrame && replayFrame.session) : (viewSid && !isSpecial(viewSid) ? sessionById(viewSid) : null);
  if (!s || ground.busy || (ground.sid === s.id && Date.now() - ground.t < 10000)) return;
  ground.busy = true;
  try {
    const g = await (await fetch('/api/grounding?' + new URLSearchParams({ sid: s.id, aid: 'all', ...(replay ? { replay: '1' } : {}) }))).json();
    if (!g || !g.ok) return;
    ground.sid = s.id; ground.t = Date.now();
    ground.stale = new Set(g.stale.map(x => x.agent));
    // per ogni agente l'ultima risposta con affermazioni: conta solo se non è ancorata e (dal vivo) è recente
    const claim = new Map(), newest = new Map();
    for (const c of g.claims) if (c.t > (newest.get(c.agent) || 0)) newest.set(c.agent, c.t);
    for (const c of g.claims) {
      if (c.t !== newest.get(c.agent) || c.status === 'grounded' || (!replay && g.now - c.t > 300000)) continue;
      const prev = claim.get(c.agent);
      if (!prev || (c.status === 'contradicted' && prev.status !== 'contradicted')) claim.set(c.agent, c);
    }
    ground.claim = claim;
    // sorprese: "!?" per un attimo quando ne arriva una forte; nuvoletta grigia se insiste due volte di fila
    const last = new Map(), run = new Map();
    for (const x of g.surprises || []) { last.set(x.agent, x); run.set(x.agent, x.reaction === 'insists' ? (run.get(x.agent) || 0) + 1 : 0); }
    const puzzled = new Set();
    for (const [id, x] of last) {
      const recent = replay || g.now - x.t < 30000;
      if (x.value >= 0.7 && recent && x.t > (ground.seen.get(id) || 0)) ground.bang.set(id, performance.now() + 4000);
      ground.seen.set(id, x.t);
      if ((run.get(id) || 0) >= 2 && (replay || g.now - x.t < 600000)) puzzled.add(id);
    }
    ground.puzzled = puzzled;
  } catch {} finally { ground.busy = false; }
}
setInterval(loadGrounding, 3000);
const elder = { sid: null, t: 0, busy: false, hints: [], back: new Map(), last: new Map() };
async function loadHints() {
  const s = viewSid && !isSpecial(viewSid) ? sessionById(viewSid) : null;
  if (!s || elder.busy || !settingOn('elderEnabled') || (elder.sid === s.id && Date.now() - elder.t < 5000)) return;
  elder.busy = true;
  try {
    const r = await (await fetch('/api/bottega/hints?' + new URLSearchParams({ sid: s.id }))).json();
    elder.sid = s.id; elder.t = Date.now(); elder.hints = (r && r.ok && r.hints) || [];
  } catch {} finally { elder.busy = false; }
}
setInterval(loadHints, 3000);
const groundFor = c => (c.npc || c.sid !== ground.sid ? null : { stale: ground.stale.has(c.id), claim: ground.claim.get(c.id) || null, bang: ground.bang.get(c.id) || 0, puzzled: ground.puzzled.has(c.id) });

async function loadCosts() { if (Date.now() - costsT < 60000 && costsData) return; costsT = Date.now(); try { costsData = await (await fetch('/api/stats/costs?days=14')).json(); } catch {} }
async function loadHonors() { if (Date.now() - honorsT < 60000 && honorsData) return; honorsT = Date.now(); try { honorsData = await (await fetch('/api/stats/honors')).json(); } catch {} }
let tabSig = '';
async function renderBoardTab() {
  if (boardTab === 'costs') await loadCosts(); else if (boardTab === 'bottega') await loadBooks(); else await loadHonors();
  const html = boardTab === 'costs' ? costsHtml() : boardTab === 'bottega' ? booksHtml() : honorsHtml();
  if (html === tabSig) return;
  tabSig = html;
  $('#board').innerHTML = boardTabs() + html;
  bindBoardTabs();
  for (const r of $('#board').querySelectorAll('tr[data-book]')) r.onclick = () => window.openBottega && openBottega(null, null, { key: r.dataset.book });
}
let booksData = null, booksT = 0;
async function loadBooks() { if (Date.now() - booksT < 15000 && booksData) return; booksT = Date.now(); try { booksData = (await (await fetch('/api/bottega/list')).json()).books || []; } catch {} }
function booksHtml() {
  const d = booksData || [];
  return `<h2>${tr('LIBRO DELLA BOTTEGA')} <span>${tr('la memoria di ogni progetto, dedotta dalle sessioni')}</span></h2>` +
    (d.length ? `<table><thead><tr><th>${tr('PROGETTO')}</th><th>${tr('LEZIONI')}</th><th>${tr('OSSERVAZIONI')}</th><th>${tr('ULTIMO CASO')}</th></tr></thead><tbody>${d.map(b => `<tr data-book="${esc(b.key)}" class="click"><td class="proj">${esc(b.name)}</td><td class="num">${b.strong}</td><td class="num">${b.lessons - b.strong}</td><td>${esc(new Date(b.last).toLocaleDateString(AO_I18N.locale || 'it-IT'))}</td></tr>`).join('')}</tbody></table>`
      : `<p>${tr('Ancora nessun libro: le lezioni nascono mentre l\'ufficio segue le sessioni, oppure dal pulsante «Impara dall\'archivio» nel libro di un piano.')}</p>`) +
    `<div class="foot">${tr('Le lezioni sono deduzioni dai fatti, non regole certe. Restano in .platypus/bottega.')}</div>`;
}
function costsHtml() {
  const d = costsData || [];
  const projTot = {};
  for (const x of d) for (const [p, v] of Object.entries(x.projects)) projTot[p] = (projTot[p] || 0) + v;
  const top = Object.entries(projTot).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
  const pal = [C.pink, C.blue, C.yellow, C.green, C.orange, C.lav, C.lgrey];
  const max = Math.max(1, ...d.map(x => x.total));
  const Wd = 900, Hd = 180, bw = Wd / Math.max(1, d.length);
  let svg = '';
  d.forEach((x, i) => {
    let y = Hd - 18;
    const parts = top.map((p, k) => [x.projects[p] || 0, pal[k]]).concat([[x.total - top.reduce((t, p) => t + (x.projects[p] || 0), 0), pal[6]]]);
    for (const [v, col] of parts) { if (v <= 0) continue; const h = v / max * (Hd - 34); y -= h; svg += `<rect x="${(i * bw + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${h.toFixed(1)}" fill="${col}"/>`; }
    const dd = new Date(x.day + 'T12:00:00');
    svg += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${Hd - 4}" text-anchor="middle">${dd.getDate()}/${dd.getMonth() + 1}</text>`;
    if (x.total) svg += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" class="v">${Math.round(x.total)}</text>`;
  });
  const sum = d.reduce((t, x) => t + x.total, 0), week = d.slice(-7).reduce((t, x) => t + x.total, 0);
  return `<h2>${tr('COSTI NEL TEMPO')} <span>${tr('ultimi 14 giorni · totale {sum} · ultimi 7 giorni {week}', { sum: money(sum), week: money(week) })}</span></h2>` +
    `<svg class="costs" viewBox="0 0 ${Wd} ${Hd}" preserveAspectRatio="none" role="img" aria-label="${esc(tr('Costi degli ultimi 14 giorni'))}">${svg}</svg>` +
    `<div class="legend2">${top.map((p, k) => `<span><i style="background:${pal[k]}"></i>${esc(p)} · ${money(projTot[p])}</span>`).join('')}${Object.keys(projTot).length > top.length ? `<span><i style="background:${pal[6]}"></i>${tr('altri')}</span>` : ''}</div>` +
    `<div class="foot">${esc(snap && snap.demo && !d.some(x => x.total && !snap.demo) ? tr('Le statistiche si accumulano mentre l\'ufficio è aperto e restano salvate in .platypus/stats.json (in demo: dati finti).') : tr('Le statistiche si accumulano mentre l\'ufficio è aperto e restano salvate in .platypus/stats.json.'))}</div>`;
}
function honorsHtml() {
  const h = honorsData || {};
  const box = (title, r, what, cls) => `<div class="honor ${cls || ''}"><h3>${title}</h3>${r ? `<b>${esc(String(r.type).toUpperCase())}</b><span>${what(r)}</span>` : '<span>' + tr('nessuno, per ora') + '</span>'}</div>`;
  return `<h2>${tr('ONORI DELLA SETTIMANA')} <span>${esc(h.week || '')}</span></h2><div class="honors">` +
    box(tr('DIPENDENTE DELLA SETTIMANA'), h.employee, r => `${trn('{n} compito chiuso', '{n} compiti chiusi', r.completed)} · ${trn('{n} errore', '{n} errori', r.errors)}`, 'gold') +
    box(tr('PREMIO CAFFÈ'), h.coffee, r => tr('il più costoso: {cost}', { cost: money(r.cost) })) +
    box(tr('STACANOVISTA'), h.worker, r => trn('{n} strumento usato', '{n} strumenti usati', r.tools)) +
    box(tr('MANI DI BURRO'), h.butter, r => trn('{n} errore', '{n} errori', r.errors)) + '</div>' +
    ((h.rows || []).length ? `<table><thead><tr><th>${tr('TIPO')}</th><th>${tr('COMPITI')}</th><th>${tr('STRUMENTI')}</th><th>${tr('ERRORI')}</th><th>${tr('COSTO')}</th></tr></thead><tbody>${h.rows.map(r => `<tr><td class="proj">${esc(String(r.type).toUpperCase())}</td><td class="num">${r.completed}</td><td class="num">${r.tools}</td><td class="num">${r.errors}</td><td class="num">${money(r.cost)}</td></tr>`).join('')}</tbody></table>` : '') +
    `<div class="foot">${tr('Il dipendente della settimana è il tipo di agente che chiude più compiti con meno errori.')}</div>`;
}

function drawLobby(t) {
  // pavimento in marmo
  for (let y = WALL_H; y < H; y += 16) for (let x = 0; x < W; x += 16) {
    R(x, y, 16, 16, ((x + y) / 16) % 2 ? '#4a4560' : '#544e6c');
    R(x, y, 16, 1, '#5e587a');
  }
  // parete
  R(0, 0, W, WALL_H, '#1D2B53');
  for (let x = 0; x < W; x += 8) R(x, 10, 1, WALL_H - 14, '#22325f');
  R(0, 0, W, 2, '#3a4a7a'); R(0, WALL_H - 5, W, 5, '#5F574F'); R(0, WALL_H - 5, W, 1, '#83769C');
  // finestre
  let wi = 0;
  const door = relaxDoor();
  for (let x = 12; x + 46 < W / 2 - 50; x += 92, wi++) drawWindow(x, 13, t, wi);
  for (let x = W - 58; x - 2 > door.x + door.w + 6; x -= 92, wi++) drawWindow(x, 13, t, wi); // a destra si fermano prima della porta del relax
  // ascensori al centro
  const cx = Math.round(W / 2);
  [['CODE', -40, C.green], ['COWORK', 8, C.pink]].forEach(([lbl, dx, col]) => {
    const ex = cx + dx;
    R(ex - 2, WALL_H - 38, 36, 38, '#5F574F');
    R(ex, WALL_H - 36, 32, 36, '#a3a2b0'); R(ex + 15, WALL_H - 36, 2, 36, '#6d6878');
    R(ex + 16 - lbl.length * 2 - 2, WALL_H - 46, lbl.length * 4 + 3, 8, C.black); pixText(lbl, ex + 16 - lbl.length * 2, WALL_H - 45, col, 4);
  });
  R(cx - 4, WALL_H - 22, 3, 5, C.dgrey); R(cx - 3, WALL_H - 21, 1, 1, ((t / 500) | 0) % 2 ? C.yellow : C.dgrey);
  // insegna
  const label = 'PLATYPUS';
  const tw = label.length * 8;
  R(cx - tw / 2 - 5, 1, tw + 10, 12, '#120c22');
  pixText(label, cx - tw / 2, 2, Math.sin(t / 900) > -0.97 ? C.pink : '#5a2a44', 7);
  // tappeto, piante, reception
  R(cx - 70, H - 46, 140, 44, '#7E2553'); R(cx - 66, H - 42, 132, 36, '#9a3366');
  drawDecor(16, H - 40); drawDecor(W - 32, H - 40);
  if (receptionist) drawChar(receptionist, t);
  drawEmployeePortrait(t);
  drawDoor(door, 'RELAX', C.green, t);
  const dx = cx - 48, dy = H - 30;
  R(dx, dy, 96, 6, '#e0a070'); R(dx, dy + 6, 96, 18, '#8a4a2a'); R(dx + 4, dy + 9, 88, 1, '#a35a32');
  pixText('RECEPTION', dx + 30, dy + 13, C.yellow, 4);
  R(dx + 70, dy - 3, 5, 3, C.yellow); R(dx + 72, dy - 4, 1, 1, C.yellow);
}

// quadro del dipendente della settimana, appeso in atrio
function drawEmployeePortrait(t) {
  const emp = honorsData && honorsData.employee;
  if (!emp) { loadHonors(); return; }
  const x = Math.round(W / 2) + 64, y = 8;
  R(x - 3, y - 3, 34, 44, '#c8a040'); R(x - 1, y - 1, 30, 40, '#8a6a20'); R(x, y, 28, 38, '#1a1426');
  const look = { skin: '#E8B48A', hair: '#5F3A1E', style: 1, ...uniformFor(emp.type) };
  drawChar({ key: 'portrait', x: x + 14, y: y + 34, phase: 'stand', alpha: 1, dir: 'down', moving: false, look, data: { status: 'idle', kind: 'sub' } }, t);
  R(x + 2, y + 30, 24, 7, '#c8a040'); pixText('TOP', x + 8, y + 31, '#3a2a10', 4);
  const nm = String(emp.type).toUpperCase().slice(0, 9);
  pixText(nm, x + 14 - nm.length * 2, y + 44, C.yellow, 4);
  if (((t / 900) | 0) % 2) R(x + 25, y + 2, 2, 2, C.white);
}

function drawPlant(x, y) {
  R(x + 2, y + 14, 10, 10, C.brown); R(x + 1, y + 14, 12, 2, '#c46a40');
  R(x + 5, y + 2, 4, 12, C.dgreen); R(x, y + 4, 6, 4, C.green); R(x + 8, y, 6, 5, C.green); R(x + 3, y - 4, 6, 6, C.dgreen); R(x + 9, y + 7, 5, 4, C.dgreen);
}

// ================================================================ area relax: la caffetteria del piano terra
// Si entra dalla porta RELAX dell'atrio (o con R). Niente agenti: impiegati qualunque che prendono
// il caffè, si siedono, giocano ai cabinati. Uno mangia sempre una banana, e chi gli passa vicino commenta.
const ARCADES = [
  { id: 'pacman', name: 'PAC-MAN', col: C.yellow, body: '#1D2B53', scr: '#000000' },
  { id: 'tetris', name: 'TETRIS', col: C.red, body: '#7E2553', scr: '#0b1430' },
  { id: 'invaders', name: 'SPACE INVADERS', col: C.green, body: '#2b2b3a', scr: '#000000' },
  { id: 'frogger', name: 'FROGGER', col: C.blue, body: '#008751', scr: '#1D2B53' },
];
const PAC_ICON = ['01110', '11100', '11000', '11100', '01110'];
const INV_ICON = ['0100010', '0111110', '1101011', '1111111', '1010101'];
const FROG_ICON = ['1000001', '0111110', '1101011', '0111110', '1000001'];
const RELAX_NAMES = ['Gianni', 'Marisa', 'Franco', 'Loredana', 'Sandro', 'Patrizia', 'Walter', 'Rossella'];
const RELAX_DEPTS = ['contabilita', 'vendite', 'marketing', 'acquisti', 'logistica', 'segreteria', 'legale', 'magazzino'];
// ruoli aziendali: credibili su LinkedIn, assurdi appena ci pensi (in inglese, come sui biglietti da visita)
const RELAX_ROLES = [
  'Help Desk Evangelist', 'Firewall Outage Architect', 'Senior Meeting Facilitator', 'Head of Synergy Alignment',
  'Chief Excel Officer', 'Agile Coffee Strategist', 'Legacy Code Archaeologist', 'Junior Visionary',
  'Lead Reply-All Specialist', 'Principal PowerPoint Engineer', 'Deadline Postponement Manager', 'Cloud Weather Analyst',
  'VP of Internal Buzzwords', 'Scrum Master of Ceremonies', 'Data Lake Lifeguard', 'Printer Relations Manager',
  'Digital Transformation Survivor', 'Head of Low-Hanging Fruit', 'Blockchain Feng Shui Consultant', 'Senior Out-of-Office Officer',
  'Ticket Escalation Choreographer', 'Global Head of Local Issues', 'Backup Restore Optimist', 'Inbox Zero Denier',
];
const BANANA_LINE = tr('Beh, almeno una te la sei mangiata...');
let relax = null;

// porta dell'area relax in atrio, a destra del quadro del dipendente della settimana
function relaxDoor() { return { x: Math.round(W / 2) + 104, y: WALL_H - 36, w: 22, h: 36 }; }
function drawDoor(d, sign, col, t) {
  R(d.x - 2, d.y - 2, d.w + 4, d.h + 2, '#5F574F');
  R(d.x, d.y, d.w, d.h, '#8a4a2a'); R(d.x + 3, d.y + 14, d.w - 6, 18, '#a35a32');
  // oblò con la luce calda: ogni tanto di là passa qualcuno
  R(d.x + 6, d.y + 3, d.w - 12, 8, '#ffd27a');
  const p = ((t / 70) | 0) % 140, a = Math.max(d.x + 6, d.x + 2 + p), b = Math.min(d.x + d.w - 6, d.x + 6 + p);
  if (b > a) R(a, d.y + 5, b - a, 6, '#5a3a2a');
  R(d.x + d.w - 5, d.y + 19, 2, 3, C.yellow);
  const tw = sign.length * 4;
  R(d.x + d.w / 2 - tw / 2 - 2, d.y - 11, tw + 3, 8, C.black);
  pixText(sign, d.x + d.w / 2 - tw / 2, d.y - 10, Math.sin(t / 700) > -0.95 ? col : shade(col, 0.4), 4);
}

function dropRelax() { if (relax) for (const n of relax.npcs) if (n.el) n.el.remove(); relax = null; }

function layoutRelax() {
  layoutLobby(); // stessa scala e altezza fissa dell'atrio
  const sig = W + 'x' + H;
  if (relax && relax.sig === sig) return;
  dropRelax();
  // da sinistra: uscita, angolo bar, finestre; a destra divano, quattro cabinati, divano
  const lane = WALL_H + 28, kx = 34, bx = W - 175;
  const spots = [];
  const sofas = [{ x: bx, col: C.orange }, { x: bx + 133, col: C.lav }];
  for (const s of sofas) for (const dx of [10, 24]) spots.push({ kind: 'sofa', x: s.x + dx, y: WALL_H + 10, ex: s.x + dx, dir: 'down' });
  const cabs = ARCADES.map((a, i) => ({ ...a, x: bx + 40 + i * 23, top: WALL_H - 26, player: null }));
  for (const c of cabs) spots.push({ kind: 'arcade', cab: c, x: c.x + 9, y: WALL_H + 24, ex: c.x + 9, dir: 'up' });
  spots.push({ kind: 'coffee', x: kx + 16, y: WALL_H + 22, ex: kx + 16, dir: 'up' });
  // tavolini: due sedie dietro ognuno, si entra e si esce dai corridoi laterali
  // al massimo 4 x 3, larghi e distribuiti su tutta l'altezza
  const y0 = lane + 30, rows = Math.max(1, Math.min(3, Math.floor((H - 24 - y0) / 48) + 1));
  const gapY = rows > 1 ? Math.min(64, Math.floor((H - 24 - y0) / (rows - 1))) : 0;
  const cols = Math.max(2, Math.min(4, Math.floor((W - 40) / 90))), pitch = (W - 40) / cols;
  const tables = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const tx = Math.round(20 + pitch * (c + 0.5)), ty = y0 + r * gapY;
    tables.push({ x: tx, y: ty });
    spots.push({ kind: 'table', x: tx - 7, y: ty, ex: tx - 26, dir: 'down' }, { kind: 'table', x: tx + 7, y: ty, ex: tx + 26, dir: 'down' });
  }
  relax = { sig, lane, kx, bx, sofas, cabs, tables, spots, npcs: [], door: { x: 6, y: WALL_H - 36, w: 22, h: 36 } };
  // più è larga la stanza, più gente in pausa
  const n = Math.max(5, Math.min(8, 5 + Math.floor((W - 360) / 140)));
  const t = performance.now(), off = (Math.random() * RELAX_NAMES.length) | 0;
  const roles = RELAX_ROLES.slice().sort(() => Math.random() - 0.5);
  const seats = spots.filter(s => s.kind === 'table' || s.kind === 'sofa').sort(() => Math.random() - 0.5);
  const arcade = spots.filter(s => s.kind === 'arcade');
  for (let i = 0; i < n; i++) {
    // quello della banana sta sul divano accanto ai cabinati, dove passano tutti
    const banana = i === 0;
    const spot = banana ? spots.find(s => s.kind === 'sofa' && s.x === bx + 24) : i === 1 ? arcade[(Math.random() * arcade.length) | 0] : seats.find(s => !s.by && s.x !== bx + 24);
    if (!spot) break;
    const key = 'relax:' + i + ':' + ((Math.random() * 1e6) | 0);
    const play = spot.kind === 'arcade';
    const c = { key, id: key, npc: 'relax', x: spot.x, y: spot.y, path: [], dir: spot.dir, moving: false, alpha: 1, phase: play ? 'stand' : 'seated',
      look: makeLook(key, { kind: 'sub', type: RELAX_DEPTS[(off + i) % RELAX_DEPTS.length] }),
      data: { status: 'idle', kind: 'sub', name: banana ? 'Rag. Bruno' : RELAX_NAMES[(off + i) % RELAX_NAMES.length], type: '', action: '', description: banana ? 'Chief Potassium Officer' : roles[i] },
      spot, act: play ? 'play' : 'sit', until: t + 2000 + Math.random() * 10000, speech: '', speechUntil: 0, quipAt: 0, banana, t0: t - Math.random() * 10000,
      doing: banana ? tr('Mangia una banana') : play ? tr('Gioca a {game}', { game: spot.cab.name }) : tr('Si gode la pausa') };
    spot.by = c;
    if (play) spot.cab.player = c;
    relax.npcs.push(c);
  }
}

// finito quello che faceva, l'impiegato sceglie la prossima cosa e ci va passando dal corridoio davanti al bancone
function relaxGo(n) {
  const from = n.spot || { x: n.x, y: n.y, ex: n.x };
  if (n.spot) { n.spot.by = null; if (n.spot.cab) n.spot.cab.player = null; }
  const free = k => relax.spots.filter(s => s.kind === k && !s.by && s !== from);
  const playing = relax.spots.filter(s => s.kind === 'arcade' && s.by).length;
  const r = Math.random();
  let act = n.cup ? 'sit' : r < 0.3 ? 'coffee' : r < 0.45 && playing < 2 ? 'play' : r < 0.85 ? 'sit' : 'walk';
  const opts = act === 'sit' ? [...free('table'), ...free('sofa')] : act === 'coffee' ? free('coffee') : act === 'play' ? free('arcade') : [];
  if (!opts.length) act = 'walk';
  let to;
  if (act === 'walk') { const x = Math.round(30 + Math.random() * (W - 60)); to = { kind: 'walk', x, y: relax.lane, ex: x, dir: 'down' }; }
  else to = opts[(Math.random() * opts.length) | 0];
  const L = relax.lane;
  n.path = [{ x: from.ex, y: from.y }, { x: from.ex, y: L }, { x: to.ex, y: L }, { x: to.ex, y: to.y }, { x: to.x, y: to.y }];
  n.spot = to; to.by = n; n.act = act;
  n.phase = n.cup ? 'break' : 'stand'; // con la tazza in mano
  n.doing = act === 'sit' ? (n.cup ? tr('Si porta il caffè al tavolo') : tr('Cerca un posto')) : act === 'coffee' ? tr('Va a prendere un caffè') : act === 'play' ? tr('Va a giocare a {game}', { game: to.cab.name }) : tr('Fa due passi');
}
function relaxArrive(n, t) {
  const s = n.spot;
  n.dir = s.dir;
  if (n.act === 'sit') { n.phase = 'seated'; n.until = t + 8000 + Math.random() * 12000; n.doing = tr('Si gode la pausa'); }
  else if (n.act === 'coffee') { n.phase = 'stand'; n.act = 'brew'; n.until = t + 3000 + Math.random() * 2000; n.doing = tr('Aspetta il caffè'); }
  else if (n.act === 'play') { n.phase = 'stand'; s.cab.player = n; n.until = t + 9000 + Math.random() * 9000; n.doing = tr('Gioca a {game}', { game: s.cab.name }); }
  else { n.phase = 'stand'; n.until = t + 1500 + Math.random() * 2500; n.doing = tr('Si guarda intorno'); }
}

function updateRelax(dt, t) {
  const b = relax.npcs.find(n => n.banana);
  for (const n of relax.npcs) {
    if (n.path.length) {
      const p = n.path[0], dx = p.x - n.x, dy = p.y - n.y, d = Math.hypot(dx, dy), step = SPEED * 0.8 * dt;
      n.moving = true;
      if (d > 0.01) { if (Math.abs(dx) > Math.abs(dy)) n.dir = dx > 0 ? 'right' : 'left'; else n.dir = dy > 0 ? 'down' : 'up'; }
      if (d <= step) { n.x = p.x; n.y = p.y; n.path.shift(); if (!n.path.length) { n.moving = false; relaxArrive(n, t); } }
      else { n.x += dx / d * step; n.y += dy / d * step; }
    } else if (!n.banana && t > n.until) {
      if (n.act === 'brew') n.cup = true; else if (n.act === 'sit') n.cup = false; // caffè pronto / caffè finito
      relaxGo(n);
    }
    // chi passa vicino a quello della banana non resiste al commento (una volta ogni tanto)
    if (b && n !== b && n.moving && t > n.quipAt && Math.hypot(n.x - b.x, n.y - b.y) < 24) { n.quipAt = t + 25000; n.speech = BANANA_LINE; n.speechUntil = t + 3200; n.last = ''; }
    if (n.speech && t > n.speechUntil) { n.speech = ''; n.last = ''; }
  }
}

function drawIcon(rows, x, y, col) { rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '1') R(x + i, y + j, 1, 1, col); }); }
// schermo del cabinato in modalità attract: va più veloce se qualcuno sta giocando
function drawArcadeScreen(c, x, y, t) {
  const k = (t / (c.player ? 90 : 160)) | 0;
  const P = (px, py, w, h, col) => { const a = Math.max(px, x), b = Math.min(px + w, x + 12); if (b > a) R(a, py, b - a, h, col); };
  if (c.id === 'pacman') {
    R(x, y + 1, 12, 1, C.blue); R(x, y + 8, 12, 1, C.blue);
    const px = x + (k % 20) - 4;
    for (let i = 1; i < 12; i += 2) if (x + i > px + 2) R(x + i, y + 4, 1, 1, C.white);
    P(px, y + 3, 3, 3, C.yellow); if (k % 2) P(px + 2, y + 4, 1, 1, c.scr);
    P(px - 5, y + 3, 3, 3, C.red); P(px - 5, y + 3, 1, 1, C.white);
  } else if (c.id === 'tetris') {
    const cols = [C.red, C.blue, C.yellow, C.green, C.lav];
    for (let i = 0; i < 12; i++) { if (i !== 7) R(x + i, y + 9, 1, 1, cols[i % 5]); if (i < 4 || i > 8) R(x + i, y + 8, 1, 1, cols[(i + 2) % 5]); }
    const py = k % 7, px = x + 3 + ((k / 7 | 0) % 3) * 2;
    R(px, y + py, 3, 1, C.orange); R(px + 1, y + py + 1, 1, 1, C.orange);
  } else if (c.id === 'frogger') {
    // strada con le macchine e la rana che attraversa
    R(x, y, 12, 2, C.dgreen); R(x, y + 8, 12, 2, C.dgreen);
    for (let i = 0; i < 12; i += 4) R(x + i, y + 5, 2, 1, C.lgrey);
    P(x + (k % 16) - 3, y + 3, 3, 2, C.red); P(x + 12 - ((k + 6) % 16), y + 6, 4, 2, C.yellow);
    R(x + 5, y + 8 - ((k / 4 | 0) % 4) * 2, 2, 2, C.green);
  } else {
    const o = (k % 4) - 1;
    for (let r = 0; r < 2; r++) for (let i = 0; i < 4; i++) P(x + 1 + i * 3 + o, y + 1 + r * 2, 2, 1, r ? C.green : C.pink);
    const cx = x + 4 + ((k / 8 | 0) % 4);
    R(cx, y + 9, 3, 1, C.green); R(cx + 1, y + 8 - (k % 7), 1, 1, C.white);
  }
}
function drawCabinet(c, t) {
  const x = c.x, y = c.top, play = !!c.player;
  ctx.globalAlpha = 0.12 + 0.06 * Math.sin(t / 300 + x); R(x - 3, y - 2, 24, 26, c.col); ctx.globalAlpha = 1; // bagliore sul muro
  R(x, y, 18, 38, c.body); R(x, y, 2, 38, shade(c.body, 0.7)); R(x + 16, y, 2, 38, shade(c.body, 0.7));
  // insegna luminosa, una per gioco
  R(x + 1, y + 1, 16, 7, C.black); R(x + 1, y + 7, 16, 1, c.col);
  if (c.id === 'pacman') { drawIcon(PAC_ICON, x + 3, y + 2, C.yellow); R(x + 10, y + 4, 1, 1, C.white); R(x + 13, y + 4, 1, 1, C.white); }
  else if (c.id === 'tetris') { R(x + 3, y + 2, 6, 2, C.red); R(x + 5, y + 4, 2, 2, C.red); R(x + 10, y + 4, 4, 2, C.blue); R(x + 12, y + 2, 4, 2, C.blue); }
  else if (c.id === 'frogger') drawIcon(FROG_ICON, x + 5, y + 2, C.green);
  else drawIcon(INV_ICON, x + 5, y + 2, C.green);
  R(x + 2, y + 9, 14, 12, '#111'); R(x + 3, y + 10, 12, 10, c.scr);
  drawArcadeScreen(c, x + 3, y + 10, t);
  // comandi: il joystick si muove solo se c'è qualcuno
  R(x - 1, y + 21, 20, 4, shade(c.body, 1.5)); R(x - 1, y + 25, 20, 1, C.black);
  const j = play ? (((t / 180) | 0) % 3) - 1 : 0;
  R(x + 5, y + 20, 1, 2, C.black); R(x + 4 + j, y + 18, 3, 2, C.red);
  R(x + 10, y + 22, 2, 1, play && ((t / 150) | 0) % 2 ? C.white : C.yellow); R(x + 13, y + 22, 2, 1, C.blue);
  // gettoniera
  R(x + 6, y + 28, 6, 7, '#111'); R(x + 8, y + 30, 2, 2, ((t / 600) | 0) % 2 ? C.orange : '#7a4a00');
  R(x, y + 37, 18, 1, C.black);
}
function drawKitchen(t) {
  const x = relax.kx, at = relax.spots.find(s => s.kind === 'coffee').by;
  const brewing = at && at.act === 'brew' && !at.moving;
  // pensili e piastrelle
  R(x, 14, 76, 13, '#c2a36b');
  for (let i = 0; i < 4; i++) { R(x + 1 + i * 19, 15, 17, 11, '#d9b87a'); R(x + 9 + i * 19, 22, 2, 1, '#5a3a10'); }
  for (let yy = 28; yy < WALL_H - 4; yy += 4) for (let xx = 0; xx < 76; xx += 4) R(x + xx, yy, 4, 4, ((xx + yy) / 4) % 2 ? '#e8e0d0' : '#9fd3c7');
  // bancone
  R(x, WALL_H - 4, 78, 4, '#d9d9d9'); R(x, WALL_H, 78, 14, '#8a4a2a');
  for (let i = 1; i < 4; i++) R(x + i * 19, WALL_H + 2, 1, 10, '#6a3a20');
  R(x, WALL_H + 13, 78, 1, C.black);
  // macchina del caffè: lucina verde e tazzina sotto quando c'è qualcuno che aspetta
  const m = x + 8;
  R(m - 1, WALL_H - 24, 18, 3, C.dgrey); R(m, WALL_H - 21, 16, 17, '#5F574F');
  R(m + 2, WALL_H - 19, 12, 3, brewing && ((t / 250) | 0) % 2 ? C.green : '#1a3a1a');
  R(m + 6, WALL_H - 14, 4, 2, '#111');
  if (brewing) { R(m + 6, WALL_H - 9, 4, 5, C.white); R(m + 7, WALL_H - 12 + ((t / 120) | 0) % 3, 1, 1, '#6b3a1a'); }
  if (brewing || ((t / 2000) | 0) % 4 === 0) R(m + 13, WALL_H - 28 - ((t / 200) | 0) % 3, 1, 2, '#ffffff88');
  [C.red, C.blue, C.yellow].forEach((c, i) => R(x + 30 + i * 4, WALL_H - 7, 3, 3, c));
  // microonde e frigorifero
  R(x + 46, WALL_H - 14, 18, 10, C.lgrey); R(x + 48, WALL_H - 12, 10, 6, '#222'); R(x + 60, WALL_H - 12, 2, 1, C.red);
  R(x + 80, WALL_H - 34, 16, 48, C.white); R(x + 80, WALL_H - 14, 16, 1, C.lgrey);
  R(x + 93, WALL_H - 30, 1, 10, C.dgrey); R(x + 93, WALL_H - 10, 1, 8, C.dgrey); R(x + 82, WALL_H - 32, 3, 3, C.pink);
  R(x + 80, WALL_H + 13, 16, 1, C.black);
}
function drawSofaBack(s) { R(s.x, WALL_H - 10, 34, 14, shade(s.col, 0.75)); R(s.x, WALL_H - 10, 34, 2, s.col); }
function drawSofaFront(s) {
  const d = shade(s.col, 0.6);
  R(s.x + 3, WALL_H + 4, 28, 6, s.col); R(s.x + 17, WALL_H + 4, 1, 6, d);
  R(s.x, WALL_H + 10, 34, 4, d); R(s.x, WALL_H - 2, 4, 16, shade(s.col, 0.85)); R(s.x + 30, WALL_H - 2, 4, 16, shade(s.col, 0.85));
  R(s.x + 2, WALL_H + 14, 2, 1, C.black); R(s.x + 30, WALL_H + 14, 2, 1, C.black);
}
function drawChairs(tb) { for (const dx of [-7, 7]) { R(tb.x + dx - 4, tb.y - 17, 8, 9, '#c46a40'); R(tb.x + dx - 4, tb.y - 17, 8, 1, '#e0a070'); R(tb.x + dx - 4, tb.y - 3, 1, 5, C.dgrey); R(tb.x + dx + 3, tb.y - 3, 1, 5, C.dgrey); } }
function drawTable(tb) {
  R(tb.x - 14, tb.y - 8, 28, 5, '#e0d6c4'); R(tb.x - 14, tb.y - 3, 28, 1, '#a89a80');
  R(tb.x - 1, tb.y - 2, 2, 6, C.dgrey); R(tb.x - 5, tb.y + 4, 10, 1, C.dgrey);
  R(tb.x - 1, tb.y - 10, 3, 2, C.white); // portatovaglioli
}
// la banana: si accorcia a morsi, resta la buccia, poi ne arriva un'altra
function drawBanana(n, t) {
  const x = Math.round(n.x), by = Math.round(n.y) - 6;
  const p = ((t - n.t0) % 10000) / 10000;
  const up = p < 0.7 && ((t / 700) | 0) % 3 === 0;
  const hx = x + 5, hy = up ? by - 12 : by - 8;
  if (p < 0.7) {
    const len = 6 - Math.floor(p / 0.7 * 5), curve = [0, 0, 1, 1, 1, 0];
    for (let i = 0; i < len; i++) { R(hx + curve[i], hy - 1 - i, 2, 1, C.yellow); R(hx + curve[i] + 1, hy - 1 - i, 1, 1, '#c9b800'); }
    if (len === 6) R(hx, hy - 7, 1, 1, '#5a3a10');
  } else if (p < 0.85) { R(hx - 1, hy - 3, 1, 3, C.yellow); R(hx + 2, hy - 3, 1, 3, C.yellow); R(hx, hy - 2, 2, 2, '#c9b800'); }
  R(hx, hy, 2, 2, n.look.skin);
}

function drawRelax(t) {
  const { kx, bx } = relax;
  // pavimento a scacchi da tavola calda, parete color mattone
  for (let y = WALL_H; y < H; y += 10) for (let x = 0; x < W; x += 10) R(x, y, 10, 10, (x + y - WALL_H) / 10 % 2 ? '#3e5a5e' : '#47676b');
  R(0, 0, W, WALL_H, '#7a3b2e');
  for (let x = 0; x < W; x += 8) R(x, 10, 1, WALL_H - 14, '#6c3328');
  R(0, 0, W, 2, '#e0a070'); R(0, WALL_H - 5, W, 5, '#5F574F'); R(0, WALL_H - 5, W, 1, '#83769C');
  let wi = 7;
  for (let x = kx + 106; x + 46 <= bx - 6; x += 92, wi++) drawWindow(x, 16, t, wi);
  const name = tr('CAFFETTERIA'), tw = name.length * 8, cx = Math.round(W / 2);
  R(cx - tw / 2 - 5, 1, tw + 10, 12, '#120c22');
  pixText(name, cx - tw / 2, 2, Math.sin(t / 800) > -0.96 ? C.orange : '#5a3a10', 7);
  drawDoor(relax.door, tr('ATRIO'), C.yellow, t);
  R(bx + 5, 28, 25, 9, C.black); pixText('RELAX', bx + 8, 30, Math.sin(t / 500) > -0.9 ? C.pink : '#5a2a44', 4);
  drawClock(bx + 150, 32);
  drawKitchen(t);
  for (const s of relax.sofas) drawSofaBack(s);
  for (const c of relax.cabs) drawCabinet(c, t);
  // davanti e dietro: divani, sedie, tavolini e persone in ordine di profondità
  const list = [];
  for (const s of relax.sofas) list.push({ y: WALL_H + 10.5, draw: () => drawSofaFront(s) });
  for (const tb of relax.tables) { list.push({ y: tb.y - 1, draw: () => drawChairs(tb) }); list.push({ y: tb.y + 0.5, draw: () => drawTable(tb) }); }
  for (const n of relax.npcs) list.push({ y: n.phase === 'seated' ? n.y : n.y + 0.1, draw: () => {
    drawChar(n, t);
    if (n.banana) drawBanana(n, t);
    else if (n.cup && n.phase === 'seated') { R(Math.round(n.x) + 5, Math.round(n.y) - 11, 3, 3, C.white); if (((t / 500) | 0) % 2) R(Math.round(n.x) + 6, Math.round(n.y) - 14, 1, 2, '#ffffff88'); }
  } });
  list.push({ y: H, draw: () => { drawDecor(4, H - 28); drawDecor(W - 18, H - 28); } });
  list.sort((a, b) => a.y - b.y);
  for (const d of list) d.draw();
}

// atrio e area relax: porte, cabinati e impiegati in pausa sotto il mouse
function sceneHit(wx, wy) {
  const inDoor = d => wx >= d.x - 2 && wx <= d.x + d.w + 2 && wy >= d.y - 12 && wy <= d.y + d.h;
  if (!viewSid) { const d = relaxDoor(); return inDoor(d) ? { door: d, tip: tr('Area relax'), col: C.green } : null; }
  if (viewSid !== 'relax' || !relax) return null;
  if (inDoor(relax.door)) return { door: relax.door, tip: tr('Torna all\'atrio'), col: C.yellow, back: true };
  for (const c of relax.cabs) if (wx >= c.x - 1 && wx <= c.x + 19 && wy >= c.top && wy <= c.top + 38) return { cab: c, tip: c.name, col: c.col };
  for (const n of relax.npcs) if (Math.abs(wx - n.x) < 8 && wy < n.y + 2 && wy > n.y - 26) return { npc: n };
  return null;
}
function showTip(h) {
  if (!h || !h.tip) { const el = labels.get('scenetip'); if (el) el.style.display = 'none'; return; }
  const el = label('scenetip', 'roomplate');
  el.style.display = ''; el.style.background = h.col; el.style.zIndex = '1000';
  setHtml(el, esc(h.tip));
  const r = h.door || { x: h.cab.x, y: h.cab.top + 12, w: 18 };
  placeLabel(el, Math.max(2, Math.min(W * scale - el.offsetWidth - 2, (r.x + r.w / 2) * scale - el.offsetWidth / 2)), Math.max(2, (r.y - 13) * scale - el.offsetHeight));
}
function playArcade(c) {
  showTip(null);
  if (window.openArcade) openArcade(c.id);
  else toast(tr('Il cabinato è fuori servizio.'), false);
}

// ================================================================ piano: organigramma
function computeGroups(s) {
  const byId = new Map(s.subs.map(a => [a.id, a]));
  const parentOf = a => (a.parentId && byId.has(a.parentId) && a.parentId !== a.id) ? a.parentId : null;
  const hasKids = new Set();
  for (const a of s.subs) { const p = parentOf(a); if (p) hasKids.add(p); }
  for (const id of hasKids) managersSeen.add(s.id + '|' + id);
  const topOf = a => { let cur = a, n = 0; while (parentOf(cur) && n++ < 20) cur = byId.get(parentOf(cur)); return cur; };
  const groups = new Map();
  const ensure = (key, init) => { if (!groups.has(key)) groups.set(key, { key, members: [], ...init }); return groups.get(key); };
  for (const a of s.subs) {
    if (!parentOf(a) && (hasKids.has(a.id) || managersSeen.has(s.id + '|' + a.id))) {
      ensure('mgr:' + a.id, { kind: 'mgr', manager: a, title: tr('REPARTO DI {name}', { name: agentName(a) }), type: null });
      groups.get('mgr:' + a.id).manager = a;
    }
  }
  for (const a of s.subs) {
    const top = topOf(a);
    if (groups.has('mgr:' + a.id) && top === a) continue; // è il capo reparto
    if (top !== a && groups.has('mgr:' + top.id)) { groups.get('mgr:' + top.id).members.push(a); continue; }
    if (a.workflow) { // gli agenti di un Workflow: una sala per esecuzione e fase
      const run = (s.workflows || []).find(r => r.id === a.workflow), wname = (run && run.name) || tr('workflow');
      // prima la fase (è quella che serve sul piano), poi il nome dell'esecuzione accorciato: il resto è nel pannello SQUADRE
      const wshort = wname.length > 24 ? wname.slice(0, 23) + '…' : wname;
      ensure('grp:wf:' + a.workflow + ':' + (a.phase || ''), { kind: 'grp', manager: null, title: a.phase ? tr('WF {phase} · {name}', { name: wshort, phase: a.phase }) : tr('WF {name}', { name: wshort }), type: null }).members.push(a);
      continue;
    }
    const k = a.team ? 'team:' + a.team : 'type:' + a.type;
    ensure('grp:' + k, { kind: 'grp', manager: null, title: a.team ? tr('SQUADRA {name}', { name: a.team.toUpperCase() }) : tr('SALA {type}', { type: String(a.type).toUpperCase() }), type: a.team ? null : a.type }).members.push(a);
  }
  const list = [...groups.values()];
  for (const g of list) {
    const fk = s.id + '|' + g.key;
    if (!roomFirstSeen.has(fk)) roomFirstSeen.set(fk, roomFirstSeen.size);
    g.order = (g.kind === 'mgr' ? 0 : 1e6) + roomFirstSeen.get(fk);
    g.color = g.kind === 'mgr' ? C.blue : g.type ? uniformFor(g.type).shirt : groupColor(g.key);
  }
  list.sort((a, b) => a.order - b.order);
  return list;
}

function priority(a) {
  return (a.status === 'waiting' ? 3e13 : 0) + (BUSY.includes(a.status) ? 1e13 : 0) + (a.lastActivity || 0);
}

// scrivanie stabili: chi è seduto resta seduto finché c'è; i posti liberi vanno ai più attivi
function assignSeats(sid, g) {
  const key = sid + '|' + g.key;
  const seats = roomSeats.get(key) || [];
  const members = g.members;
  const ids = new Set(members.map(a => a.id));
  const reserved = g.manager ? 1 : 0;
  const cap = Math.max(1, Math.min(MAX_SEATS, reserved + members.length));
  for (let i = 0; i < seats.length; i++) if (seats[i] && !ids.has(seats[i]) && !(g.manager && seats[i] === g.manager.id)) seats[i] = null;
  if (g.manager) {
    for (let i = 0; i < seats.length; i++) if (seats[i] === g.manager.id) seats[i] = null;
    seats[0] = g.manager.id;
  }
  // compatta oltre la capienza
  for (let i = cap; i < seats.length; i++) {
    if (!seats[i]) continue;
    const free = seats.findIndex((x, j) => j >= reserved && j < cap && !x);
    if (free >= 0) seats[free] = seats[i];
    seats[i] = null;
  }
  seats.length = cap;
  for (let i = 0; i < cap; i++) if (seats[i] === undefined) seats[i] = null;
  const seated = new Set(seats.filter(Boolean));
  const waiting = members.filter(a => !seated.has(a.id) && !a.finished).sort((a, b) => priority(b) - priority(a));
  for (const a of waiting) {
    const free = seats.findIndex((x, j) => j >= reserved && !x);
    if (free >= 0) { seats[free] = a.id; seated.add(a.id); continue; }
    // chi aspetta il tuo permesso deve essere visibile: prende il posto del meno attivo
    if (a.status === 'waiting') {
      let worst = -1, wp = Infinity;
      const byId = new Map(members.map(m => [m.id, m]));
      for (let j = reserved; j < cap; j++) {
        const m = byId.get(seats[j]);
        const pr = m ? priority(m) : -1;
        if (m && m.status !== 'waiting' && pr < wp) { wp = pr; worst = j; }
      }
      if (worst >= 0) { seated.delete(seats[worst]); seats[worst] = a.id; seated.add(a.id); }
    }
  }
  roomSeats.set(key, seats);
  return seats;
}

function layoutFloor(s) {
  scale = baseScale();
  const sw = stage.clientWidth || 800;
  W = Math.max(360, Math.floor(sw / scale));
  const groups = computeGroups(s);
  const officeY = WALL_H + 8, officeBottom = officeY + OFF_H;
  const office = { x: LM, y: officeY, w: OFF_W, h: OFF_H, bottom: officeBottom, doorX: LM + Math.round(OFF_W / 2) };
  const bossDesk = { x: LM + 16, top: officeY + 10, role: 'boss', key: 'boss', color: colorFor(s.id) };
  bossDesk.seatX = bossDesk.x + 12; bossDesk.seatY = bossDesk.top + 30;
  office.spot = { x: LM + OFF_W - 24, y: officeBottom - 10 };

  const rooms = [];
  const maxRight = W - 10;
  let x = LM, y = officeBottom + 26, lineH = 0, line = 0;
  const lineYs = [y];
  // sala creativa con le due lavagne: per prima, subito sotto l'ufficio del capo, così la lista e il piano
  // si vedono senza scorrere anche sui piani con tante sale
  const CW = 2 * BOARD_W + 3 * 14, CH = 18 + BOARD_H + 34;
  const creative = { x, y, w: CW, h: CH, line, doorX: x + 21, key: 'creative', color: C.yellow, g: { kind: 'creative', members: [], key: 'creative' } };
  creative.boards = ['A', 'B'].map((k, i) => {
    const bx = x + 14 + i * (BOARD_W + 14), by = y + 22;
    return { key: k, x: bx, y: by, w: BOARD_W, h: BOARD_H, spot: { x: bx + 18, y: by + BOARD_H + 18 } };
  });
  x += CW + 18; lineH = CH;
  for (const g of groups) {
    const seats = assignSeats(s.id, g);
    const cap = seats.length;
    const cols = Math.min(4, cap), rows = Math.ceil(cap / 4);
    const w = Math.max(160, 28 + (cols - 1) * PITCH + 40);
    const h = 18 + rows * ROW_H + 14;
    if (x > LM && x + w > maxRight) { y += lineH + 24; x = LM; lineH = 0; line++; lineYs.push(y); }
    const room = { g, seats, x, y, w, h, line, cols, rows, doorX: x + 21, key: g.key, color: g.color };
    room.desks = seats.map((id, i) => {
      const c = i % 4, r = Math.floor(i / 4);
      const dx = x + 14 + c * PITCH, top = y + 18 + r * ROW_H;
      return { x: dx, top, seatX: dx + 12, seatY: top + 30, row: r, role: g.manager && i === 0 ? 'manager' : 'worker', key: g.key + '#' + i, agentId: id, color: g.color, room };
    });
    rooms.push(room);
    x += w + 18;
    lineH = Math.max(lineH, h);
  }
  const contentH = y + lineH + 20;
  scale = baseScale();
  applySize(contentH);
  const prev = floor;
  floor = { s, office, bossDesk, rooms, lineYs, bus0: officeBottom + 14, creative };
  floor.corridorY = l => (floor.lineYs[l] || floor.bus0 + 12) - 12;
  floor.cables = rooms.map(r => cablePath(r));
  floor.sig = W + '|' + rooms.map(r => r.key + '@' + r.x + ',' + r.y + ',' + r.w + ',' + r.h).join(';') + '|' + creative.x + ',' + creative.y;
  // le sale si sono spostate (nuovo reparto, finestra ridimensionata...): nessuno deve restare
  // a camminare verso una stanza che non c'è più
  if (prev && prev.s && prev.s.id === s.id && prev.sig !== floor.sig) relayoutPeople();
  updateFloorLabels();
}

function relayoutPeople() {
  for (const [id, c] of chars) {
    if (c.fadeAway || c.fading) continue;
    const desk = deskFor(id);
    if (c.errand) {
      const g = geomOf(c.errand.key);
      if (!g) { c.errand = null; if (desk) { c.relocate = desk; c.fadeOut = true; } else c.fading = true; continue; }
      if (c.phase === 'errand') { c.x = g.spot.x; c.y = g.spot.y; c.path = []; }
      else c.teleport = { x: g.spot.x, y: g.spot.y, arrive: true }; // stava andando alla lavagna
      continue;
    }
    if (c.phase === 'leave') { c.fading = true; continue; }
    if (c.role === 'boss' && !c.relocate) { // l'ufficio del capo non si sposta mai
      if (c.purpose === 'desk' && c.phase !== 'walk') { c.x = floor.bossDesk.seatX; c.y = floor.bossDesk.seatY; }
      continue;
    }
    if (!desk) { c.fadeAway = true; continue; }
    if (c.phase === 'seated' || c.phase === 'linger') { c.x = desk.seatX; c.y = desk.seatY; c.path = []; c.deskKey = desk.key; }
    else { c.relocate = desk; c.fadeOut = true; c.deskKey = desk.key; } // stava camminando: ricompare alla sua scrivania
  }
  for (const n of npcs) {
    n.alpha = 0;
    const tgt = n.npc === 'cat' ? n.target : n.npc === 'pest' && n.state === 'chat' ? n.victim : n.npc === 'hr' && n.state !== 'exit' ? n.victim : null;
    const d = tgt && deskFor(tgt);
    let place;
    if (d) place = besidePlace(d);
    else if (n.npc === 'cat') { place = poufPlace(); n.target = null; }
    else { place = { kind: 'elevator' }; if (n.npc === 'pest' && n.state !== 'exit') n.state = 'seek'; if (n.npc === 'janitor' && n.state === 'clean') n.lines = (n.lines || 0); if (n.npc === 'hr') { n.state = 'exit'; n.speech = ''; n.last = ''; const v = chars.get(n.victim); if (v) v.scoldedUntil = 0; } }
    const end = place.kind === 'spot' ? place.inner[place.inner.length - 1] : { x: ELEV.x, y: ELEV.y };
    n.x = end.x; n.y = end.y - (n.npc === 'cat' && !d ? 6 : 0); n.path = []; n.place = place;
    if (n.npc === 'cat') n.phase = d ? 'keys' : 'nap';
  }
}

function cablePath(r) {
  const o = floor.office;
  const pts = [{ x: o.doorX, y: o.bottom }];
  const cy = floor.corridorY(r.line);
  if (r.line === 0) pts.push({ x: o.doorX, y: cy }, { x: r.doorX, y: cy });
  else pts.push({ x: o.doorX, y: floor.bus0 }, { x: ELEV.x + 6, y: floor.bus0 }, { x: ELEV.x + 6, y: cy }, { x: r.doorX, y: cy });
  pts.push({ x: r.doorX, y: r.y + 2 });
  return { room: r, pts, len: polyLen(pts) };
}
function polyLen(pts) { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y); return l; }
function pointAt(pts, d) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (d <= l) { const k = l ? d / l : 0; return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }; }
    d -= l;
  }
  return pts[pts.length - 1];
}

// ---- etichette HTML del piano
function label(key, cls) {
  let el = labels.get(key);
  if (!el) { el = document.createElement('div'); el.className = 'plate ' + cls; overlay.appendChild(el); labels.set(key, el); }
  el._used = true;
  return el;
}
// Leggere offsetWidth/offsetHeight forza un layout sincrono. Facendolo dentro placeLabel()
// si alternavano scrittura e lettura per ogni etichetta, e il browser rifaceva il layout a
// ogni giro — anche 60 volte al secondo, perché updateBoardLabels() gira a ogni frame.
// Qui si scrive soltanto, e le misure si prendono tutte insieme in measurePlaced().
let rectQueue = [];
function placeLabel(el, x, y, maxW) {
  if (maxW) el.style.maxWidth = Math.round(maxW) + 'px';
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el._rect = { x, y, w: 0, h: 0 };
  rectQueue.push(el);
}
function measurePlaced() {
  for (const el of rectQueue) { const r = el._rect; if (r) { r.w = el.offsetWidth; r.h = el.offsetHeight; } }
  rectQueue.length = 0;
}
function setHtml(el, html) { if (el._h !== html) { el.innerHTML = html; el._h = html; } }

function updateFloorLabels() {
  for (const el of labels.values()) el._used = false;
  const s = floor.s;
  const c = sessionCounts(s);
  const kind = s.kind || 'unknown';
  // targa del piano sulla parete
  const fp = label('floorplate', 'floorplate');
  setHtml(fp, `${s._replay ? tr('SEMINTERRATO · REPLAY') : tr('PIANO {n}', { n: floorLabel(s) })} · ${esc(s._replay && replayFrame ? replayFrame.title || projName(s) : projName(s))}${s.demo ? ' [DEMO]' : ''}<span class="kindtag" style="background:${KIND_COLOR[kind]};color:#000">${KIND_LABEL[kind]}</span>`);
  placeLabel(fp, (LM + 2) * scale, 4 * scale, (W - LM - 70) * scale);
  // bacheca accanto all'ufficio del capo
  const bx = LM + OFF_W + 16, avail = W - bx - 10;
  const b = label('bacheca', 'bacheca');
  if (avail > 120) {
    b.style.display = '';
    setHtml(b, `<h4>${tr('BACHECA')}${s.wing === 'cowork' ? ' · COWORK' : ''}</h4><div class="t">${esc(s.wing === 'cowork' ? tr('Sessione Cowork') : (s.title || tr('Sessione senza titolo')))}</div>` +
      `<div class="nums"><span>${p2(c.agents)}<em>${c.agents === 1 ? tr('agente') : tr('agenti')}</em></span><span>${p2(c.busy)}<em>${tr('al lavoro')}</em></span>` +
      `<span class="${c.wait ? 'w' : ''}">${p2(c.wait)}<em>${tr('in attesa')}</em></span><span>${p2(c.done)}<em>${tr('fatti')}</em></span></div>` +
      `<div class="chart">${historySvg(s.history, Math.round(Math.min(320, avail) * scale - 22), Math.round(Math.max(30, 14 * scale)), { axis: true })}` +
      `<div class="axis"><span>${tr('60 min fa')}</span><span>${tr('picco {peak} · finiti {done}', { peak: historyPeak(s.history), done: historyDone(s.history) })}</span><span>${tr('ora')}</span></div></div>` +
      `<div class="cost ${costClass(s.cost)}"><span>${tr('COSTO')}</span> <b>${money(s.cost)}</b>${s.costEstimated ? ' <i>' + tr('stima') + '</i>' : ''}` +
      (budget() ? `<span class="bar"><i style="width:${Math.min(100, Math.round((s.cost || 0) / budget() * 100))}%"></i></span><em>${tr('budget {money}', { money: money(budget()) })}</em>` : '') +
      `<em>${tr('{n} token', { n: tokText((s.tokens || {}).total) })}</em></div>` +
      (alertsOf(s).length ? `<ul class="alerts">${alertsOf(s).slice(0, 4).map(a => `<li class="lv-${a.level}">${esc(a.text)}</li>`).join('')}</ul>` : '') +
      `<div class="t">${esc(s.cwd || '')}</div>` +
      (!s._replay ? '<div class="btns">' + (!s.demo ? '<button data-do="focus" title="' + esc(tr('Porta in primo piano il terminale o la finestra di questa sessione')) + '">' + tr('FINESTRA') + '</button><button data-do="folder">' + tr('CARTELLA') + '</button>' : '') + '<button data-do="book" title="' + esc(tr('Le lezioni di questo progetto, dedotte dalle sessioni')) + '">' + tr('LIBRO') + '</button>' + teamsButton(s) + '</div>' : '<div class="btns">' + teamsButton(s) + '</div>'));
    for (const btn of b.querySelectorAll('button[data-do]')) btn.onclick = () => sessionAction(btn.dataset.do, s.id);
    b.style.pointerEvents = 'auto';
    placeLabel(b, bx * scale, (WALL_H + 10) * scale, Math.min(320, avail) * scale);
    b.style.width = Math.min(320, avail) * scale + 'px';
  } else b.style.display = 'none';
  // targhette e contatori delle sale
  for (const r of floor.rooms) {
    const g = r.g;
    const active = g.members.filter(a => !a.finished);
    const plate = label('plate:' + g.key, 'roomplate');
    plate.style.background = r.color;
    const nAg = active.length + (g.manager && !g.manager.finished ? 1 : 0);
    setHtml(plate, esc(g.title) + `<small>${trn('{n} agente', '{n} agenti', nAg)}</small>`);
    placeLabel(plate, (r.x + 34) * scale, (r.y + 1) * scale, (r.w - 40) * scale);
    const seatedN = r.seats.filter(id => id && id !== (g.manager && g.manager.id)).length;
    const others = Math.max(0, active.length - seatedN);
    const done = g.type ? (s.completedByType || {})[g.type] || 0 : 0;
    const total = active.length + done;
    const foot = label('foot:' + g.key, 'roomfoot');
    foot.dataset.room = g.key;
    foot.onclick = () => showRoomList(g.key);
    const rc = g.type ? (s.costByType || {})[g.type] : g.members.concat(g.manager ? [g.manager] : []).reduce((t, a) => t + (a.cost || 0), 0);
    setHtml(foot, (others ? tr('<b>+{n}</b> fuori vista', { n: others }) : tr('{n} al lavoro', { n: active.length })) +
      (done ? ' · ' + tr('{n} fatti', { n: done }) : '') + (rc ? ` · ≈${money(rc)}` : '') + (total > 1 && done ? `<span class="bar"><i style="width:${Math.round(done / total * 100)}%"></i></span>` : '') + ' ›');
    placeLabel(foot, (r.x + 4) * scale, (r.y + r.h - 13) * scale, (r.w - 8) * scale);
  }
  // bacheca dei rilasci appesa alla parete
  const rels = (s.releases || []).slice(-3).reverse();
  const rb = label('releases', 'relboard');
  const rw = Math.min(230, W - LM - 300);
  if (rw > 120) {
    rb.style.display = '';
    setHtml(rb, `<h4>${tr('RILASCI')}</h4>` + (rels.length ? rels.map(r => `<span class="r k-${esc(r.kind)}"><i></i>${esc(r.text)}</span>`).join('') : '<span class="none">' + tr('Ancora nessun commit o PR oggi') + '</span>'));
    rb.onclick = () => showReleases(s);
    placeLabel(rb, (W - rw - 40) * scale, 3 * scale, rw * scale);
    rb.style.width = rw * scale + 'px';
  } else rb.style.display = 'none';
  if (floor.creative) {
    const cp = label('plate:creative', 'roomplate');
    cp.style.background = C.yellow;
    setHtml(cp, tr('SALA CREATIVA') + '<small>' + tr('lavagne') + '</small>');
    placeLabel(cp, (floor.creative.x + 34) * scale, (floor.creative.y + 1) * scale, (floor.creative.w - 40) * scale);
    for (const g of floor.creative.boards) label('wb:' + g.key, 'wbtext');
  }
  for (const [k, el] of labels) if (!el._used) { el.remove(); labels.delete(k); }
}

// ================================================================ personaggi
// Divise: tutti gli agenti dello stesso tipo hanno lo stesso colore, accessorio e motivo,
// così una squadra si riconosce a colpo d'occhio; viso e capelli restano personali.
const UNIFORM_COLORS = ['#00E436', '#29ADFF', '#FFA300', '#FF77A8', '#83769C', '#FFEC27', '#FF004D', '#00B5A5', '#C2C3C7', '#B13EDB', '#6ABE30', '#4DD2FF'];
const EXTRA_ACC = ['cap', 'beret', 'bowtie', 'visor', 'badge', 'scarf', 'headset', 'none'];
const uniformCache = new Map();
function shade(hex, k) {
  const n = parseInt(hex.slice(1, 7), 16);
  const f = v => Math.max(0, Math.min(255, Math.round(v * k)));
  return '#' + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function uniformFor(type) {
  const key = type || '';
  if (uniformCache.has(key)) return uniformCache.get(key);
  const t = key.toLowerCase();
  const h = hash('u:' + t);
  const shirt = TYPE_SHIRTS[key] || UNIFORM_COLORS[h % UNIFORM_COLORS.length];
  let acc;
  if (t.includes('explore')) acc = 'safari';
  else if (t.includes('plan') || t.includes('architect')) acc = 'glasses';
  else if (t.includes('review') || t.includes('audit') || t.includes('security')) acc = 'glasses';
  else if (t.includes('check') || t.includes('verif') || t.includes('valid')) acc = 'visor';
  else if (t.includes('test') || t.includes('qa')) acc = 'hardhat';
  else if (t.includes('general')) acc = 'headset';
  else if (t.includes('writ') || t.includes('doc')) acc = 'beret';
  else acc = EXTRA_ACC[(h >>> 5) % EXTRA_ACC.length];
  let accColor = UNIFORM_COLORS[(h >>> 17) % UNIFORM_COLORS.length];
  if (accColor === shirt) accColor = UNIFORM_COLORS[((h >>> 17) + 3) % UNIFORM_COLORS.length];
  const u = {
    shirt, acc, accColor,
    pattern: ['plain', 'stripes', 'vest', 'plain'][(h >>> 9) % 4],
    pants: [C.navy, C.dgrey, '#3a2a1a', '#2b2b3a'][(h >>> 13) % 4],
  };
  uniformCache.set(key, u);
  return u;
}
function makeLook(key, a, sid) {
  const h = hash(key);
  const personal = { skin: SKINS[h % SKINS.length], hair: HAIRS[(h >>> 3) % HAIRS.length], style: (h >>> 7) % 4 };
  if (a.kind === 'main') return { ...personal, shirt: colorFor(sid), pants: C.navy, acc: 'tie', pattern: 'plain', accColor: C.plum };
  return { ...personal, ...uniformFor(a.type) };
}

// percorso dall'ascensore alla scrivania (e al contrario per uscire)
function entryPath(desk) {
  if (desk.role === 'boss') {
    const o = floor.office;
    return [{ x: ELEV.x, y: ELEV.y }, { x: ELEV.x, y: floor.bus0 }, { x: o.doorX, y: floor.bus0 }, { x: o.doorX, y: o.bottom - 8 },
      { x: LM + 6, y: o.bottom - 8 }, { x: LM + 6, y: desk.seatY }, { x: desk.seatX, y: desk.seatY }];
  }
  const r = desk.room;
  const cy = floor.corridorY(r.line);
  const wy0 = r.y + 14;
  const pts = [{ x: ELEV.x, y: ELEV.y }, { x: ELEV.x, y: cy }, { x: r.doorX, y: cy }, { x: r.doorX, y: wy0 }];
  if (desk.row > 0) { const wy = desk.top - 4; pts.push({ x: r.x + 7, y: wy0 }, { x: r.x + 7, y: wy }, { x: desk.seatX, y: wy }); }
  else pts.push({ x: desk.seatX, y: wy0 });
  pts.push({ x: desk.seatX, y: desk.seatY });
  return pts;
}
function officeToSpot(desk) {
  const o = floor.office;
  return [{ x: LM + 6, y: desk.seatY }, { x: LM + 6, y: o.bottom - 8 }, { x: o.spot.x, y: o.bottom - 8 }, { x: o.spot.x, y: o.spot.y }];
}

function deskFor(id) {
  if (!floor) return null;
  if (id === 'main') return floor.bossDesk;
  for (const r of floor.rooms) for (const d of r.desks) if (d.agentId === id) return d;
  return null;
}

function syncChars(s) {
  const t = performance.now();
  const byId = new Map([[s.main.id, s.main], ...s.subs.map(a => [a.id, a])]);
  const wanted = new Map();
  wanted.set('main', floor.bossDesk);
  for (const r of floor.rooms) for (const d of r.desks) if (d.agentId) wanted.set(d.agentId, d);

  for (const [id, desk] of wanted) {
    const a = byId.get(id);
    if (!a) continue;
    let c = chars.get(id);
    const leavingNow = a.finished || s.ended || a.status === 'leaving' || a.status === 'done';
    if (!c) {
      if (leavingNow) continue;
      c = {
        key: s.id + ':' + id, id, sid: s.id, kind: a.kind, look: makeLook(s.id + ':' + id, a, s.id),
        x: desk.seatX, y: desk.seatY, path: [], phase: 'seated', purpose: 'desk', deskKey: desk.key,
        alpha: 1, dir: 'down', moving: false, idleSince: 0, prevStatus: null, leaveAt: 0, el: null, last: '', bornAt: t,
      };
      if (!instantPlace) {
        const fresh = Date.now() - (a.startedAt || 0) < 20000;
        if (fresh) { // nuovo assunto: arriva dall'ascensore
          const p = entryPath(desk);
          c.x = p[0].x; c.y = p[0].y; c.path = p.slice(1); c.phase = 'walk'; c.alpha = 0;
          openElevator();
        } else { c.alpha = 0; } // già al lavoro: compare alla scrivania liberata
      }
      chars.set(id, c);
    }
    if (a.kind === 'sub' && c.data && c.data.type !== a.type) c.look = makeLook(c.key, a, s.id);
    c.data = a;
    c.age = ageTier(a.model); c.hero = heroTier(a.effort);
    c.role = desk.role;
    c.alert = agentAlert(s, id) || null;
    if (c.deskKey !== desk.key && c.phase !== 'leave' && c.phase !== 'linger' && !c.errand) {
      // cambio di scrivania (riorganizzazione): breve dissolvenza
      c.deskKey = desk.key; c.relocate = desk; c.fadeOut = true;
    }
    if (a.status !== c.prevStatus) { c.idleSince = instantPlace ? (a.lastActivity || Date.now()) : Date.now(); c.prevStatus = a.status; c.doodled = false; }
    if (leavingNow && c.phase !== 'leave' && c.phase !== 'linger' && !c.errand) { c.phase = 'linger'; c.leaveAt = t + (a.status === 'done' ? 1500 : 400); }
  }
  for (const [id, c] of chars) {
    if (wanted.has(id) || c.phase === 'leave' || c.phase === 'linger' || c.errand) continue;
    const a = byId.get(id);
    if (!a || a.finished) { c.phase = 'linger'; c.leaveAt = t + 300; }
    else { c.fadeAway = true; } // spostato fuori vista (troppi agenti nella sala)
  }
  instantPlace = false;
}

function update(dt, t) {
  if (!floor) return;
  scheduleBoards(t);
  for (const [id, c] of chars) {
    const a = c.data || {};
    if (c.fadeAway) { c.alpha -= dt * 3; if (c.alpha <= 0) { if (c.el) c.el.remove(); chars.delete(id); } continue; }
    if (c.teleport) { // riposizionamento dopo che le sale si sono spostate
      c.alpha -= dt * 5;
      if (c.alpha <= 0) { const tp = c.teleport; c.teleport = null; c.x = tp.x; c.y = tp.y; c.path = []; c.moving = false; if (tp.arrive && c.errand) arriveErrand(c, t); }
      continue;
    }
    if (c.fadeOut) {
      c.alpha -= dt * 5;
      if (c.alpha <= 0) { const d = c.relocate; c.x = d.seatX; c.y = d.seatY; c.path = []; c.phase = 'seated'; c.purpose = 'desk'; c.fadeOut = false; }
      continue;
    }
    if (c.alpha < 1 && c.phase !== 'leave') c.alpha = Math.min(1, c.alpha + dt * 3);
    if (c.phase === 'linger' && t >= c.leaveAt && !c.errand && c.kind === 'sub' && wantDoodle(c)) {
      startErrand(c, 'doodle', boards.B, 'leave', t);
      continue;
    }
    if (c.phase === 'linger' && t >= c.leaveAt && !c.errand) {
      c.phase = 'leave';
      const d = deskFor(id) || { seatX: c.x, seatY: c.y, role: 'worker', room: null };
      c.path = d.room || d.role === 'boss' ? entryPath(d).reverse().slice(1) : [];
      if (c.purpose === 'break') c.path = [];
      if (!c.path.length) c.fading = true;
    }
    if (c.path.length) {
      const p = c.path[0];
      const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy), step = SPEED * dt * (c.age >= 3 ? 0.7 : 1);
      c.moving = true;
      if (Math.abs(dx) > Math.abs(dy)) c.dir = dx > 0 ? 'right' : 'left'; else c.dir = dy > 0 ? 'down' : 'up';
      if (d <= step) { c.x = p.x; c.y = p.y; c.path.shift(); } else { c.x += dx / d * step; c.y += dy / d * step; }
      if (!c.path.length) {
        c.moving = false; c.dir = 'down';
        if (c.purpose === 'errand') arriveErrand(c, t);
        else if (c.phase === 'leave') c.fading = true;
        else if (c.purpose === 'break') c.phase = 'break';
        else c.phase = 'seated';
      }
    } else c.moving = false;
    if (c.phase === 'leave' && c.path.length && Math.abs(c.x - ELEV.x) < 4 && c.y - ELEV.y < 40) openElevator(900);
    if (c.fading) { c.alpha -= dt * 2.5; if (c.alpha <= 0) { if (c.el) c.el.remove(); chars.delete(id); } continue; }
    if (c.phase === 'errand') { tickErrand(c, t); continue; }
    if (c.phase === 'leave' || c.phase === 'linger' || c.purpose === 'errand') continue;
    // il capo, quando ha finito e aspetta te, si alza e va alla finestra con il caffè
    if (c.role === 'boss') {
      const desk = floor.bossDesk;
      if (a.status === 'idle' && c.phase === 'seated' && !c.doodled && Date.now() - c.idleSince > IDLE_TO_BREAK_MS * 0.7 && boardFree(boards.B)) {
        c.doodled = true;
        if (Math.random() < 0.5) startErrand(c, 'doodle', boards.B, 'desk', t);
      } else if (a.status === 'idle' && c.phase === 'seated' && Date.now() - c.idleSince > IDLE_TO_BREAK_MS) {
        c.purpose = 'break'; c.phase = 'walk'; c.path = officeToSpot(desk); c.x = desk.seatX; c.y = desk.seatY;
      } else if ((c.phase === 'break' || (c.phase === 'walk' && c.purpose === 'break')) && a.status !== 'idle') {
        c.purpose = 'desk'; c.phase = 'walk';
        c.path = officeToSpot(desk).reverse().concat([{ x: desk.seatX, y: desk.seatY }]);
      }
    }
  }
}

// ================================================================ sala creativa: le lavagne
// A = lavagna del capo (la sua lista di cose da fare); B = lavagna libera (piani e disegnini).
// Chi sbaglia lo stesso strumento 3 volte di fila, o il capo quando lo interrompi, la butta per terra.
const BOARD_W = 82, BOARD_H = 50;
const ERRAND_TEXT = { write: tr('Aggiorna la lista sulla lavagna'), plan: tr('Disegna il piano alla lavagna'), doodle: tr('Lascia un disegnino'), rage: tr('#@!%&!! Basta!'), lift: tr('Rimette in piedi la lavagna') };
const MARKERS = [C.blue, C.red, C.dgreen, C.black, C.orange, C.plum];
function newBoards() {
  const b = () => ({ content: null, progress: 1, drawer: null, down: false, downAt: 0, downBy: null, fallT: 0, liftT: 0, todosAt: 0, planAt: 0 });
  return { A: b(), B: b() };
}
let boards = newBoards();
function boardOf(key) { return boards[key]; }
function geomOf(key) { return floor && floor.creative ? floor.creative.boards.find(b => b.key === key) : null; }
function boardFree(b) { return b && !b.drawer && !b.down; }

const ARTS = {
  cat: ['..k.........k...', '.kpk.......kpk..', '.kppk.....kppk..', '.kpppkkkkkpppk..', '.k...........k..', 'k...kk...kk...k.', 'k...kk...kk...k.', 'k.......p......k', 'k..k...ppp...k.k', '.k..kkkkkkkkk.k.', '..k..........k..', '...kkkkkkkkkk...'],
  rocket: ['.......r........', '......rrr.......', '.....rbbbr......', '.....rbkbr......', '.....rbbbr......', '.....rbbbr......', '....rrbbbrr.....', '...rr.bbb.rr....', '...r..b.b..r....', '......o.o.......', '.....oyoyo......', '......o.o.......'],
  heart: ['..rr...rr...', '.rrrr.rrrr..', 'rrrrrrrrrrr.', 'rrrrrrrrrrr.', '.rrrrrrrrr..', '..rrrrrrr...', '...rrrrr....', '....rrr.....', '.....r......'],
  smile: ['...kkkkk....', '..k.....k...', '.k.......k..', 'k..k...k..k.', 'k.........k.', 'k.k.....k.k.', 'k..k...k..k.', '.k..kkk..k..', '..k.....k...', '...kkkkk....'],
  bug: ['..k.....k...', '...k...k....', '....ggg.....', '.k.ggkgg.k..', '..ggggggg...', 'k.ggkgkgg.k.', '..ggggggg...', '.k.ggkgg.k..', '....ggg.....', '..k.....k...'],
  coffee: ['...k..k..k......', '..k..k..k.......', '................', '.kkkkkkkkkkk....', '.k.........kkk..', '.k.oooooooo.k.k.', '.k.oooooooo.k.k.', '.k.oooooooo.kkk.', '.k.........k....', '..kkkkkkkkk.....', 'kkkkkkkkkkkkk...'],
  chart: ['k...............', 'k...........g...', 'k..........gg...', 'k.........g.g...', 'k....g...g......', 'k...g.g.g.......', 'k..g...g........', 'k.g.............', 'kg..............', 'kkkkkkkkkkkkkkkk'],
};
const WORDS = ['SHIP IT!', 'LGTM', 'TODO', '42', 'BUG?', tr('CAFFE!'), 'GG', 'OK!'];
const ART_COL = { k: C.black, b: C.blue, r: C.red, g: C.dgreen, y: C.yellow, o: C.orange, p: C.pink };

function wantDoodle(c) {
  return boards && boardFree(boards.B) && geomOf('B') && !c._noDoodle && Math.random() < 0.55;
}

// percorsi tra scrivanie, lavagne e ascensore passando dai corridoi
function placeEntry(place) {
  if (place.kind === 'elevator') return { corr: { x: ELEV.x, y: ELEV.y }, inner: [] };
  if (place.kind === 'board') {
    const cr = floor.creative, g = geomOf(place.key);
    return { corr: { x: cr.doorX, y: floor.corridorY(cr.line) }, inner: [{ x: cr.doorX, y: cr.y + 12 }, { x: g.spot.x, y: cr.y + 12 }, { x: g.spot.x, y: g.spot.y }] };
  }
  const pts = entryPath(place.desk);
  return { corr: pts[2], inner: pts.slice(3) };
}
function routeBetween(a, b) {
  const A = placeEntry(a), B = placeEntry(b);
  const out = A.inner.slice().reverse().slice(1);
  out.push(A.corr);
  if (Math.abs(A.corr.y - B.corr.y) > 0.5) out.push({ x: ELEV.x, y: A.corr.y }, { x: ELEV.x, y: B.corr.y });
  out.push(B.corr, ...B.inner);
  return out.filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.y !== arr[i - 1].y);
}

function startErrand(c, type, board, after, t, content) {
  const key = board === boards.A ? 'A' : 'B';
  const g = geomOf(key);
  const desk = deskFor(c.id);
  if (!g || !desk) return false;
  board.drawer = c.id;
  c.errand = { type, key, after, content, color: MARKERS[hash(c.id + type + t) % MARKERS.length] };
  c.purpose = 'errand';
  c.phase = 'walk';
  c.path = routeBetween({ kind: 'desk', desk }, { kind: 'board', key });
  c.x = desk.seatX; c.y = desk.seatY;
  c.last = '';
  return true;
}
function arriveErrand(c, t) {
  const e = c.errand, b = boardOf(e.key);
  c.phase = 'errand';
  e.start = t;
  e.dur = { write: 5200, plan: 6000, doodle: 4200, rage: 2600, lift: 1600 }[e.type];
  if (e.type === 'write' || e.type === 'plan' || e.type === 'doodle') { b.content = e.content || randomDoodle(c); b.progress = 0; }
  if (e.type === 'lift') b.liftT = t;
}
function tickErrand(c, t) {
  const e = c.errand, b = boardOf(e.key);
  const k = Math.min(1, (t - e.start) / e.dur);
  c.dir = e.type === 'rage' ? 'down' : 'up';
  if (e.type === 'write' || e.type === 'plan' || e.type === 'doodle') b.progress = Math.min(1, k * 1.15);
  if (e.type === 'rage' && !b.down && t - e.start > 700) {
    b.down = true; b.downAt = t; b.fallT = t; b.downBy = c.id; b.content = b.content; // la lavagna cade, il contenuto resta
    beep([330, 247, 196, 131, 98], 0.07, 'square', 0.07);
  }
  if (e.type === 'lift' && k >= 1) { b.down = false; b.downBy = null; b.liftT = 0; }
  if (k < 1) return;
  // fine del giro: torna alla scrivania o va via
  b.drawer = null;
  const desk = deskFor(c.id);
  const from = { kind: 'board', key: e.key };
  c.errand = null;
  c.last = '';
  if (e.type === 'rage') c.scoldPending = true; // appena torna a sedersi passano le risorse umane
  if (e.after === 'leave' || !desk) {
    c.phase = 'leave'; c.purpose = 'desk';
    c.path = routeBetween(from, { kind: 'elevator' });
  } else {
    c.phase = 'walk'; c.purpose = 'desk';
    c.path = routeBetween(from, { kind: 'desk', desk });
  }
}
function randomDoodle(c) {
  const names = Object.keys(ARTS);
  const h = hash(c.id + ':' + Date.now());
  if (h % 4 === 0) return { kind: 'word', text: WORDS[h % WORDS.length], author: agentName(c.data), color: MARKERS[h % MARKERS.length] };
  return { kind: 'art', art: names[h % names.length], author: agentName(c.data) };
}

// decide chi va alla lavagna e quando
function scheduleBoards(t) {
  const s = floor.s, cr = floor.creative;
  if (!cr) return;
  const boss = chars.get('main');
  const A = boards.A, B = boards.B;
  // primo ingresso sul piano: le lavagne mostrano subito lo stato attuale
  if (!A.todosAt && s.todosAt && !A.content) { A.content = { kind: 'todo', items: s.todos }; A.todosAt = s.todosAt; }
  if (!B.planAt && s.plan && !B.content) { B.content = { kind: 'plan', ...s.plan }; B.planAt = s.plan.at; }
  const bossFree = boss && boss.phase === 'seated' && !boss.errand && !boss.fadeOut;
  if (s.todosAt > A.todosAt && bossFree && boardFree(A)) {
    A.todosAt = s.todosAt;
    startErrand(boss, 'write', A, 'desk', t, { kind: 'todo', items: s.todos });
  } else if (s.todosAt > A.todosAt && !A.drawer && !A.down && !boss) { A.todosAt = s.todosAt; A.content = { kind: 'todo', items: s.todos }; A.progress = 1; }
  if (s.plan && s.plan.at > B.planAt && bossFree && boardFree(B)) {
    B.planAt = s.plan.at;
    startErrand(boss, 'plan', B, 'desk', t, { kind: 'plan', ...s.plan });
  }
  // frustrazione: un giro di rabbia per volta
  const raging = [...chars.values()].some(c => c.errand && c.errand.type === 'rage');
  for (const c of chars.values()) {
    const a = c.data || {};
    if ((a.errStreak || 0) < 3) c.raged = false;
    if (raging || c.errand || c.phase !== 'seated' || c.fadeOut) continue;
    const errMad = (a.errStreak || 0) >= 3 && !c.raged;
    const intMad = a.interruptedAt && a.interruptedAt !== c.ragedInt && Date.now() - a.interruptedAt < 20000;
    if (!errMad && !intMad) continue;
    const target = boardFree(B) ? B : boardFree(A) ? A : null;
    if (!target) break;
    c.raged = c.raged || errMad; if (intMad) c.ragedInt = a.interruptedAt;
    startErrand(c, 'rage', target, 'desk', t);
    break;
  }
  // chi rimette in piedi le lavagne
  for (const key of ['A', 'B']) {
    const b = boards[key];
    if (!b.down || b.drawer || t - b.downAt < 9000) continue;
    const culprit = chars.get(b.downBy);
    const calm = !culprit || !culprit.data || ((culprit.data.errStreak || 0) < 3);
    if (!calm && t - b.downAt < 60000) continue;
    const lifter = [culprit, boss, ...chars.values()].find(c => c && c.phase === 'seated' && !c.errand && !c.fadeOut && deskFor(c.id));
    if (lifter) startErrand(lifter, 'lift', b, 'desk', t);
    else if (t - b.downAt > 60000) { b.down = false; b.downBy = null; }
  }
}

function drawCreativeBack(cr, t) {
  ctx.globalAlpha = 0.14; R(cr.x, cr.y, cr.w, cr.h, C.yellow); ctx.globalAlpha = 1;
  R(cr.x - 2, cr.y - 2, 14, 5, '#5F574F'); R(cr.x + 30, cr.y - 2, cr.w - 28, 5, '#5F574F');
  R(cr.x - 2, cr.y - 2, cr.w + 3, 1, '#83769C');
  R(cr.x + 12, cr.y - 2, 18, 2, '#1a1626');
  R(cr.x - 2, cr.y - 2, 3, cr.h + 2, '#5F574F'); R(cr.x + cr.w - 1, cr.y - 2, 3, cr.h + 2, '#5F574F');
  // pouf e pianta: è pur sempre la sala creativa
  const px = cr.x + cr.w - 22, py = cr.y + cr.h - 16;
  R(px, py, 14, 9, C.pink); R(px + 2, py - 2, 10, 3, '#ff9fc4'); R(px + 1, py + 8, 12, 2, '#c4527e');
}

function drawBoard(g, t) {
  const b = boards[g.key];
  const x = g.x, y = g.y, w = g.w, h = g.h;
  // caduta e risalita animate
  let k = 0;
  if (b.down) k = Math.min(1, (t - b.fallT) / 420);
  if (b.liftT) k = 1 - Math.min(1, (t - b.liftT) / 1200);
  if (k > 0.02) {
    const hh = Math.max(7, Math.round(h * (1 - k) + 7 * k));
    const yy = Math.round(y * (1 - k) + (y + h + 6) * k) + Math.round((h - hh) * (1 - k) * 0);
    const ww = Math.round(w + k * 8), xx = x - Math.round(k * 4);
    R(xx - 1, yy - 1, ww + 2, hh + 2, '#83769C'); R(xx, yy, ww, hh, '#e8e2d6');
    if (k > 0.8) { // gambe all'aria, pennarelli sparsi
      R(x + 6, yy - 8, 2, 8, C.dgrey); R(x + w - 8, yy - 8, 2, 8, C.dgrey);
      R(x + 4, yy - 10, 6, 2, C.black); R(x + w - 10, yy - 10, 6, 2, C.black);
      R(x + 20, yy + hh + 2, 5, 1, C.red); R(x + 40, yy + hh + 4, 5, 1, C.blue); R(x + 58, yy + hh + 1, 5, 1, C.dgreen);
      for (let i = 0; i < 4; i++) R(x + 12 + i * 16, yy + 2, 7, 1, '#b8b2a6');
    }
    return;
  }
  // in piedi: supporto con le ruote, cornice, vassoio dei pennarelli
  R(x + 6, y + h, 2, 14, C.dgrey); R(x + w - 8, y + h, 2, 14, C.dgrey);
  R(x + 2, y + h + 13, 10, 2, C.dgrey); R(x + w - 12, y + h + 13, 10, 2, C.dgrey);
  R(x + 3, y + h + 15, 2, 2, C.black); R(x + 9, y + h + 15, 2, 2, C.black); R(x + w - 11, y + h + 15, 2, 2, C.black); R(x + w - 5, y + h + 15, 2, 2, C.black);
  R(x - 2, y - 2, w + 4, h + 4, '#C2C3C7'); R(x - 2, y - 2, w + 4, 1, C.white);
  R(x, y, w, h, '#fbf8f0');
  R(x + 4, y + h, w - 8, 3, '#8b8a9a'); R(x + 10, y + h, 6, 2, C.red); R(x + 18, y + h, 6, 2, C.blue); R(x + 26, y + h, 6, 2, C.dgreen);
  const legTxt = g.key === 'A' ? tr('CAPO') : tr('LIBERA');
  pixText(legTxt, x + w - 2 - legTxt.length * 4, y + h + 4, '#5F574F', 4);
  // contenuto disegnato a pixel (i testi sono etichette HTML)
  const ct = b.content;
  if (ct && ct.kind === 'art' && ARTS[ct.art]) {
    const art = ARTS[ct.art], sc = 2;
    const aw = art[0].length * sc, ah = art.length * sc;
    const ox = Math.round(x + (w - aw) / 2), oy = Math.round(y + (h - ah) / 2) - 3;
    const total = art.length * art[0].length;
    const lim = Math.floor(total * b.progress);
    let n = 0;
    for (let r = 0; r < art.length; r++) for (let q = 0; q < art[r].length; q++, n++) {
      if (n > lim) break;
      const ch = art[r][q];
      if (ch !== '.') R(ox + q * sc, oy + r * sc, sc, sc, ART_COL[ch] || C.black);
    }
  } else if (ct && ct.kind === 'word') {
    const txt = ct.text.slice(0, Math.max(0, Math.ceil(ct.text.length * b.progress)));
    pixText(txt, x + Math.round((w - ct.text.length * 8) / 2), y + 16, ct.color || C.blue, 7);
  } else if (ct && ct.kind === 'plan') {
    // scatole e frecce del piano (le scritte sono HTML)
    const n = Math.max(1, Math.min(4, (ct.steps || []).length));
    const shown = Math.ceil(n * b.progress);
    for (let i = 0; i < shown; i++) {
      const bx = x + 4 + i * Math.floor((w - 8) / n), bw = Math.floor((w - 8) / n) - 6;
      R(bx, y + 22, bw, 1, C.blue); R(bx, y + 36, bw, 1, C.blue); R(bx, y + 22, 1, 15, C.blue); R(bx + bw - 1, y + 22, 1, 15, C.blue);
      if (i < shown - 1) { R(bx + bw, y + 29, 5, 1, C.red); R(bx + bw + 3, y + 28, 1, 3, C.red); }
    }
  }
}

// testi delle lavagne: aggiornati a ogni fotogramma per l'effetto "scrittura"
function updateBoardLabels() {
  if (!floor || !floor.creative) return;
  for (const g of floor.creative.boards) {
    const b = boards[g.key];
    const el = label('wb:' + g.key, 'wbtext');
    const k = b.down || b.liftT ? 0 : b.progress;
    const ct = b.content;
    let html = '';
    if (ct && ct.kind === 'todo') {
      const items = (ct.items || []).slice(-5);
      const n = Math.ceil(items.length * k);
      html = '<b>' + tr('DA FARE') + '</b>' + items.slice(0, n).map(it => `<span class="ti ${it.status}"><i></i>${esc(it.text)}</span>`).join('') +
        ((ct.items || []).length > 5 && k >= 1 ? `<span class="more">${tr('+{n} prima', { n: ct.items.length - 5 })}</span>` : '');
    } else if (ct && ct.kind === 'plan') {
      html = `<b>${esc(ct.title.slice(0, Math.ceil(ct.title.length * Math.min(1, k * 2))))}</b>` +
        (k > 0.3 ? `<span class="steps">${(ct.steps || []).slice(0, 4).map(x => `<em>${esc(x)}</em>`).join('')}</span>` : '');
    } else if (ct && (ct.kind === 'art' || ct.kind === 'word') && ct.author && k >= 1) {
      html = `<span class="sig">${tr('di {name}', { name: esc(ct.author) })}</span>`;
    } else if (!ct && g.key === 'A') {
      html = '<span class="more">' + tr('La lista di Claude comparirà qui') + '</span>';
    } else if (!ct && g.key === 'B') {
      html = '<span class="more">' + tr('Il piano di Claude comparirà qui (modalità piano)') + '</span>';
    }
    if (b.down) html = '';
    setHtml(el, html);
    el.style.display = html ? '' : 'none';
    el.style.width = (g.w - 4) * scale + 'px';
    el.style.height = (g.h - 2) * scale + 'px';
    el.classList.toggle('plan', !!(ct && ct.kind === 'plan'));
    placeLabel(el, (g.x + 2) * scale, (g.y + 1) * scale);
  }
}

// ================================================================ personaggi extra: gatto, collega fastidioso, pulizie, risorse umane
// Non sono agenti: girano per il piano, ma il gatto ha un compito vero (si sdraia sulla
// tastiera di chi è bloccato) e il collega... beh, fa il collega.
const PEST_LINES = [
  tr('Hai un minuto? Sono due secondi.'), tr('Ma la mail di stamattina l\'hai letta?'), tr('Io l\'avrei fatto in Excel.'),
  tr('Facciamo una call veloce? Tipo un\'ora.'), tr('Chi ha spostato la mia spillatrice?'), tr('Ma questo non era pronto ieri?'),
  tr('Ti metto in copia, ok?'), tr('Mio cugino fa le app, sai?'), tr('Si può fare un filino più blu?'), tr('Ho prenotato la sala per parlarne.'),
  tr('Ma l\'IA non doveva fare tutto da sola?'), tr('Non per mettere fretta, ma…'), tr('Chi ha finito il caffè?'), tr('Ho un\'ideona per il prossimo sprint!'),
  tr('Scusa, mi rispieghi tutto dall\'inizio?'), tr('Lo mettiamo in agenda per lunedì?'), tr('Ah, ma stai lavorando? Allora dopo…'),
];
const JANITOR_LINES = [tr('Alzate i piedi, passo l\'aspirapolvere.'), tr('Chi ha lasciato le tazze sulla scrivania?'), tr('Qui è tutto un cavo…'), tr('Le lavagne non si buttano per terra!')];
// le risorse umane: una battuta dopo l'altra, alla scrivania di chi ha buttato giù la lavagna
const HR_LINES = [tr('Buongiorno, sono delle Risorse Umane.'), tr('Abbattere le lavagne non è un comportamento consono all\'ufficio.'), tr('Le lascio un richiamo formale. Firmi qui, grazie.')];
const HR_LINE_MS = 3200;
let npcs = [];
let npcT0 = 0;

function settingOn(k) { return !snap || !snap.settings || snap.settings[k] !== false; }
const NIGHT_FORCE = new URLSearchParams(location.search).get('night'); // ?night=1 per provare
function isNight() {
  if (NIGHT_FORCE) return NIGHT_FORCE === '1';
  if (!settingOn('nightAuto')) return false;
  const h = new Date().getHours();
  return h >= 20 || h < 7;
}

function poufPlace() {
  const cr = floor.creative;
  return { kind: 'spot', corr: { x: cr.doorX, y: floor.corridorY(cr.line) }, inner: [{ x: cr.doorX, y: cr.y + 12 }, { x: cr.x + cr.w - 30, y: cr.y + 12 }, { x: cr.x + cr.w - 30, y: cr.y + cr.h - 8 }] };
}
function besidePlace(desk) {
  const pts = entryPath(desk);
  const inner = pts.slice(3);
  const last = inner[inner.length - 1], prev = inner[inner.length - 2];
  if (prev && prev.y !== last.y && prev.x === last.x) inner[inner.length - 2] = { x: last.x - 15, y: prev.y };
  inner[inner.length - 1] = { x: last.x - 15, y: last.y + 2 };
  return { kind: 'spot', corr: pts[2], inner };
}
function corridorEndPlace(line) {
  const y = floor.corridorY(line);
  return { kind: 'spot', corr: { x: ELEV.x, y }, inner: [{ x: W - 30, y }] };
}
function npcGo(n, place) {
  const from = n.place || { kind: 'elevator' };
  n.path = routeBetweenPlaces(from, place);
  n.place = place;
}
// come routeBetween, ma con luoghi qualsiasi (corr + inner)
function routeBetweenPlaces(a, b) {
  const A = a.kind === 'spot' ? a : placeEntry(a), B = b.kind === 'spot' ? b : placeEntry(b);
  const out = A.inner.slice().reverse().slice(1);
  out.push(A.corr);
  if (Math.abs(A.corr.y - B.corr.y) > 0.5) out.push({ x: ELEV.x, y: A.corr.y }, { x: ELEV.x, y: B.corr.y });
  out.push(B.corr, ...B.inner);
  return out.filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.y !== arr[i - 1].y);
}

function makeNpc(kind) {
  const base = { key: 'npc:' + kind, id: 'npc:' + kind, npc: kind, x: ELEV.x, y: ELEV.y, path: [], dir: 'down', moving: false, alpha: 0, phase: 'walk', state: 'enter', until: 0, speech: '', role: 'npc' };
  if (kind === 'pest') return { ...base, look: { skin: '#E8B48A', hair: '#5F3A1E', style: 3, shirt: '#d4a017', pants: C.navy, acc: 'bowtie', accColor: C.red, pattern: 'stripes' }, data: { status: 'idle', kind: 'sub', type: tr('collega'), name: (snap.settings && snap.settings.pestName) || 'Ugo Pignolo', action: '', description: '' } };
  if (kind === 'hr') return { ...base, look: { skin: '#F2C6A0', hair: '#2B1B17', style: 1, shirt: C.white, pants: C.navy, acc: 'badge', accColor: C.plum, pattern: 'vest' }, data: { status: 'idle', kind: 'sub', type: tr('risorse umane'), name: hrName(), action: '', description: '' } };
  if (kind === 'elder') return { ...base, age: 3, look: { skin: '#E8B48A', hair: '#F2F2F2', style: 0, shirt: '#8B5A2B', pants: '#5F574F', acc: 'none', accColor: '#8B5A2B', pattern: 'vest' }, data: { status: 'idle', kind: 'sub', type: tr('memoria del progetto'), name: tr('Nonno'), action: '', description: '' } };
  if (kind === 'janitor') return { ...base, look: { skin: '#C68A5E', hair: '#C2C3C7', style: 0, shirt: '#2c6e49', pants: '#1f3d2b', acc: 'cap', accColor: '#2c6e49', pattern: 'plain' }, data: { status: 'idle', kind: 'sub', type: tr('pulizie'), name: tr('Pulizie'), action: '', description: '' } };
  // gatto
  return { ...base, x: 0, y: 0, alpha: 1, state: 'nap', place: null };
}

// il Libro della bottega si apre su quella lezione (la vista del libro è in C3: finché non c'è, la lezione arriva in un avviso)
function openElderBook(n) {
  if (!n.hint) return;
  if (window.openBottega && floor) return openBottega(floor.s.id, n.hint.lessonId);
  toast(n.hint.text, true);
}
function hrName() { return (snap.settings && snap.settings.hrName) || 'Dott.ssa Ornella Rigore'; }
function dropNpc(n) { if (n && n.el) { n.el.remove(); n.el = null; } npcs = npcs.filter(x => x !== n); }
function resetNpcs() { for (const n of npcs) if (n.el) n.el.remove(); npcs = []; npcT0 = performance.now(); }

function updateNpcs(dt, t) {
  if (!floor || !floor.creative) return;
  const fl = floor;
  // il gatto vive nella sala creativa
  let cat = npcs.find(n => n.npc === 'cat');
  if (settingOn('catEnabled') && !cat) {
    cat = makeNpc('cat'); const p = poufPlace(); const last = p.inner[p.inner.length - 1];
    cat.x = last.x; cat.y = last.y - 6; cat.place = p; cat.phase = 'nap'; npcs.push(cat);
  }
  if (!settingOn('catEnabled') && cat) { dropNpc(cat); cat = null; }
  if (cat && !cat.path.length) {
    const stuck = [...chars.values()].find(c => c.alert && (c.alert.kind === 'stuck' || c.alert.kind === 'errors') && c.phase === 'seated' && deskFor(c.id));
    if (stuck && cat.target !== stuck.id) {
      cat.target = stuck.id; cat.phase = 'walk'; cat.y = cat.place && cat.place.inner ? cat.place.inner[cat.place.inner.length - 1].y : cat.y;
      npcGo(cat, besidePlace(deskFor(stuck.id)));
    } else if (!stuck && cat.target) {
      cat.target = null; cat.phase = 'walk'; npcGo(cat, poufPlace());
    }
  }
  // il collega fastidioso: arriva dall'ascensore, disturba un paio di persone, se ne va, poi torna
  let pest = npcs.find(n => n.npc === 'pest');
  if (settingOn('pestEnabled') && !pest && t - npcT0 > 8000 && chars.size > 0 && t > (updateNpcs.pestBack || 0)) {
    pest = makeNpc('pest'); pest.visits = 2 + Math.floor(Math.random() * 2); npcs.push(pest); openElevator(); pest.place = { kind: 'elevator' };
    pest.state = 'seek';
  }
  if (pest && !settingOn('pestEnabled')) { dropNpc(pest); pest = null; }
  if (pest && pest.data) pest.data.name = (snap.settings && snap.settings.pestName) || 'Ugo Pignolo';
  if (pest && !pest.path.length) {
    if (pest.state === 'seek') {
      const victims = [...chars.values()].filter(c => c.phase === 'seated' && !c.errand && deskFor(c.id) && c.id !== pest.lastVictim);
      if (!victims.length || pest.visits <= 0) { pest.state = 'exit'; npcGo(pest, { kind: 'elevator' }); }
      else {
        const v = victims[Math.floor(Math.random() * victims.length)];
        pest.victim = v.id; pest.lastVictim = v.id; pest.state = 'go'; npcGo(pest, besidePlace(deskFor(v.id)));
      }
    } else if (pest.state === 'go') {
      pest.state = 'chat'; pest.until = t + 6500; pest.dir = 'right';
      pest.speech = PEST_LINES[Math.floor(Math.random() * PEST_LINES.length)]; pest.last = '';
      const v = chars.get(pest.victim); if (v) v.annoyedUntil = t + 7500;
    } else if (pest.state === 'chat' && t > pest.until) {
      pest.speech = ''; pest.last = ''; pest.visits--; pest.state = 'seek';
    } else if (pest.state === 'exit') {
      pest.fading = true;
    }
  }
  if (pest && pest.fading) { pest.alpha -= dt * 2.5; if (pest.alpha <= 0) { dropNpc(pest); updateNpcs.pestBack = t + 60000 + Math.random() * 90000; } }
  // pulizie notturne
  let jan = npcs.find(n => n.npc === 'janitor');
  if (isNight() && !jan && t - npcT0 > 4000) { jan = makeNpc('janitor'); jan.place = { kind: 'elevator' }; jan.state = 'clean'; jan.lines = 0; npcs.push(jan); openElevator(); }
  if (jan && !isNight() && !jan.path.length) jan.state = 'exit';
  if (jan && !jan.path.length) {
    if (jan.state === 'clean') {
      const line = Math.floor(Math.random() * fl.lineYs.length);
      npcGo(jan, corridorEndPlace(line));
      if (Math.random() < 0.35) { jan.speech = JANITOR_LINES[Math.floor(Math.random() * JANITOR_LINES.length)]; jan.last = ''; jan.until = t + 4000; }
      if (++jan.lines > 6) jan.state = 'exit';
    } else if (jan.state === 'exit') { if (jan.place.kind !== 'elevator') npcGo(jan, { kind: 'elevator' }); else jan.fading = true; }
  }
  if (jan && jan.speech && t > jan.until) { jan.speech = ''; jan.last = ''; }
  if (jan && jan.fading) { jan.alpha -= dt * 2.5; if (jan.alpha <= 0) dropNpc(jan); }
  // risorse umane: chi ha buttato giù una lavagna, appena è di nuovo seduto, riceve un richiamo
  let hr = npcs.find(n => n.npc === 'hr');
  if (!settingOn('hrEnabled')) {
    if (hr) { dropNpc(hr); hr = null; }
    for (const c of chars.values()) { c.scoldPending = false; c.scoldedUntil = 0; }
  } else if (!hr && t > (updateNpcs.hrBack || 0)) {
    const v = [...chars.values()].find(c => c.scoldPending && c.phase === 'seated' && !c.errand && !c.fadeOut && deskFor(c.id));
    if (v) {
      v.scoldPending = false;
      hr = makeNpc('hr'); hr.victim = v.id; hr.place = { kind: 'elevator' }; hr.state = 'go'; npcs.push(hr);
      openElevator(); npcGo(hr, besidePlace(deskFor(v.id)));
    }
  }
  if (hr && hr.data) hr.data.name = hrName();
  if (hr && !hr.path.length) {
    const v = chars.get(hr.victim);
    const there = v && v.phase === 'seated' && deskFor(v.id); // si è alzato o è andato via: niente richiamo
    if (hr.state === 'go') {
      if (!there) { hr.state = 'exit'; npcGo(hr, { kind: 'elevator' }); if (v) v.scoldPending = true; } // ci riprova quando torna a sedersi
      else {
        hr.state = 'scold'; hr.line = 0; hr.until = t + HR_LINE_MS; hr.dir = 'right';
        hr.speech = HR_LINES[0]; hr.last = '';
        v.scoldedUntil = t + HR_LINE_MS * HR_LINES.length + 500;
      }
    } else if (hr.state === 'scold' && (!there || t > hr.until)) { // se si alza smette subito di parlare alla sedia
      if (!there || ++hr.line >= HR_LINES.length) { hr.speech = ''; hr.last = ''; hr.state = 'exit'; npcGo(hr, { kind: 'elevator' }); if (v) v.scoldedUntil = 0; }
      else { hr.speech = HR_LINES[hr.line]; hr.last = ''; hr.until = t + HR_LINE_MS; }
    } else if (hr.state === 'exit') {
      hr.fading = true;
    }
  }
  if (hr && hr.fading) { hr.alpha -= dt * 2.5; if (hr.alpha <= 0) { dropNpc(hr); updateNpcs.hrBack = t + 4000; } }
  // il Nonno: quando l'azione in corso di un agente corrisponde a una lezione forte del Libro della bottega
  let gp = npcs.find(n => n.npc === 'elder');
  if (!settingOn('elderEnabled')) { if (gp) { dropNpc(gp); gp = null; } }
  else if (!gp && floor && elder.sid === floor.s.id && t > (elder.back.get(floor.s.id) || 0)) {
    const sid = floor.s.id;
    // mai sullo stesso agente due volte di fila per la stessa lezione
    const h = elder.hints.find(x => { const c = chars.get(x.agent); return c && c.phase === 'seated' && !c.errand && deskFor(c.id) && elder.last.get(sid) !== x.agent + '|' + x.lessonId; });
    if (h) {
      gp = makeNpc('elder'); gp.hint = h; gp.victim = h.agent; gp.place = { kind: 'elevator' }; gp.state = 'go'; npcs.push(gp);
      openElevator(); npcGo(gp, besidePlace(deskFor(h.agent)));
      elder.back.set(sid, t + 180000); elder.last.set(sid, h.agent + '|' + h.lessonId);
    }
  }
  if (gp && !gp.path.length) {
    const v = chars.get(gp.victim);
    const there = v && v.phase === 'seated' && deskFor(v.id);
    if (gp.state === 'go') {
      if (!there) { gp.state = 'exit'; npcGo(gp, { kind: 'elevator' }); }
      else { gp.state = 'tell'; gp.until = t + 9000; gp.dir = 'right'; gp.speech = gp.hint.text; gp.last = ''; }
    } else if (gp.state === 'tell' && (!there || t > gp.until)) {
      gp.speech = ''; gp.last = ''; gp.state = 'exit'; npcGo(gp, { kind: 'elevator' });
    } else if (gp.state === 'exit') gp.fading = true;
  }
  if (gp && gp.fading) { gp.alpha -= dt * 2.5; if (gp.alpha <= 0) dropNpc(gp); }
  // movimento
  for (const n of npcs) {
    if (n.alpha < 1 && !n.fading) n.alpha = Math.min(1, n.alpha + dt * 3);
    if (!n.path.length) { n.moving = false; continue; }
    const p = n.path[0];
    const dx = p.x - n.x, dy = p.y - n.y, d = Math.hypot(dx, dy), step = (n.npc === 'cat' ? 40 : SPEED * (n.age >= 3 ? 0.6 : 0.9)) * dt;
    n.moving = true;
    if (Math.abs(dx) > Math.abs(dy)) n.dir = dx > 0 ? 'right' : 'left'; else n.dir = dy > 0 ? 'down' : 'up';
    if (d <= step) { n.x = p.x; n.y = p.y; n.path.shift(); } else { n.x += dx / d * step; n.y += dy / d * step; }
    if (!n.path.length) {
      n.moving = false; n.dir = 'down';
      if (n.npc === 'cat') n.phase = n.target ? 'keys' : 'nap';
      if (n.npc !== 'cat' && n.place && n.place.kind === 'elevator') { openElevator(900); n.fading = true; }
    }
  }
}

function drawCat(n, t) {
  let x = Math.round(n.x), y = Math.round(n.y);
  const O = C.orange, D = '#c97a00';
  if (n.phase === 'keys') { // sulla tastiera di chi è bloccato
    const d = deskFor(n.target);
    if (d) { x = d.x + 12; y = d.top + 24; }
    R(x - 6, y - 4, 12, 5, O); R(x + 4, y - 7, 5, 4, O); R(x + 4, y - 8, 1, 1, O); R(x + 8, y - 8, 1, 1, O);
    R(x - 3, y - 4, 1, 4, D); R(x, y - 4, 1, 4, D); R(x - 9, y - 1, 4, 2, O);
    const z = ((t / 600) | 0) % 3;
    pixText('Z', x + 9 + z, y - 12 - z * 3, C.white, 4);
    return;
  }
  if (n.phase === 'nap') {
    R(x - 5, y - 4, 10, 5, O); R(x + 3, y - 6, 4, 4, O); R(x + 3, y - 7, 1, 1, O); R(x + 6, y - 7, 1, 1, O);
    R(x - 7, y - 1, 3, 2, O); R(x - 2, y - 3, 1, 3, D); R(x + 1, y - 3, 1, 3, D);
    const z = ((t / 700) | 0) % 3; pixText('Z', x + 8 + z, y - 10 - z * 3, C.white, 4);
    return;
  }
  const f = ((t / 120) | 0) % 2, flip = n.dir === 'left' ? -1 : 1;
  R(x - 5, y - 6, 10, 4, O); R(x - 2, y - 6, 1, 4, D); R(x + 1, y - 6, 1, 4, D);
  R(x + 4 * flip - (flip < 0 ? 3 : 0), y - 9, 4, 4, O); R(x + 5 * flip - (flip < 0 ? 1 : 0), y - 10, 1, 1, O);
  R(x - 4, y - 2, 1, 2 + f, O); R(x + 3, y - 2, 1, 3 - f, O); R(x - 1, y - 2, 1, 3 - f, O); R(x + 1, y - 2, 1, 2 + f, O);
  R(x - 6 * flip - (flip < 0 ? 0 : 1), y - 9 + f, 1, 4, O);
}

function npcDrawables(t) {
  const out = [];
  for (const n of npcs) {
    if (n.npc === 'cat') {
      const y = n.phase === 'keys' && deskFor(n.target) ? deskFor(n.target).top + 41 : n.y + 0.2;
      out.push({ y, draw: () => drawCat(n, t) });
    } else {
      out.push({ y: n.y + 0.2, draw: () => {
        drawChar(n, t);
        if (n.npc === 'janitor') { // carrello con l'aspirapolvere
          const x = Math.round(n.x) + (n.dir === 'left' ? -14 : 8), y = Math.round(n.y);
          R(x, y - 9, 8, 8, '#5F574F'); R(x + 1, y - 8, 6, 3, C.yellow); R(x, y - 1, 2, 2, C.black); R(x + 6, y - 1, 2, 2, C.black);
          if (n.moving && ((t / 150) | 0) % 2) R(x - 2, y - 2, 1, 1, C.lgrey);
        }
      } });
    }
  }
  return out;
}

// ================================================================ festa! (commit, PR, tag, test verdi)
let confetti = [];
const partySeen = new Map();
let partyPrimed = false;
function checkParties() {
  for (const s of sessions()) {
    const p = s.party;
    if (!p) continue;
    const seen = partySeen.get(s.id);
    partySeen.set(s.id, p.t);
    if (!partyPrimed || seen === p.t || (seen && seen > p.t)) continue;
    if (!settingOn('partyEnabled')) continue;
    if (viewSid === s.id) startParty(s, p);
    else toast(tr('FESTA al piano {n} ({project}): {text}', { n: floorNo(s.id), project: projName(s), text: p.text }));
  }
  partyPrimed = true;
}
function startParty(s, p) {
  const cols = [C.red, C.yellow, C.green, C.blue, C.pink, C.orange, C.white];
  for (let i = 0; i < 160; i++) confetti.push({ x: Math.random() * W, y: WALL_H - Math.random() * 40, vx: (Math.random() - 0.5) * 30, vy: 20 + Math.random() * 40, c: cols[i % cols.length], life: 3.5 + Math.random() * 2, w: Math.random() < 0.5 ? 2 : 1 });
  const t = performance.now();
  for (const c of chars.values()) c.cheerUntil = t + 3000;
  const b = $('#party');
  b.innerHTML = `<b>${tr('FESTA!')}</b> ${esc(p.text)}<small>${esc(p.agent || '')}</small>`;
  b.hidden = false; b.classList.remove('go'); void b.offsetWidth; b.classList.add('go');
  clearTimeout(startParty._t); startParty._t = setTimeout(() => { b.hidden = true; }, 4200);
  beep([523, 659, 784, 1047, 784, 1047], 0.09, 'square', 0.05);
}
function updateConfetti(dt) {
  for (const p of confetti) { p.x += p.vx * dt + Math.sin(p.y / 9) * 0.3; p.y += p.vy * dt; p.vy += 8 * dt; p.life -= dt; }
  confetti = confetti.filter(p => p.life > 0 && p.y < H);
}
function drawConfetti() { for (const p of confetti) R(p.x, p.y, p.w, p.w === 2 ? 1 : 2, p.c); }

// ================================================================ notte in ufficio
function drawNight(t) {
  ctx.fillStyle = 'rgba(6, 4, 28, 0.38)';
  ctx.fillRect(0, WALL_H, W, H - WALL_H);
  // lampade da tavolo accese per chi lavora tardi
  const lit = d => { const o = occupantOf(d); return o && o.phase === 'seated' && o.data && o.data.status !== 'idle'; };
  const desks = [floor.bossDesk, ...floor.rooms.flatMap(r => r.desks)];
  for (const d of desks) {
    if (!lit(d)) continue;
    ctx.fillStyle = 'rgba(255, 220, 120, 0.13)';
    ctx.beginPath(); ctx.ellipse(d.x + 20, d.top + 22, 30, 18, 0, 0, Math.PI * 2); ctx.fill();
    R(d.x + 26, d.top + 9, 12, 9, 'rgba(0, 228, 54, 0.18)');
  }
}

// ================================================================ disegno del piano
function drawFloorScene(t) {
  const s = floor.s;
  // moquette
  const th = themeOf(s);
  for (let y = WALL_H; y < H; y += 12) for (let x = 0; x < W; x += 12) R(x, y, 12, 12, ((x + y) / 12) % 2 ? th.carpetA : th.carpetB);
  // corridoio verticale verso l'ascensore
  R(ELEV.x - 9, WALL_H, 18, H - WALL_H, th.corridor);
  for (let y = WALL_H + 4; y < H; y += 10) R(ELEV.x, y, 1, 4, '#4a4266');
  drawWallFloor(t, s);
  drawOfficeBack(t);
  for (const r of floor.rooms) drawRoomBack(r);
  if (floor.creative) drawCreativeBack(floor.creative, t);
  drawCables(t);
  const list = [];
  list.push(...deskDrawables(floor.bossDesk, t));
  for (const r of floor.rooms) for (const d of r.desks) list.push(...deskDrawables(d, t));
  for (const r of floor.rooms) list.push({ y: r.y + r.h, draw: () => drawRoomFront(r) });
  if (floor.creative) {
    list.push({ y: floor.creative.y + floor.creative.h, draw: () => drawRoomFront(floor.creative) });
    for (const b of floor.creative.boards) list.push({ y: b.y + b.h + 8, draw: () => drawBoard(b, t) });
  }
  list.push({ y: floor.office.bottom, draw: () => drawOfficeFront(t) });
  for (const c of chars.values()) list.push({ y: c.phase === 'seated' ? c.y : c.y + 0.1, draw: () => drawChar(c, t) });
  list.push(...npcDrawables(t));
  list.sort((a, b) => a.y - b.y);
  for (const d of list) d.draw();
  if (isNight()) drawNight(t);
  drawConfetti();
}

function drawWallFloor(t, s) {
  const th = themeOf(s);
  R(0, 0, W, WALL_H, th.wall);
  for (let x = 0; x < W; x += 8) R(x, 10, 1, WALL_H - 14, th.stripe);
  R(0, 0, W, 2, th.trim); R(0, WALL_H - 5, W, 5, '#5F574F'); R(0, WALL_H - 5, W, 1, '#83769C');
  drawElevator(t, s);
  // finestre e poster
  let wi = 0;
  for (let x = 64; x + 46 <= W - 50; x += 96, wi++) {
    drawWindow(x, 22, t, wi + floorNo(s.id) * 3);
    if (x + 96 + 34 <= W - 50 && wi % 2) drawPoster(x + 52, 24, wi);
  }
  drawClock(W - 24, 32);
}

// ---- ascensore: le porte si aprono quando qualcuno arriva o se ne va
let elevT0 = 0, elevUntil = 0;
function openElevator(dur = 1500) {
  const t = performance.now();
  if (t > elevUntil) { elevT0 = t; beep([1320, 990], 0.07, 'sine', 0.04); }
  elevUntil = Math.max(elevUntil, t + dur);
}
function elevOpenness(t) {
  if (t >= elevUntil) return 0;
  if (t < elevT0 + 220) return (t - elevT0) / 220;
  if (t > elevUntil - 220) return (elevUntil - t) / 220;
  return 1;
}
function drawElevator(t, s) {
  const ex = ELEV.x - 14, top = WALL_H - 34, w = 28, h = 34;
  const k = Math.max(0, Math.min(1, elevOpenness(t)));
  R(ex - 2, top - 2, w + 4, h + 2, '#5F574F');
  // cabina
  R(ex, top, w, h, '#2a2238'); R(ex, top, w, 2, k > 0 ? C.yellow : '#3a3350');
  R(ex + 3, top + 4, w - 6, 1, '#3a3350');
  // porte scorrevoli
  const dw = Math.round(14 * (1 - k * 0.86));
  R(ex, top, dw, h, '#a3a2b0'); R(ex + w - dw, top, dw, h, '#a3a2b0');
  R(ex + dw - 1, top, 1, h, '#6d6878'); R(ex + w - dw, top, 1, h, '#6d6878');
  // indicatore del piano e pulsante
  R(ex + 7, top - 11, 14, 8, C.black);
  pixText(String(floorLabel(s)).slice(-2), ex + 9, top - 10, k > 0 ? C.yellow : C.red, 5);
  if (k > 0) R(ex + 19, top - 9, 1, 3, C.green);
  R(ex + w + 4, WALL_H - 22, 3, 6, C.dgrey); R(ex + w + 5, WALL_H - 21, 1, 1, k > 0 ? C.green : C.yellow);
}

function drawOfficeBack(t) {
  const o = floor.office;
  // parquet
  for (let y = o.y; y < o.bottom; y += 4) R(o.x, y, o.w, 4, (y / 4) % 2 ? '#7a4a2a' : '#6a3f24');
  for (let y = o.y; y < o.bottom; y += 4) R(o.x + ((y * 7) % 40), y, 1, 4, '#4f2d18');
  // tappeto
  R(o.x + 8, o.y + 8, 64, 52, colorFor(floor.s.id)); ctx.globalAlpha = 0.6; R(o.x + 10, o.y + 10, 60, 48, '#1a1426'); ctx.globalAlpha = 1;
  // pareti a vetri (fondo e lati)
  glassWall(o.x, o.y - 2, o.w, 3);
  glassWall(o.x - 2, o.y - 2, 3, o.h + 2);
  glassWall(o.x + o.w - 1, o.y - 2, 3, o.h + 2);
  // arredi
  const fx = o.x + o.w - 34;
  R(fx, o.y + 6, 14, 20, C.lgrey); R(fx + 1, o.y + 8, 12, 1, C.dgrey); R(fx + 1, o.y + 14, 12, 1, C.dgrey); R(fx + 1, o.y + 20, 12, 1, C.dgrey);
  R(fx + 6, o.y + 10, 3, 1, C.dgrey); R(fx + 6, o.y + 16, 3, 1, C.dgrey);
  drawDecor(o.x + o.w - 18, o.y + 6);
  pixText(tr('CAPO'), o.x + o.w - 40, o.bottom - 22, '#ffffff55', 4);
}
function glassWall(x, y, w, h) {
  ctx.globalAlpha = 0.55; R(x, y, w, h, '#8fd8ff'); ctx.globalAlpha = 1;
  if (w > h) for (let i = 6; i < w; i += 22) R(x + i, y, 4, h, '#e8f8ff');
  else for (let i = 6; i < h; i += 22) R(x, y + i, w, 4, '#e8f8ff');
}
function drawOfficeFront(t) {
  const o = floor.office;
  const d0 = o.doorX - 10, d1 = o.doorX + 10;
  ctx.globalAlpha = 0.65;
  R(o.x - 2, o.bottom - 2, d0 - o.x + 2, 4, '#8fd8ff'); R(d1, o.bottom - 2, o.x + o.w + 1 - d1, 4, '#8fd8ff');
  ctx.globalAlpha = 1;
  R(d0 - 1, o.bottom - 4, 2, 6, C.lgrey); R(d1 - 1, o.bottom - 4, 2, 6, C.lgrey);
  for (let i = o.x + 4; i < d0 - 4; i += 20) R(i, o.bottom - 2, 3, 4, '#e8f8ff');
  for (let i = d1 + 6; i < o.x + o.w - 4; i += 20) R(i, o.bottom - 2, 3, 4, '#e8f8ff');
}

function drawRoomBack(r) {
  ctx.globalAlpha = 0.16; R(r.x, r.y, r.w, r.h, r.color); ctx.globalAlpha = 1;
  const glass = r.g.kind === 'mgr';
  const wallC = glass ? null : '#5F574F';
  const top = (x, w) => glass ? glassWall(x, r.y - 2, w, 4) : (R(x, r.y - 2, w, 5, wallC), R(x, r.y - 2, w, 1, '#83769C'));
  top(r.x - 2, 14);
  top(r.x + 30, r.w - 28);
  // porta aperta
  R(r.x + 12, r.y - 2, 18, 2, '#1a1626');
  if (glass) { glassWall(r.x - 2, r.y - 2, 3, r.h + 2); glassWall(r.x + r.w - 1, r.y - 2, 3, r.h + 2); }
  else { R(r.x - 2, r.y - 2, 3, r.h + 2, wallC); R(r.x + r.w - 1, r.y - 2, 3, r.h + 2, wallC); }
}
function drawRoomFront(r) {
  if (r.g.kind === 'mgr') { ctx.globalAlpha = 0.65; R(r.x - 2, r.y + r.h - 1, r.w + 3, 3, '#8fd8ff'); ctx.globalAlpha = 1; }
  else { R(r.x - 2, r.y + r.h - 1, r.w + 3, 3, '#5F574F'); R(r.x - 2, r.y + r.h - 1, r.w + 3, 1, '#83769C'); }
}

function drawCables(t) {
  for (const cb of floor.cables) {
    const pts = cb.pts;
    ctx.globalAlpha = 0.5;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      for (let d = 0; d < len; d += 3) {
        const k = d / len;
        R(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, 1, 1, cb.room.color);
      }
    }
    ctx.globalAlpha = 1;
    // pacchetti: gli ordini che scendono dal capo verso la sala
    const busy = cb.room.g.members.some(a => !a.finished && BUSY.includes(a.status)) || (cb.room.g.manager && BUSY.includes(cb.room.g.manager.status));
    if (busy) {
      const n = Math.max(1, Math.round(cb.len / 90));
      for (let i = 0; i < n; i++) {
        const d = ((t / 1000 * 40) + i * cb.len / n + hash(cb.room.key) % 50) % cb.len;
        const p = pointAt(pts, d);
        R(p.x - 1, p.y - 1, 3, 3, cb.room.color); R(p.x, p.y, 1, 1, C.white);
      }
    }
  }
}

// ================================================================ scrivanie
function occupantOf(desk) {
  if (desk.role === 'boss') return chars.get('main') || null;
  return desk.agentId ? chars.get(desk.agentId) || null : null;
}
function deskDrawables(desk, t) {
  const occ = occupantOf(desk);
  const seated = occ && occ.phase === 'seated' && !occ.fadeOut && Math.abs(occ.x - desk.seatX) < 1 && Math.abs(occ.y - desk.seatY) < 1;
  const chief = desk.role !== 'worker';
  return [
    { y: desk.seatY - 0.5, draw: () => {
      const x = desk.seatX, y = desk.top;
      R(x - 7, y + 8, 14, 12, chief ? C.plum : C.navy);
      R(x - 6, y + 9, 12, 2, chief ? '#a8337a' : '#2c3f74');
      R(x - 8, y + 18, 16, 3, '#111');
    } },
    { y: desk.top + 40, draw: () => drawDesk(desk, occ, seated, chief, t) },
  ];
}

function drawDesk(desk, occ, seated, chief, t) {
  const x = desk.x, y = desk.top;
  const st = occ && occ.data ? occ.data.status : null;
  R(x - 1, y + 20, 42, 2, '#e0a070');
  R(x - 1, y + 22, 42, 6, '#c27c4e');
  R(x - 1, y + 28, 42, 10, '#8a4a2a');
  R(x + 1, y + 30, 18, 6, '#7a3f22'); R(x + 9, y + 32, 2, 1, C.yellow);
  R(x - 1, y + 38, 3, 2, '#3a1e10'); R(x + 38, y + 38, 3, 2, '#3a1e10');
  if (chief) { R(x + 22, y + 30, 16, 5, desk.color); R(x + 23, y + 31, 14, 3, '#00000033'); }
  R(x + 6, y + 22, 12, 4, C.lgrey); for (let k = 0; k < 5; k++) R(x + 7 + k * 2, y + 23, 1, 1, C.dgrey);
  if (seated && occ) {
    const typing = st === 'working' || st === 'writing';
    const f = ((t / 110) | 0) % 2;
    const sk = occ.look.skin;
    if (typing) { R(x + 7, y + 21 - (f ? 1 : 0), 3, 2, sk); R(x + 14, y + 21 - (f ? 0 : 1), 3, 2, sk); }
    else if (st === 'thinking' || st === 'supervising') R(x + 8, y + 21, 3, 2, sk);
    else { R(x + 7, y + 23, 3, 2, sk); R(x + 14, y + 23, 3, 2, sk); }
  }
  const mx = x + 24, my = y + 7;
  R(mx, my, 16, 13, '#d8d2c0'); R(mx + 15, my + 1, 1, 12, '#a39d8a'); R(mx + 5, my + 13, 6, 2, '#a39d8a'); R(mx + 3, my + 15, 10, 1, '#8b8574');
  const sx = mx + 2, sy = my + 2, sw = 11, sh = 8;
  const seed = hash(desk.key) % 97;
  if (!occ || !seated) {
    R(sx, sy, sw, sh, '#0b0b14');
    if (((t / 1300 + seed) | 0) % 5 === 0) R(sx + ((t / 200) | 0) % sw, sy + ((t / 300) | 0) % sh, 1, 1, C.white);
  } else if (st === 'working' || st === 'writing') {
    R(sx, sy, sw, sh, '#002b16');
    const off = ((t / 160) | 0);
    for (let l = 0; l < 4; l++) R(sx + 1, sy + 1 + l * 2, 2 + (hash('l' + (l + off) + seed) % 8), 1, C.green);
  } else if (st === 'thinking' || st === 'supervising') {
    R(sx, sy, sw, sh, '#2b1d00');
    for (let l = 0; l < 3; l++) R(sx + 1, sy + 1 + l * 2, 4 + (hash('t' + l + seed) % 5), 1, C.orange);
    if (((t / 400) | 0) % 2) R(sx + 1, sy + 7, 2, 1, C.yellow);
  } else if (st === 'waiting') {
    R(sx, sy, sw, sh, ((t / 350) | 0) % 2 ? C.red : C.plum);
    R(sx + 5, sy + 1, 1, 4, C.white); R(sx + 5, sy + 6, 1, 1, C.white);
  } else if (st === 'done') {
    R(sx, sy, sw, sh, '#003b1f'); R(sx + 3, sy + 4, 1, 1, C.green); R(sx + 4, sy + 5, 1, 1, C.green); R(sx + 5, sy + 4, 1, 1, C.green); R(sx + 6, sy + 3, 1, 1, C.green); R(sx + 7, sy + 2, 1, 1, C.green);
  } else {
    R(sx, sy, sw, sh, '#10183a');
    const ph = (t / 250) | 0;
    R(sx + Math.abs((ph % 20) - 10), sy + Math.abs(((ph * 0.6 | 0) % 14) - 7), 2, 1, C.blue);
  }
  if (desk.role === 'boss') {
    R(x + 1, y + 13, 1, 8, C.dgrey); R(x - 1, y + 11, 6, 3, C.yellow); R(x, y + 19, 4, 2, C.dgrey);
    R(x + 19, y + 17, 3, 4, C.white); R(x + 22, y + 18, 1, 2, C.white);
  } else if (desk.role === 'manager') {
    R(x + 1, y + 13, 1, 8, C.dgrey); R(x - 1, y + 11, 6, 3, C.blue); R(x, y + 19, 4, 2, C.dgrey);
  } else if (seed % 2) {
    R(x + 19, y + 19, 4, 2, C.white); R(x + 20, y + 18, 4, 2, '#e8e0d0');
  }
}

// ================================================================ ambiente comune
function drawWindow(x, y, t, wi) {
  if (typeof isNight === 'function' && !isNight() && snap) return drawDayWindow(x, y, t, wi);
  R(x - 2, y - 2, 48, 30, C.lgrey);
  R(x, y, 44, 26, '#0d0b25');
  R(x, y, 44, 10, '#151236');
  if (wi % 5 === 0) { R(x + 34, y + 3, 4, 4, C.white); R(x + 35, y + 3, 3, 3, '#0d0b25'); R(x + 34, y + 3, 2, 4, C.white); }
  const sr = hash('stars' + wi);
  for (let i = 0; i < 5; i++) if (((t / 700 + i) | 0) % 7 !== 0) R(x + ((sr >>> (i * 3)) % 40) + 2, y + 2 + ((sr >>> (i * 5)) % 8), 1, 1, C.white);
  const hs = hash('city' + wi);
  let bx = x;
  for (let i = 0; bx < x + 44; i++) {
    const bw = 5 + ((hs >>> (i * 2)) % 6), bh = 8 + ((hs >>> (i * 3)) % 13);
    const w = Math.min(bw, x + 44 - bx);
    R(bx, y + 26 - bh, w, bh, i % 2 ? '#1D2B53' : '#24224a');
    for (let wy = y + 28 - bh; wy < y + 24; wy += 3) for (let wx = bx + 1; wx < bx + w - 1; wx += 2) {
      if ((hash(wi + ':' + wx + ':' + wy) + ((t / 2500) | 0)) % 9 < 2) R(wx, wy, 1, 1, C.yellow);
    }
    bx += bw + 1;
  }
  drawPrecip(x, y, t, wi, true);
  R(x + 21, y, 2, 26, C.lgrey);
  R(x, y + 12, 44, 1, C.lgrey);
}
function drawDayWindow(x, y, t, wi) {
  R(x - 2, y - 2, 48, 30, C.lgrey);
  const wx = dress.wx, grey = wx === 'cloudy' || wx === 'rain' || wx === 'storm' || wx === 'snow' || wx === 'fog';
  R(x, y, 44, 26, grey ? '#9fb2c6' : '#8fd8ff'); R(x, y, 44, 9, grey ? '#b7c4d2' : '#b8e8ff');
  const cx = x + 2 + ((t / 400 + wi * 13) | 0) % 32;
  R(cx, y + 4, 10, 3, grey ? '#dfe5ec' : C.white); R(cx + 2, y + 2, 6, 2, grey ? '#dfe5ec' : C.white);
  if (grey) { const cx2 = x + 2 + ((t / 520 + wi * 7 + 16) | 0) % 32; R(cx2, y + 7, 12, 3, '#d3dbe4'); }
  if (wi % 4 === 1 && !grey) { R(x + 34, y + 3, 5, 5, C.yellow); }
  const hs = hash('city' + wi);
  let bx = x;
  for (let i = 0; bx < x + 44; i++) {
    const bw = 5 + ((hs >>> (i * 2)) % 6), bh = 8 + ((hs >>> (i * 3)) % 13);
    const w = Math.min(bw, x + 44 - bx);
    R(bx, y + 26 - bh, w, bh, i % 2 ? '#6d7a99' : '#5b6785');
    for (let wy = y + 28 - bh; wy < y + 24; wy += 3) for (let wx = bx + 1; wx < bx + w - 1; wx += 2) R(wx, wy, 1, 1, '#a9c8e8');
    bx += bw + 1;
  }
  drawPrecip(x, y, t, wi, false);
  R(x + 21, y, 2, 26, C.lgrey);
  R(x, y + 12, 44, 1, C.lgrey);
}
// pioggia, neve, temporale e nebbia fuori dalle finestre
function drawPrecip(x, y, t, wi, night) {
  const wx = dress.wx;
  if (wx === 'rain' || wx === 'storm') {
    const col = night ? '#7f8fc0' : '#e8f4ff';
    for (let i = 0; i < 12; i++) { const px = x + (i * 11 + wi * 5) % 44, py = y + ((i * 7 + t / 9) | 0) % 24; R(px, py, 1, 3, col); }
    if (wx === 'storm' && ((t / 90 + wi) | 0) % 70 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(x, y, 44, 26); }
  } else if (wx === 'snow') {
    for (let i = 0; i < 12; i++) { const px = x + ((i * 11 + wi * 5 + Math.sin(t / 700 + i) * 2) | 0) % 44, py = y + ((i * 5 + t / 60) | 0) % 25; R(px, py, 1, 1, C.white); }
    R(x, y + 25, 44, 1, C.white);
  } else if (wx === 'fog') { ctx.fillStyle = night ? 'rgba(120,120,150,0.35)' : 'rgba(255,255,255,0.45)'; ctx.fillRect(x, y + 10, 44, 16); }
}
function drawPoster(x, y, i) {
  if (i % 3 === 0) { R(x, y, 30, 22, C.yellow); R(x + 1, y + 1, 28, 20, C.orange); pixText('SHIP', x + 4, y + 3, C.navy, 5); pixText('IT!', x + 7, y + 11, C.red, 5); }
  else if (i % 3 === 1) {
    R(x, y, 26, 24, C.white); R(x, y, 26, 6, C.red);
    const d = new Date();
    pixText(p2(d.getDate()), x + 7, y + 9, C.black, 7);
    pixText(tr('GEN FEB MAR APR MAG GIU LUG AGO SET OTT NOV DIC').split(' ')[d.getMonth()] || '', x + 4, y + 1, C.white, 4);
  } else { R(x, y, 28, 22, C.navy); R(x + 1, y + 1, 26, 20, '#0b2a4a'); [16, 13, 14, 9, 7, 3].forEach((h, k) => R(x + 3 + k * 4, y + 2 + h, 3, 18 - h, C.green)); }
}
function drawClock(x, y) {
  const d = new Date();
  R(x - 7, y - 6, 14, 13, C.white); R(x - 6, y - 7, 12, 15, C.white); R(x - 5, y - 5, 10, 11, '#f7efe0');
  R(x - 7, y - 6, 1, 13, C.dgrey); R(x + 6, y - 6, 1, 13, C.dgrey);
  const hA = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2, mA = d.getMinutes() / 60 * Math.PI * 2;
  for (let i = 1; i <= 4; i++) R(x + Math.sin(mA) * i, y - Math.cos(mA) * i, 1, 1, C.black);
  for (let i = 1; i <= 3; i++) R(x + Math.sin(hA) * i, y - Math.cos(hA) * i, 1, 1, C.red);
  R(x, y, 1, 1, C.black);
}

// testo pixel 3x5 disegnato a mano
const GLYPHS = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
  '9': '111101111001110', '!': '010010010000010', '/': '001001010100100', ':': '000010000010000', '.': '000000000000010',
  '-': '000000111000000', ' ': '000000000000000', '?': '110001010000010', '+': '000010111010000',
};
function pixText(str, x, y, col, size = 5) {
  const k = size >= 7 ? 2 : 1, adv = 4 * k;
  ctx.fillStyle = col;
  let cx = Math.round(x);
  for (const ch of String(str).toUpperCase()) {
    const g = GLYPHS[ch] || GLYPHS['?'];
    for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3) * k, Math.round(y) + ((i / 3) | 0) * k, k, k);
    cx += adv;
  }
}

// ================================================================ personaggio
// ================================================================ modello ed effort: età e superpoteri
// Più il modello è vecchio rispetto al più recente, più il personaggio è anziano.
// Più l'effort è alto, più è vestito da supereroe (ma l'età resta quella).
const NEWEST_KNOWN = 5.5; // versione più recente conosciuta; se ne arrivano di più nuove si aggiornano da sole
const FAMILY_NAME = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
const modelCache = new Map();
function modelInfo(id) {
  if (!id) return null;
  if (modelCache.has(id)) return modelCache.get(id);
  const m = String(id).toLowerCase();
  let fam = null, ver = null;
  // claude-3-5-sonnet-20241022 (versione prima) oppure claude-sonnet-4-5-20250929 (versione dopo)
  let r = /claude-(\d)(?:-(\d))?-(opus|sonnet|haiku|fable)/.exec(m);
  if (r) { fam = r[3]; ver = Number(r[1]) + (r[2] ? Number(r[2]) / 10 : 0); }
  else if ((r = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(m))) { fam = r[1]; ver = Number(r[2]) + (r[3] ? Number(r[3]) / 10 : 0); }
  else if ((r = /(opus|sonnet|haiku|fable)/.exec(m))) fam = r[1];
  const info = { id, fam, ver, label: fam ? FAMILY_NAME[fam] + (ver ? ' ' + dec(ver) : '') : id.replace(/^claude-/, '') };
  modelCache.set(id, info);
  return info;
}
let newestSeen = NEWEST_KNOWN;
function noteNewest() {
  for (const s of sessions()) for (const a of [s.main, ...s.subs]) { const mi = modelInfo(a.model); if (mi && mi.ver && mi.ver > newestSeen) newestSeen = mi.ver; }
}
// 0 giovane · 1 maturo (tempie grigie) · 2 anziano (capelli grigi, occhiali) · 3 vecchietto (capelli bianchi, bastone, passo lento)
const AGE_NAMES = [tr('giovane'), tr('maturo'), tr('anziano'), tr('vecchietto')];
function ageTier(model) {
  const mi = modelInfo(model);
  if (!mi || mi.ver == null) return 0;
  const gap = newestSeen - mi.ver;
  return gap <= 0.3 ? 0 : gap <= 0.8 ? 1 : gap <= 1.5 ? 2 : 3;
}
const EFFORT_NAMES = { low: tr('basso'), medium: tr('medio'), high: tr('alto'), xhigh: tr('altissimo'), max: tr('massimo') };
const HERO_NAMES = ['', tr('con il mantello'), tr('mantello e stemma'), tr('supereroe completo')];
// 0 niente · 1 mantello · 2 mantello e stemma · 3 costume completo con maschera e aura
function heroTier(effort) { return { high: 1, xhigh: 2, max: 3 }[effort] || 0; }
const HERO_COLORS = [['#FF004D', '#FFEC27'], ['#29ADFF', '#FFEC27'], ['#00E436', '#FFF1E8'], ['#7E2553', '#FFA300'], ['#FFA300', '#1D2B53']];
function heroColors(c) { return HERO_COLORS[hash(c.key + 'hero') % HERO_COLORS.length]; }
function drawCapeBack(c, x, by, t) {
  if (!c.hero) return;
  const [cape] = heroColors(c);
  const flutter = c.moving ? ((t / 120) | 0) % 2 : 0;
  const len = 10 + (c.hero >= 3 ? 2 : 0);
  if (c.dir === 'up') { R(x - 6, by - 9, 12, len, cape); R(x - 6, by - 9 + len - 1, 12, 1, shade(cape, 0.7)); return; }
  if (c.dir === 'left') { R(x + 3, by - 9, 4, len - 1, cape); R(x + 6 + flutter, by - 4, 2, len - 6, cape); return; }
  if (c.dir === 'right') { R(x - 7, by - 9, 4, len - 1, cape); R(x - 8 - flutter, by - 4, 2, len - 6, cape); return; }
  R(x - 7, by - 9, 2, len, cape); R(x + 5, by - 9, 2, len, cape); // di fronte: si vede ai lati
}
function drawHeroFront(c, x, by, hy, back, t) {
  if (!c.hero) return;
  const [cape, emb] = heroColors(c);
  R(x - 5, by - 9, 10, 1, cape); // allacciatura del mantello
  if (c.hero >= 2 && !back) { R(x - 1, by - 7, 3, 3, emb); R(x, by - 8, 1, 1, emb); R(x, by - 4, 1, 1, emb); R(x, by - 6, 1, 1, cape); }
  if (c.hero >= 3 && ((t / 300 + hash(c.key)) | 0) % 6 === 0) { ctx.globalAlpha *= 0.5; R(x - 7, hy - 3, 1, 1, C.yellow); R(x + 7, hy, 1, 1, C.yellow); R(x - 6, by - 2, 1, 1, C.yellow); ctx.globalAlpha *= 2; }
}
function drawAge(c, x, by, hy, back, seated, L) {
  if (!c.age) return;
  if (c.age === 1) { R(x - 4, hy + 1, 1, 2, '#9a9a9a'); R(x + 3, hy + 1, 1, 2, '#9a9a9a'); return; } // tempie grigie
  const grey = c.age >= 3 ? '#F2F2F2' : '#A8A8A8';
  // ricolora i capelli: copre la forma di base con il grigio
  if (back) R(x - 4, hy, 8, 6, grey);
  else if (c.age >= 3) { R(x - 4, hy + 1, 1, 3, grey); R(x + 3, hy + 1, 1, 3, grey); R(x - 3, hy, 6, 1, shade(L.skin, 0.9)); } // pelato sopra
  else { R(x - 4, hy, 8, 2, grey); R(x - 4, hy + 2, 1, 2, grey); R(x + 3, hy + 2, 1, 2, grey); }
  if (!back && c.hero < 3) { const g = C.lgrey; R(x - 3, hy + 5, 3, 1, g); R(x, hy + 5, 3, 1, g); R(x - 3, hy + 3, 1, 2, g); R(x + 2, hy + 3, 1, 2, g); } // occhiali da lettura
  if (c.age >= 3 && !back) R(x - 2, hy + 6, 4, 1, grey); // baffi bianchi
  if (c.age >= 3 && !seated && c.dir !== 'up') { const cx = c.dir === 'left' ? x - 7 : x + 7; R(cx, by - 6, 1, 7, C.brown); R(cx + (c.dir === 'left' ? 0 : -1), by - 7, 2, 1, C.brown); } // bastone
}

// ================================================================ vestiti: feste, stagioni e meteo
const URLP = new URLSearchParams(location.search);
const FESTA_FORCE = URLP.get('festa'), METEO_FORCE = URLP.get('meteo'); // es. ?festa=natale&meteo=snow per provare
function easterOf(y) { // algoritmo di Meeus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mo - 1, da);
}
const HOLIDAY_NAMES = { natale: tr('Natale'), capodanno: tr('Capodanno'), carnevale: tr('Carnevale'), valentino: tr('San Valentino'), donna: tr('Festa della donna'), pesce: tr('Pesce d\'aprile'), pasqua: tr('Pasqua'), tricolore: tr('Festa nazionale'), ferragosto: tr('Ferragosto'), halloween: 'Halloween' };
function holidayOf(d) {
  const m = d.getMonth() + 1, day = d.getDate(), y = d.getFullYear(), md = m * 100 + day;
  if (md === 1231 || md === 101) return 'capodanno';
  if (md >= 1208 || md <= 106) return 'natale';
  const diff = Math.round((new Date(y, m - 1, day) - easterOf(y)) / 86400000);
  if (diff === 0 || diff === 1) return 'pasqua';
  if (diff >= -52 && diff <= -47) return 'carnevale'; // da giovedì grasso a martedì grasso
  if (md === 214) return 'valentino';
  if (md === 308) return 'donna';
  if (md === 401) return 'pesce';
  if (md === 425 || md === 501 || md === 602) return 'tricolore';
  if (md === 815) return 'ferragosto';
  if ((md >= 1025 && md <= 1031) || md === 1101) return 'halloween';
  return null;
}
function seasonOf(d) { const m = d.getMonth() + 1; return m === 12 || m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn'; }
let dress = { holiday: null, season: 'autumn', wx: 'unknown', temp: null, sig: '', t: -1e9 };
function updateDress(t) {
  if (t - dress.t < 5000) return;
  const now = new Date();
  const on = !snap || !snap.settings || snap.settings.outfits !== false;
  const w = snap && snap.weather && !snap.weather.error ? snap.weather : null;
  let wx = w ? w.kind : 'unknown', temp = w ? w.temp : null;
  if (METEO_FORCE) { wx = METEO_FORCE === 'hot' ? 'clear' : METEO_FORCE === 'cold' ? 'cloudy' : METEO_FORCE; temp = METEO_FORCE === 'hot' ? 33 : METEO_FORCE === 'snow' || METEO_FORCE === 'cold' ? -1 : 14; }
  const holiday = on ? (FESTA_FORCE || holidayOf(now)) : null;
  const season = seasonOf(now);
  dress = { holiday, season, wx, temp, on, t, sig: [on, holiday, season, wx, temp == null ? '' : Math.round(temp)].join('|') };
}
const outfitCache = new Map();
function outfitOf(c) {
  if (!dress.on || c.npc === 'cat') return null;
  const k = c.key + '|' + dress.sig;
  let o = outfitCache.get(k);
  if (o) return o;
  if (outfitCache.size > 600) outfitCache.clear();
  o = {};
  const r = hash(c.key + ':' + dress.holiday) % 100, r2 = hash(c.key + ':meteo') % 100;
  const boss = c.role === 'boss';
  switch (dress.holiday) {
    case 'natale': o.hat = boss || r < 70 ? 'santa' : 'antlers'; break;
    case 'capodanno': o.hat = 'party'; break;
    case 'carnevale': if (boss || r < 55) o.face = 'mask'; if (r >= 55 && r < 85 || boss) o.hat = 'jester'; break;
    case 'valentino': o.chest = 'heart'; break;
    case 'donna': o.chest = 'mimosa'; break;
    case 'pesce': if (r < 60 && !boss) o.back = 'fish'; break; // lo scherzo: il capo non se ne accorge mai, gli altri sì
    case 'pasqua': if (boss || r < 70) o.hat = 'bunny'; break;
    case 'tricolore': o.chest = 'flag'; break;
    case 'ferragosto': o.face = 'shades'; o.chest = 'hawaii'; break;
    case 'halloween': if (boss || r < 35) o.hat = 'witch'; else if (r < 65) o.head = 'pumpkin'; else if (r < 88) o.neck = 'vampire'; break;
  }
  const cold = dress.temp != null ? dress.temp < 9 : dress.season === 'winter';
  const hot = dress.temp != null ? dress.temp >= 28 : dress.season === 'summer' && dress.wx !== 'rain';
  if (dress.wx === 'snow' || cold) { if (!o.neck && r2 < (dress.wx === 'snow' ? 70 : 45)) o.neck = 'scarf'; if (!o.hat && !o.head && r2 < (dress.wx === 'snow' ? 50 : 25)) o.hat = 'beanie'; }
  if (hot && !o.face && !o.head && r2 < 40) o.face = 'shades';
  if (dress.wx === 'rain' || dress.wx === 'storm' || dress.wx === 'snow') o.umbrella = true;
  o.col = [C.red, C.blue, C.yellow, C.green, C.pink, C.orange][hash(c.key + 'col') % 6];
  outfitCache.set(k, o);
  return o;
}
function drawOutfitBody(c, o, x, by, back, seated) {
  if (o.neck === 'vampire') { R(x - 5, by - 8, 2, 8, C.black); R(x + 3, by - 8, 2, 8, C.black); R(x - 6, by - 11, 2, 4, C.black); R(x + 4, by - 11, 2, 4, C.black); R(x - 5, by - 10, 1, 2, C.red); R(x + 4, by - 10, 1, 2, C.red); }
  if (o.neck === 'scarf') { R(x - 5, by - 9, 10, 2, o.col); R(x - 3, by - 9, 1, 2, C.white); R(x + 1, by - 9, 1, 2, C.white); if (!back) { R(x + 2, by - 8, 2, 4, o.col); R(x + 2, by - 5, 2, 1, C.white); } }
  if (!back) {
    if (o.chest === 'heart') { R(x + 1, by - 6, 1, 1, C.red); R(x + 3, by - 6, 1, 1, C.red); R(x + 1, by - 5, 3, 1, C.red); R(x + 2, by - 4, 1, 1, C.red); }
    else if (o.chest === 'mimosa') { R(x + 2, by - 5, 1, 3, C.dgreen); R(x + 1, by - 7, 1, 1, C.yellow); R(x + 3, by - 7, 1, 1, C.yellow); R(x + 2, by - 8, 1, 1, C.yellow); R(x + 2, by - 6, 1, 1, C.yellow); R(x + 3, by - 5, 1, 1, C.yellow); }
    else if (o.chest === 'flag') { R(x + 1, by - 7, 1, 2, '#009246'); R(x + 2, by - 7, 1, 2, C.white); R(x + 3, by - 7, 1, 2, '#ce2b37'); }
  }
  if (o.chest === 'hawaii') { R(x - 4, by - 6, 1, 1, C.pink); R(x - 1, by - 3, 1, 1, C.yellow); R(x + 2, by - 7, 1, 1, C.yellow); R(x + 3, by - 4, 1, 1, C.pink); R(x - 3, by - 2, 1, 1, C.white); }
  if (o.back === 'fish' && !seated) { // pesce d'aprile attaccato alla schiena
    const fx = back ? x - 3 : c.dir === 'left' ? x + 3 : c.dir === 'right' ? x - 7 : null;
    if (fx != null) { R(fx, by - 6, 4, 3, C.white); R(fx + 4, by - 7, 2, 1, C.white); R(fx + 4, by - 3, 2, 1, C.white); R(fx + 4, by - 6, 1, 3, C.white); R(fx + 1, by - 5, 1, 1, C.black); R(fx, by - 6, 6, 1, '#00000033'); }
  }
}
function drawOutfitHead(c, o, x, hy, back, t) {
  if (o.head === 'pumpkin') {
    R(x - 5, hy - 1, 10, 8, C.orange); R(x - 2, hy - 1, 1, 8, '#c76e00'); R(x + 1, hy - 1, 1, 8, '#c76e00'); R(x - 1, hy - 3, 2, 2, C.dgreen);
    if (!back) { const g = isNight() ? C.yellow : C.black; R(x - 3, hy + 2, 2, 2, g); R(x + 1, hy + 2, 2, 2, g); R(x - 3, hy + 5, 6, 1, g); R(x - 1, hy + 4, 1, 1, g); }
  }
  if (o.face === 'mask' && !back) { R(x - 4, hy + 2, 8, 3, o.col); R(x - 5, hy + 2, 1, 1, C.yellow); R(x + 4, hy + 2, 1, 1, C.yellow); R(x - 2, hy + 3, 1, 1, C.black); R(x + 1, hy + 3, 1, 1, C.black); }
  if (o.face === 'shades' && !back) { R(x - 3, hy + 3, 3, 2, C.black); R(x, hy + 3, 3, 2, C.black); R(x - 4, hy + 3, 8, 1, C.black); R(x - 2, hy + 3, 1, 1, '#ffffff55'); }
  switch (o.hat) {
    case 'santa': R(x - 3, hy - 4, 7, 3, C.red); R(x, hy - 6, 4, 2, C.red); R(x + 3, hy - 7, 2, 2, C.white); R(x - 5, hy - 1, 10, 2, C.white); break;
    case 'antlers': { const b = '#8a5a2b'; R(x - 4, hy - 4, 1, 4, b); R(x - 5, hy - 6, 1, 2, b); R(x - 3, hy - 5, 1, 1, b); R(x + 3, hy - 4, 1, 4, b); R(x + 4, hy - 6, 1, 2, b); R(x + 2, hy - 5, 1, 1, b); if (!back) R(x - 1, hy + 4, 2, 2, C.red); break; }
    case 'party': R(x - 3, hy - 2, 6, 2, C.pink); R(x - 2, hy - 4, 4, 2, C.yellow); R(x - 1, hy - 6, 2, 2, C.blue); R(x - 1, hy - 7, 2, 1, C.white); break;
    case 'jester': R(x - 5, hy - 2, 5, 2, C.red); R(x, hy - 2, 5, 2, C.green); R(x - 7, hy - 4, 3, 2, C.red); R(x + 4, hy - 4, 3, 2, C.green); R(x - 8, hy - 5, 1, 1, C.yellow); R(x + 7, hy - 5, 1, 1, C.yellow); break;
    case 'bunny': R(x - 3, hy - 6, 2, 6, C.white); R(x - 2, hy - 5, 1, 4, C.pink); R(x + 1, hy - 6, 2, 6, C.white); R(x + 1, hy - 5, 1, 4, C.pink); break;
    case 'witch': R(x - 6, hy, 12, 1, C.black); R(x - 4, hy - 3, 8, 3, C.black); R(x - 4, hy - 1, 8, 1, C.plum); R(x - 2, hy - 5, 4, 2, C.black); R(x, hy - 7, 2, 2, C.black); R(x + 2, hy - 8, 1, 1, C.black); break;
    case 'beanie': R(x - 4, hy - 2, 8, 3, o.col); R(x - 4, hy, 8, 1, shade(o.col, 0.7)); R(x - 1, hy - 3, 2, 1, C.white); break;
  }
}
function drawUmbrella(c, o, x, hy) {
  const ux = x + 6;
  R(ux, hy - 7, 1, 13, C.dgrey);
  R(ux - 8, hy - 9, 17, 2, o.col); R(ux - 6, hy - 11, 13, 2, o.col); R(ux - 2, hy - 12, 5, 1, o.col); R(ux, hy - 13, 1, 1, C.dgrey);
  R(ux - 8, hy - 8, 17, 1, shade(o.col, 0.7));
}
function drawXmasTree(x, y) {
  R(x + 6, y + 22, 4, 4, '#6b3e1e'); R(x + 2, y + 24, 12, 6, C.red);
  for (let i = 0; i < 4; i++) R(x + 8 - (2 + i * 2), y + 4 + i * 5, 4 + i * 4, 5, i % 2 ? '#0b7a3b' : '#0f8f45');
  R(x + 7, y + 1, 2, 3, C.yellow);
  const t = performance.now();
  [[5, 9], [10, 13], [4, 18], [12, 20], [8, 16]].forEach(([dx, dy], i) => R(x + dx, y + dy, 1, 1, ((t / 400 + i) | 0) % 3 ? [C.red, C.yellow, C.blue, C.pink, C.white][i] : '#0f8f45'));
}
function drawPumpkin(x, y) {
  R(x, y + 2, 8, 6, C.orange); R(x + 3, y + 2, 1, 6, '#c76e00'); R(x + 3, y, 2, 2, C.dgreen);
  if (isNight()) { R(x + 1, y + 4, 2, 1, C.yellow); R(x + 5, y + 4, 2, 1, C.yellow); R(x + 2, y + 6, 4, 1, C.yellow); }
  else { R(x + 1, y + 4, 2, 1, C.black); R(x + 5, y + 4, 2, 1, C.black); R(x + 2, y + 6, 4, 1, C.black); }
}
// pianta, oppure l'albero di Natale, oppure la pianta con le zucche
function drawDecor(x, y) {
  if (dress.on && dress.holiday === 'natale') return drawXmasTree(x - 1, y - 6);
  drawPlant(x, y);
  if (dress.on && dress.holiday === 'halloween') drawPumpkin(x + 10, y + 16);
  if (dress.on && dress.holiday === 'donna') { R(x + 4, y - 2, 2, 2, C.yellow); R(x + 9, y, 2, 2, C.yellow); R(x + 6, y - 4, 2, 2, C.yellow); }
}

function drawChar(c, t) {
  const a = c.data || {};
  const L = c.look;
  const x = Math.round(c.x), y = Math.round(c.y);
  const f = ((t / 140) | 0) % 2;
  const seated = c.phase === 'seated';
  const alpha = Math.max(0, Math.min(1, c.alpha));
  ctx.globalAlpha = alpha;
  const bob = c.moving ? f : (seated && (a.status === 'working' || a.status === 'writing') ? (((t / 280) | 0) % 2) : 0);
  if (!seated) {
    ctx.globalAlpha = alpha * 0.35; R(x - 5, y - 1, 10, 2, C.black); ctx.globalAlpha = alpha;
    if (c.moving) { R(x - 4, y - 6, 3, f ? 5 : 6, L.pants); R(x + 1, y - 6, 3, f ? 6 : 5, L.pants); R(x - 4, y - (f ? 2 : 1), 3, 1, C.black); R(x + 1, y - (f ? 1 : 2), 3, 1, C.black); }
    else { R(x - 4, y - 6, 3, 6, L.pants); R(x + 1, y - 6, 3, 6, L.pants); R(x - 4, y - 1, 3, 1, C.black); R(x + 1, y - 1, 3, 1, C.black); }
  }
  const by = y - 6 - (c.moving ? bob : 0) + (c.age >= 3 && !seated ? 1 : 0); // il vecchietto è un po' curvo
  drawCapeBack(c, x, by, t);
  R(x - 5, by - 8, 10, 8, L.shirt);
  if (L.pattern === 'stripes') for (let k = 0; k < 3; k++) R(x - 5, by - 6 + k * 2, 10, 1, shade(L.shirt, 0.72));
  else if (L.pattern === 'vest' && c.dir !== 'up') { R(x - 5, by - 8, 3, 8, shade(L.accColor, 0.8)); R(x + 2, by - 8, 3, 8, shade(L.accColor, 0.8)); }
  R(x - 5, by - 8, 10, 1, '#ffffff22');
  if (c.dir !== 'up') {
    if (L.acc === 'bowtie') { R(x - 2, by - 8, 2, 2, L.accColor); R(x + 1, by - 8, 2, 2, L.accColor); R(x, by - 8, 1, 1, shade(L.accColor, 0.6)); }
    else if (L.acc === 'badge') { R(x + 1, by - 6, 3, 3, C.white); R(x + 1, by - 6, 3, 1, L.accColor); }
    else if (L.acc === 'scarf') { R(x - 5, by - 9, 10, 2, L.accColor); R(x + 2, by - 8, 2, 3, L.accColor); }
  }
  if (L.acc === 'tie' && c.dir !== 'up') { R(x, by - 8, 1, 6, C.plum); R(x - 1, by - 8, 3, 1, C.white); }
  const outfit = outfitOf(c);
  if (outfit) drawOutfitBody(c, outfit, x, by, c.dir === 'up', seated);
  if (c.hero) drawHeroFront(c, x, by, by - 15, c.dir === 'up', t);
  if (c.role === 'manager' && c.dir !== 'up') { R(x, by - 8, 1, 5, C.navy); }
  if ((c.phase === 'errand' && c.errand && c.errand.type === 'rage') || c.cheerUntil > t) {
    // braccia al cielo (rabbia o festa)
    R(x - 7, by - 13 - f, 2, 6, L.shirt); R(x + 5, by - 13 - (1 - f), 2, 6, L.shirt);
    R(x - 7, by - 15 - f, 2, 2, L.skin); R(x + 5, by - 15 - (1 - f), 2, 2, L.skin);
  } else if (c.phase === 'errand' && c.errand) {
    // pennarello sulla lavagna
    const m = ((t / 160) | 0) % 3;
    R(x - 7, by - 7, 2, 6, L.shirt); R(x + 5, by - 12, 2, 5, L.shirt);
    R(x + 5 + (m - 1), by - 14 - (m === 1 ? 1 : 0), 2, 2, L.skin); R(x + 6 + (m - 1), by - 16, 1, 2, c.errand.color || C.blue);
  } else if (!seated) {
    const sw = c.moving ? (f ? 1 : -1) : 0;
    R(x - 7, by - 7 + sw, 2, 6, L.shirt); R(x + 5, by - 7 - sw, 2, 6, L.shirt);
    R(x - 7, by - 1 + sw, 2, 2, L.skin); R(x + 5, by - 1 - sw, 2, 2, L.skin);
    if (c.phase === 'break') { R(x + 5, by - 4, 3, 3, C.white); if (((t / 500) | 0) % 2) R(x + 6, by - 7, 1, 2, '#ffffff88'); }
    if (c.npc === 'pest') { R(x + 5, by - 4, 3, 3, C.white); R(x + 6, by - 3, 1, 1, C.red); } // la sua tazza
    if (c.npc === 'elder') { R(x + 5, by - 6, 4, 6, '#7E2553'); R(x + 5, by - 6, 4, 1, C.yellow); R(x + 8, by - 5, 1, 4, C.white); } // il Libro della bottega
    if (c.npc === 'hr') { R(x + 5, by - 6, 4, 6, C.brown); R(x + 6, by - 5, 2, 4, C.white); R(x + 6, by - 7, 2, 1, C.lgrey); } // la cartellina dei richiami
  } else {
    R(x - 7, by - 7, 2, 4, L.shirt); R(x + 5, by - 7, 2, 4, L.shirt);
    if (a.status === 'thinking' && c.kind === 'main') R(x + 2, by - 10, 2, 3, L.skin);
  }
  const hy = by - 15 - (seated ? bob : 0);
  R(x - 4, hy, 8, 7, L.skin);
  const back = c.dir === 'up';
  if (back) R(x - 4, hy, 8, 6, L.hair);
  else if (L.style === 0) { R(x - 4, hy, 8, 2, L.hair); R(x - 4, hy + 2, 1, 2, L.hair); R(x + 3, hy + 2, 1, 2, L.hair); }
  else if (L.style === 1) { R(x - 5, hy - 1, 10, 3, L.hair); R(x - 5, hy + 2, 2, 6, L.hair); R(x + 3, hy + 2, 2, 6, L.hair); }
  else if (L.style === 2) { R(x - 4, hy, 8, 1, L.hair); R(x - 1, hy - 2, 4, 2, L.hair); }
  else { R(x - 4, hy - 1, 8, 2, L.hair); R(x - 4, hy + 1, 2, 1, L.hair); }
  if (!back) {
    const ex = c.dir === 'left' ? -1 : c.dir === 'right' ? 1 : 0;
    const blink = ((t / 100 + hash(c.key) % 40) | 0) % 40 === 0;
    let look = 0;
    if (a.status === 'supervising' && seated) look = ((t / 1200) | 0) % 3 - 1;
    if (!blink) { R(x - 2 + ex + look, hy + 3, 1, 2, C.black); R(x + 1 + ex + look, hy + 3, 1, 2, C.black); }
    else { R(x - 2 + ex, hy + 4, 1, 1, C.black); R(x + 1 + ex, hy + 4, 1, 1, C.black); }
  }
  if (L.acc === 'safari') { R(x - 6, hy, 12, 1, '#8a6a3a'); R(x - 4, hy - 3, 8, 3, '#b08a4a'); R(x - 4, hy - 1, 8, 1, '#5a3a1a'); }
  else if (L.acc === 'glasses' && !back) { R(x - 3, hy + 3, 3, 2, '#000000aa'); R(x + 0, hy + 3, 3, 2, '#000000aa'); R(x - 3, hy + 3, 6, 1, C.black); }
  else if (L.acc === 'hardhat') { R(x - 5, hy - 2, 10, 3, C.yellow); R(x - 6, hy + 1, 12, 1, '#c9b800'); }
  else if (L.acc === 'headset') { R(x - 5, hy - 1, 10, 1, C.dgrey); R(x - 5, hy + 2, 1, 3, C.dgrey); R(x + 4, hy + 2, 1, 3, C.dgrey); if (!back) R(x - 4, hy + 5, 3, 1, C.dgrey); }
  else if (L.acc === 'cap') { R(x - 4, hy - 2, 8, 3, L.accColor || C.red); if (!back) R(x - 6, hy, 4, 1, L.accColor || C.red); }
  else if (L.acc === 'beret') { R(x - 5, hy - 2, 9, 2, L.accColor); R(x - 4, hy - 3, 6, 1, L.accColor); R(x + 1, hy - 4, 1, 1, L.accColor); }
  else if (L.acc === 'visor') { R(x - 5, hy, 10, 1, '#00873a'); if (!back) R(x - 6, hy + 1, 12, 1, '#00E436'); }
  if (c.age) drawAge(c, x, by, hy, back, seated, L);
  if (c.hero >= 3 && !back) { const [cape] = heroColors(c); R(x - 4, hy + 2, 8, 2, cape); R(x - 2, hy + 3, 1, 1, C.white); R(x + 1, hy + 3, 1, 1, C.white); } // maschera
  if (outfit) {
    drawOutfitHead(c, outfit, x, hy, back, t);
    if (outfit.umbrella && c.moving && !seated && c.phase !== 'errand') drawUmbrella(c, outfit, x, hy);
  }
  // icone di stato accanto alla testa
  const ix = x + 6, iy = hy - 6;
  if (a.status === 'waiting' && ((t / 300) | 0) % 2) { R(ix, iy - 2, 5, 9, C.red); R(ix + 2, iy - 1, 1, 4, C.white); R(ix + 2, iy + 5, 1, 1, C.white); }
  if ((a.status === 'thinking' || a.status === 'supervising') && c.phase !== 'break') {
    const n = ((t / 350) | 0) % 4;
    for (let i = 0; i < n; i++) R(ix + i * 2, iy + 3 - i, 1 + (i > 1 ? 1 : 0), 1 + (i > 1 ? 1 : 0), C.white);
  }
  if (c.annoyedUntil > t) { // nuvoletta grigia: il collega è passato a disturbare
    R(ix - 1, iy - 3, 7, 3, C.dgrey); R(ix, iy - 4, 5, 1, C.dgrey); if (((t / 200) | 0) % 2) R(ix + 2, iy, 1, 2, C.yellow);
  }
  if (c.scoldedUntil > t) { // goccia di sudore: le risorse umane lo stanno richiamando
    const d = ((t / 250) | 0) % 3;
    R(ix + 1, iy - 2 + d, 2, 3, C.blue); R(ix + 2, iy - 3 + d, 1, 1, C.blue);
  }
  if (c.alert && a.status !== 'waiting' && ((t / 600) | 0) % 2) { R(ix, iy - 2, 5, 9, C.orange); R(ix + 1, iy - 1, 3, 1, C.black); R(ix + 3, iy, 1, 2, C.black); R(ix + 2, iy + 2, 1, 1, C.black); R(ix + 2, iy + 5, 1, 1, C.black); }
  if (a.status === 'done' || a.finished) { R(ix, iy, 1, 1, C.green); R(ix + 1, iy + 1, 1, 1, C.green); R(ix + 2, iy, 1, 1, C.green); R(ix + 3, iy - 1, 1, 1, C.green); R(ix + 4, iy - 2, 1, 1, C.green); }
  const gr = groundFor(c);
  if (gr && gr.puzzled) { // nuvoletta grigia sopra la testa, con il punto di domanda: insiste sullo stesso errore
    const cx = x - 4, cy = hy - 17 + (((t / 700) | 0) % 2);
    R(cx + 1, cy, 7, 7, C.lgrey); R(cx, cy + 1, 9, 5, C.lgrey);
    R(cx + 2, cy + 8, 2, 1, C.lgrey); R(cx + 4, cy + 10, 1, 1, C.lgrey);
    pixText('?', cx + 3, cy + 1, C.dgrey);
  }
  if (gr && gr.bang > t) { // "!?": il mondo gli ha appena dato torto, e non se l'aspettava
    const j = Math.round(Math.sin(t / 45));
    R(ix - 2 + j, iy - 13, 11, 8, C.black);
    pixText('!?', ix - 1 + j, iy - 12, C.yellow);
  }
  if (gr && gr.stale) { // orologio: ha in testa un file che nel frattempo è cambiato (ricordo scaduto)
    const ox = x - 11, oy = hy - 7;
    R(ox + 1, oy + 1, 3, 3, C.black); R(ox + 1, oy, 3, 1, C.orange); R(ox, oy + 1, 1, 3, C.orange); R(ox + 4, oy + 1, 1, 3, C.orange); R(ox + 1, oy + 4, 3, 1, C.orange);
    R(ox + 2, oy + 1, 1, 2, C.white); R(ox + 3, oy + 2, 1, 1, C.white);
  }
  ctx.globalAlpha = 1;
}

// ================================================================ fumetti
const ICONS = { working: '>', writing: '>', thinking: '...', supervising: '*', idle: '-', waiting: '!', done: 'OK', leaving: '<' };

function wantsBalloon(c) {
  const a = c.data || {};
  if (c.npc) return !!c.speech || hoverId === c.id;
  if (c.phase === 'leave' || c.fadeAway || c.fadeOut) return false;
  return allBalloons || c.role === 'boss' || c.role === 'manager' || a.status === 'waiting' || focusId === c.id || hoverId === c.id || c.phase === 'linger' || !!c.alert || !!c.errand || !!(groundFor(c) || {}).claim;
}

function updateBalloon(c) {
  const a = c.data;
  if (!a) return null;
  if (!wantsBalloon(c)) { if (c.el) c.el.style.display = 'none'; return null; }
  if (!c.el) {
    c.el = document.createElement('div');
    c.el.className = 'balloon';
    c.el.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('button[data-d]');
      if (b) { const ap = approvalFor(c.sid, c.id); if (ap) answerApproval(ap, b.dataset.d); return; }
      if (c.npc === 'elder') return openElderBook(c);
      showInfo(c.sid, c.id);
    });
    overlay.appendChild(c.el);
  }
  c.el.style.display = '';
  const status = a.status;
  let action = a.action || '';
  if (c.phase === 'break') action = tr('Pausa caffè: tocca a te!');
  if (c.errand) action = ERRAND_TEXT[c.errand.type] + (c.phase === 'errand' ? '' : '…');
  if (c.alert && status !== 'waiting') action = c.alert.text.replace(/^[A-Z0-9-]+ /, '').replace(/^: /, '');
  if (c.npc) action = c.speech || (c.npc === 'pest' ? tr('Passavo di qui…') : c.npc === 'hr' ? tr('Ha un richiamo da consegnare') : c.npc === 'elder' ? tr('Il Nonno: la memoria del progetto') : c.npc === 'relax' ? c.doing : tr('Pulizie in corso'));
  if (c.cheerUntil > performance.now() && c.role === 'boss' && floor && floor.s.party) action = tr('Evviva! {text}', { text: floor.s.party.text });
  const ap = c.npc ? null : approvalFor(c.sid, c.id);
  const gc = (groundFor(c) || {}).claim;
  const sig = status + '|' + action + '|' + a.description + '|' + a.type + '|' + a.seq + '|' + (focusId === c.id) + '|' + !!c.alert + '|' + (c.errand ? c.errand.type : '') + '|' + (ap ? ap.id : '') + '|' + (gc ? gc.status + gc.t : '');
  if (sig !== c.last) {
    c.last = sig;
    c.el.className = 'balloon st-' + (c.npc ? 'npc' : c.errand && c.errand.type === 'rage' ? 'rage' : c.alert && status !== 'waiting' ? 'alert' : status) + (focusId === c.id ? ' focus' : '') + (a.kind === 'main' || !a.description ? ' compact' : '') + (ap ? ' asking' : '') + (gc ? ' unground' : '');
    c.el.innerHTML =
      '<span class="nm">' + esc(agentName(a)) + (c.role === 'manager' ? ' · ' + tr('CAPO REPARTO') : '') + '</span>' +
      (a.kind === 'sub' && a.description ? '<span class="task">' + esc(a.description) + '</span>' : '') +
      '<span class="act"><i class="ico">' + esc(ICONS[status] || '') + '</i>' + esc(action) + '</span>' +
      // affermazione dell'ultima risposta senza un fatto che la provi (o smentita dall'ultimo esito)
      (gc ? '<span class="ung">' + esc(gc.status === 'contradicted' ? tr('smentita: «{text}»', { text: gc.text }) : tr('senza prove: «{text}»', { text: gc.text })) + '</span>' : '') +
      (ap ? askButtons(ap) : '');
    c.el.title = agentName(a) + (a.description ? ' — ' + a.description : '') + '\n' + action + (gc ? '\n' + (gc.status === 'contradicted' ? tr('smentita: «{text}»', { text: gc.text }) : tr('senza prove: «{text}»', { text: gc.text })) : '');
  }
  const walking = c.moving;
  c.el.classList.toggle('walking', walking);
  const headTop = c.y - (c.phase === 'seated' ? 22 : 23);
  const maxW = Math.max(110, Math.round(PITCH * scale * 1.3));
  if (c._maxW !== maxW) { c.el.style.maxWidth = maxW + 'px'; c._maxW = maxW; }
  c.el.style.opacity = Math.max(0, Math.min(1, c.alpha));
  const bw = c.el.offsetWidth, bh = c.el.offsetHeight;
  const prio = (focusId === c.id ? 10 : 0) + (status === 'waiting' ? 5 : 0) + (c.role === 'boss' ? 3 : c.role === 'manager' ? 2 : 0) + (walking ? 0 : 1);
  return { c, bw, bh, hx: c.x * scale, top: headTop * scale - bh - 8, prio };
}

// ---- permessi: rispondi dal fumetto (o dalla striscia mini) senza passare dal terminale
const answered = new Set();
function approvalFor(sid, aid) {
  if (!snap || viewSid === 'replay') return null;
  const real = (snap.approvals || []).find(x => x.sid === sid && x.agentId === aid && !answered.has(x.id));
  if (real) return real;
  const s = sessionById(sid);
  if (s && s.demo) {
    const a = aid === 'main' ? s.main : s.subs.find(x => x.id === aid);
    const id = 'demo:' + sid + ':' + aid + ':' + (a && a.statusSince);
    if (a && a.status === 'waiting' && !answered.has(id)) return { id, demo: true, sid, agentId: aid, always: true, text: a.action };
  }
  return null;
}
function askButtons(ap) {
  return '<span class="ask"><button data-d="allow" title="' + esc(tr('Consenti questa volta')) + '">' + tr('SÌ') + '</button>' +
    (ap.always ? '<button data-d="always" title="' + esc(tr('Consenti e non chiedere più per questa sessione')) + '">' + tr('SEMPRE') + '</button>' : '') +
    '<button data-d="deny" class="no" title="' + esc(tr('Rifiuta')) + '">' + tr('NO') + '</button></span>';
}
async function answerApproval(ap, decision) {
  answered.add(ap.id);
  for (const c of chars.values()) c.last = ''; // ridisegna i fumetti senza pulsanti
  if (widgetOn) renderWidget();
  try {
    const r = await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ap.demo ? { demo: true, sid: ap.sid, agentId: ap.agentId, decision } : { id: ap.id, decision }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { toast(j.reason || tr('Non sono riuscito a rispondere: usa il terminale.'), false); return; }
    toast(decision === 'deny' ? tr('Rifiutato.') : decision === 'always' ? tr('Consentito, e non lo chiederà più in questa sessione.') : tr('Consentito.'));
    beep(decision === 'deny' ? [330, 220] : [660, 880], 0.06);
  } catch { toast(tr('Ufficio non raggiungibile.'), false); }
}

// rete di sicurezza: nessun fumetto senza il suo personaggio
function sweepBalloons() {
  const live = new Set();
  for (const c of chars.values()) if (c.el) live.add(c.el);
  for (const n of npcs) if (n.el) live.add(n.el);
  if (relax) for (const n of relax.npcs) if (n.el) live.add(n.el);
  for (const el of overlay.querySelectorAll('.balloon')) if (!live.has(el)) el.remove();
}

function placeBalloons(items) {
  measurePlaced(); // unico punto che usa _rect: le misure servono fresche solo qui
  items.sort((a, b) => b.prio - a.prio || a.c.y - b.c.y);
  const placed = [...labels.values()].filter(e => e.style.display !== 'none').map(e => e._rect).filter(Boolean);
  const maxX = W * scale, gap = 3;
  // anche i personaggi sono ostacoli: un fumetto non deve coprire la testa o il busto di nessuno, nemmeno del suo
  const bodies = [];
  for (const o of [...chars.values(), ...npcs]) if (o.alpha == null || o.alpha > 0.3) bodies.push({ o, x: (o.x - 7) * scale, y: (o.y - 25) * scale, w: 14 * scale, h: 20 * scale });
  const overlap = r => {
    let area = 0;
    for (const p of placed) {
      const ox = Math.min(r.x + r.w, p.x + p.w) - Math.max(r.x, p.x) + gap;
      const oy = Math.min(r.y + r.h, p.y + p.h) - Math.max(r.y, p.y) + gap;
      if (ox > 0 && oy > 0) area += ox * oy;
    }
    for (const b of bodies) {
      const ox = Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x), oy = Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y);
      if (ox > 0 && oy > 0) area += 1.5 * ox * oy;
    }
    return area;
  };
  for (const it of items) {
    const { c, bw, bh, hx, top } = it;
    const sideL = hx - bw + 14, sideR = hx - 14, center = hx - bw / 2;
    // sopra la testa (centro, sinistra, destra), poi di fianco alla testa (senza punta), poi più in alto, poi sotto
    const headY = top + bh + 8, besideY = headY - bh / 2;
    const cands = [[center, top], [sideL, top], [sideR, top], [hx + 10 * scale, besideY], [hx - 10 * scale - bw, besideY], [center, top - bh - 4], [sideL, top - bh - 4], [sideR, top - bh - 4], [center, top + bh * 0.5 + 30]];
    const order = c._cand != null ? [c._cand, ...cands.keys()] : [...cands.keys()];
    let best = null, bestScore = Infinity;
    for (const i of order) {
      const [x0, y0] = cands[i];
      const r = { x: Math.max(2, Math.min(maxX - bw - 2, x0)), y: Math.max(2, y0), w: bw, h: bh };
      const ov = overlap(r);
      const sc = ov + i * 0.5;
      if (sc < bestScore) { bestScore = sc; best = { r, i }; }
      if (ov === 0) { best = { r, i }; break; }
    }
    c._cand = best.i;
    placed.push(best.r);
    c.el.style.setProperty('--tail', Math.max(8, Math.min(bw - 10, hx - best.r.x - 4)) + 'px');
    c.el.classList.toggle('below', best.i === 8);
    c.el.classList.toggle('beside', best.i === 3 || best.i === 4);
    c.el.style.transform = `translate(${Math.round(best.r.x)}px, ${Math.round(best.r.y)}px)`;
    c.el.style.zIndex = focusId === c.id ? '999' : String(10 + it.prio * 100 + Math.round(c.y / 4));
  }
}

// ================================================================ schede di dettaglio
function showInfo(sid, aid) {
  const s = getSession(sid);
  if (!s) return;
  const a = aid === 'main' ? s.main : s.subs.find(x => x.id === aid);
  if (!a) return;
  focusId = aid;
  const parent = a.parentId ? s.subs.find(x => x.id === a.parentId) : null;
  const box = $('#info');
  box.innerHTML = '<span class="x">X</span><h3>' + esc(agentName(a)) + '</h3><dl>' +
    '<dt>' + tr('Piano') + '</dt><dd>' + floorNo(sid) + ' · ' + esc(projName(s)) + (s.wing === 'cowork' ? ' (Cowork)' : '') + '</dd>' +
    (s.title ? '<dt>' + tr('Sessione') + '</dt><dd>' + esc(s.title) + '</dd>' : '') +
    (a.kind === 'sub' ? '<dt>' + tr('Tipo') + '</dt><dd>' + esc(a.type) + (a.background ? ' ' + tr('(in background)') : '') + '</dd>' : '') +
    (a.kind === 'sub' ? '<dt>' + tr('Risponde a') + '</dt><dd>' + esc(parent ? agentName(parent) : 'CLAUDE') + '</dd>' : '') +
    (a.team ? '<dt>' + tr('Squadra') + '</dt><dd>' + esc(a.team) + '</dd>' : '') +
    (a.phase ? '<dt>' + tr('Fase') + '</dt><dd>' + esc(a.phase) + '</dd>' : '') +
    (a.description ? '<dt>' + tr('Compito') + '</dt><dd>' + esc(a.description) + '</dd>' : '') +
    '<dt>' + tr('Ora') + '</dt><dd>' + esc(a.action) + '</dd>' +
    (a.model ? '<dt>' + tr('Modello') + '</dt><dd>' + esc(modelInfo(a.model).label) + ' <span class="dim">(' + esc(a.model) + ')</span> · ' + esc(AGE_NAMES[ageTier(a.model)]) + '</dd>' : '') +
    (a.effort ? '<dt>Effort</dt><dd>' + esc(EFFORT_NAMES[a.effort] || a.effort) + (heroTier(a.effort) ? ' · ' + esc(HERO_NAMES[heroTier(a.effort)]) : '') + '</dd>' : '') +
    '<dt>' + tr('Strumenti') + '</dt><dd>' + trn('{n} usato', '{n} usati', a.toolCount || 0) + '</dd>' +
    '<dt>' + tr('Token') + '</dt><dd>' + tokText(a.tokens) + (a.cost ? ' · ≈' + money(a.cost) : '') + '</dd>' +
    (agentAlert(s, aid) ? '<dt>' + tr('Avviso') + '</dt><dd class="al">' + esc(agentAlert(s, aid).text) + '</dd>' : '') +
    (a.kind === 'sub' ? '<dt>' + tr('Al lavoro da') + '</dt><dd>' + agoText(a.startedAt) + '</dd>' : '') +
    (a.kind === 'main' ? '<dt>' + tr('Cartella') + '</dt><dd>' + esc(s.cwd || '') + '</dd>' : '') + '</dl>' +
    '<div class="btns"><button data-do="worldmap">' + esc(tr('MAPPA DELLA REALTÀ')) + '</button></div>' +
    (!s._replay && !s.demo ? '<div class="btns"><button data-do="focus">' + tr('VAI ALLA FINESTRA') + '</button><button data-do="folder">' + tr('CARTELLA') + '</button></div>' : '');
  box.hidden = false;
  box.querySelector('.x').onclick = e => { e.stopPropagation(); hideInfo(); };
  for (const btn of box.querySelectorAll('button[data-do]')) btn.onclick = () => {
    if (btn.dataset.do === 'worldmap') { hideInfo(); return openWorldMap(s.id, aid, !!s._replay); }
    sessionAction(btn.dataset.do, s.id);
  };
  for (const ch of chars.values()) ch.last = '';
}
function hideInfo() { focusId = null; $('#info').hidden = true; for (const ch of chars.values()) ch.last = ''; }

function showReleases(s) {
  roomListKey = null;
  const box = $('#roomlist');
  const rels = (s.releases || []).slice().reverse();
  const KIND = { commit: 'COMMIT', pr: 'PR', merge: 'MERGE', tag: 'TAG', tests: 'TEST', push: 'PUSH' };
  box.innerHTML = `<span class="x">X</span><h3>${tr('RILASCI')} · ${esc(projName(s))}</h3><div class="sub">${tr('Commit, push, PR e test verdi fatti dagli agenti')}</div><div class="list">` +
    (rels.length ? rels.map(r => `<div class="row rel"><i class="dot k-${esc(r.kind)}"></i><span class="n">${KIND[r.kind] || r.kind}</span><span class="a">${esc(r.text)}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">${tr('apri')}</a>` : ''}</span><span class="d">${new Date(r.t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })} · ${esc(r.agent)}</span></div>`).join('') : '<div class="row">' + tr('Nessun rilascio in questa sessione.') + '</div>') + '</div>';
  box.querySelector('.x').onclick = () => { box.hidden = true; };
  box.hidden = false;
}

let roomListKey = null;
function showRoomList(key) {
  roomListKey = key;
  renderRoomList();
  $('#roomlist').hidden = false;
}
function renderRoomList() {
  if (!roomListKey || !floor) return;
  const r = floor.rooms.find(x => x.key === roomListKey);
  const box = $('#roomlist');
  if (!r) { box.hidden = true; roomListKey = null; return; }
  const g = r.g;
  const all = [...(g.manager ? [g.manager] : []), ...g.members].filter(a => !a.finished).sort((a, b) => priority(b) - priority(a));
  const done = g.type ? (floor.s.completedByType || {})[g.type] || 0 : 0;
  box.innerHTML = `<span class="x">X</span><h3>${esc(g.title)}</h3><div class="sub">${tr('{n} al lavoro', { n: all.length })}${done ? ' · ' + trn('{n} ha finito', '{n} hanno finito', done) : ''}</div><div class="list">` +
    all.map(a => `<div class="row" data-id="${esc(a.id)}"><i class="dot ${esc(a.status)}"></i><span class="n">${esc(agentName(a))}</span><span class="a" title="${esc(a.description)}">${esc(a.action)}</span><span class="d">${agoText(a.startedAt)}</span></div>`).join('') + '</div>';
  box.querySelector('.x').onclick = () => { box.hidden = true; roomListKey = null; };
  for (const row of box.querySelectorAll('.row')) row.onclick = () => showInfo(floor.s.id, row.dataset.id);
}

let hoverId = null;
canvas.addEventListener('mousemove', e => {
  const rc = canvas.getBoundingClientRect();
  const wx = (e.clientX - rc.left) / scale, wy = (e.clientY - rc.top) / scale;
  if (!floor) { // atrio e area relax
    const h = sceneHit(wx, wy);
    hoverId = h && h.npc ? h.npc.id : null;
    canvas.style.cursor = h && !h.npc ? 'pointer' : '';
    showTip(h);
    return;
  }
  let best = null;
  for (const c of [...chars.values(), ...npcs.filter(n => n.npc !== 'cat')]) if (Math.abs(wx - c.x) < 8 && wy < c.y + 2 && wy > c.y - 26) best = c;
  hoverId = best ? best.id : null;
  canvas.style.cursor = best ? 'pointer' : '';
});
canvas.addEventListener('mouseleave', () => { hoverId = null; showTip(null); });

canvas.addEventListener('click', e => {
  const rc = canvas.getBoundingClientRect();
  const wx = (e.clientX - rc.left) / scale, wy = (e.clientY - rc.top) / scale;
  if (!floor) {
    const h = sceneHit(wx, wy);
    if (h && h.door) { canvas.style.cursor = ''; goTo(h.back ? null : 'relax'); }
    else if (h && h.cab) playArcade(h.cab);
    return;
  }
  let best = null;
  for (const c of chars.values()) if (Math.abs(wx - c.x) < 8 && wy < c.y + 2 && wy > c.y - 26) best = c;
  if (best) { showInfo(best.sid, best.id); return; }
  const gpc = npcs.find(n => n.npc === 'elder' && Math.abs(wx - n.x) < 8 && wy < n.y + 2 && wy > n.y - 26);
  if (gpc) return openElderBook(gpc);
  const cat = npcs.find(n => n.npc === 'cat');
  if (cat) {
    const cx = cat.phase === 'keys' && deskFor(cat.target) ? deskFor(cat.target).x + 12 : cat.x, cy = cat.phase === 'keys' && deskFor(cat.target) ? deskFor(cat.target).top + 24 : cat.y;
    if (Math.abs(wx - cx) < 10 && Math.abs(wy - cy) < 10) {
      const v = cat.target && chars.get(cat.target);
      toast(v && v.alert ? tr('Il gatto segnala: {text}', { text: v.alert.text }) : tr('Il gatto dorme. Tutto tranquillo.'));
      return;
    }
  }
  const room = floor.rooms.find(r => wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h);
  if (room) showRoomList(room.key); else hideInfo();
});

// ================================================================ HUD, ascensore, ticker, suoni
function updateHud() {
  let ses = 0, ag = 0, busy = 0, wait = 0, done = 0, cost = 0, alerts = 0;
  for (const s of sessions()) {
    if (s.ended) continue;
    ses++;
    const c = sessionCounts(s);
    ag += c.agents; busy += c.busy; wait += c.wait; done += c.done; cost += s.cost || 0; alerts += alertsOf(s).length;
  }
  // dalla voce più importante: in una finestra stretta restano visibili attese, avvisi e costo (le altre vanno a capo, fuori vista)
  const item = (cls, html) => `<span class="it ${cls}">${html}</span>`;
  $('#stats').innerHTML = (wait ? item('off', `${tr('ATTESA')} ${p2(wait)}`) : '') + (alerts ? item('warn', `${tr('AVVISI')} ${p2(alerts)}`) : '') +
    item('', `${tr('COSTO')} <b>${money(cost)}</b>`) + item('', `${tr('AL LAVORO')} <b>${p2(busy)}</b>`) + item('', `${tr('AGENTI')} <b>${p2(ag)}</b>`) +
    item('', `${tr('FATTI')} <b>${p2(done)}</b>`) + item('', `${tr('SESSIONI')} <b>${p2(ses)}</b>`) + item('live', '● LIVE');
  const hs = $('#hookstate');
  const on = snap.hooks && (snap.hooks.installed || snap.hooks.active);
  hs.textContent = on ? 'HOOK ON' : 'HOOK OFF';
  hs.className = on ? 'on' : 'off';
  hs.title = on ? tr('Gli hook di Claude Code sono installati: eventi istantanei.') : tr('Hook non installati: l\'ufficio legge i transcript (va bene lo stesso). Installa gli hook dal menu dell\'icona per i permessi in tempo reale.');
  $('#btn-demo').classList.toggle('on', !!snap.demo);
  $('#btn-balloons').classList.toggle('on', allBalloons);
  $('#btn-follow').classList.toggle('on', follow);
  if (isApp && window.officeApp.setCounts) window.officeApp.setCounts({ sessions: ses, agents: ag, busy, waiting: wait });
}

let elevSig = '';
function updateElevator() {
  const list = sessions();
  const items = list.map((s, i) => ({ id: s.id, n: i + 1, p: projName(s), wing: s.wing || 'code', c: sessionCounts(s), al: alertsOf(s).length, col: colorFor(s.id) }));
  const twoWings = items.some(i => i.wing === 'cowork');
  const sig = JSON.stringify([viewSid, !!(snap && snap.replay), items.map(i => [i.id, i.p, i.wing, i.c.agents, i.c.wait, i.al])]);
  if (sig === elevSig) return;
  elevSig = sig;
  const cur = viewSid === 'archive' ? '-1' : viewSid === 'replay' ? 'S' : viewSid === 'relax' ? 'R' : viewSid ? floorNo(viewSid) : 'T';
  const el = $('#elevator');
  el.innerHTML = `<div class="disp">${cur}<small>${tr('PIANO')}</small></div>` +
    items.slice().reverse().map((i, j, arr) => (twoWings && (j === 0 || arr[j - 1].wing !== i.wing) ? `<div class="lbl sec">${i.wing === 'cowork' ? 'COWORK' : 'CODE'}</div>` : '') + `<button data-sid="${esc(i.id)}" class="${i.id === viewSid ? 'cur' : ''} ${i.c.wait ? 'wait' : i.al ? 'alert' : ''}" title="${esc(i.p)}"><i style="background:${i.col}"></i>${i.n}<b>${i.c.agents}</b><small>${esc(i.p)}</small></button>`).join('') +
    `<button class="lobby ${viewSid ? '' : 'cur'}" data-sid="">T<small>${tr('atrio')}</small></button>` +
    `<button class="lobby ${viewSid === 'relax' ? 'cur' : ''}" data-sid="relax">R<small>${tr('relax')}</small></button>` +
    (snap && snap.replay ? `<button class="lobby ${viewSid === 'replay' ? 'cur' : ''}" data-sid="replay">S<small>${tr('replay')}</small></button>` : '') +
    `<button class="lobby ${viewSid === 'archive' ? 'cur' : ''}" data-sid="archive">-1<small>${tr('archivio')}</small></button>`;
  for (const b of el.querySelectorAll('button')) b.onclick = () => goTo(b.dataset.sid || null);
}

let tickerSig = '';
function updateTicker() {
  const log = snap.log.slice(-12).reverse();
  const sig = log.map(l => l.t + l.text).join('|');
  if (sig === tickerSig) return;
  tickerSig = sig;
  const el = $('#ticker-inner');
  const fmt = t => new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const items = log.length ? log : [{ t: Date.now(), text: tr('Benvenuto in Platypus: qui vedi i tuoi agenti di Claude Code al lavoro'), kind: 'session' }];
  el.innerHTML = items.map(l => `<span class="e k-${esc(l.kind)}"><span class="t">${fmt(l.t)}</span>${l.project ? '[' + esc(l.project) + '] ' : ''}${esc(l.text)}</span>`).join('');
  const first = el.firstElementChild;
  if (first) { first.classList.add('new'); }
}

let audio = null;
function beep(notes, len = 0.07, type = 'square', vol = 0.05) {
  if (!soundOn) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    let t0 = audio.currentTime;
    for (const f of notes) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = f; g.gain.value = vol;
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + len);
      t0 += len;
    }
  } catch {}
}
let soundPrimed = false;
function maybeSound() {
  const fresh = snap.log.filter(l => l.t > lastLogT);
  if (snap.log.length) lastLogT = Math.max(lastLogT, ...snap.log.map(l => l.t));
  if (!soundPrimed) { soundPrimed = true; return; }
  let n = 0;
  for (const l of fresh) {
    if (n++ > 2) break; // niente raffiche con le folle
    if (l.kind === 'spawn') beep([523, 659, 784]);
    else if (l.kind === 'done') beep([988, 1319], 0.08);
    else if (l.kind === 'wait') beep([440, 330, 440, 330], 0.09, 'square', 0.06);
    else if (l.kind === 'session') beep([392, 523], 0.09);
  }
}

// ================================================================ ciclo principale
let lastT = performance.now();
let lastList = 0;
function frame(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  updateDress(t);
  ctx.clearRect(0, 0, W, H);
  const items = [];
  if (viewSid === 'archive') {
    drawBasement(t);
  } else if (viewSid === 'relax') {
    if (relax) {
      updateRelax(dt, t);
      drawRelax(t);
      for (const n of relax.npcs) { const it = updateBalloon(n); if (it) items.push(it); }
      placeBalloons(items);
    }
  } else if (floor && viewSid) {
    update(dt, t);
    updateNpcs(dt, t);
    updateConfetti(dt);
    drawFloorScene(t);
    updateBoardLabels();
    for (const c of chars.values()) { const it = updateBalloon(c); if (it) items.push(it); }
    for (const n of npcs) { if (n.npc === 'cat') continue; const it = updateBalloon(n); if (it) items.push(it); }
    placeBalloons(items);
    if (t - lastList > 1000) { lastList = t; if (roomListKey) renderRoomList(); }
  } else if (!viewSid) {
    drawLobby(t);
  }
  if (t - (frame.sweep || 0) > 1000) { frame.sweep = t; sweepBalloons(); }
  $('#clock').textContent = new Date().toLocaleTimeString(LOCALE);
  requestAnimationFrame(frame);
}

// ================================================================ comandi
function toggleDemo() { fetch('/api/demo', { method: 'POST', body: '{}' }).catch(() => {}); }
function toggleSound() { soundOn = !soundOn; save('sound', soundOn); $('#btn-sound').classList.toggle('on', soundOn); if (soundOn) beep([660, 880]); }
function toggleCrt() { crtOn = !crtOn; save('crt', crtOn); document.body.classList.toggle('crt', crtOn); $('#btn-crt').classList.toggle('on', crtOn); }
function toggleHelp() { $('#help').hidden = !$('#help').hidden; }
function toggleBalloons() { allBalloons = !allBalloons; save('balloons', allBalloons); updateHud(); }
function toggleFollow() { follow = !follow; save('follow', follow); updateHud(); }
function setZoom(z) { zoom = Math.max(0.5, Math.min(2.5, z)); save('zoom', zoom); if (snap) reconcile(); }
async function togglePin() {
  if (!isApp) return;
  const on = await window.officeApp.togglePin();
  $('#btn-pin').classList.toggle('on', !!on);
}

// ---- ricerca su tutti i piani
function toggleSearch() {
  const box = $('#search');
  if (!box.hidden) { box.hidden = true; return; }
  box.innerHTML = '<input type="search" placeholder="' + esc(tr('Cerca un agente, un compito, un progetto…')) + '" aria-label="' + esc(tr('Cerca')) + '"><div class="res"></div>';
  box.hidden = false;
  const inp = box.querySelector('input'), res = box.querySelector('.res');
  const run = () => {
    const q = inp.value.trim().toLowerCase();
    const hits = [];
    for (const s of sessions()) {
      const fl = floorNo(s.id);
      if (q && (projName(s) + ' ' + (s.title || '')).toLowerCase().includes(q)) hits.push({ s, a: s.main, what: 'piano' });
      for (const a of [s.main, ...s.subs]) {
        if (a.finished) continue;
        const hay = (agentName(a) + ' ' + a.type + ' ' + (a.description || '') + ' ' + (a.action || '')).toLowerCase();
        if (!q || hay.includes(q)) hits.push({ s, a, what: 'agente', fl });
      }
    }
    res.innerHTML = hits.slice(0, 40).map((h, i) => `<div class="hit" data-i="${i}"><b>${tr('P{n}', { n: floorNo(h.s.id) })}</b> <span class="n">${esc(h.what === 'piano' ? projName(h.s) : agentName(h.a))}</span> <span class="a">${esc(h.what === 'piano' ? (h.s.title || '') : (h.a.description || h.a.action || ''))}</span></div>`).join('') ||
      '<div class="hit none">' + tr('Nessun risultato') + '</div>';
    for (const el of res.querySelectorAll('.hit[data-i]')) el.onclick = () => {
      const h = hits[Number(el.dataset.i)];
      box.hidden = true;
      const show = () => showInfo(h.s.id, h.a.id);
      if (viewSid === h.s.id) show(); else { goTo(h.s.id); setTimeout(show, 700); }
    };
  };
  inp.oninput = run;
  inp.onkeydown = e => { if (e.key === 'Enter') { const first = res.querySelector('.hit[data-i]'); if (first) first.click(); } if (e.key === 'Escape') box.hidden = true; e.stopPropagation(); };
  run();
  setTimeout(() => inp.focus(), 30);
}

// ---- modalità mini: una striscia con contatori e richieste, sempre in primo piano
let widgetOn = false;
function toggleWidget(force) {
  widgetOn = typeof force === 'boolean' ? force : !widgetOn;
  document.body.classList.toggle('widget', widgetOn);
  if (isApp && window.officeApp.setWidget) window.officeApp.setWidget(widgetOn);
  renderWidget();
}
function renderWidget() {
  const el = $('#widget');
  if (!widgetOn) { el.hidden = true; return; }
  el.hidden = false;
  let ag = 0, busy = 0, cost = 0;
  const items = [];
  for (const s of sessions()) {
    const c = sessionCounts(s); ag += c.agents; busy += c.busy; cost += s.cost || 0;
    for (const a of [s.main, ...s.subs]) if (a.status === 'waiting' && !a.finished) {
      const ap = approvalFor(s.id, a.id);
      items.push({ s, txt: agentName(a) + (ap ? ': ' + (ap.text || tr('chiede il permesso')) : ' ' + tr('aspetta il tuo OK')), cls: 'w', ap });
    }
    for (const al of alertsOf(s)) if (al.kind !== 'wait') items.push({ s, txt: al.text, cls: 'a' });
  }
  el.innerHTML = `<div class="top"><span>${tr('AGENTI')} <b>${p2(ag)}</b></span><span>${tr('LAVORO')} <b>${p2(busy)}</b></span><span>${tr('COSTO')} <b>${money(cost)}</b></span><button data-do="full" title="${esc(tr('Torna all\'ufficio (M)'))}">${tr('APRI')}</button></div>` +
    (items.length ? items.slice(0, 4).map((it, i) => `<div class="it ${it.cls}" data-i="${i}"><span class="tx">${tr('P{n}', { n: floorNo(it.s.id) })} · ${esc(it.txt)}</span>${it.ap ? askButtons(it.ap) : ''}</div>`).join('') : '<div class="it ok">' + tr('Tutto tranquillo in ufficio') + '</div>');
  el.querySelector('[data-do=full]').onclick = () => toggleWidget(false);
  for (const d of el.querySelectorAll('.it[data-i]')) d.onclick = e => {
    const it = items[Number(d.dataset.i)];
    const b = e.target.closest('button[data-d]');
    if (b && it.ap) { e.stopPropagation(); answerApproval(it.ap, b.dataset.d); return; }
    toggleWidget(false); goTo(it.s.id);
  };
}

// ---- pannello opzioni
const SETTINGS_FIELDS = [
  ['budgetUSD', tr('Budget per sessione ($)'), tr('Oltre questa cifra il costo diventa rosso e parte un avviso. 0 = nessun budget.')],
  ['waitMin', tr('Permesso in attesa da (min)'), tr('Avviso se un agente aspetta il tuo OK da più di così.')],
  ['stuckMin', tr('Agente fermo dopo (min)'), tr('Avviso se uno strumento (es. un comando) non risponde da più di così.')],
  ['errStreak', tr('Errori di fila'), tr('Avviso dopo questo numero di errori consecutivi con lo stesso strumento.')],
  ['idleMin', tr('Sessione che ti aspetta da (min)'), tr('Avviso quando Claude ha finito e aspetta te da più di così.')],
  ['pricePerMTok', tr('Prezzo di stima ($/M token)'), tr('Usato solo finché Claude Code non ha scritto il costo reale nel transcript.')],
  ['reportHour', tr('Ora del report giornaliero'), tr('A quest\'ora l\'app ti avvisa che il report della giornata è pronto.')],
  ['approveWaitSec', tr('Attesa risposta dal fumetto (s)'), tr('Per quanto tempo l\'ufficio tiene in sospeso una richiesta di permesso prima di lasciarla al terminale.')],
];
const SETTINGS_CHECKS = [
  ['approveFromOffice', tr('Rispondi ai permessi dai fumetti (SÌ / SEMPRE / NO)')],
  ['alertsNotify', tr('Notifiche del sistema anche per gli avvisi')],
  ['pestEnabled', tr('Collega fastidioso in giro per i piani')],
  ['catEnabled', tr('Gatto dell\'ufficio')],
  ['hrEnabled', tr('Risorse umane: richiamo a chi butta giù una lavagna')],
  ['partyEnabled', tr('Feste per commit, PR e test verdi')],
  ['nightAuto', tr('Luci basse e pulizie dopo le 20')],
  ['outfits', tr('Vestiti per feste, stagioni e meteo')],
  ['groundingAlerts', tr('Avvisi di ancoraggio: modifiche alla cieca e affermazioni smentite')],
  ['elderEnabled', tr('Il Nonno racconta le lezioni del Libro della bottega')],
  ['bottegaLearn', tr('Il Libro della bottega impara dalle sessioni (dal vivo e dall\'archivio)')],
];
const SETTINGS_TEXTS = [
  ['pestName', tr('Nome del collega fastidioso'), 40, tr('Il nome del collega fastidioso')],
  ['hrName', tr('Nome della responsabile HR'), 40, tr('Il nome della responsabile delle risorse umane')],
  ['weatherCity', tr('Città per il meteo'), 40, tr('Serve per ombrelli, sciarpe e pioggia alle finestre. Vuoto = niente meteo.')],
  ['claudeDirs', tr('Altre cartelle di Claude Code'), 600, tr('Altre installazioni di Claude Code da seguire, per esempio dentro WSL o un altro utente (cartelle .claude, separate da ;). Le distribuzioni WSL accese si trovano da sole.')],
  ['coworkDirs', tr('Cartelle Cowork extra'), 600, tr('Se le sessioni Cowork non compaiono, indica qui la cartella (anche più di una, separate da ;).')],
];
// le opzioni divise per argomento, dalle più importanti; una voce che manca qui finisce in fondo (ALTRO)
const SETTINGS_GROUPS = [
  [tr('AVVISI'), ['budgetUSD', 'waitMin', 'stuckMin', 'errStreak', 'idleMin', 'groundingAlerts', 'alertsNotify']],
  [tr('PERMESSI DAI FUMETTI'), ['approveFromOffice', 'approveWaitSec']],
  [tr('COSTI E REPORT'), ['pricePerMTok', 'reportHour']],
  [tr('LIBRO DELLA BOTTEGA'), ['bottegaLearn', 'elderEnabled']],
  [tr('VITA D\'UFFICIO'), ['partyEnabled', 'pestEnabled', 'pestName', 'catEnabled', 'hrEnabled', 'hrName', 'nightAuto', 'outfits', 'weatherCity']],
  [tr('LINGUA E CARTELLE'), ['lang', 'claudeDirs', 'coworkDirs']],
];
function settingRow(k, st) {
  const f = SETTINGS_FIELDS.find(x => x[0] === k), c = SETTINGS_CHECKS.find(x => x[0] === k), tx = SETTINGS_TEXTS.find(x => x[0] === k);
  if (f) return `<label title="${esc(f[2])}"><span>${esc(f[1])}</span><input type="number" min="0" step="any" name="${k}" value="${esc(st[k])}"></label>`;
  if (c) return `<label class="chk"><input type="checkbox" name="${k}" ${st[k] !== false ? 'checked' : ''}><span>${esc(c[1])}</span></label>`;
  if (tx) return `<label title="${esc(tx[3])}"><span>${esc(tx[1])}</span><input type="text" name="${k}" maxlength="${tx[2]}" value="${esc(st[k] || '')}" placeholder="${k === 'coworkDirs' ? esc(tr('es. D:\\Claude')) : ''}"></label>`;
  if (k === 'lang') return `<label title="${esc(tr('Lingua dell\'ufficio'))}"><span>${esc(tr('Lingua'))}</span><select name="lang">` +
    [['auto', tr('Automatica (come il sistema)')], ...Object.entries((window.AO_I18N && AO_I18N.langs) || { it: 'Italiano' })]
      .map(([v, l]) => `<option value="${esc(v)}" ${(st.lang || 'auto') === v ? 'selected' : ''}>${esc(l)}</option>`).join('') + '</select></label>';
  return '';
}
function settingsGroupsHtml(st) {
  const placed = new Set(SETTINGS_GROUPS.flatMap(g => g[1]));
  const rest = [...SETTINGS_FIELDS, ...SETTINGS_CHECKS, ...SETTINGS_TEXTS].map(x => x[0]).filter(k => !placed.has(k));
  return [...SETTINGS_GROUPS, ...(rest.length ? [[tr('ALTRO'), rest]] : [])]
    .map(([title, keys]) => `<fieldset><legend>${esc(title)}</legend>${keys.map(k => settingRow(k, st)).join('')}</fieldset>`).join('');
}
const WEATHER_NAMES = { clear: tr('sereno'), partly: tr('poco nuvoloso'), cloudy: tr('nuvoloso'), rain: tr('pioggia'), snow: tr('neve'), storm: tr('temporale'), fog: tr('nebbia') };
function settingsStatus() {
  const w = snap && snap.weather, cw = snap && snap.cowork;
  const wtxt = !w ? esc(tr('Meteo spento.')) : w.error ? esc(tr('Meteo: {error} ({city}).', { error: w.error, city: w.city })) :
    esc(tr('Meteo a {city}: {temp}°, {sky}.', { city: w.city, temp: Math.round(w.temp), sky: WEATHER_NAMES[w.kind] || w.kind }));
  const fest = dress.holiday ? ' ' + esc(tr('Oggi in ufficio: {holiday}.', { holiday: HOLIDAY_NAMES[dress.holiday] || dress.holiday })) : '';
  let ctxt = esc(tr('Ricerca delle sessioni Cowork in corso…'));
  if (cw) {
    const ex = (cw.roots || []).filter(r => r.exists).map(r => r.path);
    ctxt = esc(tr('Cowork sul computer: {found} cartelle di sessione trovate, {watched} seguite (usate nelle ultime 36 ore).', { found: cw.found, watched: cw.watched })) +
      (ex.length ? '<br>' + esc(tr('Cerco in: {dirs}', { dirs: ex.join(' · ') })) : '<br>' + esc(tr('Nessuna cartella dell\'app Claude trovata.'))) +
      '<br>' + esc(tr('Le sessioni Cowork avviate nel cloud (da telefono o dal web) girano sui server di Anthropic e non lasciano file sul computer: quelle l\'ufficio non le può vedere.'));
  }
  return `<div class="stat"><p>${wtxt}${fest}</p><p>${ctxt}</p><button data-do="rescan">${tr('CERCA DI NUOVO LE SESSIONI COWORK')}</button></div>`;
}
function toggleSettings() {
  const box = $('#settings');
  if (!box.hidden) { if (box._tryClose) box._tryClose(); else box.hidden = true; return; }
  const st = (snap && snap.settings) || {};
  box.innerHTML = '<span class="x">X</span><h3>' + tr('OPZIONI') + '</h3>' + settingsGroupsHtml(st) + settingsStatus() +
    `<p class="dim">${tr('Le opzioni restano salvate anche alla prossima apertura.')}</p>` +
    `<div class="btns save-bar"><button data-do="save">${tr('SALVA')}</button><span class="dirty" hidden>${tr('Modifiche non salvate')}</span></div>`;
  // chiudere con X dopo una modifica: la prima volta avvisa, la seconda chiude senza salvare
  let dirty = false, warned = false;
  box.addEventListener('input', () => { dirty = true; warned = false; box.querySelector('.dirty').hidden = false; });
  box._tryClose = () => {
    if (dirty && !warned) { warned = true; toast(tr('Ci sono modifiche non salvate: premi SALVA, oppure chiudi di nuovo per lasciarle perdere.'), false); return; }
    box.hidden = true;
  };
  box.querySelector('.x').onclick = box._tryClose;
  box.querySelector('[data-do=rescan]').onclick = async () => {
    const r = await api('/api/cowork-scan', {});
    if (r) { snap.cowork = r; toast(tr('Cowork: {found} cartelle trovate, {watched} seguite', { found: r.found, watched: r.watched })); box.hidden = true; toggleSettings(); }
  };
  box.querySelector('[data-do=save]').onclick = async () => {
    const body = {};
    for (const inp of box.querySelectorAll('input[type=number]')) body[inp.name] = Number(inp.value);
    for (const [k] of SETTINGS_CHECKS) body[k] = box.querySelector(`input[name=${k}]`).checked;
    for (const [k] of SETTINGS_TEXTS) body[k] = box.querySelector(`input[name=${k}]`).value;
    body.lang = box.querySelector('select[name=lang]').value;
    const r = await api('/api/settings', body);
    if (r && r.budgetUSD != null) { snap.settings = r; dress.t = -1e9; toast(tr('Opzioni salvate')); box.hidden = true; boardSig = ''; reconcile(); } else toast(tr('Non sono riuscito a salvare'), false);
  };
  box.hidden = false;
}
$('#btn-settings').onclick = toggleSettings;
$('#btn-search').onclick = toggleSearch;
$('#btn-mini').onclick = () => toggleWidget();
$('#btn-demo').onclick = toggleDemo;
$('#btn-sound').onclick = toggleSound;
$('#btn-crt').onclick = toggleCrt;
$('#btn-help').onclick = toggleHelp;
$('#btn-balloons').onclick = toggleBalloons;
$('#btn-follow').onclick = toggleFollow;
$('#btn-pin').onclick = togglePin;
$('#btn-min').onclick = () => isApp && window.officeApp.minimize();
function showMaximized(on) { $('#btn-max').classList.toggle('on', !!on); }
$('#btn-max').onclick = async () => {
  if (!isApp || !window.officeApp.toggleMaximize) return;
  showMaximized(await window.officeApp.toggleMaximize());
};
$('#btn-close').onclick = () => isApp && window.officeApp.close();
window.addEventListener('keydown', e => {
  if (window.arcadeOpen && arcadeOpen()) return; // il cabinato ha i suoi tasti
  if (e.target.closest && e.target.closest('input,select,textarea')) return; // si sta scrivendo
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  // con la mappa, le squadre o il Libro aperti l'ufficio dietro non si vede: valgono solo Esc e il tasto che li chiude
  const over = window.worldMapOpen && worldMapOpen() ? 'g' : window.teamsOpen && teamsOpen() ? 'w' : window.bottegaOpen && bottegaOpen() ? '' : null;
  if (over !== null && k !== 'escape' && k !== over) return;
  if (k === 'd') toggleDemo();
  else if (k === 's') toggleSound();
  else if (k === 'c') toggleCrt();
  else if (k === 'h' || k === '?') toggleHelp();
  else if (k === 'p') togglePin();
  else if (k === 'b') toggleBalloons();
  else if (k === 'f') toggleFollow();
  else if (k === 't' || k === '0' || k === 'home') goTo(null);
  else if (k === 'a') goTo('archive');
  else if (k === 'r') goTo('relax');
  else if (k === '/' || k === 'k') { e.preventDefault(); toggleSearch(); }
  else if (k === 'm') toggleWidget();
  else if (k === 'o') toggleSettings();
  else if (k === 'w') { // squadre: workflow, squadre e messaggi del piano
    if (window.teamsOpen && teamsOpen()) closeTeams();
    else { const s = viewSid === 'replay' ? (replayFrame && replayFrame.session) : sessionById(viewSid); if (s && window.openTeams) openTeams(s.id); }
  }
  else if (k === 'g') { // mappa della realtà dell'agente selezionato (o del capo del piano)
    if (window.worldMapOpen && worldMapOpen()) closeWorldMap();
    else { const s = viewSid === 'replay' ? (replayFrame && replayFrame.session) : sessionById(viewSid); if (s) openWorldMap(s.id, focusId || 'main', viewSid === 'replay'); }
  }
  else if (k === ' ' && viewSid === 'replay' && replayFrame) { e.preventDefault(); api('/api/replay', { action: replayFrame.playing ? 'pause' : 'play' }); }
  else if (k === 'arrowup' || k === 'pageup') { e.preventDefault(); stepFloor(1); }
  else if (k === 'arrowdown' || k === 'pagedown') { e.preventDefault(); stepFloor(-1); }
  else if (/^[1-9]$/.test(k)) { const s = sessions()[Number(k) - 1]; if (s) goTo(s.id); }
  else if (k === '+' || k === '=') setZoom(zoom * 1.15);
  else if (k === '-') setZoom(zoom / 1.15);
  else if (k === 'escape') {
    // dall'area relax si torna in atrio, se non c'è niente di aperto da chiudere
    if (viewSid === 'relax' && $('#help').hidden && $('#settings').hidden && $('#search').hidden && !(window.worldMapOpen && worldMapOpen())) goTo(null);
    if (window.closeWorldMap) closeWorldMap(); if (window.closeBottega) closeBottega(); if (window.closeTeams) closeTeams(); hideInfo(); $('#help').hidden = true; $('#roomlist').hidden = true; { const sb = $('#settings'); if (!sb.hidden) { if (sb._tryClose) sb._tryClose(); else sb.hidden = true; } } roomListKey = null;
  }
});
window.addEventListener('resize', () => { if (snap) reconcile(); });

(async function boot() {
  document.body.classList.toggle('crt', crtOn);
  $('#btn-crt').classList.toggle('on', crtOn);
  $('#btn-sound').classList.toggle('on', soundOn);
  if (isApp && window.officeApp.getPin) $('#btn-pin').classList.toggle('on', !!(await window.officeApp.getPin()));
  if (isApp && window.officeApp.isMaximized) showMaximized(await window.officeApp.isMaximized());
  // anche doppio clic sulla barra o Win+↑: il bottone segue la finestra, non solo i propri click
  if (isApp && window.officeApp.onMaximized) window.officeApp.onMaximized(showMaximized);
  if (isApp && !window.officeApp.toggleMaximize) $('#btn-max').hidden = true; // shell più vecchia
  if (isApp && window.officeApp.onGoto) window.officeApp.onGoto(sid => { if (sessionById(sid)) goTo(sid); });
  try { await Promise.all([document.fonts.load('10px PS2P'), document.fonts.load('16px VT')]); } catch {}
  layoutLobby();
  connect();
  requestAnimationFrame(frame);
})();
