'use strict';
// La paura prestata (2.14): mette insieme il classificatore del rischio (risk.js) e la prudenza (prudence.js)
// con quello che l'ufficio sa già di un agente, e legge gli eventi di rischio dallo storico.
//   fearOf({ s, a, tool, input, steps })  → { risk, prudence, missed, event }   event è null se l'azione non è rischiosa
//   queryRisks(store, { projects, session, from, to, limit })                    → gli eventi, dal più recente
// Come i due moduli che usa, legge soltanto: niente comandi, niente file, niente rete.
// Dell'azione restano la regola, il livello, le prudenze, la forma del comando e il bersaglio relativo al progetto:
// mai il comando, mai un percorso fuori dal progetto, mai il messaggio dell'utente.

const { classify, RULES } = require('./risk');
const { assess, missedFear } = require('./prudence');

const MAX_LIMIT = 500;

// l'ultimo messaggio dell'utente e quando è arrivato: l'inizio del turno (lo tiene semantic.js, tagliato a 300 caratteri)
function lastGoal(s, a) {
  const of = x => { const g = x && x.mind && x.mind.goals; return g && g.length ? g[g.length - 1] : null; };
  const main = of(s && s.main), own = a && s && a !== s.main ? of(a) : null;
  return { t: Math.max(main ? main.t : 0, own ? own.t : 0), text: [main && main.text, own && own.text].filter(Boolean).join('\n') };
}

function fearOf({ s, a, tool, input, steps } = {}) {
  const world = a && a.world;
  const before = Array.isArray(steps) ? steps : (world ? world.steps : []);
  const goal = lastGoal(s, a);
  // di questo turno: i file già modificati e i segreti già letti
  const turn = before.filter(x => x && x.t >= goal.t);
  const files = new Set(turn.filter(x => x.act === 'edit' && x.target).map(x => x.target));
  const root = (s && s.cwd) || '';
  const risk = classify({
    tool, input, root, cwd: (world && world.shellCwd) || root, branch: (s && s.branch) || undefined,
    turnFilesModified: files.size, turnReadSecrets: turn.some(x => x.secret),
  });
  if (!risk.level) return { risk, prudence: null, missed: false, event: null };
  const prudence = assess({ risk, action: { tool, input }, steps: before, prompt: goal.text, hints: risk.category === 'git' && s && s.branch ? [s.branch] : [] });
  const missed = missedFear(risk, prudence);
  const event = {
    level: risk.level, ruleIds: risk.ruleIds.slice(0, 8), category: risk.category, shape: risk.shape, target: risk.targets[0] || '',
    prudence: prudence.score, present: prudence.present, missing: prudence.missing, missed,
  };
  return { risk, prudence, missed, event };
}

// gli eventi salvati, con i testi delle regole nella lingua dell'ufficio (i testi non stanno nello storico)
function queryRisks(store, q = {}) {
  const where = {};
  if (q.projects) where.project = { $in: q.projects };
  if (q.session) where.session = String(q.session);
  if (Number.isFinite(q.from) || Number.isFinite(q.to)) where.t = { ...(Number.isFinite(q.from) ? { $gte: q.from } : {}), ...(Number.isFinite(q.to) ? { $lt: q.to } : {}) };
  if (q.missed) where.missed = true;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(Number(q.limit)) || 100));
  const rows = store.collection('risks').find(where, { sort: { t: -1 }, limit });
  return rows.map(({ _id, ...r }) => {
    const top = RULES[(r.ruleIds || [])[0]];
    return { ...r, reasons: (r.ruleIds || []).filter(id => RULES[id]).map(id => RULES[id].text()), undo: top && top.undo ? top.undo() : '', category: top ? top.category : '' };
  });
}

module.exports = { fearOf, queryRisks, lastGoal, MAX_LIMIT };
