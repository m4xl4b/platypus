'use strict';
// Feedback agli agenti: quello che Platypus dice a un agente attraverso gli hook di Claude Code.
// Qui stanno solo le decisioni, come funzioni pure: (evento dell'hook, contesto) -> messaggio o niente.
// Chi chiama (index.js) risponde sempre, anche quando qualcosa va storto: Claude Code non deve mai accorgersi di noi.
//
// Una regola è una funzione (input, ctx) -> null | { feature, text, lessonId?, block? }
//   input   l'oggetto che Claude Code manda all'hook (hook_event_name, session_id, agent_id, cwd, tool_name, tool_input…)
//   ctx     { now(), deadline, session, cwd, lessons(cwd), settings } : solo stato già in memoria, niente letture lente
//   block   solo per Stop/SubagentStop: chiede all'agente di continuare (l'unica risposta che cambia quello che fa)
// Le regole si aggiungono a RULES, per evento; conta la prima che ha qualcosa da dire.

const MAX_TEXT = 400;          // un messaggio a un agente è breve
const PREFIX = 'Platypus: ';   // dice sempre chi parla
// gli eventi a cui sappiamo rispondere (vedi "Hook formats" nel piano della 2.11)
const CONTEXT_EVENTS = new Set(['SessionStart', 'PostToolUse', 'PostToolUseFailure']);
const STOP_EVENTS = new Set(['Stop', 'SubagentStop']);
const EVENTS = new Set([...CONTEXT_EVENTS, ...STOP_EVENTS]);

const RULES = { SessionStart: [], PostToolUse: [], PostToolUseFailure: [], Stop: [], SubagentStop: [] };

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
// il testo come arriva all'agente: una riga, firmata, entro il limite
function say(text) {
  const t = clip(text, MAX_TEXT);
  if (!t) return '';
  return /^Platypus\b/.test(t) ? t : clip(PREFIX + t, MAX_TEXT);
}

// input dell'hook + contesto -> { message, rule } oppure null. Non lancia mai.
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
      let m = null;
      try { m = rule(input, ctx); } catch { m = null; } // una regola rotta non ferma le altre
      if (!m || typeof m !== 'object') continue;
      const text = say(m.text);
      if (!text) continue;
      const block = !!m.block && STOP_EVENTS.has(ev);
      if (STOP_EVENTS.has(ev) && !block) continue; // a fine turno si può solo chiedere di continuare
      return { message: { feature: String(m.feature || ''), text, lessonId: m.lessonId || null, block }, rule };
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

// ---- prova su una sessione vera (docs/plans/2.11-real-check.md, PLATYPUS_FEEDBACK_CHECK=1): risposte fisse, con un
// marcatore per evento, per vedere quali arrivano davvero al modello. Comprende PreToolUse, che il resto del modulo non usa.
const CHECK_MARK = { SessionStart: 'PLATY-START', PreToolUse: 'PLATY-PRE', PostToolUse: 'PLATY-POST', PostToolUseFailure: 'PLATY-FAIL', Stop: 'PLATY-STOP' };
function checkAnswer(input) {
  const ev = input && input.hook_event_name, mark = CHECK_MARK[ev];
  if (!mark) return null;
  if (ev === 'Stop') return input.stop_hook_active ? null : { decision: 'block', reason: `Platypus check: before stopping, write the marker ${mark} on a line of its own, then stop.` };
  return { hookSpecificOutput: { hookEventName: ev, additionalContext: `Platypus check: the marker for this event is ${mark}.` } };
}

module.exports = { decide, answer, say, checkAnswer, RULES, EVENTS, MAX_TEXT, CHECK_MARK };
