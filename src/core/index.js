'use strict';
// Avvia il "cuore" dell'ufficio: stato + fonti + server HTTP locale (solo 127.0.0.1).
//   GET  /                   la pagina dell'ufficio
//   GET  /events             stream SSE dello stato (evento "replay" per il seminterrato)
//   GET  /api/shell/events   stream SSE per le shell: solo contatori e notifiche (notify.js)
//   POST /platypus-hook      eventi dagli hook di Claude Code (anche il vecchio /agent-office-hook)
//   POST /platypus-hook/feedback  hook sincrono: quello che Platypus dice all'agente (o 204), sempre entro un tempo massimo
//   GET  /api/feedback/hooks  gli hook di feedback: installati o no, e le righe che l'installazione scriverebbe
//   POST /api/feedback/hooks  {action: install|uninstall, confirm: true}  li scrive o li toglie da settings.json
//   GET  /api/feedback/log    {sid|cwd|key}  i messaggi agli agenti di un progetto, mandati e in ombra
//   GET  /api/feedback/counts quanti messaggi per funzione negli ultimi 7 giorni
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
//   GET  /api/embed          il motore del significato: fonte in uso, stato di ogni fonte, cache (vedi embed/)
//   GET  /api/grounding      {sid, aid, replay}  mappa contro territorio: ricordi scaduti, modifiche alla cieca, percorsi inventati, affermazioni, sorprese

const { dataDir } = require('../paths');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OfficeState, DEFAULT_SETTINGS, displayName } = require('./state');
const worldmap = require('./worldmap');
const semantic = require('./semantic');
const { Embedder } = require('./embed');
const grounding = require('./grounding');
const surprise = require('./surprise');
const { Bottega, digest, hints, renderSection, projectKey, normDir } = require('./bottega');
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
const { History } = require('./history');
const { runRetention } = require('./retention');
const experiments = require('./experiments');
const fear = require('./fear');
const historyQuery = require('./history-query');
const search = require('./search');
const { demoHistoryStore } = require('./demo-history');
const hooks = require('./hooks');
const feedback = require('./feedback');
const { FeedbackLog, MemoryFeedbackLog } = require('./feedbacklog');
const outcomes = require('./outcomes');
const { Notifier } = require('./notify');
require('./feedback-rules'); // aggiunge le regole a feedback.RULES

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

function startCore({ port = DEFAULT_PORT, base, includeCowork = true, settingsPath = defaultSettingsPath(), fetch: fetchImpl, osLocale } = {}) {
  const initialSettings = loadSettings(settingsPath);
  i18n.setLang(i18n.resolveLang(initialSettings.lang, osLocale));
  const state = new OfficeState({ settings: initialSettings });
  // lo storico (store): accanto alle opzioni, in platypus.db. Se non si apre si va avanti in memoria e l'ufficio lo dice
  const history = new History({ dir: path.dirname(settingsPath), settings: initialSettings });
  // ogni azione finita diventa un passo nello storico; i riassunti delle sessioni ogni minuto e alla chiusura
  state.on('step', (s, a, step) => { try { history.recordStep(s, a, step); } catch {} });
  state.on('risk', (s, a, step) => { try { history.recordRisk(s, a, step); } catch {} }); // le azioni rischiose (2.14)
  const summaryTimer = setInterval(() => { try { history.summarize(state, { counts: sessionCounts }); } catch {} }, 60000);
  summaryTimer.unref && summaryTimer.unref();
  const stats = new Stats(state, { store: history.store }); // nello storico, collezione daily
  // il Libro della bottega, nello storico. La cartella di un progetto (lo storico non la tiene) la cerca il motore
  const bottega = new Bottega({ store: history.store, keys: history.keys, cwdOf: projectFolder, isDemo: cwd => isDemoCwd(cwd) });
  // le notifiche (attese, avvisi, report): le decide il motore, le mostra la shell
  // (shellInfo: le voci del menu dei gusci esterni; si chiama solo più tardi, quando hook e demo esistono già)
  const notifier = new Notifier(state, {
    stats, memo: { get: k => history.store.getMeta(k), set: (k, v) => history.store.setMeta(k, String(v)) }, // nello storico, non in notify.json
    shellInfo: () => ({ hooks: hooksInstalled(), demo: demo.on, cowork: !!state.includeCowork, base: base || claudeDir() }),
  }).start();
  // il libro impara dalle sessioni aperte: gli stessi fatti della mappa, una volta al minuto
  // (i casi già visti non contano due volte; la demo ha il suo libro finto)
  // e, per ogni progetto aperto, rilegge da sé le sessioni passate (una volta ogni 6 ore: quelle già lette non si rileggono)
  const ARCHIVE_EVERY = 6 * 3600000, archived = new Map();
  function learnLive() {
    let n = 0;
    const learning = !!state.settings.bottegaLearn;
    for (const s of state.sessions.values()) {
      if (!s.cwd) continue;
      // le cicatrici (2.14): il danno visto dopo un'azione rischiosa va sul passo (anche nella demo, per l'ufficio)
      // e nel suo evento nello storico (la demo non scrive: recordRisk la salta). Vale anche se il Libro non impara
      try { const agents = agentsOf(s); for (const sc of fear.markScars(s, agents)) history.recordRisk(s, { id: sc.agent }, sc.step); } catch {}
      if (s.demo || !learning) continue;
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
  const demo = new Demo(state, { bottega, feedback: j => feedbackAnswer(j), dropFeedback: () => dropDemoFeedback() });
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
      if (b.meta && b.meta.isArchived === true) continue; // archiviata nell'app: non la seguiamo
      const w = new TranscriptWatcher(state, { base: b.path, forceCowork: true });
      coworkWatchers.set(b.path, w);
      w.start();
    }
    // i titoli dell'app (arrivano dai metadati della sessione): subito, e di nuovo quando i transcript appena aperti hanno creato le sessioni
    const applyMeta = () => { for (const b of r.bases) if (b.meta) state.applyCoworkMeta(b.meta); };
    applyMeta();
    const t = setTimeout(applyMeta, 6000); if (t.unref) t.unref();
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

  // ---- feedback agli agenti: risposta sincrona agli hook. Mai un errore, mai un'attesa: se non c'è niente di pronto, 204
  // e Claude Code prosegue come se Platypus non ci fosse.
  const FEEDBACK_MS = 300;
  const feedbackStats = { calls: 0, said: 0, shadow: 0, late: 0, errors: 0 };
  const feedbackLog = new FeedbackLog({ store: history.store, keys: history.keys }); // nello storico, collezione feedback
  const embedder = new Embedder({ settings: state.settings, dir: path.join(path.dirname(settingsPath), 'embed-cache'), deps: { modelsDir: path.join(path.dirname(settingsPath), 'models') } }); // significato neurale (embed/)
  const feedbackGate = new feedback.Gate(); // i limiti di frequenza, in memoria: ripartono con Platypus
  // la demo (C3): agenti finti, quindi ogni funzione nel modo più alto che ha nella 2.11, qualunque cosa dicano le
  // opzioni; un registro tutto suo, in memoria, che si svuota quando la demo finisce
  const demoFeedbackLog = new MemoryFeedbackLog();
  const DEMO_FEEDBACK = { fbSessionLessons: 'on', fbElder: 'on', fbLoop: 'on', fbStale: 'shadow', fbClaims: 'shadow', fbDrift: 'shadow' };
  const isDemoCwd = cwd => { const k = normDir(cwd); return [...state.sessions.values()].some(x => x.demo && normDir(x.cwd) === k); };
  // PLATYPUS_FEEDBACK_CHECK=1: solo per la prova su una sessione vera (docs/plans/2.11-real-check.md)
  const FEEDBACK_CHECK = process.env.PLATYPUS_FEEDBACK_CHECK === '1';
  function feedbackHook(j, res, req) {
    if (FEEDBACK_CHECK) {
      feedbackStats.calls++;
      let a = null;
      try { a = feedback.checkAnswer(j); } catch {}
      console.log('[feedback-check]', (j && j.hook_event_name) || '?', (j && j.tool_name) || '-', 'agent=' + ((j && j.agent_id) || 'main'), 'origin=' + ((req && req.headers.origin) || '-'), a ? '→ ' + (a.decision || 'context') : '→ 204');
      try { if (a) json(res, 200, a); else { res.writeHead(204); res.end(); } } catch {}
      return;
    }
    const out = feedbackAnswer(j);
    try {
      if (out) json(res, 200, out);
      else { res.writeHead(204); res.end(); }
    } catch {}
  }
  // la risposta per Claude Code (null = niente da dire), con tutto quello che ci gira intorno: registro, fumetti, esiti.
  // La chiamano l'hook vero e la demo, che recita i suoi scenari senza passare dalla rete.
  function feedbackAnswer(j) {
    const t0 = Date.now();
    let out = null, entry = null, cwd = '', log = feedbackLog;
    feedbackStats.calls++;
    try {
      const ev = j && j.hook_event_name;
      // a fine turno le ultime righe del transcript possono non essere ancora lette: servono per giudicare il turno
      if (ev === 'Stop' || ev === 'SubagentStop') { try { watcher.pollTracked(); } catch {} }
      const s = (j && state.sessions.get(j.session_id)) || null;
      // la cartella del progetto è quella della sessione, se la conosciamo: quella dell'hook cambia quando l'agente fa cd
      cwd = (s && s.cwd) || (j && j.cwd) || '';
      if (s && s.demo) log = demoFeedbackLog; // la demo non lascia righe nel registro vero
      const r = feedback.respond(j, {
        now: Date.now, deadline: t0 + FEEDBACK_MS, session: s, cwd, settings: s && s.demo ? DEMO_FEEDBACK : state.settings,
        lessons: cwd => { try { return bottega.view(cwd).lessons; } catch { return []; } },
        muted: cwd => bottega.muted(cwd),
        // i progetti della demo sono finti: anche se una cartella con quel nome esiste sul computer, non la guardiamo
        hasSection: cwd => (s && s.demo ? false : claudemd.hasSection(cwd)),
        // i passi già visti dell'agente che ha mandato l'hook (il principale, o il sottoagente con quell'identificativo)
        agent: i => { const a = s && (i.agent_id ? s.subs.get(i.agent_id) : s.main); return a && a.world ? { id: a.id, steps: a.world.steps, nodes: a.world.nodes, goals: (a.mind && a.mind.goals) || [], mind: a.mind || null, corpus: s.corpus || null, space: a.mind && s.corpus ? semantic.pickSpace([a.mind], s.corpus, [embedder.space(1, { demo: !!s.demo })]) : null } : null; },
        waiting: i => { const a = s && (i.agent_id ? s.subs.get(i.agent_id) : s.main); return !!(a && state.userPending(s, a, i.agent_id || null)); },
        agentName: i => { const a = s && (i.agent_id ? s.subs.get(i.agent_id) : s.main); return a ? displayName(a) : ''; },
        // tutti gli agenti della sessione, con il nome che hanno in ufficio (serve a dire chi ha cambiato un file)
        team: () => (s ? [s.main, ...s.subs.values()].filter(a => a && a.world).map(a => ({ id: a.id, name: displayName(a), nodes: a.world.nodes })) : []),
        log,
      }, feedbackGate);
      out = r.out; entry = r.entry;
      if (entry && entry.mode === 'shadow') feedbackStats.shadow++;
      // in esperimento: il gruppo della sessione resta nello storico (mai per la demo)
      if (entry && entry.group && !(s && s.demo)) history.recordExperiment({ cwd, sid: entry.sid, feature: entry.feature, group: entry.group, t: entry.t });
    } catch { feedbackStats.errors++; out = null; }
    // calcolata tardi: non la mandiamo (la regola del tempo massimo vale anche per noi)
    if (out && Date.now() - t0 > FEEDBACK_MS) {
      feedbackStats.late++; out = null;
      try { if (entry && entry.id) log.setOutcome(cwd, entry.id, 'late'); } catch {} // nel registro risultava mandata: non lo è stata
      try { if (entry && entry.lessonId) feedbackGate.untell(j, entry.lessonId); } catch {}
    }
    if (out) feedbackStats.said++;
    // l'ufficio lo mostra sull'agente per un po': mandato davvero, oppure in ombra («avrebbe detto»)
    if (entry && (out || entry.mode === 'shadow')) {
      feedbackSaid.push({ id: entry.id || '', sid: entry.sid, agent: entry.agent, feature: entry.feature, mode: entry.mode, text: entry.local || entry.text, t: entry.t });
      if (feedbackSaid.length > 60) feedbackSaid.shift();
      try { state.touch(); } catch {}
      // e aspetta il suo esito (mandato o in ombra, mai quello arrivato tardi): lo decidono i passi dopo dell'agente
      if (entry.id && feedbackPending.size < 500) feedbackPending.set(entry.id, { entry, cwd, log });
    }
    return out;
  }
  // ---- C2 · esiti: i messaggi in attesa si giudicano con i passi successivi dell'agente (outcomes.js), ogni 15 secondi.
  // In memoria: se Platypus si chiude prima, quei messaggi restano senza esito nel registro.
  const feedbackPending = new Map(); // id -> { entry, cwd, log }
  function judgeFeedback(now = Date.now()) {
    let n = 0;
    for (const [id, { entry, cwd, log }] of feedbackPending) {
      let r = null;
      try {
        const s = state.sessions.get(entry.sid);
        const a = s && (entry.agent === 'main' ? s.main : s.subs.get(entry.agent));
        const ag = a && a.world ? { steps: a.world.steps, goals: (a.mind && a.mind.goals) || [], replies: a.world.replies || [] } : null;
        r = outcomes.judge(entry, ag, now);
      } catch { r = { outcome: 'unclear', why: '' }; }
      if (!r) continue;
      try { (log || feedbackLog).setOutcome(cwd, id, r.outcome, r.why); } catch {}
      feedbackPending.delete(id);
      n++;
    }
    return n;
  }
  // la demo finisce: il suo registro si svuota, e i suoi messaggi non aspettano più un esito
  // lo storico finto della demo (S14): in memoria, creato alla prima domanda mentre la demo è accesa, buttato quando finisce
  let demoStore = null;
  function demoHistory() {
    if (!demo.on) { demoStore = null; return null; }
    if (!demoStore) demoStore = demoHistoryStore();
    return demoStore;
  }
  // su quale storico rispondere: quello vero, o quello della demo per un suo piano. null = progetto sconosciuto
  function historyScope(q) {
    if (!(q.sid || q.cwd || q.key)) return { store: history.store, projects: null, demo: false };
    const cwd = projectCwd(q);
    if (cwd && isDemoCwd(cwd)) { const ds = demoHistory(); return { store: ds, projects: [projectKey(cwd)], demo: true }; }
    if (cwd) return { store: history.store, projects: history.keys.allKeys(history.keys.keyIfKnown(cwd)), demo: false };
    if (q.key && /^[0-9a-f]{16}$/.test(q.key)) return { store: history.store, projects: history.keys.allKeys(q.key), demo: false };
    return null;
  }
  function dropDemoFeedback() {
    demoStore = null;
    demoFeedbackLog.clear();
    for (const [id, p] of feedbackPending) if (p.log === demoFeedbackLog) feedbackPending.delete(id);
    feedbackSaid = feedbackSaid.filter(x => !String(x.sid).startsWith('demo-'));
  }
  const judgeTimer = setInterval(() => judgeFeedback(), 15000);
  judgeTimer.unref && judgeTimer.unref();
  // i messaggi degli ultimi secondi, per i fumetti dell'ufficio (il registro completo sta nel Libro)
  const SAID_MS = 45000;
  let feedbackSaid = [];
  // una riga del registro come la mostrano l'ufficio e il Libro: nella lingua dell'ufficio, con l'inglese accanto se è diverso
  const feedbackRow = e => ({ id: e.id, t: e.t, sid: e.sid, agent: e.agent, name: e.name || '', feature: e.feature, mode: e.mode, event: e.event, tag: e.tag || '', text: e.local || e.text, sent: e.local ? e.text : '', outcome: e.outcome || '', why: e.why || '' });

  let hooksCache = { t: 0, v: false, f: false };
  function hooksInstalled() {
    if (Date.now() - hooksCache.t > 5000) hooksCache = { t: Date.now(), v: hooks.status({ base }), f: hooks.feedbackStatus({ base }) };
    return hooksCache.v;
  }
  function payload() {
    const snap = state.snapshot();
    snap.hooks.installed = hooksInstalled();
    snap.hooks.feedback = hooksCache.f; // gli hook di feedback, installati a parte
    const nowMs = Date.now();
    feedbackSaid = feedbackSaid.filter(x => nowMs - x.t < SAID_MS);
    snap.feedback = feedbackSaid;
    snap.replay = replay ? { key: replay.key } : null;
    snap.history = history.info();
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
    const minds = list.filter(a => a.mind && a.mind.pieces.length).slice(0, 40).map(a => ({ id: a.id, name: displayName(a), mind: a.mind, ctx: a.ctx || 0, model: a.model || '' }));
    if (!minds.length) return { ok: true, empty: true, sid: s.id, aid };
    try {
      const space = semantic.pickSpace(minds.map(m => m.mind), s.corpus, [embedder.space(0, { demo: !!s.demo })]);
      const v = semantic.snapshotMinds(minds, s.corpus, (q.get('replay') ? 'r:' : '') + s.id + ':' + aid, 0, space);
      const active = embedder.activeId(); // la fonte scelta: finché non ha tutti i vettori si mostra il TF-IDF e si "affina"
      return { ok: true, sid: s.id, aid, now: st.now(), active, refining: active !== 'tfidf' && !(active.startsWith('fake:') && !s.demo) && (v.src !== active || v.pending > 0), fallback: embedder.fallback, names: Object.fromEntries(minds.map(m => [m.id, m.name])), ctxNow: Object.fromEntries(minds.map(m => [m.id, m.ctx])), models: Object.fromEntries(minds.map(m => [m.id, m.model])), ...v };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // i conteggi di una sessione per lo storico (S12): gli stessi fatti che l'ufficio mostra, contati.
  //   surprises  i fallimenti inattesi (surprise.js)          loops  quelli in cui l'agente insiste con lo stesso comando
  //   stuck      le volte che un agente entra nella fase "bloccato"   flaky  i comandi di verifica instabili (come il Libro)
  //   claims     le affermazioni senza prove (grounding.js)    stale  le memorie non aggiornate e le modifiche alla cieca
  //   lessons    i messaggi del Libro mandati davvero agli agenti della sessione
  function sessionCounts(s) {
    const agents = agentsOf(s), now = Date.now();
    const sp = surprise.surprises(agents, { now }).surprises;
    const loops = new Set(sp.filter(x => x.reaction === 'insists').map(x => x.sig || x.target || x.t));
    let stuck = 0;
    for (const a of agents) { let prev = ''; for (const st of a.world.steps) { if (st.phase === 'stuck' && prev !== 'stuck') stuck++; prev = st.phase; } }
    const cases = digest(s, agents, now);
    const flaky = new Set(cases.filter(c => c.kind === 'flaky-command').map(c => c.key)).size;
    const g = grounding.checkStale(s, agents, s.cwd, { disk: false });
    const claims = grounding.checkClaims(s, agents, s.cwd).claims.filter(c => c.status === 'ungrounded').length;
    let lessons = 0;
    try { lessons = history.store.collection('feedback').count({ sid: s.id, mode: 'on', lessonId: { $exists: true } }); } catch {}
    return { surprises: sp.length, loops: loops.size, stuck, flaky, claims, stale: g.stale.length + g.blindEdits.length, lessons };
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

  // la cartella di un progetto dalla sua chiave: tra le sessioni aperte, poi nell'archivio di Claude Code (rifatto al
  // massimo ogni 30 s). Lo storico non tiene percorsi assoluti, quindi un progetto senza sessioni né archivio non ha cartella
  let folders = { at: 0, map: new Map() };
  function projectFolder(key) {
    const keys = history.keys;
    // keyIfKnown: cercare una cartella non deve chiedere niente a git né registrare progetti (un progetto dimenticato non rinasce)
    for (const s of state.sessions.values()) if (!s.demo && s.cwd && (keys.keyIfKnown(s.cwd) === key || projectKey(s.cwd) === key)) return s.cwd;
    if (Date.now() - folders.at > 30000) {
      const map = new Map();
      try { for (const x of listArchive({ base, limit: 400 })) if (x.cwd) for (const k of [keys.keyIfKnown(x.cwd), projectKey(x.cwd)]) if (!map.has(k)) map.set(k, x.cwd); } catch {}
      folders = { at: Date.now(), map };
    }
    return folders.map.get(key) || '';
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
      case hooks.MARK + '/feedback':
        return feedbackHook(j, res, req);
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
      case '/api/feedback/hooks': {
        // installa o toglie gli hook di feedback in settings.json di Claude Code: mai senza la conferma esplicita
        if (j.action !== 'install' && j.action !== 'uninstall') return json(res, 400, { ok: false, reason: 'action' });
        if (j.confirm !== true) return json(res, 400, { ok: false, reason: 'confirm' });
        try {
          const r = j.action === 'install' ? hooks.installFeedback({ port, base, curl: j.curl === true }) : hooks.uninstallFeedback({ base });
          hooksCache.t = 0;
          state.touch();
          return json(res, 200, { ok: true, installed: hooks.feedbackStatus({ base }), ...r });
        } catch (e) { return json(res, 200, { ok: false, reason: tr('Non sono riuscito a modificare le impostazioni di Claude Code: {error}', { error: e.message }) }); }
      }
      case '/api/bottega/claudemd': {
        const p = claudeMdPlan(j);
        if (!p) return json(res, 404, { ok: false });
        if (j.confirm !== true) return json(res, 400, { ok: false, reason: 'confirm' }); // mai in automatico
        if (!p.writable) return json(res, 409, { ok: false, reason: p.reason });
        return json(res, 200, { path: p.path, ...claudemd.upsertSection(p.path, p.markdown) });
      }
      // lo storico: compatta, esporta, dimentica un progetto, applica subito la conservazione
      case '/api/store': {
        if (j.action === 'compact') return json(res, 200, { ok: true, size: history.compact() });
        if (j.action === 'retention') return json(res, 200, { ok: true, result: await retention() });
        if (j.action === 'export') {
          const dir = typeof j.dir === 'string' && j.dir.trim() ? j.dir.trim().slice(0, 500) : '';
          if (dir && !path.isAbsolute(dir)) return json(res, 400, { ok: false, reason: tr('Serve un percorso completo per la cartella di esportazione.') });
          try { return json(res, 200, { ok: true, ...history.exportAll(dir || undefined) }); }
          catch (e) { return json(res, 200, { ok: false, reason: tr('Non sono riuscito a esportare lo storico: {error}', { error: e.message }) }); }
        }
        if (j.action === 'forget') {
          // il progetto: dalla sua chiave, oppure dalla sessione o dalla cartella (dal Libro)
          let key = typeof j.key === 'string' && /^[0-9a-f]{16}$/.test(j.key) ? j.key : '';
          if (!key) {
            const cwd = projectCwd(j);
            if (cwd && isDemoCwd(cwd)) return json(res, 409, { ok: false, reason: tr('Il Libro della demo è finto e non sta nello storico.') });
            if (cwd) key = history.keys.keyIfKnown(cwd);
          }
          if (!key) return json(res, 404, { ok: false });
          if (j.confirm !== true) return json(res, 400, { ok: false, reason: 'confirm' }); // mai senza conferma
          return json(res, 200, { ok: true, ...forgetProject(key) });
        }
        return json(res, 400, { ok: false, reason: 'action' });
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
        // il progetto non vuole che Platypus parli ai suoi agenti (o lo vuole di nuovo)
        if (j.action === 'mute' || j.action === 'unmute') return json(res, 200, { ok: true, mute: bottega.setMute(cwd, j.action === 'mute') });
        const ok = bottega.act(cwd, String(j.action || ''), String(j.id || ''));
        return json(res, ok ? 200 : 404, { ok });
      }
      case '/api/demo': {
        const on = typeof j.on === 'boolean' ? j.on : !demo.on;
        on ? demo.start() : demo.stop();
        return json(res, 200, { demo: demo.on });
      }
      case '/api/embed': { // il motore del significato: guarda le fonti (probe) o svuota la cache (clear)
        if (j.action === 'clear') { await embedder.clearCache(); return json(res, 200, embedder.status()); }
        if (j.action === 'probe') return json(res, 200, await embedder.probe());
        return json(res, 400, { ok: false });
      }
      case '/api/settings': {
        const before = { city: state.settings.weatherCity, dirs: state.settings.coworkDirs, lang: state.settings.lang };
        const s = state.setSettings(j);
        saveSettings(settingsPath, s);
        embedder.configure(s);
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
    if (url.pathname === '/api/shell/events') return notifier.attach(req, res);
    if (url.pathname === '/api/state') return json(res, 200, { ...state.snapshot(), history: history.info() });
    if (url.pathname === '/i18n.js') { // traduzioni per la pagina (la lingua scelta nelle opzioni)
      const lang = i18n.getLang();
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end('window.AO_I18N=' + JSON.stringify({ lang, locale: i18n.localeTag(lang), dict: i18n.dict(lang), langs: i18n.LANGS }) + ';');
    }
    if (url.pathname === '/models.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(fs.readFileSync(path.join(__dirname, 'models.js'))); } // nomi dei modelli, età e contesto: gli stessi del motore
    if (url.pathname === '/drift-rule.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(fs.readFileSync(path.join(__dirname, 'drift-rule.js'))); } // la regola della deriva, la stessa del motore
    if (url.pathname === '/api/settings') return json(res, 200, state.settings);
    if (url.pathname === '/api/store') return json(res, 200, storeInfo());
    if (url.pathname === '/api/cowork-scan') return json(res, 200, state.coworkScan || {});
    if (url.pathname === '/api/agentmap') return json(res, 200, agentMap(url.searchParams));
    if (url.pathname === '/api/agentmind') return json(res, 200, agentMind(url.searchParams));
    if (url.pathname === '/api/embed') return json(res, 200, embedder.status());
    if (url.pathname === '/api/grounding') return json(res, 200, agentGrounding(url.searchParams));
    if (url.pathname === '/api/bottega/list') return json(res, 200, { ok: true, books: bottega.list() });
    if (url.pathname === '/api/bottega/claudemd') { const p = claudeMdPlan(Object.fromEntries(url.searchParams)); return p ? json(res, 200, { ok: true, ...p }) : json(res, 404, { ok: false }); }
    // gli hook di feedback: se ci sono, e le righe esatte che l'installazione scriverebbe (da mostrare prima della conferma)
    if (url.pathname === '/api/feedback/hooks') {
      try { return json(res, 200, { ok: true, installed: hooks.feedbackStatus({ base }), ...hooks.feedbackPreview({ port, base, curl: url.searchParams.get('curl') === '1' }) }); }
      catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
    }
    // il registro dei messaggi agli agenti di un progetto (scheda FEEDBACK del Libro), dal più recente
    if (url.pathname === '/api/feedback/log') {
      const cwd = projectCwd(Object.fromEntries(url.searchParams));
      if (!cwd) return json(res, 404, { ok: false });
      try { return json(res, 200, { ok: true, demo: isDemoCwd(cwd), entries: (isDemoCwd(cwd) ? demoFeedbackLog : feedbackLog).recent(cwd, 200).map(feedbackRow) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    // la ricerca nell'archivio sui passi salvati (S12b): per il progetto (sid, cwd o key) o per tutti
    if (url.pathname === '/api/history/search') {
      try {
        history.flush();
        const q = Object.fromEntries(url.searchParams);
        const sc = historyScope(q);
        if (!sc) return json(res, 404, { ok: false });
        if (!sc.store) return json(res, 200, { ok: true, demo: true, results: [], scanned: 0, partial: false });
        const projects = sc.projects;
        const r = search.searchSteps(sc.store, {
          projects, file: (q.file || '').slice(0, 200), command: (q.command || '').slice(0, 200), error: (q.error || '').slice(0, 200), outcome: q.outcome,
          from: Number(q.from) || undefined, to: Number(q.to) || undefined, limit: Number(q.limit) || 50,
        });
        return json(res, 200, { ok: true, demo: sc.demo, ...r });
      } catch (e) { return json(res, e.code === 'bad-query' ? 400 : 200, { ok: false, error: e.message }); }
    }
    // le azioni rischiose salvate (2.14): per il progetto (sid, cwd, key o project) o per tutti; session, from, to, missed=1
    if (url.pathname === '/api/risks') {
      try {
        history.flush();
        const q = Object.fromEntries(url.searchParams);
        if (q.project && !q.key) q.key = q.project;
        const sc = historyScope(q);
        if (!sc) return json(res, 404, { ok: false });
        if (!sc.store) return json(res, 200, { ok: true, demo: true, risks: [] });
        const risks = fear.queryRisks(sc.store, { projects: sc.projects, session: (q.session || '').slice(0, 200) || undefined, from: Number(q.from) || undefined, to: Number(q.to) || undefined, missed: q.missed === '1', limit: Number(q.limit) || 100 });
        return json(res, 200, { ok: true, demo: sc.demo, risks });
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    // lo storico nel tempo (S12): per il progetto (sid, cwd o key) o per tutti; metric=all dà tutte le metriche con la loro lettura
    if (url.pathname === '/api/history') {
      try {
        history.flush();
        const q = Object.fromEntries(url.searchParams);
        const sc = historyScope(q);
        if (!sc) return json(res, 404, { ok: false });
        if (!sc.store) return json(res, 200, { ok: true, demo: true });
        const projects = sc.projects, hstore = sc.store;
        // di base le ultime 26 settimane, compresa quella in corso, dall'inizio di una settimana
        const now = Date.now(), to = Number(q.to) || now + 1, from = Number(q.from) || historyQuery.addDays(historyQuery.bucketStart(now, 'week'), -7 * 25);
        const bucket = q.bucket || 'week', metric = q.metric || 'all';
        const one = m => { const r = historyQuery.query(hstore, { projects, metric: m, from, to, bucket }); return m === 'feedback' ? r : { ...r, trend: historyQuery.trend(r, now) }; };
        if (metric === 'all') {
          // le metriche delle sessioni in una lettura sola, più il feedback
          const all = historyQuery.queryAll(hstore, { projects, from, to, bucket });
          for (const m of Object.keys(all)) all[m].trend = historyQuery.trend(all[m], now);
          all.feedback = one('feedback');
          return json(res, 200, { ok: true, demo: sc.demo, from, to, bucket, metrics: all });
        }
        return json(res, 200, { ok: true, demo: sc.demo, ...one(metric) });
      } catch (e) { return json(res, e.code && /^bad-/.test(e.code) ? 400 : 200, { ok: false, error: e.message }); }
    }
    // l'esperimento sul feedback (S11): i due gruppi a confronto, per il progetto e per tutti i progetti
    if (url.pathname === '/api/feedback/experiment') {
      try {
        history.flush();
        const q = Object.fromEntries(url.searchParams);
        const sc = historyScope(q);
        if (!sc) return json(res, 404, { ok: false });
        if (!sc.store) return json(res, 200, { ok: true, demo: true });
        // nella demo il giro in tondo e le lezioni a inizio sessione sono in esperimento (dati finti, demo-history.js)
        const modes = sc.demo ? { sessionLessons: 'experiment', elder: 'on', loop: 'experiment' } : Object.fromEntries(experiments.FEATURES.map(f => [f, feedback.modeOf(state.settings, f)]));
        return json(res, 200, { ok: true, demo: sc.demo, modes, minN: experiments.MIN_N, project: sc.projects ? experiments.results(sc.store, sc.projects) : null, all: experiments.results(sc.store) });
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    // quanti messaggi per funzione negli ultimi 7 giorni, in tutti i progetti (accanto agli interruttori delle opzioni)
    if (url.pathname === '/api/feedback/counts') {
      try { return json(res, 200, { ok: true, days: 7, counts: feedbackLog.counts(Date.now() - 7 * 86400000) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/bottega/hints') {
      const s = state.sessions.get(url.searchParams.get('sid') || '');
      if (!s || !s.cwd) return json(res, 404, { ok: false });
      // told: quella lezione è arrivata anche all'agente (feedback acceso), non solo al fumetto
      try { return json(res, 200, { ok: true, hints: hints(s, agentsOf(s), bottega.view(s.cwd).lessons, state.now()).map(h => ({ ...h, told: feedbackGate.told(s.id, h.agent, h.lessonId) })) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/bottega') {
      const cwd = projectCwd(Object.fromEntries(url.searchParams));
      return cwd ? json(res, 200, { ok: true, ...bottega.view(cwd) }) : json(res, 404, { ok: false });
    }
    if (url.pathname === '/api/stats/costs') return json(res, 200, stats.costHistory(Math.min(90, Number(url.searchParams.get('days')) || 14)));
    if (url.pathname === '/api/stats/honors') return json(res, 200, stats.honors());
    if (url.pathname === '/api/report') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : undefined;
      const r = stats.report(day);
      // la tendenza della settimana (S12), come stava alla fine di quel giorno (o adesso, per oggi)
      try {
        history.flush();
        const end = new Date(r.day + 'T00:00:00'); end.setDate(end.getDate() + 1);
        // con la demo accesa, la tendenza dei suoi tre mesi finti (come i costi della demo nel report)
        const ds = demoHistory();
        r.trend = historyQuery.reportTrend(ds || history.store, Math.min(Date.now(), end.getTime() - 1));
        if (ds) r.trend.demo = true;
      } catch { r.trend = null; }
      return json(res, 200, r);
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

  let historyReady = Promise.resolve(null);
  let retentionRun = null;
  function retention() {
    if (retentionRun) return retentionRun; // un giro alla volta
    bottega.save(); // quello che il Libro ha in memoria va nello storico prima di sfoltirlo
    retentionRun = runRetention({ store: history.store, bottega, settings: state.settings })
      .catch(e => { console.error('[platypus] store: conservazione non riuscita (' + (e && e.message || e) + ')'); return null; })
      .finally(() => { retentionRun = null; });
    return retentionRun;
  }
  const retentionTimer = setInterval(() => { retention(); }, 6 * 3600000);
  retentionTimer.unref && retentionTimer.unref();
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
      // i dati della 2.12 entrano nello storico la prima volta, senza far aspettare l'ufficio
      historyReady = history.start().then(r => {
        // la prima volta i dati della 2.12 arrivano dopo che statistiche e Libri sono partiti: si rileggono
        if (r && r.done && r.imported) { stats.reload(); bottega.reloadFromStore(); }
        return r;
      }).catch(() => null);
      // conservazione e dimensione: subito dopo, e poi ogni 6 ore, a piccoli blocchi
      historyReady.then(() => retention()).catch(() => {});
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
    notifier.stop();
    clearInterval(learnTimer); clearTimeout(learnSoon); clearInterval(judgeTimer);
    bottega.stop();
    embedder.stop();
    state.stop();
    clearInterval(summaryTimer);
    clearInterval(retentionTimer);
    try { history.summarize(state, { counts: sessionCounts, final: true }); } catch {}
    history.stop(); // per ultimo: statistiche, Libro e registro hanno appena salvato
    for (const c of clients) try { c.end(); } catch {}
    server.close();
  }

  // "Dimentica questo progetto" con tutto quello che il motore ha in memoria
  function forgetProject(key) { return history.forgetProject(key, { state, bottega, stats }); }

  // lo storico per la sezione ARCHIVIO delle opzioni: dove sta, quanto pesa, per quanto tiene, che cosa ha tolto
  // l'ultima volta, le copie di sicurezza accanto, i progetti che conosce (per "Dimentica")
  function storeInfo() {
    const st = history.store, info = st.info(), s = state.settings;
    let used = null, last = null, projects = [];
    try { used = st.driver && typeof st.driver.usedBytes === 'function' ? st.driver.usedBytes() : null; } catch {}
    try { last = JSON.parse(st.getMeta('retentionLast') || 'null'); } catch {}
    try {
      projects = st.collection('projects').find({}, { sort: { lastSeen: -1 }, limit: 300 })
        .map(p => ({ key: p._id, name: p.name || '', remote: p.remote || '', lastSeen: p.lastSeen || 0 }));
    } catch {}
    const backups = history.backups(); // "Dimentica" cancella anche queste
    return {
      ok: true, backend: info.backend, persistent: !!info.persistent, file: info.file || '', sizeBytes: info.sizeBytes || 0, usedBytes: used,
      notice: history.notice(), limitMB: s.storeMaxMB,
      retention: { steps: s.storeKeepSteps, sessions: s.storeKeepSessions, feedback: s.storeKeepFeedback, lessons: s.storeKeepLessons },
      collections: info.collections.map(c => ({ name: c.name, count: c.count })), last, backups, projects,
    };
  }

  return { state, history, historyReady: () => historyReady, retention, forgetProject, sessionCounts, stats, notify: notifier, bottega, embedder, learnLive, feedbackStats, feedbackLog, feedbackGate, feedbackSaid: () => feedbackSaid.slice(), judgeFeedback, feedbackPending, demo, server, ready, stop, port, base: base || claudeDir(), hooks: {
    install: () => hooks.install({ port, base }),
    uninstall: () => hooks.uninstall({ base }),
    status: () => hooks.status({ base }),
    installFeedback: opts => hooks.installFeedback({ port, base, ...opts }),
    uninstallFeedback: () => hooks.uninstallFeedback({ base }),
    feedbackStatus: () => hooks.feedbackStatus({ base }),
  } };
}

module.exports = { startCore, DEFAULT_PORT };
