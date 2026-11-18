'use strict';
// Le regole del feedback agli agenti: che cosa dice Platypus, e quando (piano 2.11, parte B).
// Ogni regola è una funzione pura (input dell'hook, ctx) -> messaggio o niente; modi, limiti e registro stanno in feedback.js.
// I testi sono sempre in inglese (li legge il modello), qualunque sia la lingua dell'ufficio.
//   ctx.lessons(cwd)      le lezioni del Libro della bottega per quel progetto
//   ctx.hasSection(cwd)   il CLAUDE.md del progetto ha già la sezione di Platypus
//   ctx.agent(input)      l'agente che ha mandato l'hook, come lo vede l'ufficio: { id, steps, nodes, goals } (null se non lo conosciamo)
//   ctx.team()            tutti gli agenti della sessione: [{ id, name, nodes }]

const i18n = require('../i18n');
const feedback = require('./feedback');
const { lessonLines, elderLine, sameCmd, errorPattern } = require('./bottega');
const { classifyFailure, errorExcerpt } = require('./surprise');
const { relKey, isProjectFile } = require('./worldmap');

const en = fn => i18n.withLang('en', fn);

// ---- B1 · le lezioni del progetto a inizio sessione (avvio, ripresa, /clear, dopo una compattazione)
const MAX_START = 6;
function sessionLessons(input, ctx) {
  const cwd = ctx.cwd || input.cwd || '';
  if (!cwd || !ctx.lessons) return null;
  if (ctx.hasSection && ctx.hasSection(cwd)) return null; // le ha già nel CLAUDE.md: non si ripetono
  const lines = en(() => lessonLines(ctx.lessons(cwd) || [], MAX_START));
  if (!lines.length) return null;
  return {
    text: ['Platypus (project memory): lessons inferred from past sessions of this project. They are clues from what happened, not rules.', ...lines.map(l => '- ' + l)].join('\n'),
    lines: true, max: feedback.MAX_LONG,
  };
}

// ---- B2 · il Nonno parla all'agente: dopo una trappola nota, la lezione del Libro che la riguarda
// Parla dopo lo strumento, quando la lezione serve: un comando instabile appena fallito, un file che non c'è, un file
// fragile appena modificato. Il confronto usa quello che l'hook porta con sé (tool_input, error, tool_response), non lo
// stato dell'ufficio, che può essere indietro di qualche riga. Solo lezioni forti e non ignorate, una volta per agente.
const BASH = new Set(['Bash', 'PowerShell']), EDITS = new Set(['Edit', 'Write', 'MultiEdit']);
// quello che il Nonno direbbe nel fumetto, in inglese, più (dove serve) che cosa fare adesso
const elderSay = (l, then) => ({ text: en(() => elderLine(l)) + (then ? ' ' + then : ''), lessonId: l.id });
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
      if (fix) return elderSay(fix);
    }
    if (cmd) {
      const l = strongest(strong, l => (l.kind === 'flaky-command' || l.kind === 'loop-trap') && sameCmd(l.key, cmd));
      if (l) return elderSay(l);
    }
    if (tool === 'Read') {
      const k = key(ti.file_path);
      const l = k && strongest(strong, l => l.kind === 'ghost-path' && l.key === k);
      if (l) return elderSay(l);
    }
    return null;
  }
  if (EDITS.has(tool)) {
    const k = key(ti.file_path);
    const l = k && strongest(strong, l => l.kind === 'fragile-file' && l.key === k);
    return l ? elderSay(l, 'Run the tests now.') : null;
  }
  if ((tool === 'Glob' || tool === 'Grep') && foundNothing(input.tool_response)) {
    const g = tool === 'Glob' ? globTarget(ti.pattern) : '';
    const k = tool === 'Grep' ? key(ti.path) : null;
    const l = strongest(strong, l => l.kind === 'ghost-path' && (k ? l.key === k : !!g && (l.key === g || l.key.endsWith('/' + g))));
    return l ? elderSay(l) : null;
  }
  if (BASH.has(tool) && ti.command) {
    const l = strongest(strong, l => l.kind === 'slow-step' && sameCmd(l.key, String(ti.command)));
    return l ? elderSay(l) : null;
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
  const quote = excerpt.length > 120 ? excerpt.slice(0, 119) + '…' : excerpt;
  return {
    text: `this command failed ${n} times in a row with the same error («${quote}») and no edit in between. Change something before running it again, or stop and say what is blocking you.`,
    once: 'loop|' + sig + '|' + pat,
  };
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
  for (const a of en(() => ctx.team()) || []) {
    if (a.id === me.id || !a.nodes) continue;
    const o = a.nodes.get(key);
    for (const t of (o && o.edits) || []) if (t > from && t <= to && (!by || t > by.t)) by = { t, name: a.name };
  }
  if (!by) return null;
  const file = '`' + key + '`', who = by.name || 'another agent';
  return {
    text: tool === 'Write'
      ? `you just rewrote ${file}, but ${who} changed it at ${hhmm(by.t)}, after you last read it. Check that you did not undo that change.`
      : `${who} changed ${file} at ${hhmm(by.t)}, after you last read it, and you just edited it without reading it again. Read it again and check that your edit still fits.`,
    once: 'stale|' + key + '|' + by.t,
  };
}

// le regole entrano in RULES una volta sola, nell'ordine in cui devono parlare. Dopo un fallimento il Nonno viene prima:
// quello che il progetto ha già imparato (dove l'errore è stato sistemato, che il comando è instabile) è più preciso
// dell'avviso generico; se poi l'agente insiste, al fallimento dopo tocca al giro in tondo. Dopo una modifica riuscita
// viene prima la memoria non aggiornata: riguarda quella modifica, la lezione sul file fragile può aspettare la prossima.
const ALL = [
  ['SessionStart', 'sessionLessons', sessionLessons],
  ['PostToolUseFailure', 'elder', elder], ['PostToolUseFailure', 'loop', loop],
  ['PostToolUse', 'stale', stale], ['PostToolUse', 'elder', elder],
];
function register(rules = feedback.RULES) {
  for (const [ev, feature, run] of ALL) if (!rules[ev].some(r => r.run === run)) rules[ev].push({ feature, run });
  return rules;
}
register();

module.exports = { register, sessionLessons, elder, loop, stale, MAX_START };
