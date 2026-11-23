'use strict';
// La paura prestata (2.14): mette insieme il classificatore del rischio (risk.js) e la prudenza (prudence.js)
// con quello che l'ufficio sa già di un agente, e legge gli eventi di rischio dallo storico.
//   fearOf({ s, a, tool, input, steps })  → { risk, prudence, missed, event }   event è null se l'azione non è rischiosa
//   queryRisks(store, { projects, session, from, to, limit })                    → gli eventi, dal più recente
//   scars(session, agents)                → le azioni rischiose dopo le quali si vedono i segni di un danno (R4)
// Come i due moduli che usa, legge soltanto: niente comandi, niente file, niente rete.
// Dell'azione restano la regola, il livello, le prudenze, la forma del comando e il bersaglio relativo al progetto:
// mai il comando, mai un percorso fuori dal progetto, mai il messaggio dell'utente.

const { classify, undoOf, RULES } = require('./risk');
const { assess, missedFear, adviceFor } = require('./prudence');
const { tr } = require('../i18n');

const MAX_LIMIT = 500;

// ---- le cicatrici (R4): dopo un'azione di livello 2 o più si guardano le SCAR_WINDOW azioni seguenti di quell'agente
// e il messaggio successivo dell'utente. I segni di un danno:
//   error     un errore nuovo su un file che l'azione ha toccato
//   ghost     un file che l'agente conosceva e che dopo non c'è più
//   recovery  un tentativo di recupero (git reflog, git fsck --lost-found, ripristino da una copia)
//   user      l'utente scrive "hai cancellato", "ripristina", "undo"… (lessicale: è solo "probabile")
const SCAR_WINDOW = 8;
const RECOVERY = /\bgit\s+(reflog\b|fsck\b.*--lost-found|reset\s+--hard\s+(ORIG_HEAD|HEAD@\{)|checkout\s+\S*@\{|stash\s+(apply|pop)\s+\S+|cherry-pick\s+\S*@\{|show\s+\S*@\{)|\b(testdisk|photorec|extundelete|undelete)\b|\b(cp|mv|copy-item|rsync|tar\s+-?x\w*)\b[^|;&]*\b(backup|\.bak|\.orig|bak\b)|\b(pg_restore|mysql\s.*<\s*\S+\.sql|sqlite3\b.*\.restore)\b/i;
const REGRET = /\b(you|hai|avete)\s+(just\s+|appena\s+)?(deleted|removed|wiped|destroyed|overwrote|overwritten|lost|erased|broke|cancellato|eliminato|rimosso|sovrascritto|perso|distrutto|rotto|buttato)|\b(undo|revert that|bring (it|them|that) back|get (it|them) back|ripristin\w+|rimetti\w*|recuper\w+|riport\w+ (indietro|com'era)|annulla\w*|torna indietro)\b|\b(where (is|are|did)|dov'è finit\w+|dove sono finit\w+|che fine ha(nno)? fatto|è sparit\w+|sono sparit\w+|is gone|are gone|went missing)\b/i;
const under = (file, dir) => { const f = String(file || '').replace(/\\/g, '/'), d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, ''); return !!d && (f === d || f.startsWith(d + '/')); };
const cmdOfStep = x => { const g = String((x && x.sig) || ''); return g.startsWith('run:') ? g.slice(4) : ''; };

function scars(session, agents) {
  const out = [];
  // i messaggi dell'utente della sessione, in ordine di tempo
  const goals = [];
  for (const a of agents || []) for (const g of (a && a.mind && a.mind.goals) || []) goals.push(g);
  goals.sort((x, y) => x.t - y.t);
  for (const a of agents || []) {
    const st = a && a.world && a.world.steps;
    if (!st) continue;
    for (let i = 0; i < st.length; i++) {
      const s = st[i], r = s.risk;
      if (!r || r.level < 2 || s.err === null) continue; // solo azioni finite: un comando ancora in corso non ha fatto niente
      const after = st.slice(i + 1, i + 1 + SCAR_WINDOW);
      const until = after.length >= SCAR_WINDOW ? after[after.length - 1].t + (after[after.length - 1].dur || 0) : Infinity;
      const signs = new Set(), evidence = [];
      let at = 0;
      const mark = (sign, x) => { signs.add(sign); if (x && x.id && !evidence.includes(x.id)) evidence.push(x.id); const t = (x && x.t) || 0; if (t && (!at || t < at)) at = t; };
      for (const x of after) {
        if (RECOVERY.test(cmdOfStep(x))) mark('recovery', x);
        if (x.err && r.target) {
          const refs = (x.refs && x.refs.refs) || [];
          if (refs.some(f => under(typeof f === 'string' ? f : f && f.file, r.target)) || (typeof x.target === 'string' && under(x.target, r.target))) mark('error', x);
        }
      }
      // file che conosceva (li aveva letti o scritti prima) e che dopo l'azione non ci sono più
      for (const [key, nd] of a.world.nodes || []) {
        if (!nd.ghost || !(nd.ghostAt > s.t) || nd.ghostAt > until || !(nd.lastSync && nd.lastSync < s.t)) continue;
        if (r.target && !under(key, r.target)) continue;
        signs.add('ghost'); if (!at || nd.ghostAt < at) at = nd.ghostAt;
      }
      // il primo messaggio dell'utente dopo l'azione (e prima della prossima azione rischiosa finita con un danno suo)
      const g = goals.find(x => x.t > s.t);
      if (g && REGRET.test(g.text || '')) { signs.add('user'); if (!at || g.t < at) at = g.t; }
      if (!signs.size) continue;
      out.push({
        agent: a.id, agentName: a.name, step: s, t: s.t, at: at || s.t, signs: [...signs], evidence: evidence.slice(0, 8), probable: signs.size === 1 && signs.has('user'),
        key: (r.shape || (r.ruleIds || [])[0] || '?') + ' → ' + (r.target || '*'), missing: r.missing || [],
      });
    }
  }
  return out;
}
// segna il danno sul passo (per l'ufficio e per lo storico) e dà solo quelli nuovi
function markScars(session, agents) {
  const fresh = [];
  for (const sc of scars(session, agents)) {
    const r = sc.step.risk;
    // la cicatrice sul personaggio (R5): resta per il resto della sessione
    const ag = (agents || []).find(x => x && x.id === sc.agent);
    if (ag && ag.world && !(ag.world.scarAt <= sc.at)) ag.world.scarAt = sc.at;
    if (r.outcome === 'damage' && (r.evidence || []).length === sc.evidence.length) continue;
    r.outcome = 'damage'; r.at = sc.at; r.signs = sc.signs;
    r.evidence = sc.evidence.map(id => `${session.id}:${id}`);
    fresh.push(sc);
  }
  return fresh;
}

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
    return { ...r, reasons: (r.ruleIds || []).filter(id => RULES[id]).map(id => RULES[id].text()), undo: undoOf(r.ruleIds), category: top ? top.category : '' };
  });
}

// ---- per l'ufficio (R5): l'ultima azione rischiosa di un agente, se è recente, e la sua cicatrice.
// I testi nella lingua dell'ufficio; del comando solo la forma della regola.
const FRESH_MS = 120000;
function fearView(a, now = Date.now()) {
  const w = a && a.world;
  if (!w || !Array.isArray(w.steps)) return null;
  let last = null;
  for (let i = w.steps.length - 1; i >= 0 && i >= w.steps.length - 40; i--) { const s = w.steps[i]; if (s && s.risk) { last = s; break; } }
  const out = {};
  if (last && now - last.t < FRESH_MS) {
    const r = last.risk;
    out.last = {
      id: String(last.id || last.t), t: last.t, level: r.level, missed: !!r.missed, prudence: r.prudence, shape: r.shape || '', target: r.target || '',
      reasons: (r.ruleIds || []).filter(id => RULES[id]).slice(0, 3).map(id => RULES[id].text()), advice: adviceFor(r.missing),
      undo: undoOf(r.ruleIds), outcome: r.outcome || '',
    };
  }
  if (w.scarAt) out.scarAt = w.scarAt;
  return out.last || out.scarAt ? out : null;
}

// ---- la richiesta di permesso (R6): quanto è rischiosa l'azione che Claude Code ti chiede di approvare.
// I passi già aperti per questa stessa azione non contano come prudenza (sarebbe lei a giustificare se stessa).
const LEVEL_NAMES = { 1: () => tr('ATTENZIONE'), 2: () => tr('PERICOLO'), 3: () => tr('IRREVERSIBILE') };
function permissionView({ s, a, tool, input } = {}) {
  const w = a && a.world;
  const open = new Set(w && w.open ? w.open.values() : []);
  const f = fearOf({ s, a, tool, input, steps: w ? w.steps.filter(x => !open.has(x)) : [] });
  if (!f.event) return null;
  return {
    level: f.risk.level, name: LEVEL_NAMES[f.risk.level](), missed: f.missed, shape: f.risk.shape,
    reasons: f.risk.ruleIds.filter(id => RULES[id]).slice(0, 3).map(id => RULES[id].text()), advice: adviceFor(f.prudence.missing),
    undo: f.risk.undo,
  };
}
// una riga sola per la notifica e per il fumetto: "IRREVERSIBILE (probabile): spinge sul branch principale. Manca: …. Non si torna indietro."
function permissionLine(p) {
  if (!p) return '';
  const parts = [tr('{level} (probabile): {why}.', { level: p.name, why: p.reasons.join(tr('; ')) })];
  if (p.advice.length) parts.push(tr('Manca: {what}.', { what: p.advice.join(tr(', ')) }));
  parts.push(p.undo ? tr('Per tornare indietro: {how}.', { how: p.undo }) : tr('Non si torna indietro.'));
  return parts.join(' ');
}

// ---- R9 · per il Libro: gli eventi degli ultimi `days` giorni, per livello e per regola, e i più recenti
const SUMMARY_DAYS = 90;
function summary(store, { projects = null, now = Date.now(), days = SUMMARY_DAYS } = {}) {
  const out = { days, total: 0, missed: 0, damage: 0, levels: { 1: 0, 2: 0, 3: 0 }, rules: [], recent: [] };
  if (!store) return out;
  const from = now - days * 86400000;
  const where = { t: { $gte: from } };
  if (projects) where.project = { $in: projects };
  const by = new Map();
  for (const r of store.collection('risks').find(where, { fields: ['ruleIds', 'level', 'missed', 'outcome'] })) {
    out.total++;
    if (r.level >= 1 && r.level <= 3) out.levels[r.level]++;
    if (r.missed) out.missed++;
    if (r.outcome === 'damage') out.damage++;
    const id = (r.ruleIds || [])[0];
    if (!id || !RULES[id]) continue;
    const x = by.get(id) || { id, level: RULES[id].level, count: 0, missed: 0, damage: 0 };
    x.count++; if (r.missed) x.missed++; if (r.outcome === 'damage') x.damage++;
    by.set(id, x);
  }
  out.rules = [...by.values()].sort((a, b) => (b.level - a.level) || (b.count - a.count)).map(x => ({ ...x, text: RULES[x.id].text(), shape: RULES[x.id].shape }));
  out.recent = queryRisks(store, { projects, from, limit: 20 });
  return out;
}
// ---- R9 · per il report del giorno: le paure mancate per agente, e le cicatrici (con il progetto per nome)
function reportDay(store, from, to) {
  const out = { total: 0, missed: 0, byAgent: [], scars: [] };
  if (!store) return out;
  const names = new Map();
  const projectName = key => { if (!names.has(key)) { let n = ''; try { const p = store.collection('projects').get(key); n = (p && p.name) || ''; } catch {} names.set(key, n); } return names.get(key); };
  const by = new Map();
  for (const r of store.collection('risks').find({ t: { $gte: from, $lt: to } }, { fields: ['agent', 'name', 'missed', 'level'] })) {
    if (!(r.level >= 2)) continue;
    out.total++;
    if (!r.missed) continue;
    out.missed++;
    const who = r.name || (r.agent === 'main' ? 'Claude' : r.agent || '?');
    by.set(who, (by.get(who) || 0) + 1);
  }
  out.byAgent = [...by.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 10);
  // le cicatrici del giorno: il danno visto quel giorno (at), anche se l'azione era del giorno prima
  for (const r of store.collection('risks').find({ outcome: 'damage', at: { $gte: from, $lt: to } }, { sort: { at: 1 }, limit: 20 })) {
    const top = RULES[(r.ruleIds || [])[0]];
    out.scars.push({ t: r.at, name: r.name || (r.agent === 'main' ? 'Claude' : r.agent || '?'), project: projectName(r.project), shape: r.shape || (top ? top.shape : ''), target: r.target || '', reason: top ? top.text() : '' });
  }
  return out;
}

// le regole accettate di un progetto, con il testo (R8): [{ id, level, text, shape, t }]
const RULE_IDS = Object.keys(RULES);
function acceptedView(accepted) {
  return Object.entries(accepted || {}).filter(([id]) => RULES[id]).map(([id, t]) => ({ id, level: RULES[id].level, text: RULES[id].text(), shape: RULES[id].shape, t })).sort((a, b) => b.level - a.level || b.t - a.t);
}

module.exports = { acceptedView, RULE_IDS, summary, reportDay, SUMMARY_DAYS, permissionView, permissionLine, fearOf, fearView, queryRisks, scars, markScars, lastGoal, MAX_LIMIT, SCAR_WINDOW, FRESH_MS };
