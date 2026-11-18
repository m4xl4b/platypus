'use strict';
// Le regole del feedback agli agenti: che cosa dice Platypus, e quando (piano 2.11, parte B).
// Ogni regola è una funzione pura (input dell'hook, ctx) -> messaggio o niente; modi, limiti e registro stanno in feedback.js.
// I testi sono sempre in inglese (li legge il modello), qualunque sia la lingua dell'ufficio.
//   ctx.lessons(cwd)      le lezioni del Libro della bottega per quel progetto
//   ctx.hasSection(cwd)   il CLAUDE.md del progetto ha già la sezione di Platypus

const i18n = require('../i18n');
const feedback = require('./feedback');
const { lessonLines } = require('./bottega');

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

// le regole entrano in RULES una volta sola, nell'ordine in cui devono parlare
const ALL = [['SessionStart', 'sessionLessons', sessionLessons]];
function register(rules = feedback.RULES) {
  for (const [ev, feature, run] of ALL) if (!rules[ev].some(r => r.run === run)) rules[ev].push({ feature, run });
  return rules;
}
register();

module.exports = { register, sessionLessons, MAX_START };
