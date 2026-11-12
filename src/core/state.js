'use strict';
// Stato dell'ufficio: sessioni -> agente principale + sottoagenti (con la loro gerarchia).
// Riceve eventi da tre fonti (transcript, registro sessioni, hook) e li fonde.
// Tiene anche token e costi, lo storico dell'ultima ora e gli avvisi.
// L'orologio è iniettabile: lo stesso motore serve per il live e per il replay dell'archivio.

const { EventEmitter } = require('events');
const path = require('path');
const { describeTool, clip } = require('./describe');
const { tr, trn, money: fmtMoney } = require('../i18n');
const releases = require('./releases');

const SPAWN_TOOLS = new Set(['Task', 'Agent']);
const FINAL_STATUSES = new Set(['completed', 'failed', 'error', 'killed', 'cancelled', 'canceled', 'interrupted', 'stopped']);
const BUSY = new Set(['working', 'thinking', 'writing']);
// strumenti che aspettano te, non un processo: non sono "blocchi"
const USER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// il file del piano di Claude Code: <cartella di configurazione>/plans/<nome>.md (es. ~/.claude/plans/…)
// un piano scritto da più di così prima di ExitPlanMode non è quello che viene presentato
const PLAN_DRAFT_MS = 45 * 60 * 1000;
// il file del piano quando il transcript non ne ha il testo (solo .md, piccolo, se c'è ancora)
function readPlanFile(p) {
  try { if (!/\.md$/i.test(p) || require('fs').statSync(p).size > 256 * 1024) return ''; return require('fs').readFileSync(p, 'utf8'); } catch { return ''; }
}
function isPlanFile(p) { return typeof p === 'string' && /[\\/]\.claude[^\\/]*[\\/]plans[\\/][^\\/]+\.md$/i.test(p); }

// titolo e passi di un piano in markdown: prima le voci numerate (anche "### 1. …"), poi i titoli ##, poi gli elenchi
function parsePlan(text) {
  const lines = String(text || '').replace(/```[\s\S]*?(```|$)/g, '').split(/\r?\n/);
  const clean = l => l.replace(/^#+\s*/, '').replace(/^(\d+[.)]|[-*+])\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  const title = clean(lines.find(l => /^#\s/.test(l)) || lines.find(l => l.trim()) || '');
  const pick = re => lines.filter(l => re.test(l)).map(clean).filter(Boolean);
  const numbered = pick(/^(#{2,4}\s+)?\d+[.)]\s+\S/);
  const headings = pick(/^#{2,3}\s+\S/);
  const bullets = pick(/^[-*+]\s+\S/);
  const steps = numbered.length >= 2 ? numbered : headings.length >= 2 ? headings : bullets.length ? bullets : numbered.concat(headings);
  return { title, steps: steps.slice(0, 6) };
}

// il piano approvato nel risultato di ExitPlanMode, se c'è
function approvedPlan(block, line) {
  const r = line && line.toolUseResult;
  if (r && typeof r.plan === 'string' && r.plan.trim()) return r.plan;
  const c = block && block.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join('\n') : '';
  const m = /##\s*Approved Plan:?[ \t]*\r?\n([\s\S]+)$/i.exec(text);
  return m ? m[1] : null;
}

const CFG = {
  sessionIdleTimeoutMs: 20 * 60 * 1000, // sessione senza registro: sparisce dopo 20 min di silenzio
  subQuietAfterReportMs: 25 * 1000,     // sottoagente che ha scritto il resoconto e tace: ha finito
  subQuietMs: 150 * 1000,               // sottoagente senza strumenti in corso che tace da 2,5 min: ha finito
  subStuckMs: 20 * 60 * 1000,           // sottoagente con uno strumento "appeso" da 20 min: lo togliamo
  subSilentRemoveMs: 10 * 60 * 1000,    // oltre questo silenzio si esce senza animazione
  doneLingerMs: 6000,                   // quanto resta visibile un agente che ha finito
  endedLingerMs: 4000,
};

const DEFAULT_SETTINGS = {
  budgetUSD: 10,        // budget per sessione
  stuckMin: 10,         // agente fermo sullo stesso strumento
  waitMin: 3,           // permesso in attesa
  idleMin: 15,          // sessione che ti aspetta
  errStreak: 3,         // errori di fila sullo stesso strumento
  alertsNotify: true,   // notifiche di Windows per gli avvisi
  pricePerMTok: 4,      // stima quando Claude Code non ha ancora scritto il costo ($ per milione di token "equivalenti input")
  pestEnabled: true,    // il collega fastidioso
  pestName: 'Ugo Pignolo',
  hrEnabled: true,      // le risorse umane richiamano chi butta giù una lavagna
  hrName: 'Dott.ssa Ornella Rigore',
  nightAuto: true,      // luci basse e pulizie dopo le 20
  catEnabled: true,
  partyEnabled: true,
  reportHour: 18,       // ora del report giornaliero (notifica nell'app)
  outfits: true,        // vestiti di stagione, feste e meteo
  weatherCity: 'Roma',  // città per il meteo (vuoto = niente meteo)
  approveFromOffice: true, // permessi approvabili dai fumetti dell'ufficio
  approveWaitSec: 120,  // quanto a lungo l'ufficio tiene in sospeso una richiesta
  groundingAlerts: false, // avvisi di ancoraggio: modifiche alla cieca e affermazioni smentite
  elderEnabled: true,   // il Nonno racconta le lezioni del Libro della bottega
  bottegaLearn: true,   // il Libro della bottega impara dalle sessioni (dal vivo e dall'archivio)
  coworkDirs: '',       // cartelle extra dove cercare le sessioni Cowork (separate da ;)
  claudeDirs: '',       // altre cartelle di configurazione di Claude Code (es. dentro WSL), separate da ;
  lang: 'auto',         // lingua: auto (quella del sistema), it, en
};
const LONG_STRINGS = { coworkDirs: 600, claudeDirs: 600 };
const i18n = require('../i18n');
const { AgentWorld } = require('./worldmap');
const grounding = require('./grounding');
const { AgentMind, Corpus } = require('./semantic');

// testo di un'azione per la "mente": cosa ha chiesto lo strumento
function actionText(name, input) {
  const i = input || {};
  return [name, i.file_path, i.notebook_path, i.path, i.pattern, i.glob, i.command, i.description, i.query, i.url, i.prompt, i.subagent_type,
    typeof i.new_string === 'string' ? i.new_string.slice(0, 3000) : '', typeof i.content === 'string' ? i.content.slice(0, 3000) : ''].filter(Boolean).join(' ');
}
function blockText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c.slice(0, 20000);
  if (Array.isArray(c)) return c.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('\n').slice(0, 20000);
  return '';
}
const RESULT_KIND = { Read: 'file', NotebookRead: 'file', Grep: 'search', Glob: 'search', LS: 'search', WebFetch: 'web', WebSearch: 'web', Bash: 'output', PowerShell: 'output', Agent: 'report', Task: 'report' };

// Da dove è partita la sessione (stessa classificazione che usa Claude Code)
function kindOf(ep) {
  if (!ep) return 'unknown';
  if (/cowork|local-agent|coworker/.test(ep)) return 'cowork';
  if (ep === 'claude-vscode') return 'ide';
  if (/desktop/.test(ep)) return 'desktop';
  if (/^sdk/.test(ep)) return 'sdk';
  if (ep === 'cli') return 'cli';
  if (/remote/.test(ep)) return 'remote';
  return 'other';
}

// token "pesati" come equivalenti di input: l'output costa ~5x, la cache letta ~0,1x, scritta ~1,25x
function weight(t) { return t.in + 5 * t.out + 0.1 * t.cr + 1.25 * t.cw; }
function emptyTok() { return { in: 0, out: 0, cr: 0, cw: 0 }; }

function newAgent(id, kind, t) {
  return {
    id, kind,
    type: kind === 'main' ? 'Claude' : 'Sottoagente',
    description: '',
    name: '',
    parentId: null,
    team: '',
    phase: '',
    status: 'idle',
    action: kind === 'main' ? tr('Entra in ufficio') : tr('Arriva alla scrivania'),
    startedAt: t,
    lastActivity: t,
    statusSince: t,
    toolCount: 0,
    pending: 0,
    pendingSince: 0,
    pendingDesc: '',
    errTool: '',
    errStreak: 0,
    tok: emptyTok(),
    finished: false,
    finishedAt: 0,
  };
}

class OfficeState extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.clock = opts.clock || (() => Date.now());
    this.settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
    this.sessions = new Map();
    this.log = [];
    this.hooksLastSeen = 0;
    this.registrySeen = false;
    this.demo = false;
    this.includeCowork = true;
    this.noTimeout = !!opts.noTimeout;  // replay: le sessioni non scadono per silenzio
    this.retired = new Map();           // contabilità delle sessioni uscite, se tornano
    this._dirty = false;
    if (!opts.manual) {
      this._timer = setInterval(() => this.tick(), 1000);
      this._timer.unref && this._timer.unref();
    }
  }

  now() { return this.clock(); }
  stop() { clearInterval(this._timer); }

  // ---------- helpers ----------
  touch() {
    if (this._dirty) return;
    this._dirty = true;
    setTimeout(() => { this._dirty = false; this.emit('change'); }, 250);
  }

  visible(s) { return s.demo || this.includeCowork || s.kind !== 'cowork'; }
  label(s) { return s.kind === 'cowork' ? s.title || s.project : s.project; }

  addLog(session, text, kind = 'info') {
    if (session && !this.visible(session)) return;
    this.log.push({ t: this.now(), session: session ? session.id : null, project: session ? this.label(session) : '', wing: session && session.kind === 'cowork' ? 'cowork' : 'code', text, kind });
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }

  setSettings(obj) {
    for (const [k, v] of Object.entries(obj || {})) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      if (typeof DEFAULT_SETTINGS[k] === 'boolean') this.settings[k] = !!v;
      else if (typeof DEFAULT_SETTINGS[k] === 'string') {
        const str = String(v ?? '').replace(/[<>"]/g, '').trim().slice(0, LONG_STRINGS[k] || 40);
        if (k === 'lang') { this.settings.lang = str === 'auto' || i18n.LANGS[str] ? str : 'auto'; continue; }
        this.settings[k] = str || (k === 'pestName' || k === 'hrName' ? DEFAULT_SETTINGS[k] : '');
      }
      else { const n = Number(v); if (Number.isFinite(n) && n >= 0) this.settings[k] = n; }
    }
    this.touch();
    return this.settings;
  }

  ensureSession(id, cwd, ts) {
    let s = this.sessions.get(id);
    if (!s) {
      const t = ts || this.now();
      s = {
        id,
        cwd: cwd || '',
        project: cwd ? path.basename(cwd.replace(/\\/g, '/')) || cwd : '…',
        title: '',
        name: '',
        entrypoint: '',
        kind: 'unknown',
        alive: null,          // true/false se il registro lo sa, null se non lo sa
        pid: null,
        registryStatus: null,
        waitingFor: null,
        ended: false,
        endedAt: 0,
        lastActivity: t,
        createdAt: t,
        demo: false,
        main: newAgent('main', 'main', t),
        subs: new Map(),
        quietDone: new Map(),    // sottoagenti dati per finiti dal solo silenzio: se riscrivono tornano gli stessi
        pendingTools: new Map(), // toolUseId -> {name, input, agentId}
        spawns: new Map(),       // toolUseId (Agent/Task) -> {type, description, prompt, parent}
        completed: 0,
        completedByType: {},
        hist: [],                // ultimi 60 minuti: {m, a, b, w, d}
        histCur: null,
        tok: emptyTok(),         // tutti i token letti (capo + sottoagenti)
        wByType: {},             // token pesati per tipo di sottoagente (anche di chi ha finito)
        seenMsg: new Set(),      // id dei messaggi già contati (ogni messaggio occupa più righe)
        costState: null,         // ultimo costo scritto da Claude Code
        rate: 0,                 // $ per token pesato, ricavato da costState
        alerts: [],
        alertSeen: new Set(),
        todos: [],               // lista delle cose da fare del capo (TodoWrite o Task*)
        todosAt: 0,
        tasks: new Map(),        // id -> {content, status} per TaskCreate/TaskUpdate
        taskSeq: 0,
        plan: null,              // {title, steps[], at}
        planDraft: null,         // {path, text, t}: il file in <config>/plans/ mentre Claude lo scrive
        mdDraft: null,           // {path, text, t}: l'ultimo .md toccato altrove (il piano nell'app desktop)
        deskPlan: null,          // [{text, status}]: la lista dei compiti dell'app desktop (mcp__ccd_turn__update_plan)
        workflows: new Map(),    // runId -> esecuzione di un Workflow (vedi ensureRun)
        workflowCalls: new Map(), // toolUseId dello strumento Workflow -> {description, t}
        messages: [],            // SendMessage tra agenti: {t, from, to, toId, summary}
        releases: [],            // commit, push, PR, tag, test verdi
        party: null,             // ultima cosa da festeggiare
        testsRed: false,
        lastTestParty: 0,
        errByType: {},
        toolsByType: {},
        _announced: false,
      };
      const old = this.retired.get(id);
      if (old) { Object.assign(s, old); this.retired.delete(id); }
      this.sessions.set(id, s);
    } else if (cwd && (!s.cwd || s.project === '…')) {
      this.setCwd(s, cwd);
    }
    return s;
  }

  announce(s) {
    if (s._announced || (s.kind === 'unknown' && !s.demo && !s.hookSeen && s.alive == null)) return;
    s._announced = true;
    this.addLog(s, s.project && s.project !== '…' ? tr('Nuova sessione in ufficio: {name}', { name: this.label(s) }) : tr('Nuova sessione in ufficio'), 'session');
  }

  setCwd(s, cwd) {
    s.cwd = cwd;
    s.project = path.basename(cwd.replace(/\\/g, '/')) || cwd;
  }

  setEntrypoint(s, ep) {
    if (!ep || s.entrypoint === ep) return;
    s.entrypoint = ep;
    s.kind = kindOf(ep);
  }

  ensureSub(s, agentId, meta, quiet, ts) {
    let a = s.subs.get(agentId);
    if (!a && s.quietDone.has(agentId)) { // era solo zitto: torna lo stesso agente, non uno nuovo
      a = s.quietDone.get(agentId);
      s.quietDone.delete(agentId);
      s.subs.set(agentId, a);
    }
    if (!a) {
      a = newAgent(agentId, 'sub', ts || this.now());
      s.subs.set(agentId, a);
      if (meta) this.applySubMeta(s, a, meta);
      if (quiet) a._announced = true;
      if (!a._announced) {
        a._announced = true;
        const boss = a.parentId && s.subs.get(a.parentId) ? displayName(s.subs.get(a.parentId)) : 'Claude';
        this.addLog(s, a.description ? tr('{boss} chiama {agent}: {task}', { boss, agent: displayName(a), task: clip(a.description, 40) }) : tr('{boss} chiama {agent}', { boss, agent: displayName(a) }), 'spawn');
      }
    } else if (meta) {
      this.applySubMeta(s, a, meta);
    }
    return a;
  }

  applySubMeta(s, a, meta) {
    if (meta.toolUseId && s.spawns.has(meta.toolUseId)) {
      const sp = s.spawns.get(meta.toolUseId);
      if (!meta.agentType && sp.type) meta.agentType = sp.type;
      if (!meta.description && sp.description) meta.description = sp.description;
      if (!meta.parentAgentId && sp.parent) meta.parentAgentId = sp.parent;
    }
    if (meta.agentType && a.type !== meta.agentType) {
      // i token già contati sotto il tipo provvisorio passano al tipo vero
      const w = weight(a.tok);
      if (w && s.wByType[a.type]) { s.wByType[a.type] -= w; s.wByType[meta.agentType] = (s.wByType[meta.agentType] || 0) + w; }
      a.type = meta.agentType;
    }
    if (meta.description) a.description = meta.description;
    if (meta.toolUseId) a.toolUseId = meta.toolUseId;
    if (meta.name) a.name = meta.name;
    if (meta.teamName) a.team = meta.teamName;
    if (meta.workflowPhase) a.phase = String(meta.workflowPhase);
    if (meta.workflowRunId) {
      // agente di un Workflow: etichetta e fase vengono dal giornale dell'esecuzione
      a.workflow = meta.workflowRunId;
      const ra = this.runAgent(s, a.workflow, a.id);
      if (ra.label && !a.name) a.name = ra.label;
      if (ra.phase && !a.phase) a.phase = ra.phase;
      if (!ra.type || ra.type === 'Sottoagente') ra.type = a.type;
    }
    if (meta.parentAgentId && meta.parentAgentId !== a.id) a.parentId = meta.parentAgentId;
    if (meta.background != null) a.background = !!meta.background;
    if (meta.finished && !a.finished) this.finishSub(s, a, tr('Ha finito!'), !a._live);
  }

  // byQuiet: dedotto dal silenzio, non detto da Claude Code (se il sottoagente riscrive, riprende)
  finishSub(s, a, msg, quiet, byQuiet = false) {
    if (a.finished) return;
    const t = this.now();
    a.finished = true;
    a.finishedAt = quiet ? t - CFG.doneLingerMs : t;
    a.byQuiet = byQuiet;
    a.status = 'done';
    a.action = msg || tr('Ha finito!');
    a.pending = 0;
    // un compito si conta una volta sola, anche se il sottoagente era stato dato per finito e poi ha ripreso
    if (!a.counted) {
      a.counted = true;
      s.completed++;
      s.completedByType[a.type] = (s.completedByType[a.type] || 0) + 1;
      if (a._live || s.demo) { this.sample(s); s.histCur.d++; }
    }
    if (!quiet) this.addLog(s, a.description ? tr('{agent} ha finito: {task}', { agent: displayName(a), task: clip(a.description, 40) }) : tr('{agent} ha finito', { agent: displayName(a) }), 'done');
  }

  // un sottoagente dato per finito dal silenzio scrive di nuovo: stava solo pensando a lungo
  resumeSub(a, ts) {
    a.finished = false;
    a.finishedAt = 0;
    a.byQuiet = false;
    a.status = 'thinking';
    a.statusSince = ts || this.now();
    a.action = tr('Riprende il lavoro');
  }

  setAgent(a, status, action, ts) {
    if (a.finished) return;
    const t = ts || this.now();
    if (status !== a.status) a.statusSince = t;
    a.status = status;
    if (action != null) a.action = action;
    a.lastActivity = Math.max(a.lastActivity, t);
  }

  // una domanda (o un piano) per l'utente senza risposta: l'agente aspetta lui, non lavora
  waitUser(a, name, ts) {
    a.userWait = true;
    this.setAgent(a, 'waiting', name === 'ExitPlanMode' ? tr('Aspetta che approvi il piano') : tr('Aspetta la tua risposta'), ts);
  }
  // lo strumento "dell'utente" di questo agente ancora senza risposta: dal transcript (pendingTools) o dall'hook
  userPending(s, a, agentId) {
    for (const p of s.pendingTools.values()) if (!p.answered && USER_TOOLS.has(p.name) && (p.agentId || null) === (agentId || null)) return p.name;
    return a.userHook || null;
  }
  // la risposta è arrivata (o la domanda non vale più: interruzione, nuova richiesta, fine del turno)
  userAnswered(s, a, agentId) {
    for (const p of s.pendingTools.values()) if (USER_TOOLS.has(p.name) && (p.agentId || null) === (agentId || null)) p.answered = true;
    a.userHook = null; a.userWait = false;
  }
  // dopo ogni passo: finché una domanda è aperta l'agente aspetta l'utente, qualunque altro strumento parta o finisca
  step(s, a, agentId, status, action, ts) {
    const u = this.userPending(s, a, agentId);
    if (u) return this.waitUser(a, u, ts);
    a.userWait = false;
    this.setAgent(a, status, action, ts);
  }

  addTokens(s, a, usage, msgId, ts) {
    if (!usage) return;
    if (msgId) {
      if (s.seenMsg.has(msgId)) return;
      if (s.seenMsg.size > 50000) s.seenMsg.clear();
      s.seenMsg.add(msgId);
    }
    const d = { in: usage.input_tokens || 0, out: usage.output_tokens || 0, cr: usage.cache_read_input_tokens || 0, cw: usage.cache_creation_input_tokens || 0 };
    for (const k of Object.keys(d)) { a.tok[k] += d[k]; s.tok[k] += d[k]; }
    a.ctx = d.in + d.cr + d.cw; // quanto è pieno il contesto in questo momento
    if (a.kind) this.mindOf(s, a).noteCtx(ts || this.now(), a.ctx);
    if (a.kind === 'sub') s.wByType[a.type] = (s.wByType[a.type] || 0) + weight(d);
    if (a.workflow && a.id) { const ra = this.runAgent(s, a.workflow, a.id); ra.w += weight(d); ra.tokens += d.in + d.out + d.cr + d.cw; }
  }

  // ---------- Workflow: esecuzioni, agenti, fasi ----------
  // un'esecuzione nasce dal primo segno che ne arriva (strumento Workflow, giornale, agente o riepilogo)
  ensureRun(s, runId) {
    let r = s.workflows.get(runId);
    if (!r) {
      r = { id: runId, name: '', description: '', status: 'running', startedAt: 0, endedAt: 0, durationMs: 0, phases: [], agents: new Map(), agentCount: 0, totalTokens: 0, totalToolCalls: 0, summary: '', taskId: '' };
      s.workflows.set(runId, r);
      if (s.workflows.size > 40) s.workflows.delete(s.workflows.keys().next().value);
    }
    return r;
  }
  runAgent(s, runId, agentId) {
    const r = this.ensureRun(s, runId);
    let ra = r.agents.get(agentId);
    if (!ra) { ra = { id: agentId, key: '', label: '', phase: '', state: 'running', type: '', t0: 0, t1: 0, w: 0, tokens: 0 }; r.agents.set(agentId, ra); }
    return ra;
  }
  // una riga del giornale: launched | started {agentId, key, label, phase} | result {agentId, key} | failed {agentId, key}
  applyWorkflowEvent(sessionId, runId, ev) {
    if (!ev || typeof ev !== 'object' || !runId) return;
    const s = this.ensureSession(sessionId, '', undefined);
    const r = this.ensureRun(s, runId);
    if (ev.type === 'launched') { if (!r.startedAt) r.startedAt = this.now(); }
    else if (ev.agentId && (ev.type === 'started' || ev.type === 'result' || ev.type === 'failed')) {
      const ra = this.runAgent(s, runId, String(ev.agentId));
      if (ev.key) ra.key = String(ev.key).slice(0, 80);
      if (ev.type === 'started') {
        if (ev.label) ra.label = clip(String(ev.label), 40);
        if (ev.phase) ra.phase = clip(String(ev.phase), 60);
        const a = s.subs.get(ra.id);
        if (a) { if (ra.label && !a.name) a.name = ra.label; if (ra.phase) a.phase = ra.phase; a.workflow = runId; }
      } else {
        ra.state = ev.type === 'result' ? 'done' : 'failed';
        const a = s.subs.get(ra.id);
        if (a && !a.finished) this.finishSub(s, a, ev.type === 'result' ? tr('Ha finito!') : tr('Si è fermato'), !a._live);
      }
    }
    this.touch();
  }
  // lo strumento Workflow (chi lo lancia) e SendMessage (chi scrive a chi): servono alla vista delle squadre
  trackTeam(s, a, tool, input, ts, toolUseId) {
    if (tool === 'Workflow' && toolUseId) {
      s.workflowCalls.set(toolUseId, { description: clip(String(input.description || ''), 80), t: ts });
      if (s.workflowCalls.size > 40) s.workflowCalls.delete(s.workflowCalls.keys().next().value);
    } else if (tool === 'SendMessage') {
      const to = String(input.to || input.recipient || '').slice(0, 80);
      if (!to) return;
      s.messages.push({ t: ts, fromId: a.id, from: displayName(a), to, toId: '', toolUseId, summary: clip(String(input.summary || input.message || input.content || ''), 80) });
      if (s.messages.length > 60) s.messages.splice(0, s.messages.length - 60);
    }
  }
  teamResult(s, tool, toolUseId, r, ts) {
    if (!r || typeof r !== 'object') return;
    if (tool === 'Workflow' && r.runId) {
      const run = this.ensureRun(s, String(r.runId));
      const call = s.workflowCalls.get(toolUseId);
      if (r.workflowName) run.name = clip(String(r.workflowName), 60);
      if (call && call.description && !run.description) run.description = call.description;
      if (r.taskId) run.taskId = String(r.taskId);
      if (!run.startedAt) run.startedAt = (call && call.t) || ts;
      this.touch();
    } else if (tool === 'SendMessage') {
      const m = s.messages.find(x => x.toolUseId === toolUseId);
      if (m && r.resumedAgentId) m.toId = String(r.resumedAgentId);
    }
  }

  // un'esecuzione per l'interfaccia: fasi nell'ordine dello script, con avanzamento, costo e tempi
  workflowSnapshot(s, r) {
    const rate = this.rateOf(s);
    const final = /^(completed|done|success|failed|error|cancel+ed|killed|stopped)$/i.test(r.status);
    const agents = [...r.agents.values()].map(ra => ({ id: ra.id, key: ra.key, label: ra.label, phase: ra.phase, type: ra.type, t0: ra.t0, t1: ra.t1, tokens: ra.tokens, cost: ra.w * rate,
      state: ra.state === 'running' && final ? 'stopped' : ra.state }));
    const order = r.phases.map(p => p.title);
    for (const a of agents) if (a.phase && !order.includes(a.phase)) order.push(a.phase);
    if (agents.some(a => !a.phase)) order.push('');
    const phases = order.map(title => {
      const l = agents.filter(a => (a.phase || '') === title);
      const t0s = l.map(a => a.t0).filter(Boolean), t1s = l.map(a => a.t1).filter(Boolean);
      return {
        title, detail: (r.phases.find(p => p.title === title) || {}).detail || '',
        total: l.length, done: l.filter(a => a.state === 'done').length, failed: l.filter(a => a.state === 'failed').length,
        running: l.filter(a => a.state === 'running').length, stopped: l.filter(a => a.state === 'stopped').length,
        cost: l.reduce((x, a) => x + a.cost, 0), tokens: l.reduce((x, a) => x + a.tokens, 0),
        t0: t0s.length ? Math.min(...t0s) : 0, t1: t1s.length ? Math.max(...t1s) : 0,
      };
    }).filter(p => p.total || p.title);
    const running = agents.some(a => a.state === 'running');
    const firstT0 = agents.map(a => a.t0).filter(Boolean);
    return {
      id: r.id, name: r.name, description: r.description, taskId: r.taskId,
      // senza riepilogo: finita se tutti i suoi agenti hanno un esito
      status: final ? r.status : running || !agents.length ? 'running' : 'done',
      startedAt: r.startedAt || (firstT0.length ? Math.min(...firstT0) : 0),
      endedAt: r.endedAt, durationMs: r.durationMs,
      agentCount: Math.max(r.agentCount, agents.length), totalTokens: r.totalTokens || agents.reduce((x, a) => x + a.tokens, 0), totalToolCalls: r.totalToolCalls,
      cost: agents.reduce((x, a) => x + a.cost, 0), summary: r.summary, phases,
      agents: agents.sort((x, y) => (x.t0 || 0) - (y.t0 || 0)).slice(-80),
    };
  }

  // il riepilogo scritto da Claude Code alla fine: nome, stato, fasi, durata, totali
  applyWorkflowSummary(sessionId, runId, o) {
    const s = this.ensureSession(sessionId, '', undefined);
    const r = this.ensureRun(s, runId);
    if (o.workflowName) r.name = clip(String(o.workflowName), 60);
    if (o.status) r.status = String(o.status);
    if (Array.isArray(o.phases)) r.phases = o.phases.slice(0, 20).map(p => ({ title: clip(String((p && p.title) || ''), 60), detail: clip(String((p && p.detail) || ''), 120) })).filter(p => p.title);
    if (Number(o.startTime)) r.startedAt = Number(o.startTime);
    if (Number(o.durationMs)) { r.durationMs = Number(o.durationMs); r.endedAt = (r.startedAt || 0) + r.durationMs; }
    for (const k of ['agentCount', 'totalTokens', 'totalToolCalls']) if (Number.isFinite(Number(o[k]))) r[k] = Number(o[k]);
    if (o.summary) r.summary = clip(String(o.summary), 300);
    if (o.taskId) r.taskId = String(o.taskId);
    this.touch();
  }

  // lista delle cose da fare e piano del capo: finiscono sulle lavagne
  trackBoards(s, tool, input, ts, toolUseId) {
    const norm = st => (st === 'completed' ? 'done' : st === 'in_progress' ? 'doing' : 'todo');
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      s.todos = input.todos.slice(0, 12).map(x => ({ text: clip(x.content || x.activeForm || '', 60), status: norm(x.status) }));
      s.todosAt = ts;
    } else if (tool === 'TaskCreate' && (input.subject || input.description)) {
      // l'id vero arriva nel risultato ("Task #7 created"); intanto ne usiamo uno provvisorio
      const id = toolUseId ? 'tmp:' + toolUseId : String(++s.taskSeq);
      s.tasks.set(id, { text: clip(input.subject || input.description, 60), status: 'todo' });
      s.todos = this.boardTodos(s); s.todosAt = ts;
    } else if (tool === 'TaskUpdate' && input.taskId != null) {
      const t = s.tasks.get(String(input.taskId));
      if (t) {
        if (input.status === 'deleted') s.tasks.delete(String(input.taskId));
        else if (input.status) t.status = norm(input.status);
        if (input.subject) t.text = clip(input.subject, 60);
        s.todos = this.boardTodos(s); s.todosAt = ts;
      }
    } else if (tool === 'mcp__ccd_turn__update_plan') {
      // app desktop di Claude: la lista dei compiti passa da questo strumento (items la sostituisce tutta;
      // advance chiude il passo in corso e apre il successivo; done/start indicano i passi per numero, da 1)
      if (Array.isArray(input.items)) s.deskPlan = input.items.slice(0, 12).map(x => ({ text: clip(String((x && x.content) || ''), 60), status: norm(x && x.status) }));
      const L = s.deskPlan;
      if (!L) return;
      if (input.advance) {
        const i = L.findIndex(x => x.status === 'doing');
        if (i >= 0) L[i].status = 'done';
        const j = L.findIndex(x => x.status === 'todo');
        if (j >= 0) L[j].status = 'doing';
      }
      if (Array.isArray(input.done)) for (const n of input.done) if (L[Number(n) - 1]) L[Number(n) - 1].status = 'done';
      if (input.start && L[Number(input.start) - 1]) L[Number(input.start) - 1].status = 'doing';
      s.todos = L.map(x => ({ ...x })); s.todosAt = ts;
    } else if (tool === 'mcp__ccd_turn__wrap_up' && s.deskPlan) {
      // chiudere il turno spunta la lista
      for (const x of s.deskPlan) x.status = 'done';
      s.todos = s.deskPlan.map(x => ({ ...x })); s.todosAt = ts;
    } else if ((tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') && /\.md$/i.test(String(input.file_path || ''))) {
      // Claude Code scrive il piano in un file .md e poi chiama ExitPlanMode senza contenuto. Il file sta in
      // <config>/plans/ o, nell'app desktop, in una cartella di lavoro della sessione: in modalità piano Claude può
      // scrivere solo quello, quindi vale l'ultimo .md toccato prima di ExitPlanMode (quelli in plans/ hanno la precedenza)
      const p = String(input.file_path), key = isPlanFile(p) ? 'planDraft' : 'mdDraft';
      const d = s[key] && s[key].path === p ? s[key] : null;
      if (tool === 'Write') s[key] = { path: p, text: String(input.content || ''), t: ts };
      else if (d && d.text != null) {
        const edits = tool === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []) : [input];
        for (const e of edits) {
          if (!e || typeof e.old_string !== 'string' || !e.old_string || !d.text.includes(e.old_string)) continue;
          const nw = String(e.new_string ?? '');
          d.text = e.replace_all ? d.text.split(e.old_string).join(nw) : d.text.replace(e.old_string, () => nw);
        }
        d.t = ts;
      } else s[key] = { path: p, text: null, t: ts }; // scritto prima della parte di transcript che abbiamo letto: si rilegge dal disco
    } else if (tool === 'ExitPlanMode') {
      // le versioni vecchie passano il piano nell'input; quelle nuove lo lasciano nel file
      let text = typeof input.plan === 'string' && input.plan.trim() ? input.plan : '';
      if (!text) {
        const recent = d => d && ts - (d.t || 0) < PLAN_DRAFT_MS;
        const d = recent(s.planDraft) ? s.planDraft : recent(s.mdDraft) ? s.mdDraft : null;
        if (d) text = d.text != null ? d.text : readPlanFile(d.path);
      }
      if (text) this.setPlan(s, text, ts);
    }
  }

  setPlan(s, text, ts) {
    const pl = parsePlan(text);
    s.plan = { title: clip(pl.title || tr('Piano di lavoro'), 50), steps: pl.steps.map(x => clip(x, 28)), at: ts || this.now() };
    this.touch();
  }

  // commit, push, PR, tag e test verdi: finiscono nella bacheca dei rilasci e fanno partire la festa
  trackRelease(s, a, pend, block, line, ts) {
    const cmd = pend.input && pend.input.command;
    const ev = releases.detect(cmd, block, line);
    if (releases.isTestCommand(cmd) && (!ev || ev.kind !== 'tests')) { s.testsRed = true; return; }
    if (!ev) return;
    this.addRelease(s, a, ev, ts);
  }
  addRelease(s, a, ev, ts) {
    const t = ts || this.now();
    let party = true;
    if (ev.kind === 'tests') {
      // test verdi: si festeggia solo se prima erano rossi o se è passato un po'
      party = s.testsRed || t - s.lastTestParty > 15 * 60000;
      s.testsRed = false;
      if (party) s.lastTestParty = t;
    }
    const rel = { id: t + ':' + s.releases.length, t, kind: ev.kind, text: ev.text, url: ev.url || '', agent: displayName(a) };
    s.releases.push(rel);
    if (s.releases.length > 30) s.releases.splice(0, s.releases.length - 30);
    if (ev.kind !== 'push' && party) s.party = { t, kind: ev.kind, text: ev.text, agent: displayName(a) };
    if (ev.kind !== 'tests' || party) this.addLog(s, displayName(a) + ' · ' + ev.text, 'release');
    this.touch();
  }

  // sulla lavagna: tutto quello che è ancora da fare, più le ultime cose finite
  boardTodos(s) {
    const all = [...s.tasks.values()];
    const open = all.filter(t => t.status !== 'done');
    const done = all.filter(t => t.status === 'done').slice(-Math.max(2, 10 - open.length));
    return [...done, ...open].slice(-10);
  }

  resolveTask(s, toolUseId, result) {
    const tmp = 'tmp:' + toolUseId;
    const t = s.tasks.get(tmp);
    if (!t) return;
    const text = typeof result === 'string' ? result : Array.isArray(result) ? result.map(x => x && x.text || '').join(' ') : '';
    const m = /Task #(\d+)/.exec(text);
    s.tasks.delete(tmp);
    const id = m ? m[1] : String(++s.taskSeq);
    if (m) s.taskSeq = Math.max(s.taskSeq, Number(m[1]));
    s.tasks.set(id, t);
  }

  applyCostState(s, line) {
    const total = Number(line.totalCostUSD);
    if (!Number.isFinite(total)) return;
    let w = 0;
    for (const m of Object.values(line.modelUsage || {})) {
      w += (m.inputTokens || 0) + 5 * (m.outputTokens || 0) + 0.1 * (m.cacheReadInputTokens || 0) + 1.25 * (m.cacheCreationInputTokens || 0);
    }
    if (w > 0 && total > 0) s.rate = total / w;
    s.costState = { total, weightedAt: weight(s.tok) };
  }

  rateOf(s) { return s.rate || this.settings.pricePerMTok / 1e6; }
  costOf(s) {
    const r = this.rateOf(s);
    const wNow = weight(s.tok);
    if (s.costState) return s.costState.total + Math.max(0, wNow - s.costState.weightedAt) * r;
    return wNow * r;
  }

  // solo contabilità (token e costi) per le parti di transcript che non rileggiamo
  // detached: sottoagente già concluso, contiamo i suoi token senza farlo entrare in ufficio
  accountLine(sessionId, agentId, line, meta, detached) {
    const s = this.ensureSession(sessionId, line.cwd, Date.parse(line.timestamp) || undefined);
    if (line.type === 'cost-state' && !agentId) return this.applyCostState(s, line);
    if (!detached && line.type !== 'assistant') return this.prefixLine(s, agentId, line, meta);
    if (line.type !== 'assistant' || !line.message) return;
    if (detached) {
      const ghost = { id: agentId, kind: 'sub', type: (meta && meta.agentType) || 'Sottoagente', tok: emptyTok(), workflow: meta && meta.workflowRunId };
      return this.addTokens(s, ghost, line.message.usage, line.message.id || line.requestId);
    }
    const a = agentId ? this.ensureSub(s, agentId, meta, true, Date.parse(line.timestamp) || undefined) : s.main;
    this.addTokens(s, a, line.message.usage, line.message.id || line.requestId, Date.parse(line.timestamp) || undefined);
    noteModel(a, line);
    // anche la parte vecchia del transcript disegna la mappa (senza esiti, che stanno nelle righe "user")
    const c = line.message.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b && b.type === 'tool_use') this.worldStart(s, a, b.id, b.name, b.input, Date.parse(line.timestamp) || this.now());
      else if (b && b.type === 'text' && b.text) this.worldReply(s, a, Date.parse(line.timestamp) || this.now(), b.text);
    }
  }

  // parte vecchia del transcript (non riletta per l'animazione): esiti, richieste e compattazioni
  // servono solo alla mappa e alla "mente", senza cambiare lo stato dei personaggi
  prefixLine(s, agentId, line, meta) {
    const ts = Date.parse(line.timestamp) || this.now();
    const a = agentId ? this.ensureSub(s, agentId, meta, true, ts) : s.main;
    if (line.type === 'system' && line.subtype === 'compact_boundary') return this.mindOf(s, a).boundary(ts, line.compactMetadata);
    if (line.type === 'attachment' && line.attachment && line.attachment.type === 'queued_command' && typeof line.attachment.prompt === 'string') {
      if (!agentId) this.mindOf(s, a).setGoal(ts, line.attachment.prompt);
      return;
    }
    if (line.type !== 'user' || line.isMeta || !line.message) return;
    const c = line.message.content;
    if (line.isCompactSummary) return this.mindOf(s, a).compact(ts, typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join('\n') : '');
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && b.text).map(b => b.text) : [];
    for (const raw of texts) {
      const t = String(raw).trim();
      if (!t || t.startsWith('[Request interrupted') || /^<(command-name|local-command|system-reminder|bash-|task-notification)/.test(t)) continue;
      const m = this.mindOf(s, a);
      if (!agentId || !m.goals.length) m.setGoal(ts, t);
    }
    if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result') this.worldEnd(s, a, b.tool_use_id, b.is_error, b, line, ts);
  }

  // mappa della realtà dell'agente (vedi worldmap.js)
  worldStart(s, a, id, name, input, ts) {
    try { (a.world || (a.world = new AgentWorld())).start(id, name, input, ts || this.now(), s.cwd, a.ctx || 0); } catch {}
    try { const m = this.mindOf(s, a); m.action(id, ts || this.now(), describeTool(name, input), actionText(name, input)); const p = m.byTool.get(id); if (p) p.tool = name; } catch {}
  }
  // testo completo delle ultime risposte: serve a confrontare quello che dice con quello che c'è (grounding.js)
  worldReply(s, a, ts, text) {
    try { (a.world || (a.world = new AgentWorld())).reply(ts || this.now(), text); } catch {}
  }
  worldEnd(s, a, id, isErr, block, line, ts) {
    try { if (a.world) a.world.end(id, isErr, block, line, ts || this.now(), s.cwd); } catch {}
    try {
      const m = this.mindOf(s, a), act = m.byTool.get(id);
      const tool = act && act.tool;
      const kind = RESULT_KIND[tool] || 'result';
      const label = act ? (kind === 'file' ? act.label : act.label + ' → ' + (isErr ? tr('errore') : tr('risultato'))) : tr('risultato');
      m.result(id, ts || this.now(), kind, label, blockText(block), isErr);
    } catch {}
  }
  // contesto e obiettivo dell'agente (vedi semantic.js)
  mindOf(s, a) {
    if (!s.corpus) s.corpus = new Corpus();
    return a.mind || (a.mind = new AgentMind(s.corpus));
  }

  // ---------- transcript ----------
  // line: oggetto JSON di una riga del transcript. agentId: null per il principale.
  applyTranscriptLine(sessionId, agentId, line, opts = {}) {
    if (!line || typeof line !== 'object') return;
    const type = line.type;
    const ts = Date.parse(line.timestamp) || 0;
    const s = this.ensureSession(sessionId, line.cwd, ts || undefined);
    if (line.entrypoint) this.setEntrypoint(s, line.entrypoint);
    if (type === 'ai-title' && line.aiTitle) { s.title = line.aiTitle; this.touch(); return; }
    if (type === 'custom-title' && line.customTitle) { s.title = line.customTitle; this.touch(); return; }
    if (type === 'summary' && line.summary && !s.title) { s.title = line.summary; this.touch(); return; }
    if (type === 'cost-state' && !agentId) { this.applyCostState(s, line); this.touch(); return; }
    if (type === 'system' && line.subtype === 'compact_boundary') {
      const ca = agentId ? this.ensureSub(s, agentId, opts.meta, opts.replay, ts) : s.main;
      this.mindOf(s, ca).boundary(ts || this.now(), line.compactMetadata);
      return;
    }
    if (type === 'attachment' && line.attachment && line.attachment.type === 'queued_command' && typeof line.attachment.prompt === 'string' && !agentId) {
      this.mindOf(s, s.main).setGoal(ts || this.now(), line.attachment.prompt); // messaggio mandato mentre lavorava
      return;
    }
    if (type !== 'user' && type !== 'assistant') return;
    if (!ts) return;

    const live = !opts.replay;
    s.lastActivity = Math.max(s.lastActivity, ts);
    if (live) this.announce(s);
    const a = agentId ? this.ensureSub(s, agentId, opts.meta, opts.replay, ts) : s.main;
    const msg = line.message || {};
    if (a.workflow) { const ra = this.runAgent(s, a.workflow, a.id); ra.t0 = ra.t0 ? Math.min(ra.t0, ts) : ts; ra.t1 = Math.max(ra.t1 || 0, ts); }
    if (type === 'assistant') { this.addTokens(s, a, msg.usage, msg.id || line.requestId, ts); noteModel(a, line); }
    if (a.finished && a.byQuiet) this.resumeSub(a, ts);
    if (a.finished) return;
    if (live) a._live = true;
    const content = msg.content;

    if (type === 'assistant') {
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          this.setAgent(a, 'thinking', tr('Sta pensando…'), ts);
          if (typeof b.thinking === 'string' && b.thinking.trim()) this.mindOf(s, a).add('thinking', ts, clip(b.thinking, 80), b.thinking);
        } else if (b.type === 'text' && b.text && b.text.trim()) {
          this.mindOf(s, a).add('reply', ts, clip(b.text, 80), b.text);
          this.worldReply(s, a, ts, b.text);
          const end = msg.stop_reason === 'end_turn' && !agentId;
          if (end) this.setAgent(a, 'idle', tr('Ha finito: tocca a te'), ts);
          else this.setAgent(a, 'writing', tr('Scrive: «{text}»', { text: clip(b.text, 44) }), ts);
        } else if (b.type === 'tool_use') {
          a.toolCount++;
          const tk = a.kind === 'main' ? 'Claude' : a.type;
          s.toolsByType[tk] = (s.toolsByType[tk] || 0) + 1;
          if (a.pending <= 0) { a.pendingSince = ts; }
          a.pending++;
          a.pendingDesc = describeTool(b.name, b.input);
          a.pendingName = b.name;
          s.pendingTools.set(b.id, { name: b.name, input: b.input || {}, agentId, ts });
          this.worldStart(s, a, b.id, b.name, b.input, ts);
          this.step(s, a, agentId, 'working', a.pendingDesc, ts);
          if (SPAWN_TOOLS.has(b.name)) {
            const inp = b.input || {};
            s.spawns.set(b.id, { type: inp.subagent_type || 'general-purpose', description: inp.description || '', prompt: inp.prompt || '', parent: agentId });
          }
          if (!agentId) this.trackBoards(s, b.name, b.input || {}, ts, b.id);
          this.trackTeam(s, a, b.name, b.input || {}, ts, b.id);
        }
      }
      if (msg.stop_reason === 'end_turn' && !agentId && a.status !== 'idle') {
        this.setAgent(a, 'idle', tr('Ha finito: tocca a te'), ts);
      }
    } else if (type === 'user') {
      if (line.isMeta) return;
      if (line.isCompactSummary) { // il contesto è stato compattato: riparte da un riassunto
        const txt = typeof content === 'string' ? content : Array.isArray(content) ? content.map(x => (x && x.text) || '').join('\n') : '';
        this.mindOf(s, a).compact(ts, txt);
        this.setAgent(a, 'thinking', tr('Riparte dal riassunto del contesto…'), ts);
        this.touch();
        return;
      }
      if (typeof content === 'string') {
        this.onUserText(s, a, content, ts, agentId);
      } else if (Array.isArray(content)) {
        let hadResult = false;
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'tool_result') {
            hadResult = true;
            const pend = s.pendingTools.get(b.tool_use_id);
            s.pendingTools.delete(b.tool_use_id);
            this.worldEnd(s, a, b.tool_use_id, b.is_error, b, line, ts);
            if (pend) {
              if (USER_TOOLS.has(pend.name)) a.userHook = null;
              if (pend.name === 'TaskCreate' && !agentId) this.resolveTask(s, b.tool_use_id, b.content);
              // il piano approvato nel risultato (con le modifiche dell'utente), se Claude Code ce lo mette
              if (pend.name === 'ExitPlanMode' && !agentId && !b.is_error) { const ap = approvedPlan(b, line); if (ap) this.setPlan(s, ap, ts); }
              if ((pend.name === 'Workflow' || pend.name === 'SendMessage') && !b.is_error) this.teamResult(s, pend.name, b.tool_use_id, line && line.toolUseResult, ts);
              a.pending = Math.max(0, a.pending - 1);
              if (a.pending > 0) a.pendingSince = ts;
              // errori di fila sullo stesso strumento
              if (b.is_error) { const ek = a.kind === 'main' ? 'Claude' : a.type; s.errByType[ek] = (s.errByType[ek] || 0) + 1; }
              if ((pend.name === 'Bash' || pend.name === 'PowerShell') && live) this.trackRelease(s, a, pend, b, line, ts);
              if (b.is_error) { a.errStreak = a.errTool === pend.name ? a.errStreak + 1 : 1; a.errTool = pend.name; }
              else if (a.errTool === pend.name || !b.is_error) { a.errStreak = 0; a.errTool = ''; }
            }
            if (pend && SPAWN_TOOLS.has(pend.name)) {
              const r = line.toolUseResult || {};
              const st = String(r.status || '').toLowerCase();
              const subId = r.agentId;
              const sub = subId && s.subs.get(subId);
              if (sub && (FINAL_STATUSES.has(st) || b.is_error)) {
                this.finishSub(s, sub, b.is_error ? tr('Si è fermato') : tr('Ha finito!'), !live);
              } else if (sub && !FINAL_STATUSES.has(st)) sub.background = true;
            }
          } else if (b.type === 'text' && b.text) {
            this.onUserText(s, a, b.text, ts, agentId);
          }
        }
        if (hadResult) this.step(s, a, agentId, 'thinking', tr('Valuta il risultato…'), ts);
      }
    }
    if (live) this.sample(s);
    this.touch();
  }

  onUserText(s, a, text, ts, agentId) {
    const t = String(text).trim();
    if (!t) return;
    if (t.startsWith('[Request interrupted')) { a.pending = 0; this.userAnswered(s, a, agentId); a.interruptedAt = ts; this.setAgent(a, 'idle', tr('Interrotto da te'), ts); return; }
    if (t.startsWith('<command-name>')) {
      const m = t.match(/<command-name>([^<]+)<\/command-name>/);
      this.setAgent(a, 'thinking', tr('Comando {cmd}', { cmd: m ? m[1] : '' }), ts);
      return;
    }
    if (t.startsWith('<local-command') || t.startsWith('<system-reminder>') || t.startsWith('<bash-') || t.startsWith('<task-notification')) return;
    // l'obiettivo (stella polare): per un sottoagente il suo primo messaggio, per il capo ogni nuova richiesta
    const m = this.mindOf(s, a);
    if (!agentId || !m.goals.length) m.setGoal(ts, t);
    this.userAnswered(s, a, agentId); // una nuova richiesta chiude la domanda rimasta aperta
    if (agentId) this.setAgent(a, 'thinking', tr('Legge il compito…'), ts);
    else this.setAgent(a, 'thinking', tr('Nuovo compito: «{text}»', { text: clip(t, 40) }), ts);
  }

  // ---------- registro sessioni (~/.claude/sessions/*.json) ----------
  applyRegistry(entries) {
    this.registrySeen = true;
    const seen = new Set();
    const t = this.now();
    for (const e of entries) {
      if (!e.sessionId) continue;
      seen.add(e.sessionId);
      const s = this.ensureSession(e.sessionId, e.cwd);
      if (e.cwd && s.cwd !== e.cwd) this.setCwd(s, e.cwd);
      if (e.entrypoint) this.setEntrypoint(s, e.entrypoint);
      const wasAlive = s.alive;
      s.alive = !!e.alive;
      s.pid = e.pid;
      if (e.name && !s.name) s.name = e.name;
      s.registryStatus = e.status || null;
      s.waitingFor = e.waitingFor || null;
      if (e.alive) {
        s.ended = false;
        this.announce(s);
        const m = s.main;
        if (e.status === 'waiting') {
          if (m.status !== 'waiting') this.addLog(s, e.waitingFor ? tr('Claude aspetta il tuo OK ({what})', { what: e.waitingFor }) : tr('Claude aspetta il tuo OK'), 'wait');
          this.setAgent(m, 'waiting', e.waitingFor ? tr('Aspetta il tuo OK: {what}', { what: e.waitingFor }) : tr('Aspetta il tuo OK'), t);
        } else if (m.status === 'waiting' && !m.userWait) { // se aspetta una risposta a una domanda, lo dice il transcript
          this.setAgent(m, e.status === 'busy' ? 'thinking' : 'idle', e.status === 'busy' ? tr('Riprende il lavoro') : tr('Ha finito: tocca a te'), t);
        } else if (e.status === 'idle' && BUSY.has(m.status) && t - m.lastActivity > 4000) {
          this.setAgent(m, 'idle', tr('Ha finito: tocca a te'), m.lastActivity);
        } else if (e.status === 'busy' && m.status === 'idle' && t - m.lastActivity > 3000) {
          this.setAgent(m, 'thinking', tr('Sta pensando…'), t);
        }
      } else if (wasAlive) {
        this.endSession(s);
      }
    }
    // sessioni che il registro conosceva e che sono sparite dal registro => chiuse
    for (const s of this.sessions.values()) {
      if (s.demo) continue;
      if (s.alive === true && !seen.has(s.id)) {
        s.alive = false;
        this.endSession(s);
      }
    }
    this.touch();
  }

  endSession(s) {
    if (s.ended) return;
    s.ended = true;
    s.endedAt = this.now();
    s.main.status = 'leaving';
    s.main.action = tr('Chiude e va a casa');
    for (const a of s.subs.values()) if (!a.finished) this.finishSub(s, a, tr('Va a casa'), true);
    this.addLog(s, tr('Sessione chiusa: {name}', { name: this.label(s) }), 'end');
  }

  // ---------- hook ----------
  applyHook(ev) {
    if (!ev || !ev.session_id) return;
    const t = this.now();
    if (!ev._demo) this.hooksLastSeen = t;
    const s = this.ensureSession(ev.session_id, ev.cwd);
    s.lastActivity = t;
    s.hookSeen = true;
    this.announce(s);
    const name = ev.hook_event_name;
    const subId = ev.agent_id;
    const getA = () => { const a = subId ? this.ensureSub(s, subId, { agentType: ev.agent_type }) : s.main; a._live = true; return a; };

    switch (name) {
      case 'SessionStart':
        if (ev.cwd) this.setCwd(s, ev.cwd);
        s.ended = false;
        if (s.alive === false) s.alive = null;
        this.setAgent(s.main, 'idle', ev.source === 'resume' ? tr('Riprende una vecchia pratica') : tr('Entra in ufficio'));
        break;
      case 'SessionEnd':
        this.endSession(s);
        break;
      case 'UserPromptSubmit':
        if (s.demo && ev.prompt) this.mindOf(s, s.main).setGoal(t, ev.prompt); // per le sessioni vere lo leggiamo dal transcript
        this.userAnswered(s, s.main, null);
        this.setAgent(s.main, 'thinking', tr('Nuovo compito: «{text}»', { text: clip(ev.prompt, 40) }));
        break;
      case 'PreToolUse': {
        const a = getA();
        if (USER_TOOLS.has(ev.tool_name)) a.userHook = ev.tool_name;
        this.step(s, a, subId, 'working', describeTool(ev.tool_name, ev.tool_input));
        if (SPAWN_TOOLS.has(ev.tool_name) && ev.tool_use_id) {
          const inp = ev.tool_input || {};
          s.spawns.set(ev.tool_use_id, { type: inp.subagent_type || 'general-purpose', description: inp.description || '', prompt: inp.prompt || '', parent: subId || null });
        }
        break;
      }
      case 'PostToolUse': {
        const a = getA();
        if (s.demo) a.errStreak = 0;
        if (USER_TOOLS.has(ev.tool_name)) this.userAnswered(s, a, subId);
        this.step(s, a, subId, 'thinking', tr('Valuta il risultato…'));
        break;
      }
      case 'PostToolUseFailure': {
        const a = getA();
        if (USER_TOOLS.has(ev.tool_name)) this.userAnswered(s, a, subId);
        if (s.demo) { a.errStreak = a.errTool === ev.tool_name ? a.errStreak + 1 : 1; a.errTool = ev.tool_name; }
        this.step(s, a, subId, 'thinking', tr('Valuta l\'errore…'));
        break;
      }
      case 'PermissionRequest': {
        const a = getA();
        this.setAgent(a, 'waiting', tr('Serve il tuo OK: {what}', { what: describeTool(ev.tool_name, ev.tool_input) }));
        this.addLog(s, tr('{agent} chiede il permesso: {tool}', { agent: a.kind === 'main' ? 'CLAUDE' : displayName(a), tool: ev.tool_name || '' }), 'wait');
        break;
      }
      case 'Notification': {
        const nt = ev.notification_type || '';
        if (nt === 'permission_prompt' || /permission/i.test(ev.message || '')) {
          if (s.main.status !== 'waiting') this.addLog(s, tr('Claude chiede il permesso'), 'wait');
          this.setAgent(s.main, 'waiting', clip(ev.message || tr('Serve il tuo OK'), 60));
        } else if (nt === 'idle_prompt') {
          if (s.main.status !== 'idle') this.setAgent(s.main, 'idle', tr('Ti aspetta da un po\'…'));
        }
        break;
      }
      case 'Stop':
        this.userAnswered(s, s.main, null);
        this.setAgent(s.main, 'idle', tr('Ha finito: tocca a te'));
        break;
      case 'SubagentStart': {
        const a = this.ensureSub(s, subId, { agentType: ev.agent_type, parentAgentId: ev.parent_agent_id });
        a._live = true;
        this.setAgent(a, 'thinking', tr('Si mette al lavoro'));
        break;
      }
      case 'SubagentStop': {
        const a = s.subs.get(subId);
        if (a) this.finishSub(s, a, tr('Ha finito!'));
        break;
      }
      case 'PreCompact':
        this.setAgent(s.main, 'working', tr('Riordina la scrivania (compatta)'));
        break;
      default:
        break;
    }
    this.sample(s);
    this.touch();
  }

  // ---------- ciclo periodico ----------
  tick() {
    const t = this.now();
    let changed = false;
    for (const s of [...this.sessions.values()]) {
      for (const [id, a] of [...s.subs]) {
        if (a.finished) {
          if (t - a.finishedAt > CFG.doneLingerMs) {
            s.subs.delete(id); changed = true;
            if (a.byQuiet) { s.quietDone.set(id, a); if (s.quietDone.size > 100) s.quietDone.delete(s.quietDone.keys().next().value); }
          }
          continue;
        }
        if (s.demo) continue;
        // Claude Code non segna sempre i sottoagenti conclusi: deduciamolo dal silenzio
        const idle = t - a.lastActivity;
        let done = false;
        if (a.pending <= 0) {
          if (a.status === 'writing' && idle > CFG.subQuietAfterReportMs) done = true;
          else if (idle > CFG.subQuietMs) done = true;
        } else if (idle > CFG.subStuckMs) done = true;
        // chi non abbiamo mai visto lavorare dal vivo esce senza animazione (ricostruzione all'avvio)
        if (done) { this.finishSub(s, a, tr('Ha finito!'), idle > CFG.subSilentRemoveMs || !a._live, true); changed = true; }
      }
      // fine sessione
      if (s.ended && t - s.endedAt > CFG.endedLingerMs) { this.retire(s); changed = true; continue; }
      if (!s.demo && !this.noTimeout && s.alive !== true && !s.ended) {
        // nessuna informazione dal registro: usa il silenzio
        let lastAny = s.lastActivity;
        for (const a of s.subs.values()) if (a.lastActivity > lastAny) lastAny = a.lastActivity;
        if (t - lastAny > CFG.sessionIdleTimeoutMs + 60000) { this.retire(s); changed = true; continue; }
        if (t - lastAny > CFG.sessionIdleTimeoutMs) { this.endSession(s); changed = true; }
      }
      if (s.pendingTools.size > 500) s.pendingTools.clear();
      this.sample(s);
      if (this.updateAlerts(s)) changed = true;
    }
    if (changed) this.touch();
  }

  // toglie la sessione dall'ufficio ma ne conserva costi e storico, nel caso riprenda
  retire(s) {
    this.sessions.delete(s.id);
    if (s.demo) return;
    this.retired.set(s.id, {
      tok: s.tok, wByType: s.wByType, seenMsg: s.seenMsg, costState: s.costState, rate: s.rate,
      completed: s.completed, completedByType: s.completedByType, hist: s.hist, histCur: s.histCur, title: s.title,
      todos: s.todos, todosAt: s.todosAt, tasks: s.tasks, taskSeq: s.taskSeq, plan: s.plan,
      releases: s.releases, errByType: s.errByType, toolsByType: s.toolsByType,
    });
    if (this.retired.size > 200) this.retired.delete(this.retired.keys().next().value);
  }

  // avvisi di ancoraggio (facoltativi): solo fatti in memoria, senza disco, ricalcolati al massimo ogni 10 s
  groundingAlerts(s, t) {
    if (s._ground && t - s._ground.t < 10000) return s._ground.items;
    const items = [];
    try {
      const agents = [s.main, ...s.subs.values()].filter(a => a.world).map(a => ({ id: a.id, name: displayName(a), world: a.world, mind: a.mind }));
      const recent = x => t - x.t < 10 * 60000;
      for (const b of grounding.checkStale(s, agents, s.cwd, { disk: false }).blindEdits.filter(b => recent(b) && !b.caught)) {
        items.push({ id: 'ground:blind:' + b.agent + ':' + b.key + ':' + b.t, agentId: b.agent, kind: 'grounding', level: 'warn', since: b.t, text: tr('{name} ha modificato {file} senza rileggerlo dopo la modifica di {who}', { name: b.agentName, file: clip(b.key, 40), who: b.changedBy || '?' }) });
      }
      for (const c of grounding.checkClaims(s, agents, s.cwd).claims.filter(c => recent(c) && c.status === 'contradicted')) {
        items.push({ id: 'ground:claim:' + c.agent + ':' + c.t + ':' + c.kind, agentId: c.agent, kind: 'grounding', level: 'warn', since: c.t, text: tr('{name} dice «{text}», ma l\'ultimo esito lo smentisce', { name: c.agentName, text: clip(c.text, 50) }) });
      }
    } catch {}
    s._ground = { t, items: items.slice(0, 6) };
    return s._ground.items;
  }

  // ---------- avvisi intelligenti ----------
  updateAlerts(s) {
    const t = this.now(), st = this.settings;
    const out = [];
    const min = ms => Math.floor(ms / 60000);
    if (!s.ended) {
      for (const a of [s.main, ...s.subs.values()]) {
        if (a.finished) continue;
        const name = displayName(a);
        if (a.status === 'waiting' && t - a.statusSince > st.waitMin * 60000) {
          out.push({ id: 'wait:' + a.id, agentId: a.id, kind: 'wait', level: 'crit', since: a.statusSince, text: a.userWait ? tr('{name} aspetta una tua risposta da {min} min', { name, min: min(t - a.statusSince) }) : tr('{name} aspetta il tuo OK da {min} min', { name, min: min(t - a.statusSince) }) });
        } else if (a.pending > 0 && a.pendingSince && !USER_TOOLS.has(a.pendingName) && t - a.pendingSince > st.stuckMin * 60000 && t - a.lastActivity > st.stuckMin * 60000) {
          out.push({ id: 'stuck:' + a.id, agentId: a.id, kind: 'stuck', level: 'warn', since: a.pendingSince, text: tr('{name} è fermo su «{what}» da {min} min', { name, what: clip(a.pendingDesc, 40), min: min(t - a.pendingSince) }) });
        }
        if (st.errStreak > 0 && a.errStreak >= st.errStreak) {
          out.push({ id: 'err:' + a.id, agentId: a.id, kind: 'errors', level: 'warn', since: a.lastActivity, text: tr('{name}: {n} errori di fila con {tool}', { name, n: a.errStreak, tool: a.errTool }) });
        }
      }
      const activeSubs = [...s.subs.values()].some(a => !a.finished);
      const m = s.main;
      if (m.status === 'idle' && !activeSubs && s.alive !== false && t - m.statusSince > st.idleMin * 60000 && t - m.statusSince < 12 * 3600000) {
        out.push({ id: 'idle:main', agentId: 'main', kind: 'idle', level: 'info', since: m.statusSince, text: tr('La sessione ti aspetta da {min} min', { min: min(t - m.statusSince) }) });
      }
      if (st.groundingAlerts) out.push(...this.groundingAlerts(s, t));
      const cost = this.costOf(s);
      if (st.budgetUSD > 0 && cost > st.budgetUSD) {
        out.push({ id: 'budget', agentId: 'main', kind: 'budget', level: 'warn', since: t, text: tr('Costo {cost} oltre il budget di {budget}', { cost: fmtMoney(cost), budget: fmtMoney(st.budgetUSD, st.budgetUSD % 1 ? 2 : 0) }) });
      }
    }
    const ids = new Set(out.map(x => x.id));
    for (const al of out) {
      if (!s.alertSeen.has(al.id)) { s.alertSeen.add(al.id); this.addLog(s, al.text, 'alert'); }
    }
    for (const id of [...s.alertSeen]) if (!ids.has(id)) s.alertSeen.delete(id);
    const changed = out.length !== s.alerts.length || out.some((x, i) => s.alerts[i].text !== x.text);
    s.alerts = out;
    return changed;
  }

  // ---------- snapshot per il renderer ----------
  sessionSnapshot(s) {
    const t = this.now();
    const rate = this.rateOf(s);
    const costByType = {};
    for (const [k, w] of Object.entries(s.wByType)) costByType[k] = w * rate;
    return {
      id: s.id,
      project: s.project,
      title: s.title || s.name || '',
      cwd: s.cwd,
      kind: s.kind,
      wing: s.kind === 'cowork' ? 'cowork' : 'code',
      alive: s.alive,
      ended: s.ended,
      demo: s.demo,
      hasPid: !!s.pid,
      createdAt: s.createdAt,
      completed: s.completed,
      completedByType: s.completedByType,
      history: historyOf(s, t),
      cost: this.costOf(s),
      costEstimated: !s.costState,
      tokens: { ...s.tok, total: s.tok.in + s.tok.out + s.tok.cr + s.tok.cw },
      costByType,
      alerts: s.alerts,
      todos: s.todos,
      todosAt: s.todosAt,
      plan: s.plan,
      releases: s.releases.slice(-12),
      workflows: [...s.workflows.values()].map(r => this.workflowSnapshot(s, r)),
      messages: s.messages.slice(-30),
      party: s.party,
      main: supervise(pub(s.main, rate), s, t),
      subs: [...s.subs.values()].sort((x, y) => x.startedAt - y.startedAt).map(a => pub(numbered(s, a), rate)),
    };
  }

  snapshot() {
    const t = this.now();
    const sessions = [];
    let hidden = 0;
    for (const s of this.sessions.values()) {
      if (!this.visible(s)) { hidden++; continue; }
      if (s.kind === 'unknown' && !s.demo && !s.hookSeen && s.alive == null && !s.subs.size && s.main.status === 'idle') continue;
      sessions.push(this.sessionSnapshot(s));
    }
    // prima i piani di Claude Code, poi quelli di Cowork; dentro ogni gruppo in ordine di arrivo
    sessions.sort((a, b) => (a.wing === b.wing ? 0 : a.wing === 'code' ? -1 : 1) || a.createdAt - b.createdAt);
    return {
      now: t,
      sessions,
      hiddenCowork: hidden,
      includeCowork: this.includeCowork,
      settings: this.settings,
      log: this.log.slice(-20),
      hooks: { active: t - this.hooksLastSeen < 30 * 60 * 1000, lastSeen: this.hooksLastSeen },
      registry: this.registrySeen,
      demo: this.demo,
      weather: this.weather || null,
      approvals: this.approvals ? [...this.approvals.values()].map(a => ({ id: a.id, sid: a.sid, agentId: a.agentId, tool: a.tool, text: a.text, always: !!a.always, t: a.t })) : [],
      cowork: this.coworkScan || null,
      lang: i18n.getLang(),
    };
  }

  counts() {
    let sessions = 0, agents = 0, busy = 0, waiting = 0;
    for (const s of this.sessions.values()) {
      if (s.ended || !this.visible(s)) continue;
      sessions++;
      const all = [s.main, ...s.subs.values()].filter(a => !a.finished);
      agents += all.length;
      busy += all.filter(a => BUSY.has(a.status)).length;
      waiting += all.filter(a => a.status === 'waiting').length;
    }
    return { sessions, agents, busy, waiting };
  }

  // un campione al minuto: massimo di agenti presenti / al lavoro / in attesa, e quanti hanno finito
  sample(s) {
    const minute = Math.floor(this.now() / 60000);
    if (!s.histCur || s.histCur.m !== minute) {
      if (s.histCur) {
        s.hist.push(s.histCur);
        for (let m = s.histCur.m + 1; m < minute && s.hist.length < 120; m++) s.hist.push({ m, a: 0, b: 0, w: 0, d: 0, gap: true });
        if (s.hist.length > 60) s.hist.splice(0, s.hist.length - 60);
      }
      s.histCur = { m: minute, a: 0, b: 0, w: 0, d: 0 };
    }
    let a = 0, b = 0, w = 0;
    for (const x of [s.main, ...s.subs.values()]) {
      if (x.finished) continue;
      a++;
      if (BUSY.has(x.status)) b++;
      if (x.status === 'waiting') w++;
    }
    const c = s.histCur;
    c.a = Math.max(c.a, a); c.b = Math.max(c.b, b); c.w = Math.max(c.w, w);
  }

  setIncludeCowork(on) { this.includeCowork = !!on; this.touch(); }

  removeDemo() {
    for (const s of [...this.sessions.values()]) if (s.demo) this.sessions.delete(s.id);
    this.touch();
  }
}

// ultimi 60 minuti come array compatto [agenti, al lavoro, in attesa, finiti] (null = sessione non ancora aperta)
function historyOf(s, t) {
  const out = new Array(60).fill(null);
  const minute = Math.floor(t / 60000);
  for (const h of [...s.hist, s.histCur].filter(Boolean)) {
    const i = 59 - (minute - h.m);
    if (i >= 0 && i < 60) out[i] = [h.a, h.b, h.w, h.d];
  }
  return out;
}

function displayName(a) {
  if (a.kind === 'main') return 'CLAUDE';
  // 'Sottoagente' è il tipo provvisorio interno: si mostra tradotto
  const label = a.name || (a.type === 'Sottoagente' ? tr('Sottoagente') : a.type) || tr('Agente');
  return String(label).toUpperCase() + (!a.name && a.seq > 1 ? '-' + a.seq : '');
}

// numero progressivo stabile per i sottoagenti dello stesso tipo (EXPLORE, EXPLORE-2, …)
function numbered(s, a) {
  if (!a.seq && a.type && a.type !== 'Sottoagente') {
    let max = 0;
    for (const o of s.subs.values()) if (o !== a && o.type === a.type && !o.finished) max = Math.max(max, o.seq || 0);
    a.seq = max + 1;
  }
  return a;
}

// se il capo sta solo aspettando i suoi sottoagenti, diciamolo
function supervise(m, s, t) {
  const active = [...s.subs.values()].filter(a => !a.finished && !a.parentId);
  if (active.length && m.status === 'thinking' && t - m.lastActivity > 2500) {
    m.status = 'supervising';
    const types = {};
    for (const a of active) types[a.type] = (types[a.type] || 0) + 1;
    m.action = tr('Coordina {who}', { who: Object.entries(types).slice(0, 3).map(([k, n]) => (n > 1 ? n + ' ' : '') + (k === 'Sottoagente' ? tr('Sottoagente') : k).toUpperCase()).join(', ') });
  }
  return m;
}

// modello e livello di effort scritti da Claude Code in ogni risposta
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function noteModel(a, line) {
  const m = line.message && line.message.model;
  if (typeof m === 'string' && m && !/synthetic/.test(m)) a.model = m;
  const e = typeof line.effort === 'string' ? line.effort : line.effort && typeof line.effort.level === 'string' ? line.effort.level : null;
  if (e && EFFORTS.has(e)) a.effort = e;
}

function pub(a, rate) {
  const tok = a.tok.in + a.tok.out + a.tok.cr + a.tok.cw;
  return {
    id: a.id, kind: a.kind, type: a.type, seq: a.seq || 0, name: a.name || '', description: a.description,
    parentId: a.parentId || null, team: a.team || '', phase: a.phase || '', workflow: a.workflow || '',
    status: a.status, action: a.action, toolCount: a.toolCount, background: !!a.background,
    startedAt: a.startedAt, lastActivity: a.lastActivity, statusSince: a.statusSince, finished: a.finished,
    tokens: tok, cost: weight(a.tok) * rate,
    errStreak: a.errStreak || 0, interruptedAt: a.interruptedAt || 0,
    model: a.model || '', effort: a.effort || '',
  };
}

module.exports = { OfficeState, CFG, DEFAULT_SETTINGS, kindOf, displayName, parsePlan, isPlanFile };
