'use strict';
// Feedback agli agenti: quello che Platypus dice a un agente attraverso gli hook di Claude Code.
// Qui stanno solo le decisioni, come funzioni pure: (evento dell'hook, contesto) -> messaggio o niente.
// Chi chiama (index.js) risponde sempre, anche quando qualcosa va storto: Claude Code non deve mai accorgersi di noi.
//
// Una regola è { feature, run } (o una funzione sola): run(input, ctx) -> null | { feature, text, lessonId?, once?, block?, lines?, max? }
//   once    una chiave per gli avvisi che non vengono dal Libro: lo stesso avviso non torna allo stesso agente
// Le regole vere stanno in feedback-rules.js, che le aggiunge a RULES quando il motore parte.
//   input   l'oggetto che Claude Code manda all'hook (hook_event_name, session_id, agent_id, cwd, tool_name, tool_input…)
//   ctx     { now(), deadline, session, cwd, lessons(cwd), agent(input), settings } : solo stato già in memoria, niente letture lente
//   block   solo per Stop/SubagentStop: chiede all'agente di continuare (l'unica risposta che cambia quello che fa)
// Le regole si aggiungono a RULES, per evento; conta la prima che ha qualcosa da dire e che può dirlo adesso.
//
// Ogni funzione ha tre modi nelle opzioni: spenta, ombra (calcola e registra quello che direbbe, senza dirlo) e accesa.
// I messaggi agli agenti sono sempre in inglese: li legge il modello.

const MAX_TEXT = 400;          // un messaggio a un agente è breve
const PREFIX = 'Platypus: ';   // dice sempre chi parla
// gli eventi a cui sappiamo rispondere (vedi "Hook formats" nel piano della 2.11)
const CONTEXT_EVENTS = new Set(['SessionStart', 'PostToolUse', 'PostToolUseFailure']);
const STOP_EVENTS = new Set(['Stop', 'SubagentStop']);
const EVENTS = new Set([...CONTEXT_EVENTS, ...STOP_EVENTS]);

const RULES = { SessionStart: [], PostToolUse: [], PostToolUseFailure: [], Stop: [], SubagentStop: [] };

// ---- le funzioni e i loro modi
const FEATURES = { sessionLessons: 'fbSessionLessons', elder: 'fbElder', loop: 'fbLoop', claims: 'fbClaims', drift: 'fbDrift' };
const MODES = ['off', 'shadow', 'on'];
const SHADOW_ONLY = new Set(['claims', 'drift']); // nella 2.11 queste due registrano soltanto: prima si guardano i dati
const featureOfSetting = k => Object.keys(FEATURES).find(f => FEATURES[f] === k) || null;
// il valore di un'opzione fb*, ripulito: un modo valido, e mai "acceso" per le funzioni solo in ombra
function cleanMode(setting, v) {
  const m = MODES.includes(v) ? v : 'off';
  return m === 'on' && SHADOW_ONLY.has(featureOfSetting(setting)) ? 'shadow' : m;
}
function modeOf(settings, feature) {
  const k = FEATURES[feature];
  return k ? cleanMode(k, settings && settings[k]) : 'off';
}

const MAX_LONG = 1500;         // il tetto per i pochi messaggi lunghi (l'elenco delle lezioni a inizio sessione)
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
// il testo come arriva all'agente: firmato, entro il limite, su una riga sola (o su più righe pulite, se la regola
// lo chiede con lines: true; con max può chiedere più spazio, fino a MAX_LONG)
function say(text, { max = MAX_TEXT, lines = false } = {}) {
  const lim = Math.max(1, Math.min(Number(max) || MAX_TEXT, MAX_LONG));
  const one = s => String(s || '').replace(/\s+/g, ' ').trim();
  const t = lines ? String(text || '').split('\n').map(one).filter(Boolean).join('\n') : one(text);
  if (!t) return '';
  return cut(/^Platypus\b/.test(t) ? t : PREFIX + t, lim);
}

// input dell'hook + contesto -> { message, rule } oppure null. Non lancia mai.
//   ctx.enabled(rule)       false = quella regola è spenta, non si prova nemmeno
//   ctx.allow(message)      false = quel messaggio adesso non può partire (limiti): si passa alla regola dopo
function decide(input, ctx = {}, rules = RULES) {
  try {
    if (!input || typeof input !== 'object') return null;
    const ev = input.hook_event_name;
    if (typeof ev !== 'string' || !EVENTS.has(ev) || typeof input.session_id !== 'string' || !input.session_id) return null;
    // una risposta di Stop mentre Claude Code sta già continuando per un nostro blocco farebbe un giro senza fine
    if (STOP_EVENTS.has(ev) && input.stop_hook_active) return null;
    const now = ctx.now || Date.now;
    for (const rule of rules[ev] || []) {
      if (ctx.deadline && now() > ctx.deadline) return null; // tempo scaduto: meglio niente che tardi
      const run = typeof rule === 'function' ? rule : rule && rule.run;
      if (typeof run !== 'function') continue;
      let m = null;
      try {
        if (ctx.enabled && !ctx.enabled(rule)) continue;
        m = run(input, ctx);
      } catch { m = null; } // una regola rotta non ferma le altre
      if (!m || typeof m !== 'object') continue;
      const text = say(m.text, { max: m.max, lines: m.lines });
      if (!text) continue;
      const block = !!m.block && STOP_EVENTS.has(ev);
      if (STOP_EVENTS.has(ev) && !block) continue; // a fine turno si può solo chiedere di continuare
      const message = { feature: String(m.feature || rule.feature || ''), text, lessonId: m.lessonId || null, once: m.once ? String(m.once).slice(0, 400) : null, block };
      let ok = true;
      try { if (ctx.allow) ok = !!ctx.allow(message, rule); } catch { ok = false; }
      if (!ok) continue;
      return { message, rule };
    }
    return null;
  } catch { return null; }
}

// il messaggio nella forma che Claude Code si aspetta per quell'evento (null = niente da dire).
// Mai permissionDecision, updatedInput o updatedToolOutput: Platypus aggiunge contesto, non decide al posto dell'utente.
function answer(event, message) {
  if (!message || !message.text) return null;
  if (CONTEXT_EVENTS.has(event)) return { hookSpecificOutput: { hookEventName: event, additionalContext: message.text } };
  if (STOP_EVENTS.has(event) && message.block) return { decision: 'block', reason: message.text };
  return null;
}

// ---- i limiti: i messaggi devono restare rari. Contano allo stesso modo quelli mandati e quelli in ombra
// (l'ombra deve dire che cosa sarebbe successo davvero), e valgono per ogni agente, sottoagenti compresi.
const AGENT_GAP_MS = 2 * 60000;   // al massimo un messaggio ogni 2 minuti per agente
const SESSION_MAX = 6, HOUR = 3600000; // e 6 all'ora per sessione, tutte le funzioni insieme
class Gate {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.agents = new Map();   // sessione|agente -> { t: ultimo messaggio, said: Set di lezioni già dette }
    this.sessions = new Map(); // sessione -> [momenti dei messaggi dell'ultima ora]
  }
  key(input) { return input.session_id + '|' + (input.agent_id || 'main'); }
  // perché questo messaggio adesso non può partire, oppure '' se può
  why(input, message) {
    const t = this.now(), a = this.agents.get(this.key(input));
    const once = message.lessonId || message.once; // la stessa lezione (o lo stesso avviso), una volta sola per agente
    if (once && a && a.said.has(once)) return 'repeat';
    if (STOP_EVENTS.has(input.hook_event_name)) return ''; // la fine del turno ha la sua regola: una volta per turno
    if (a && t - a.t < AGENT_GAP_MS) return 'agent';
    if ((this.sessions.get(input.session_id) || []).filter(x => t - x < HOUR).length >= SESSION_MAX) return 'session';
    return '';
  }
  record(input, message, mode) {
    const t = this.now(), k = this.key(input);
    const a = this.agents.get(k) || { t: 0, said: new Set(), told: new Set() };
    if (message.lessonId || message.once) a.said.add(message.lessonId || message.once);
    if (message.lessonId && mode === 'on') a.told.add(message.lessonId); // arrivata davvero all'agente, non solo in ombra
    if (!STOP_EVENTS.has(input.hook_event_name)) {
      a.t = t;
      this.sessions.set(input.session_id, [...(this.sessions.get(input.session_id) || []).filter(x => t - x < HOUR), t]);
    }
    this.agents.set(k, a);
    if (this.agents.size > 2000) this.prune(t);
  }
  // quella lezione è stata detta davvero a quell'agente (l'ufficio lo mostra nel fumetto del Nonno)
  told(sid, agentId, lessonId) { const a = this.agents.get(sid + '|' + (agentId || 'main')); return !!(a && a.told && a.told.has(lessonId)); }
  // la risposta è partita troppo tardi e non è stata mandata: non risulta detta
  untell(input, lessonId) { const a = this.agents.get(this.key(input)); if (a && a.told) a.told.delete(lessonId); }
  // le sessioni ferme da un pezzo non servono più
  prune(t = this.now()) {
    for (const [k, a] of this.agents) if (t - a.t > 12 * HOUR) this.agents.delete(k);
    for (const [k, l] of this.sessions) if (!l.some(x => t - x < HOUR)) this.sessions.delete(k);
  }
}

// ---- tutto insieme, per la rotta dell'hook: modi, progetto zittito, limiti, registro.
//   ctx.muted(cwd)   il progetto ha chiesto di non parlare ai suoi agenti
//   ctx.log          registro dei messaggi ({ append(cwd, entry) }), mandati e in ombra
// Restituisce { out, entry }: out è la risposta per Claude Code (null in ombra o se non c'è niente da dire).
function respond(input, ctx = {}, gate, rules = RULES) {
  try {
    const cwd = ctx.cwd || (input && input.cwd) || '';
    if (ctx.muted && ctx.muted(cwd)) return { out: null, entry: null };
    const r = decide(input, {
      ...ctx,
      enabled: rule => modeOf(ctx.settings, rule && rule.feature) !== 'off',
      allow: message => modeOf(ctx.settings, message.feature) !== 'off' && (!gate || !gate.why(input, message)),
    }, rules);
    if (!r) return { out: null, entry: null };
    const mode = modeOf(ctx.settings, r.message.feature);
    if (gate) gate.record(input, r.message, mode);
    const now = ctx.now || Date.now;
    let entry = { t: now(), sid: input.session_id, agent: input.agent_id || 'main', feature: r.message.feature, mode, event: input.hook_event_name, lessonId: r.message.lessonId, text: r.message.text };
    try { if (ctx.log) entry = ctx.log.append(cwd, entry) || entry; } catch {}
    return { out: mode === 'on' ? answer(input.hook_event_name, r.message) : null, entry };
  } catch { return { out: null, entry: null }; }
}

// ---- prova su una sessione vera (docs/plans/2.11-real-check.md, PLATYPUS_FEEDBACK_CHECK=1): risposte fisse, con un
// marcatore per evento, per vedere quali arrivano davvero al modello. Comprende PreToolUse, che il resto del modulo non usa.
const CHECK_MARK = { SessionStart: 'PLATY-START', PreToolUse: 'PLATY-PRE', PostToolUse: 'PLATY-POST', PostToolUseFailure: 'PLATY-FAIL', Stop: 'PLATY-STOP' };
function checkAnswer(input) {
  const ev = input && input.hook_event_name, mark = CHECK_MARK[ev];
  if (!mark) return null;
  if (ev === 'Stop') return input.stop_hook_active ? null : { decision: 'block', reason: `Platypus check: before stopping, write the marker ${mark} on a line of its own, then stop.` };
  return { hookSpecificOutput: { hookEventName: ev, additionalContext: `Platypus check: the marker for this event is ${mark}.` } };
}

module.exports = {
  decide, answer, say, respond, checkAnswer, Gate, modeOf, cleanMode,
  RULES, EVENTS, MAX_TEXT, MAX_LONG, CHECK_MARK, FEATURES, MODES, SHADOW_ONLY, AGENT_GAP_MS, SESSION_MAX,
};
