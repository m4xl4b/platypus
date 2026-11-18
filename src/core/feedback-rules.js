'use strict';
// Le regole del feedback agli agenti: che cosa dice Platypus, e quando (piano 2.11, parte B).
// Ogni regola è una funzione pura (input dell'hook, ctx) -> messaggio o niente; modi, limiti e registro stanno in feedback.js.
// I testi sono sempre in inglese (li legge il modello), qualunque sia la lingua dell'ufficio.
//   ctx.lessons(cwd)      le lezioni del Libro della bottega per quel progetto
//   ctx.hasSection(cwd)   il CLAUDE.md del progetto ha già la sezione di Platypus

const i18n = require('../i18n');
const feedback = require('./feedback');
const { lessonLines, elderLine, sameCmd, errorPattern } = require('./bottega');
const { classifyFailure, errorExcerpt } = require('./surprise');
const { relKey } = require('./worldmap');

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

// le regole entrano in RULES una volta sola, nell'ordine in cui devono parlare
const ALL = [['SessionStart', 'sessionLessons', sessionLessons], ['PostToolUseFailure', 'elder', elder], ['PostToolUse', 'elder', elder]];
function register(rules = feedback.RULES) {
  for (const [ev, feature, run] of ALL) if (!rules[ev].some(r => r.run === run)) rules[ev].push({ feature, run });
  return rules;
}
register();

module.exports = { register, sessionLessons, elder, MAX_START };
