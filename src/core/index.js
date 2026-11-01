'use strict';
// Avvia il "cuore" dell'ufficio: stato + fonti + server HTTP locale (solo 127.0.0.1).
//   GET  /                   la pagina dell'ufficio
//   GET  /events             stream SSE dello stato (evento "replay" per il seminterrato)
//   POST /platypus-hook      eventi dagli hook di Claude Code (anche il vecchio /agent-office-hook)
//   POST /api/demo           {on}
//   POST /api/cowork         {on}
//   GET/POST /api/settings   soglie degli avvisi, budget, prezzo di stima
//   GET  /api/archive        sessioni passate
//   POST /api/replay         {action: start|play|pause|speed|seek|stop, key, value, at} (at: parti da quel momento, in pausa)
//   POST /api/focus          {sid}   porta in primo piano la finestra della sessione
//   POST /api/resume         {key}   riprende una sessione chiusa in un nuovo terminale
//   POST /api/open-folder    {sid|key}
//   GET  /api/bottega        {sid|cwd|key}  il Libro della bottega del progetto (lezioni dedotte dai fatti)
//   GET  /api/bottega/list   i progetti che hanno un libro
//   GET  /api/bottega/claudemd  {sid|cwd|key}  anteprima della sezione per il CLAUDE.md e se si può scrivere
//   POST /api/bottega/claudemd  {sid|cwd|key, confirm: true}  la scrive tra i marcatori (con copia di sicurezza)
//   POST /api/bottega        {sid|cwd, action: pin|ignore|unignore|forget, id}
//   POST /api/bottega/learn  {sid|cwd}  impara dalle sessioni passate del progetto (in background)
//   GET  /api/bottega/hints  {sid}  cosa direbbe il Nonno adesso: azioni in corso che corrispondono a una lezione
//   GET  /api/grounding      {sid, aid, replay}  mappa contro territorio: ricordi scaduti, modifiche alla cieca, percorsi inventati, affermazioni, sorprese

const { dataDir } = require('../paths');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OfficeState, DEFAULT_SETTINGS, displayName } = require('./state');
const worldmap = require('./worldmap');
const semantic = require('./semantic');
const grounding = require('./grounding');
const surprise = require('./surprise');
const { Bottega, digest, hints, renderSection, projectKey } = require('./bottega');
const claudemd = require('./claudemd');
const { TranscriptWatcher, SessionRegistry, claudeDir, findCoworkBases } = require('./sources');
const { Weather } = require('./weather');
const { describeTool } = require('./describe');
const crypto = require('crypto');
const i18n = require('../i18n');
const { tr } = i18n;
const { Demo } = require('./demo');
const { listArchive, findSessionFile, Replay } = require('./archive');
const osint = require('./osint');
const { Stats } = require('./stats');
const hooks = require('./hooks');

const DEFAULT_PORT = Number(process.env.PLATYPUS_PORT) || 47800;
const RENDERER = path.join(__dirname, '..', '..', 'renderer');
// pagine dell'ufficio: solo script e risorse del server locale (un'eventuale iniezione di HTML non potrebbe eseguire
// nulla), stili in linea ammessi (gli attributi style dei pannelli), e mai dentro un iframe di un'altra pagina
// (nessuno può farti cliccare "SÌ" su un permesso nascondendo l'ufficio sotto la sua pagina)
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function defaultSettingsPath() { return path.join(dataDir(), 'settings.json'); }
function loadSettings(p) { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; } }
function saveSettings(p, s) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s, null, 2)); } catch {} }

function startCore({ port = DEFAULT_PORT, base, includeCowork = true, settingsPath = defaultSettingsPath(), statsPath, bottegaDir, fetch: fetchImpl, osLocale } = {}) {
  const initialSettings = loadSettings(settingsPath);
  i18n.setLang(i18n.resolveLang(initialSettings.lang, osLocale));
  const state = new OfficeState({ settings: initialSettings });
  const stats = new Stats(state, statsPath || path.join(path.dirname(settingsPath), 'stats.json'));
  const bottega = new Bottega(bottegaDir || path.join(path.dirname(settingsPath), 'bottega'));
  // il libro impara dalle sessioni aperte: gli stessi fatti della mappa, una volta al minuto
  // (i casi già visti non contano due volte; la demo ha il suo libro finto)
  // e, per ogni progetto aperto, rilegge da sé le sessioni passate (una volta ogni 6 ore: quelle già lette non si rileggono)
  const ARCHIVE_EVERY = 6 * 3600000, archived = new Map();
  function learnLive() {
    let n = 0;
    if (!state.settings.bottegaLearn) return 0;
    for (const s of state.sessions.values()) {
      if (s.demo || !s.cwd) continue;
      try { const agents = agentsOf(s); if (agents.length) n += bottega.learn(s.cwd, digest(s, agents)); } catch {}
      const key = projectKey(s.cwd);
      if (Date.now() - (archived.get(key) || 0) < ARCHIVE_EVERY) continue;
      archived.set(key, Date.now());
      try { bottega.learnFromArchive(s.cwd, { base, settings: state.settings, liveIds: liveIds() }); } catch {}
    }
    return n;
  }
  const learnTimer = setInterval(learnLive, 60000);
  learnTimer.unref && learnTimer.unref();
  const learnSoon = setTimeout(learnLive, 15000); // le sessioni aperte all'avvio non aspettano il primo minuto
  learnSoon.unref && learnSoon.unref();
  state.includeCowork = !!includeCowork;
  const watcher = new TranscriptWatcher(state, { base });
  const registry = new SessionRegistry(state, watcher, { base });
  const demo = new Demo(state, { bottega });
  const weather = new Weather(state, fetchImpl ? { fetch: fetchImpl } : {});
  const clients = new Set();
  let replay = null;

  // ---- sessioni Cowork dell'app desktop: cartelle trovate sotto %APPDATA%\Claude ecc.
  const coworkWatchers = new Map(); // base -> TranscriptWatcher
  const ACTIVE_MS = 36 * 3600 * 1000; // seguiamo solo le cartelle usate nelle ultime 36 ore
  function scanCowork() {
    let r;
    try { r = findCoworkBases(state.settings.coworkDirs, [base || claudeDir()]); } catch (e) { r = { roots: [], bases: [], error: e.message }; }
    const now = Date.now();
    for (const b of r.bases) {
      if (coworkWatchers.has(b.path) || now - (b.newest || 0) > ACTIVE_MS) continue;
      const w = new TranscriptWatcher(state, { base: b.path, forceCowork: true });
      coworkWatchers.set(b.path, w);
      w.start();
    }
    state.coworkScan = {
      t: now,
      roots: r.roots,
      bases: r.bases.slice(0, 40).map(b => ({ path: b.path, files: b.files, newest: b.newest, watched: coworkWatchers.has(b.path) })),
      found: r.bases.length,
      watched: coworkWatchers.size,
    };
  }
  const coworkTimer = setInterval(scanCowork, 90 * 1000);

  // ---- altre installazioni di Claude Code sullo stesso computer: cartelle indicate nelle opzioni
  // o in PLATYPUS_CLAUDE_DIRS, e su Windows le distribuzioni WSL accese (\\wsl.localhost\<distro>\home\<utente>\.claude)
  const extraWatchers = new Map();
  async function wslClaudeDirs() {
    if (process.platform !== 'win32') return [];
    const out = await new Promise(res => require('child_process').execFile('wsl.exe', ['-l', '--running', '-q'], { timeout: 5000, windowsHide: true, encoding: 'buffer' },
      (err, buf) => res(err ? '' : Buffer.from(buf).toString('utf16le').replace(/\0/g, ''))));
    const dirs = [];
    for (const d of out.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
      for (const root of [`\\\\wsl.localhost\\${d}`, `\\\\wsl$\\${d}`]) {
        try {
          for (const u of fs.readdirSync(path.join(root, 'home'))) { const c = path.join(root, 'home', u, '.claude'); if (fs.existsSync(path.join(c, 'projects'))) dirs.push(c); }
          const r = path.join(root, 'root', '.claude'); if (fs.existsSync(path.join(r, 'projects'))) dirs.push(r);
          break;
        } catch {}
      }
    }
    return dirs;
  }
  async function scanExtraClaude() {
    const list = String(state.settings.claudeDirs || '') + ';' + (process.env.PLATYPUS_CLAUDE_DIRS || '');
    const dirs = list.split(/[;\n]/).map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean).concat(await wslClaudeDirs().catch(() => []));
    const main = path.resolve(base || claudeDir()).toLowerCase();
    for (const d of new Set(dirs)) {
      const abs = path.resolve(d.replace(/^~(?=$|[\\/])/, os.homedir()));
      if (abs.toLowerCase() === main || extraWatchers.has(abs) || !fs.existsSync(path.join(abs, 'projects'))) continue;
      const w = new TranscriptWatcher(state, { base: abs });
      extraWatchers.set(abs, w);
      w.start();
    }
    state.extraClaude = [...extraWatchers.keys()];
  }
  const extraTimer = setInterval(() => scanExtraClaude().catch(() => {}), 120 * 1000);

  // ---- permessi approvabili dall'ufficio: l'hook PermissionRequest resta in attesa della tua risposta
  const approvals = new Map(); // id -> {id, sid, agentId, tool, text, suggestions, res, timer}
  state.approvals = approvals;
  const HOLD_SKIP = new Set(['AskUserQuestion']);
  function holdPermission(j, req, res) {
    const wait = Math.max(5, Math.min(600, Number(state.settings.approveWaitSec) || 120));
    const id = crypto.randomBytes(6).toString('hex');
    const ap = {
      id, sid: j.session_id, agentId: j.agent_id || 'main', tool: j.tool_name || '',
      text: describeTool(j.tool_name, j.tool_input), suggestions: Array.isArray(j.permission_suggestions) ? j.permission_suggestions : null,
      res, t: Date.now(),
    };
    ap.always = !!(ap.suggestions && ap.suggestions.length);
    ap.timer = setTimeout(() => finishApproval(id, null), wait * 1000);
    approvals.set(id, ap);
    // se rispondi nel terminale, Claude Code chiude l'hook: togliamo la richiesta
    res.on('close', () => { if (approvals.get(id) === ap) { clearTimeout(ap.timer); approvals.delete(id); state.touch(); } });
    state.touch();
  }
  function finishApproval(id, decision) {
    const ap = approvals.get(id);
    if (!ap) return false;
    clearTimeout(ap.timer);
    approvals.delete(id);
    let out = null;
    if (decision === 'allow' || decision === 'always') {
      out = { behavior: 'allow' };
      if (decision === 'always' && ap.always) out.updatedPermissions = ap.suggestions;
    } else if (decision === 'deny') {
      out = { behavior: 'deny', message: tr('L\'utente ha rifiutato questa richiesta dall\'ufficio (Platypus).') };
    }
    try {
      if (out) { ap.res.writeHead(200, { 'Content-Type': 'application/json' }); ap.res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: out } })); }
      else { ap.res.writeHead(204); ap.res.end(); } // tempo scaduto: decide il terminale come sempre
    } catch {}
    if (out) {
      const s = state.sessions.get(ap.sid);
      const a = s && (ap.agentId === 'main' ? s.main : s.subs.get(ap.agentId));
      if (a) {
        state.setAgent(a, 'thinking', decision === 'deny' ? tr('Permesso negato dall\'ufficio') : tr('Permesso concesso dall\'ufficio'));
        state.addLog(s, decision === 'deny' ? tr('Hai rifiutato: {what}', { what: ap.text }) : tr('Hai approvato: {what}', { what: ap.text }), decision === 'deny' ? 'end' : 'release');
      }
    }
    state.touch();
    return true;
  }

  let hooksCache = { t: 0, v: false };
  function hooksInstalled() {
    if (Date.now() - hooksCache.t > 5000) hooksCache = { t: Date.now(), v: hooks.status({ base }) };
    return hooksCache.v;
  }
  function payload() {
    const snap = state.snapshot();
    snap.hooks.installed = hooksInstalled();
    snap.replay = replay ? { key: replay.key } : null;
    return 'data: ' + JSON.stringify(snap) + '\n\n';
  }
  function broadcast(text) { for (const c of clients) c.write(text); }
  state.on('change', () => broadcast(payload()));
  const hb = setInterval(() => broadcast(payload()), 2000);
  function sendReplayFrame(fr) { broadcast('event: replay\ndata: ' + JSON.stringify({ key: replay && replay.key, title: replay && replay.title, ...fr }) + '\n\n'); }

  // mappa della realtà di un agente (o di tutta la sessione): territorio + traiettoria
  function agentMap(q) {
    const st = q.get('replay') ? (replay && replay.state) : state;
    const s = st && st.sessions.get(q.get('sid') || '');
    if (!s) return { ok: false };
    const aid = q.get('aid') || 'main';
    const list = aid === 'all' ? [s.main, ...s.subs.values()] : [aid === 'main' ? s.main : s.subs.get(aid)].filter(Boolean);
    const merged = new Map();
    const trajectories = [];
    for (const a of list) {
      if (!a.world) continue;
      const j = a.world.toJSON(a.id);
      for (const row of j.nodes) {
        const prev = merged.get(row[0]);
        if (!prev) { merged.set(row[0], row.slice(0, 7).concat([[a.id]])); continue; }
        const mn = (x, y) => (x && y ? Math.min(x, y) : x || y);
        prev[1] = mn(prev[1], row[1]); prev[2] = mn(prev[2], row[2]); prev[3] = mn(prev[3], row[3]);
        prev[4] = prev[4] || row[4]; prev[5] += row[5]; prev[6] = Math.max(prev[6], row[6]);
        if (prev[7].length < 6) prev[7].push(a.id);
      }
      if (trajectories.length < 40) trajectories.push({ id: a.id, name: displayName(a), type: a.type, steps: aid === 'all' ? j.steps.slice(-150) : j.steps });
    }
    const tree = s.demo ? { available: !!s.demoTree, files: s.demoTree || [] } : worldmap.scanTree(s.cwd);
    const nodes = worldmap.resolveAgainstTree([...merged.values()], tree);
    return { ok: true, sid: s.id, aid, cwd: s.cwd, now: st.now(), tree, nodes, trajectories, dims: worldmap.DIMS };
  }

  // contesto (bolla) e obiettivo (stella polare) di un agente o di tutta la sessione — sperimentale
  function agentMind(q) {
    const st = q.get('replay') ? (replay && replay.state) : state;
    const s = st && st.sessions.get(q.get('sid') || '');
    if (!s || !s.corpus) return { ok: false };
    const aid = q.get('aid') || 'main';
    const list = aid === 'all' ? [s.main, ...s.subs.values()] : [aid === 'main' ? s.main : s.subs.get(aid)].filter(Boolean);
    const minds = list.filter(a => a.mind && a.mind.pieces.length).slice(0, 40).map(a => ({ id: a.id, name: displayName(a), mind: a.mind, ctx: a.ctx || 0 }));
    if (!minds.length) return { ok: true, empty: true, sid: s.id, aid };
    try {
      const v = semantic.snapshotMinds(minds, s.corpus, (q.get('replay') ? 'r:' : '') + s.id + ':' + aid);
      return { ok: true, sid: s.id, aid, now: st.now(), names: Object.fromEntries(minds.map(m => [m.id, m.name])), ctxNow: Object.fromEntries(minds.map(m => [m.id, m.ctx])), ...v };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // gli agenti di una sessione con la loro mappa, per grounding.js, surprise.js e bottega.js
  function agentsOf(s) {
    return [s.main, ...s.subs.values()].filter(a => a.world).map(a => ({ id: a.id, name: displayName(a), world: a.world, mind: a.mind }));
  }

  // mappa contro territorio di un agente (o di tutta la sessione): calcolata solo su richiesta
  function agentGrounding(q) {
    const isReplay = !!q.get('replay');
    const st = isReplay ? (replay && replay.state) : state;
    const s = st && st.sessions.get(q.get('sid') || '');
    if (!s) return { ok: false };
    const aid = q.get('aid') || 'main';
    const agents = agentsOf(s);
    const only = aid === 'all' ? null : new Set([aid]);
    try {
      const opts = { only, replay: isReplay };
      return { ok: true, sid: s.id, aid, now: st.now(), ...grounding.checkStale(s, agents, s.cwd, opts), ...grounding.findGhosts(s, agents, s.cwd, opts), ...grounding.checkClaims(s, agents, s.cwd, opts), ...surprise.surprises(agents, { ...opts, now: st.now() }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // la cartella del progetto: dalla sessione (anche in replay) o passata direttamente
  function projectCwd(q) {
    const sid = q.sid || '';
    const s = sid && (state.sessions.get(sid) || (replay && replay.state.sessions.get(sid)));
    if (s) return s.cwd;
    if (typeof q.key === 'string' && /^[0-9a-f]{16}$/.test(q.key)) return bottega.cwdOfKey(q.key);
    return typeof q.cwd === 'string' ? q.cwd.slice(0, 500) : '';
  }

  // la sezione per il CLAUDE.md del progetto: testo, percorso e se si può scrivere (mai Cowork, mai la demo)
  function claudeMdPlan(q) {
    const cwd = projectCwd(q);
    if (!cwd) return null;
    const v = bottega.view(cwd);
    const norm = x => String(x || '').replace(/\\/g, '/').toLowerCase();
    const same = [...state.sessions.values()].filter(s => norm(s.cwd) === norm(cwd));
    const markdown = renderSection(v.lessons, v.name);
    let why = '';
    if (same.some(s => s.demo)) why = 'demo';
    else if (same.some(s => s.kind === 'cowork')) why = 'cowork';
    else { const cw = claudemd.canWrite(cwd); if (!cw.ok) why = cw.reason; }
    return { cwd, markdown, path: require('path').join(cwd, 'CLAUDE.md'), writable: !why && !!markdown, reason: why || (markdown ? '' : 'empty') };
  }

  function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
  function liveIds() { return new Set([...state.sessions.values()].filter(s => !s.ended).map(s => s.id)); }

  async function handlePost(url, body, res, req) {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch {}
    switch (url.pathname) {
      case hooks.MARK:
      case hooks.LEGACY:
        try {
          if (process.env.PLATYPUS_DEBUG) console.log('[hook]', j.hook_event_name, j.agent_type || '', j.tool_name || '', j.notification_type || '');
          state.applyHook(j);
        } catch {}
        res.writeHead(204); return res.end(); // nessun output: Claude Code non deve ricevere nulla
      case hooks.MARK + '/permission':
      case hooks.LEGACY + '/permission': {
        // hook sincrono: se l'ufficio è aperto e lo vuoi, tieni la richiesta finché non rispondi
        try { state.applyHook(j); } catch {}
        const hold = j.hook_event_name === 'PermissionRequest' && state.settings.approveFromOffice !== false &&
          clients.size > 0 && j.session_id && !HOLD_SKIP.has(j.tool_name) && !replay;
        if (!hold) { res.writeHead(204); return res.end(); }
        return holdPermission(j, req, res);
      }
      case '/api/approve': {
        if (j.demo) { // demo: nessun hook da sbloccare, aggiorniamo solo l'ufficio
          const ds = state.sessions.get(j.sid);
          const a = ds && ds.demo && (j.agentId === 'main' ? ds.main : ds.subs.get(j.agentId));
          if (!a) return json(res, 404, { ok: false });
          state.setAgent(a, j.decision === 'deny' ? 'thinking' : 'working', j.decision === 'deny' ? tr('Permesso negato dall\'ufficio') : tr('Permesso concesso dall\'ufficio'));
          state.addLog(ds, j.decision === 'deny' ? tr('Hai rifiutato dall\'ufficio') : tr('Hai approvato dall\'ufficio'), j.decision === 'deny' ? 'end' : 'release');
          state.touch();
          return json(res, 200, { ok: true });
        }
        const ok = finishApproval(String(j.id || ''), ['allow', 'deny', 'always'].includes(j.decision) ? j.decision : 'deny');
        return json(res, ok ? 200 : 404, { ok, reason: ok ? '' : tr('La richiesta non è più in attesa (forse hai già risposto nel terminale).') });
      }
      case '/api/cowork-scan':
        scanCowork();
        return json(res, 200, state.coworkScan);
      case '/api/cowork':
        state.setIncludeCowork(typeof j.on === 'boolean' ? j.on : !state.includeCowork);
        return json(res, 200, { includeCowork: state.includeCowork });
      case '/api/bottega/claudemd': {
        const p = claudeMdPlan(j);
        if (!p) return json(res, 404, { ok: false });
        if (j.confirm !== true) return json(res, 400, { ok: false, reason: 'confirm' }); // mai in automatico
        if (!p.writable) return json(res, 409, { ok: false, reason: p.reason });
        return json(res, 200, { path: p.path, ...claudemd.upsertSection(p.path, p.markdown) });
      }
      case '/api/bottega/learn': {
        const cwd = projectCwd(j);
        if (!cwd) return json(res, 404, { ok: false });
        if (!state.settings.bottegaLearn) return json(res, 409, { ok: false, reason: tr('L\'apprendimento del Libro della bottega è spento nelle opzioni.') });
        const job = bottega.learnFromArchive(cwd, { base, settings: state.settings, liveIds: liveIds() });
        return json(res, 200, { ok: true, learning: { running: job.running, total: job.total, done: job.done } });
      }
      case '/api/bottega': {
        const cwd = projectCwd(j);
        if (!cwd) return json(res, 404, { ok: false });
        const ok = bottega.act(cwd, String(j.action || ''), String(j.id || ''));
        return json(res, ok ? 200 : 404, { ok });
      }
      case '/api/demo': {
        const on = typeof j.on === 'boolean' ? j.on : !demo.on;
        on ? demo.start() : demo.stop();
        return json(res, 200, { demo: demo.on });
      }
      case '/api/settings': {
        const before = { city: state.settings.weatherCity, dirs: state.settings.coworkDirs, lang: state.settings.lang };
        const s = state.setSettings(j);
        saveSettings(settingsPath, s);
        if (before.lang !== s.lang) {
          i18n.setLang(i18n.resolveLang(s.lang, osLocale));
          if (demo.on) { demo.stop(); demo.start(); } // la demo ricomincia nella nuova lingua
          state.emit('lang', i18n.getLang());
        }
        if (before.city !== s.weatherCity) weather.refresh(true);
        if (before.dirs !== s.coworkDirs) scanCowork();
        scanExtraClaude().catch(() => {});
        return json(res, 200, s);
      }
      case '/api/replay': {
        if (j.action === 'start') {
          const file = findSessionFile(base, j.key);
          if (!file) return json(res, 404, { error: tr('Sessione non trovata') });
          if (replay) replay.stop();
          try {
            replay = new Replay({ file, base, settings: state.settings });
          } catch (e) { replay = null; return json(res, 400, { error: e.message }); }
          replay.key = j.key;
          const info = listArchive({ base, limit: 300 }).find(x => x.key === j.key);
          replay.title = info ? (info.kind === 'cowork' ? info.title || info.project : info.project) : '';
          replay.on('frame', sendReplayFrame);
          if (j.speed) replay.control('speed', j.speed);
          // dal Libro della bottega: il replay parte poco prima del momento della prova, in pausa
          const at = Number(j.at);
          if (at > replay.start) { replay.seek(Math.max(0, (at - 5000 - replay.start) / Math.max(1, replay.end - replay.start))); replay.control('pause'); }
          broadcast(payload());
          return json(res, 200, { ok: true, key: j.key });
        }
        if (!replay) return json(res, 409, { error: tr('Nessun replay in corso') });
        if (j.action === 'stop') { replay.stop(); replay = null; broadcast('event: replay\ndata: null\n\n'); broadcast(payload()); return json(res, 200, { ok: true }); }
        replay.control(j.action, j.value);
        return json(res, 200, { ok: true });
      }
      case '/api/focus': {
        const s = state.sessions.get(j.sid);
        if (!s) return json(res, 404, { ok: false, reason: tr('Sessione non trovata') });
        return json(res, 200, await osint.focusSession({ pid: s.pid, kind: s.kind, cwd: s.cwd }));
      }
      case '/api/resume': {
        const info = listArchive({ base, limit: 300 }).find(x => x.key === j.key);
        if (!info) return json(res, 404, { ok: false, reason: tr('Sessione non trovata') });
        if (info.kind === 'cowork') return json(res, 400, { ok: false, reason: tr('Le sessioni Cowork si riprendono dall\'app Claude.') });
        if (liveIds().has(info.id)) return json(res, 409, { ok: false, reason: tr('La sessione è ancora aperta.') });
        return json(res, 200, await osint.resumeSession({ cwd: info.cwd, id: info.id }));
      }
      case '/api/open-folder': {
        let cwd = '';
        if (j.sid && state.sessions.get(j.sid)) cwd = state.sessions.get(j.sid).cwd;
        else if (j.key) { const info = listArchive({ base, limit: 300 }).find(x => x.key === j.key); cwd = info ? info.cwd : ''; }
        return json(res, 200, osint.openFolder(cwd));
      }
      default:
        res.writeHead(404); return res.end();
    }
  }

  const ownOrigin = o => { const m = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/.exec(o); return !!m && Number(m[1]) === server.address().port; };
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); return res.end(); } // es. "GET http://[ HTTP/1.1"
    // accetta solo richieste locali dirette (anche contro il DNS rebinding)
    const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
    if (!hostOk) { res.writeHead(403); return res.end(); }
    // e dalle pagine dell'ufficio soltanto: un'altra pagina su localhost (un dev server, un notebook) ha un'altra porta
    // e non deve poter cambiare le opzioni, scrivere il CLAUDE.md o aprire terminali. Senza Origin: hook (curl) e programmi locali.
    if (req.headers.origin && !ownOrigin(req.headers.origin)) {
      res.writeHead(403); return res.end();
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => { handlePost(url, body, res, req).catch(e => json(res, 500, { ok: false, reason: e.message })); });
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      clients.add(res);
      res.write(payload());
      if (replay) res.write('event: replay\ndata: ' + JSON.stringify({ key: replay.key, title: replay.title, ...replay.frame() }) + '\n\n');
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state') return json(res, 200, state.snapshot());
    if (url.pathname === '/i18n.js') { // traduzioni per la pagina (la lingua scelta nelle opzioni)
      const lang = i18n.getLang();
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end('window.AO_I18N=' + JSON.stringify({ lang, locale: i18n.localeTag(lang), dict: i18n.dict(lang), langs: i18n.LANGS }) + ';');
    }
    if (url.pathname === '/api/settings') return json(res, 200, state.settings);
    if (url.pathname === '/api/cowork-scan') return json(res, 200, state.coworkScan || {});
    if (url.pathname === '/api/agentmap') return json(res, 200, agentMap(url.searchParams));
    if (url.pathname === '/api/agentmind') return json(res, 200, agentMind(url.searchParams));
    if (url.pathname === '/api/grounding') return json(res, 200, agentGrounding(url.searchParams));
    if (url.pathname === '/api/bottega/list') return json(res, 200, { ok: true, books: bottega.list() });
    if (url.pathname === '/api/bottega/claudemd') { const p = claudeMdPlan(Object.fromEntries(url.searchParams)); return p ? json(res, 200, { ok: true, ...p }) : json(res, 404, { ok: false }); }
    if (url.pathname === '/api/bottega/hints') {
      const s = state.sessions.get(url.searchParams.get('sid') || '');
      if (!s || !s.cwd) return json(res, 404, { ok: false });
      try { return json(res, 200, { ok: true, hints: hints(s, agentsOf(s), bottega.view(s.cwd).lessons, state.now()) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/bottega') {
      const cwd = projectCwd(Object.fromEntries(url.searchParams));
      return cwd ? json(res, 200, { ok: true, ...bottega.view(cwd) }) : json(res, 404, { ok: false });
    }
    if (url.pathname === '/api/stats/costs') return json(res, 200, stats.costHistory(Math.min(90, Number(url.searchParams.get('days')) || 14)));
    if (url.pathname === '/api/stats/honors') return json(res, 200, stats.honors());
    if (url.pathname === '/api/report') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : undefined;
      return json(res, 200, stats.report(day));
    }
    if (url.pathname === '/api/archive') {
      try { return json(res, 200, listArchive({ base, liveIds: liveIds() })); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    // file statici
    let rel;
    // un percorso con un "%" sbagliato (es. "/%") non deve far cadere il server
    try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname === '/report' ? '/report.html' : url.pathname); }
    catch { res.writeHead(400); return res.end(); }
    // un byte nullo farebbe lanciare fs.readFile (e cadere il server): basta un <img src=".../%00"> in una pagina web
    if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
    const file = path.normalize(path.join(RENDERER, rel));
    // dentro renderer/ e basta: senza il separatore passerebbe anche una cartella sorella come renderer-old/
    if (!file.startsWith(RENDERER + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('404'); }
      const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
      if (path.extname(file) === '.html') Object.assign(headers, { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
      res.writeHead(200, headers);
      res.end(data);
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      watcher.start();
      registry.start();
      weather.start();
      try { scanCowork(); } catch {}
      scanExtraClaude().catch(() => {});
      // hook di una versione precedente (senza approvazione dall'ufficio): aggiornali
      try { if (hooks.status({ base }) && hooks.outdated({ base })) hooks.install({ port, base }); } catch {}
      resolve({ port });
    });
  });

  function stop() {
    clearInterval(hb);
    watcher.stop();
    registry.stop();
    demo.stop();
    weather.stop();
    clearInterval(coworkTimer);
    clearInterval(extraTimer);
    for (const w of extraWatchers.values()) w.stop();
    for (const w of coworkWatchers.values()) w.stop();
    for (const id of [...approvals.keys()]) finishApproval(id, null);
    if (replay) replay.stop();
    stats.stop();
    clearInterval(learnTimer); clearTimeout(learnSoon);
    bottega.stop();
    state.stop();
    for (const c of clients) try { c.end(); } catch {}
    server.close();
  }

  return { state, stats, bottega, learnLive, demo, server, ready, stop, port, base: base || claudeDir(), hooks: {
    install: () => hooks.install({ port, base }),
    uninstall: () => hooks.uninstall({ base }),
    status: () => hooks.status({ base }),
  } };
}

module.exports = { startCore, DEFAULT_PORT };
