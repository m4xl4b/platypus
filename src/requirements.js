'use strict';
// Versione minima di Node.js, per tutto Platypus: lanciatore, modalità browser, finestra e motore dei gusci.
// Dalla 2.13 il motore tiene lo storico in SQLite (node:sqlite), che funziona senza opzioni dalla 22.13 e,
// nella serie 23, dalla 23.4. Node.js 20 non riceve più aggiornamenti di sicurezza dal 30 aprile 2026.
// Lo stesso minimo è scritto in shells/tauri/src-tauri/src/engine.rs (MIN_NODE): le prove controllano che coincidano.
// Sintassi semplice e nessun require: questo file deve poter girare anche sul Node.js vecchio che rifiuta.

const MIN_NODE = '22.13.0';

function parts(v) { return String(v || '').replace(/^v/, '').split('.').map(function (n) { return parseInt(n, 10) || 0; }); }

// "22.13.0" o più recente? (23.0–23.3 no: lì node:sqlite vuole ancora --experimental-sqlite)
function nodeOk(v) {
  const p = parts(v), a = p[0], b = p[1] || 0;
  if (a === 22) return b >= 13;
  if (a === 23) return b >= 4;
  return a > 23;
}

// il comando per aggiornare, secondo il sistema: nvm se c'è, altrimenti winget (Windows) o Homebrew (macOS)
function updateCommand(platform, env) {
  platform = platform || process.platform;
  env = env || process.env;
  if (platform === 'win32') return env.NVM_HOME ? 'nvm install lts' : 'winget install OpenJS.NodeJS.LTS';
  if (env.NVM_DIR) return 'nvm install --lts';
  if (platform === 'darwin') return 'brew install node';
  return 'nvm install --lts';
}

// le righe da mostrare a chi ha un Node.js troppo vecchio: italiano e inglese, come il resto del lanciatore
// (qui le traduzioni non sono ancora caricate, e potrebbero non caricarsi affatto su un Node.js vecchio)
function nodeMessages(version, platform, env) {
  const v = String(version || '').replace(/^v/, ''), min = MIN_NODE.replace(/\.0$/, ''), cmd = updateCommand(platform, env);
  return [
    'Serve Node.js ' + min + ' o più recente: hai la ' + v + '. Per aggiornarlo: ' + cmd + '  (oppure https://nodejs.org), poi riapri il terminale.',
    'Node.js ' + min + ' or newer is required: you have ' + v + '. To update it: ' + cmd + '  (or https://nodejs.org), then reopen the terminal.',
  ];
}

module.exports = { MIN_NODE, nodeOk, updateCommand, nodeMessages };
