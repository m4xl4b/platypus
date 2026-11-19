'use strict';
// Carica node:sqlite senza l'avviso "SQLite is an experimental feature", che Node.js stampa ancora (visto sulla
// 24.13) e che finirebbe nel terminale e nel registro di avvio a ogni partenza. Si toglie SOLO quell'avviso:
// ogni altro, anche sperimentale, passa come prima. Se il modulo non c'è, null: chi chiama ripiega (S4).

let cached; // undefined: mai provato; null: non disponibile

function isSqliteWarning(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions
    : (typeOrOptions && typeOrOptions.type) || (warning && warning.name) || '';
  const text = warning && warning.message !== undefined ? warning.message : warning;
  return type === 'ExperimentalWarning' && /\bSQLite\b/.test(String(text));
}

function loadSqlite() {
  if (cached !== undefined) return cached;
  const emit = process.emitWarning;
  process.emitWarning = function (warning, typeOrOptions) {
    if (isSqliteWarning(warning, typeOrOptions)) return;
    return emit.apply(process, arguments);
  };
  try { cached = require('node:sqlite'); }
  catch { cached = null; }
  finally { process.emitWarning = emit; }
  return cached;
}

module.exports = { loadSqlite, isSqliteWarning };
