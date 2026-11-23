'use strict';
// La guardia (2.14, R8): l'interruzione prima di un'azione irreversibile senza prudenza.
// Al PreToolUse (hook di feedback), per un'azione di livello 3 senza abbastanza prudenza, risponde a Claude Code con
// permissionDecision: "ask" e un motivo: Claude Code toglie l'approvazione automatica e chiede a te, mostrando il motivo.
// Mai "deny", mai un comando cambiato. Si sceglie PER PROGETTO, nel Libro (scheda PAURE):
//   off   spenta (di base): resta solo la paura che avvisa
//   on    sempre: chiede ogni volta. In una sessione dove nessuno può rispondere (claude -p negli script, agenti in
//         background) Claude Code trasforma la domanda in un rifiuto automatico: l'azione non parte (R0)
//   auto  Platypus stima se qualcuno può rispondere (attended, qui sotto): se sì chiede, se no lascia passare e
//         avvisa soltanto, e registra che avrebbe chiesto
// Le regole che il progetto accetta come normali ("qui terraform apply è normale") non fanno scattare né la guardia
// né il messaggio della paura. Come il classificatore, legge soltanto: niente comandi, niente file, niente rete.

const { fearOf, permissionView, permissionLine } = require('./fear');
const { RULES } = require('./risk');
const { tr } = require('../i18n');

const MODES = ['off', 'on', 'auto'];
const RECENT_MS = 30 * 60000; // un messaggio dell'utente più vecchio di così: forse non c'è più nessuno davanti
// i tipi di sessione con una persona davanti (state.js, kindOf): la riga di comando, l'app desktop, l'IDE, Cowork
const INTERACTIVE = new Set(['cli', 'desktop', 'ide', 'cowork']);

const cleanMode = m => (MODES.includes(m) ? m : 'off');

// le regole del livello più alto sono tutte accettate dal progetto? (accettarne una non zittisce le altre)
function acceptedAll(risk, accepted) {
  if (!risk || !risk.level || !accepted) return false;
  const top = (risk.ruleIds || []).filter(id => RULES[id] && RULES[id].level === risk.level);
  return top.length > 0 && top.every(id => accepted[id]);
}

// la stima della modalità automatica: c'è qualcuno che può rispondere a una domanda di Claude Code?
// → { attended, why } con il motivo nella lingua dell'ufficio. Nel dubbio dice di no: meglio avvisare che bloccare
function attended({ s, a, input, now = Date.now() } = {}) {
  if (!s) return { attended: false, why: tr('sessione sconosciuta a Platypus') };
  const kind = s.kind || 'unknown';
  if (kind === 'sdk') return { attended: false, why: tr('sessione da script (SDK o claude -p), senza nessuno che risponda') };
  if (!INTERACTIVE.has(kind)) return { attended: false, why: tr('tipo di sessione sconosciuto') };
  const sub = input && input.agent_id ? a : null;
  if (sub && sub.background) return { attended: false, why: tr('sottoagente in background') };
  const goals = (s.main && s.main.mind && s.main.mind.goals) || [];
  const last = goals.length ? goals[goals.length - 1].t : 0;
  if (!last) return { attended: false, why: tr('nessun messaggio dell\'utente in questa sessione') };
  const min = Math.max(0, Math.round((now - last) / 60000));
  if (now - last > RECENT_MS) return { attended: false, why: tr('l\'ultimo messaggio dell\'utente è di {n} minuti fa', { n: min }) };
  return { attended: true, why: tr('sessione interattiva, ultimo messaggio dell\'utente {n} minuti fa', { n: min }) };
}

// la decisione per un PreToolUse. → null (niente da fare) oppure { ask, mode, risk, view, reason, estimate }
//   ask      true: rispondere "ask" a Claude Code; false: in automatico la stima dice che nessuno può rispondere
//   reason   il motivo che Claude Code ti mostra (nella lingua dell'ufficio)
function decide({ s, a, input, mode, accepted, now = Date.now() } = {}) {
  const m = cleanMode(mode);
  if (m === 'off' || !input || input.hook_event_name !== 'PreToolUse' || !s || !a) return null;
  const w = a.world;
  const open = new Set(w && w.open ? w.open.values() : []);
  const steps = w ? w.steps.filter(x => !open.has(x) && x.id !== input.tool_use_id) : [];
  const f = fearOf({ s, a, tool: input.tool_name, input: input.tool_input || {}, steps });
  if (!f.event || f.risk.level < 3 || !f.missed || acceptedAll(f.risk, accepted)) return null;
  const view = permissionView({ s, a: { ...a, world: { ...(w || {}), steps, open: new Map() } }, tool: input.tool_name, input: input.tool_input || {} });
  const estimate = m === 'auto' ? attended({ s, a, input, now }) : null;
  const reason = tr('Platypus (guardia): {line} Confermi?', { line: permissionLine(view) });
  return { ask: m === 'on' || !!(estimate && estimate.attended), mode: m, risk: f.risk, view, reason, estimate };
}

// la risposta per Claude Code: "ask" con il motivo, più il contesto della paura se c'è. Mai "deny"
function answer(d, context) {
  if (!d || !d.ask) return null;
  const out = { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.reason.slice(0, 600) };
  if (context) out.additionalContext = context;
  return { hookSpecificOutput: out };
}

module.exports = { decide, answer, attended, acceptedAll, cleanMode, MODES, RECENT_MS, INTERACTIVE };
