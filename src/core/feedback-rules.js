'use strict';
// Le regole del feedback agli agenti: che cosa dice Platypus, e quando (piano 2.11, parte B).
// Ogni regola è una funzione pura (input dell'hook, ctx) -> messaggio o niente; modi, limiti e registro stanno in feedback.js.
// I testi sono sempre in inglese (li legge il modello), qualunque sia la lingua dell'ufficio.
//   ctx.lessons(cwd)      le lezioni del Libro della bottega per quel progetto
//   ctx.hasSection(cwd)   il CLAUDE.md del progetto ha già la sezione di Platypus
//   ctx.agent(input)      l'agente che ha mandato l'hook, come lo vede l'ufficio: { id, steps, nodes, goals } (null se non lo conosciamo)
//   ctx.team()            tutti gli agenti della sessione: [{ id, name, nodes }]
//   ctx.waiting(input)    quell'agente ha una domanda all'utente (o un piano da approvare) ancora senza risposta

const i18n = require('../i18n');
const feedback = require('./feedback');
const { lessonLines, elderLine, sameCmd, cmdCore, errorPattern } = require('./bottega');
const { classifyFailure, errorExcerpt } = require('./surprise');
const { relKey, isProjectFile } = require('./worldmap');
const { extractClaims, judgeClaim } = require('./grounding');
const { isTestCommand } = require('./releases');
const { drift: semanticDrift } = require('./semantic');
const fearMod = require('./fear');
const { RULES: RISK_RULES } = require('./risk');
const { adviceFor } = require('./prudence');

const { tr } = i18n;
const en = fn => i18n.withLang('en', fn);
// ogni messaggio in due versioni: text in inglese, per l'agente, e local nella lingua dell'ufficio, per chi lo rilegge
// nell'ufficio e nel Libro (solo se è diversa). fn costruisce il testo con tr(): viene chiamata una volta per lingua.
const two = (fn, extra = {}) => { const text = en(fn), local = fn(); return { text, ...(local && local !== text ? { local } : {}), ...extra }; };

// ---- B1 · le lezioni del progetto a inizio sessione (avvio, ripresa, /clear, dopo una compattazione)
const MAX_START = 6;
function sessionLessons(input, ctx) {
  const cwd = ctx.cwd || input.cwd || '';
  if (!cwd || !ctx.lessons) return null;
  if (ctx.hasSection && ctx.hasSection(cwd)) return null; // le ha già nel CLAUDE.md: non si ripetono
  const lessons = ctx.lessons(cwd) || [];
  if (!lessonLines(lessons, MAX_START).length) return null;
  return two(() => [tr('Platypus (memoria del progetto): lezioni dedotte dalle sessioni passate di questo progetto. Sono indizi tratti da quello che è successo, non regole.'),
    ...lessonLines(lessons, MAX_START).map(l => '- ' + l)].join('\n'), { lines: true, max: feedback.MAX_LONG });
}

// ---- B2 · il Nonno parla all'agente: dopo una trappola nota, la lezione del Libro che la riguarda
// Parla dopo lo strumento, quando la lezione serve: un comando instabile appena fallito, un file che non c'è, un file
// fragile appena modificato. Il confronto usa quello che l'hook porta con sé (tool_input, error, tool_response), non lo
// stato dell'ufficio, che può essere indietro di qualche riga. Solo lezioni forti e non ignorate, una volta per agente.
const BASH = new Set(['Bash', 'PowerShell']), EDITS = new Set(['Edit', 'Write', 'MultiEdit']);
// quello che il Nonno direbbe nel fumetto, in inglese, più (dove serve) che cosa fare adesso
// about: di che cosa parla il messaggio (il comando, il file, lo schema dell'errore), per giudicare dopo che cosa è successo (C2)
const elderSay = (l, tests, about = {}) => two(() => elderLine(l) + (tests ? ' ' + tr('Lancia i test adesso.') : ''), { lessonId: l.id, about: { kind: l.kind, ...about } });
const strongest = (ls, ok) => ls.filter(ok).sort((x, y) => y.weight - x.weight)[0] || null;
// Glob e Grep non falliscono quando non trovano niente: lo dice il risultato (se ha la forma che conosciamo)
function foundNothing(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.numFiles === 'number') return r.numFiles === 0;
  return Array.isArray(r.filenames) && r.filenames.length === 0;
}
// il percorso cercato da Glob: solo se è un nome preciso, senza caratteri jolly dopo l'eventuale "**/" iniziale
function globTarget(pattern) {
  const p = String(pattern || '').replace(/\\/g, '/').replace(/^(\*\*\/)+/, '');
  return p && !/[*?[\]{}]/.test(p) ? p : '';
}
function elder(input, ctx) {
  const cwd = ctx.cwd || input.cwd || '';
  if (!cwd || !ctx.lessons) return null;
  const strong = (ctx.lessons(cwd) || []).filter(l => l && l.level === 'lesson' && !l.ignored);
  if (!strong.length) return null;
  const tool = input.tool_name, ti = input.tool_input || {};
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const key = p => (p ? relKey(String(p), cwd) : null);
  if (failed) {
    const err = String(input.error || '');
    const cmd = BASH.has(tool) ? String(ti.command || '') : '';
    // un errore già visto e già sistemato: dove, e da chi
    if (err) {
      const pat = errorPattern(((classifyFailure(err, cmd) || {}).excerpt) || errorExcerpt(err));
      const fix = pat && strongest(strong, l => l.kind === 'known-fix' && l.key.split(' → ')[0] === pat);
      if (fix) return elderSay(fix, false, { file: fix.key.split(' → ')[1] || '' });
    }
    if (cmd) {
      const l = strongest(strong, l => (l.kind === 'flaky-command' || l.kind === 'loop-trap') && sameCmd(l.key, cmd));
      if (l) return elderSay(l, false, { cmd, pat: err ? errorPattern(excerptOf(err, cmd)) : '' });
    }
    if (tool === 'Read') {
      const k = key(ti.file_path);
      const l = k && strongest(strong, l => l.kind === 'ghost-path' && l.key === k);
      if (l) return elderSay(l, false, { file: l.key });
    }
    return null;
  }
  if (EDITS.has(tool)) {
    const k = key(ti.file_path);
    const l = k && strongest(strong, l => l.kind === 'fragile-file' && l.key === k);
    return l ? elderSay(l, true, { file: k }) : null;
  }
  if ((tool === 'Glob' || tool === 'Grep') && foundNothing(input.tool_response)) {
    const g = tool === 'Glob' ? globTarget(ti.pattern) : '';
    const k = tool === 'Grep' ? key(ti.path) : null;
    const l = strongest(strong, l => l.kind === 'ghost-path' && (k ? l.key === k : !!g && (l.key === g || l.key.endsWith('/' + g))));
    return l ? elderSay(l, false, { file: l.key }) : null;
  }
  if (BASH.has(tool) && ti.command) {
    const l = strongest(strong, l => l.kind === 'slow-step' && sameCmd(l.key, String(ti.command)));
    return l ? elderSay(l, false, { cmd: String(ti.command) }) : null;
  }
  return null;
}

// ---- B3 · fuori dal giro in tondo: lo stesso comando fallisce di nuovo con lo stesso errore, senza modifiche in mezzo
// (la reazione «insiste» del sismografo, detta all'agente mentre succede). Il fallimento di adesso è quello dell'hook;
// i tentativi di prima sono i passi dell'agente nello stato dell'ufficio (ctx.agent). Conta solo il turno in corso:
// dopo una nuova richiesta dell'utente, riprovare è una sua scelta.
const LOOP_BACK = 12, LOOP_MS = 30 * 60000;   // quanto indietro si guarda: passi e tempo
// tra un tentativo e l'altro possono stare solo passi che non cambiano niente
const HARMLESS = new Set(['read', 'search', 'web', 'look', 'verify', 'plan']);
const excerptOf = (err, cmd) => ((classifyFailure(err, cmd) || {}).excerpt) || errorExcerpt(err);
function loop(input, ctx) {
  if (!BASH.has(input.tool_name) || !ctx.agent || input.is_interrupt) return null;
  const cmd = String((input.tool_input || {}).command || '').trim();
  const st = cmd && ctx.agent(input);
  if (!st || !Array.isArray(st.steps)) return null;
  const steps = st.steps, sig = 'run:' + cmd.slice(0, 200), id = input.tool_use_id || null;
  // il passo di adesso può essere già nello stato (il transcript è arrivato prima dell'hook) oppure no
  const at = id ? steps.findIndex(x => x.id === id) : -1;
  const cur = at >= 0 && steps[at].err && steps[at].fail ? steps[at] : null;
  const excerpt = cur ? cur.fail.excerpt : excerptOf(String(input.error || ''), cmd);
  const pat = errorPattern(excerpt);
  if (!pat) return null; // senza una riga d'errore non si può dire che è «lo stesso»
  const now = ctx.now ? ctx.now() : Date.now();
  const turn = Math.max(0, ...(st.goals || []).map(g => g.t || 0)); // l'ultima richiesta dell'utente
  let before = 0;
  for (let i = (at >= 0 ? at : steps.length) - 1, seen = 0; i >= 0 && seen < LOOP_BACK; i--, seen++) {
    const x = steps[i];
    if (x.t < turn || now - x.t > LOOP_MS) break;
    if (x.err === null) continue;                       // ancora in corso (strumenti in parallelo, o questo stesso)
    if (x.sig === sig) {
      if (x.err && x.fail && errorPattern(x.fail.excerpt) === pat) { before++; continue; }
      break;                                            // è riuscito, o è fallito in un altro modo: qualcosa è cambiato
    }
    if (HARMLESS.has(x.act) || (x.err && x.act === 'edit')) continue; // una modifica rifiutata non ha cambiato niente
    break;                                              // una modifica, un altro comando, un sottoagente
  }
  // senza l'identificativo dello strumento non sappiamo se l'ultimo fallimento nello stato è questo: contiamo per difetto
  const n = id ? before + 1 : before;
  if (n < 2) return null;
  const error = excerpt.length > 120 ? excerpt.slice(0, 119) + '…' : excerpt;
  return two(() => tr('questo comando è fallito {n} volte di fila con lo stesso errore («{error}») e senza modifiche in mezzo. Cambia qualcosa prima di rilanciarlo, oppure fermati e di\' che cosa ti blocca.', { n, error }),
    { once: 'loop|' + sig + '|' + pat, about: { kind: 'loop', cmd, pat } });
}

// ---- B4 · memoria non aggiornata: l'agente ha appena modificato un file che un altro agente aveva cambiato dopo la
// sua ultima lettura. Claude Code di solito rifiuta queste modifiche (e allora l'hook è quello del fallimento, e glielo
// dice già lui): qui arrivano solo quelle che gli sfuggono. Per questo nella 2.11 la funzione resta in ombra: prima si
// guarda se di casi così ce ne sono. Arriva dopo lo strumento; la variante «prima» aspetta la prova su una sessione vera.
const hhmm = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()); };
function stale(input, ctx) {
  const tool = input.tool_name;
  if (!EDITS.has(tool) || !ctx.agent || !ctx.team) return null;
  const cwd = ctx.cwd || input.cwd || '';
  const key = relKey(String((input.tool_input || {}).file_path || ''), cwd);
  if (!cwd || !isProjectFile(key)) return null;
  const me = ctx.agent(input);
  if (!me || !me.nodes) return null;
  // l'ultimo contatto col file prima di questa modifica: lo sa il passo, se l'ufficio l'ha già visto partire;
  // altrimenti il file stesso (se questa modifica è già stata registrata, dopo non c'è niente: si tace)
  const id = input.tool_use_id || null;
  let step = null;
  if (id) for (let i = (me.steps || []).length - 1; i >= 0 && !step; i--) if (me.steps[i].id === id) step = me.steps[i];
  const nd = me.nodes.get(key);
  const from = step ? step.prevSync : nd ? nd.lastSync : 0;
  if (!from) return null; // mai letto né modificato da lui: non c'è una memoria da dire vecchia
  const to = step ? step.t : ctx.now ? ctx.now() : Date.now();
  let by = null;
  for (const a of ctx.team() || []) {
    if (a.id === me.id || !a.nodes) continue;
    const o = a.nodes.get(key);
    for (const t of (o && o.edits) || []) if (t > from && t <= to && (!by || t > by.t)) by = { t, id: a.id };
  }
  if (!by) return null;
  return two(() => {
    // il nome dell'altro agente è quello dell'ufficio, nella lingua in cui si sta scrivendo
    const p = { file: '`' + key + '`', time: hhmm(by.t), who: ((ctx.team() || []).find(a => a.id === by.id) || {}).name || tr('un altro agente') };
    return tool === 'Write'
      ? tr('hai appena riscritto {file}, ma {who} l\'aveva cambiato alle {time}, dopo la tua ultima lettura. Controlla di non aver annullato quella modifica.', p)
      : tr('{who} ha cambiato {file} alle {time}, dopo la tua ultima lettura, e tu l\'hai appena modificato senza rileggerlo. Rileggilo e controlla che la tua modifica regga ancora.', p);
  }, { once: 'stale|' + key + '|' + by.t, about: { file: key } });
}

// ---- B5 · affermazioni senza prove a fine turno: l'agente sta per fermarsi dicendo «i test passano» o «ho verificato»,
// ma in questo turno, dopo la sua ultima modifica, non ha lanciato niente (senza prove), oppure l'ultimo esito è un
// fallimento (smentita). Le affermazioni vengono dall'ultimo messaggio che l'hook porta con sé, le prove dai passi del
// turno. Chiederebbe di continuare (block): nella 2.11 la funzione resta in ombra, quindi lo registra soltanto.
// Solo «tests» e «verified»: per «sistemato» e «fatto» le prove sono meno affidabili.
const CHECKED = new Set(['tests', 'verified']);
const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const isTestStep = s => s.act === 'verify' && isTestCommand(String(s.sig || '').replace(/^run:/, ''));
function claims(input, ctx) {
  const said = String(input.last_assistant_message || '');
  if (!said || !ctx.agent) return null;
  const me = ctx.agent(input);
  if (!me || !Array.isArray(me.steps)) return null;
  if (ctx.waiting && ctx.waiting(input)) return null; // il turno finisce con una domanda all'utente: non si giudica
  const now = ctx.now ? ctx.now() : Date.now();
  // il turno: dall'ultima richiesta dell'utente (il principale) o dall'inizio del compito (un sottoagente)
  const from = input.agent_id ? 0 : Math.max(0, ...(me.goals || []).map(g => g.t || 0).filter(t => t <= now));
  const turn = me.steps.filter(s => s.t >= from);
  const open = turn[turn.length - 1];
  if (open && open.err === null && ASKS.has(open.tool)) return null;
  const edited = turn.some(s => s.act === 'edit' && s.err === false);
  let pick = null;
  for (const c of extractClaims(said)) {
    if (!CHECKED.has(c.kind)) continue;
    const j = judgeClaim(c, me.steps, from, Infinity, null);
    // smentita: l'ultimo test (o, per «verificato», l'ultimo controllo: non un comando qualunque) è fallito
    if (j.status === 'contradicted' && (c.kind === 'tests' || j.step.act === 'verify')) { pick = { c, j }; break; }
    // senza prove: conta solo se nel turno ha cambiato qualcosa. Chi risponde a una domanda, o ha solo letto, non deve prove
    if (j.status === 'ungrounded' && edited && !pick) pick = { c, j };
  }
  if (!pick) return null;
  const { c, j } = pick, claim = clip(c.text, 100);
  const last = me.steps.filter(s => s.err !== null && isTestStep(s)).pop(); // l'ultimo lancio dei test, anche di prima
  return two(() => {
    if (j.status === 'contradicted' && c.kind === 'tests') return tr('hai detto «{claim}», ma l\'ultimo lancio dei test è fallito (alle {time}). Sistema e rilancia i test, oppure di\' che falliscono.', { claim, time: hhmm(j.step.t) });
    if (j.status === 'contradicted') return tr('hai detto «{claim}», ma l\'ultimo controllo che hai lanciato è fallito (`{cmd}` alle {time}). Rilancialo, oppure di\' che non è verificato.', { claim, cmd: clip(cmdCore(j.step.sig), 60), time: hhmm(j.step.t) });
    if (c.kind !== 'tests') return tr('hai detto «{claim}», ma dopo la tua ultima modifica non hai lanciato niente per controllarlo. Lancia un controllo, oppure di\' che non è verificato.', { claim });
    if (!last) return tr('hai detto «{claim}», ma dopo la tua ultima modifica non è partito nessun test. Lanciali, oppure di\' che non è verificato.', { claim });
    return last.err
      ? tr('hai detto «{claim}», ma dopo la tua ultima modifica non è partito nessun test (ultimo lancio: fallito alle {time}). Lanciali, oppure di\' che non è verificato.', { claim, time: hhmm(last.t) })
      : tr('hai detto «{claim}», ma dopo la tua ultima modifica non è partito nessun test (ultimo lancio: passato alle {time}). Lanciali, oppure di\' che non è verificato.', { claim, time: hhmm(last.t) });
  }, { block: true, once: 'claims|' + (input.agent_id || 'main') + '|' + from, tag: c.kind + '/' + j.status, about: { kind: c.kind } });
}

// ---- B6 · ritorno al compito (sperimentale): la stella polare dice che l'agente è alla deriva, con la stessa regola
// della mappa (semantic.drift). Gli ricorderebbe il compito, citato. Il motore lessicale non distingue una deviazione
// necessaria da una deriva: per questo il testo lo ammette, e nella 2.11 la funzione resta in ombra.
function driftBack(input, ctx) {
  if (!ctx.agent) return null;
  const me = ctx.agent(input);
  if (!me || !me.mind || !me.corpus) return null;
  const d = semanticDrift(me.mind, me.corpus, me.space); // lo spazio (e quindi le soglie) della fonte dei vettori
  if (!d || !d.drifting || !d.goal.label) return null;
  return two(() => tr('le tue ultime {n} azioni sembrano lontane dal compito che hai ricevuto: «{task}». Se questa deviazione serve, continua; altrimenti torna al compito.', { n: d.run, task: clip(d.goal.label, 160) }),
    { once: 'drift|' + (input.agent_id || 'main') + '|' + d.goal.t, tag: 'run=' + d.run });
}

// ---- 2.14, R7 · la paura prestata: a un'azione di livello 2 o più senza abbastanza prudenza, Platypus dice all'agente
// che cosa ha rischiato, che cosa mancava e che cosa fare adesso (il messaggio gli arriva con il risultato, vedi R0). Una volta per regola per sessione. Se il Libro ha una cicatrice proprio su quell'azione,
// il messaggio la cita: così il Nonno e la paura non dicono due volte la stessa cosa.
const MISSING = { looked: () => tr('uno sguardo prima'), backup: () => tr('un commit o una copia'), dryrun: () => tr('una prova a vuoto'), clean: () => tr('un albero di lavoro pulito') };
function fearBefore(input, ctx) {
  const s = ctx.session;
  if (!s || !s.cwd) return null;
  const a = input.agent_id ? s.subs && s.subs.get(input.agent_id) : s.main;
  if (!a) return null;
  const w = a.world;
  // i passi di questa stessa azione (se il transcript è già arrivato) non sono prudenza
  const open = new Set(w && w.open ? w.open.values() : []);
  const steps = w ? w.steps.filter(x => !open.has(x) && x.id !== input.tool_use_id) : [];
  const f = fearMod.fearOf({ s, a, tool: input.tool_name, input: input.tool_input || {}, steps });
  if (!f.event || f.risk.level < 2 || !f.missed) return null;
  // una regola che il progetto ha accettato come normale (2.14, R8): niente messaggio
  try { if (ctx.accepted && require('./guard').acceptedAll(f.risk, ctx.accepted(s.cwd))) return null; } catch {}
  const rule = f.risk.ruleIds[0];
  const target = f.risk.targets[0] || '';
  let scar = null;
  try {
    const strong = (ctx.lessons ? ctx.lessons(s.cwd) : []).filter(l => l && l.kind === 'scar' && l.level === 'lesson' && !l.ignored);
    scar = strong.find(l => { const [shape, t] = String(l.key).split(' → '); return shape === f.risk.shape && (t === '*' || !target || t === target); }) || null;
  } catch {}
  const missing = f.prudence.missing.filter(k => MISSING[k]);
  return two(() => {
    // il perché si traduce qui dentro: two() chiama questa funzione una volta per lingua.
    // R0 (2026-11-23): il contesto di PreToolUse arriva all'agente insieme al risultato, mai prima. Quindi il messaggio
    // parla dell'azione appena fatta e di che cosa fare adesso; finché non si decide la guardia (R8), resta così.
    const parts = [tr('il comando che hai appena lanciato è {level} ({why}).', { level: f.risk.level >= 3 ? tr('irreversibile') : tr('pericoloso'), why: RISK_RULES[rule].text() })];
    if (missing.length) parts.push(tr('Nelle azioni prima mancava: {what}.', { what: missing.map(k => MISSING[k]()).join(tr(', ')) }));
    if (scar) parts.push(tr('In questo progetto ha già distrutto del lavoro una volta.'));
    parts.push(tr('Se l\'utente non ha chiesto proprio questo, controlla che cosa ha cambiato e diglielo subito.'));
    const advice = adviceFor(missing);
    if (advice.length) parts.push(tr('Prima della prossima azione rischiosa: {advice}.', { advice: advice.slice(0, 2).join(tr(' e ')) }));
    return parts.join(' ');
  }, { onceSession: 'fear:' + rule, tag: rule + (scar ? '/scar' : ''), about: { kind: 'fear', cmd: f.risk.shape, pat: rule, file: target } });
}

// le regole entrano in RULES una volta sola, nell'ordine in cui devono parlare. Dopo un fallimento il Nonno viene prima:
// quello che il progetto ha già imparato (dove l'errore è stato sistemato, che il comando è instabile) è più preciso
// dell'avviso generico; se poi l'agente insiste, al fallimento dopo tocca al giro in tondo. Dopo una modifica riuscita
// viene prima la memoria non aggiornata: riguarda quella modifica, la lezione sul file fragile può aspettare la prossima.
const ALL = [
  ['SessionStart', 'sessionLessons', sessionLessons],
  ['PreToolUse', 'fear', fearBefore],
  ['PostToolUseFailure', 'elder', elder], ['PostToolUseFailure', 'loop', loop],
  ['PostToolUse', 'stale', stale], ['PostToolUse', 'elder', elder], ['PostToolUse', 'drift', driftBack],
  ['Stop', 'claims', claims], ['SubagentStop', 'claims', claims],
];
function register(rules = feedback.RULES) {
  for (const [ev, feature, run] of ALL) if (!rules[ev].some(r => r.run === run)) rules[ev].push({ feature, run });
  return rules;
}
register();

module.exports = { register, sessionLessons, elder, loop, stale, claims, driftBack, fearBefore, MAX_START };
