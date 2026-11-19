#!/usr/bin/env node
'use strict';
// Avvio di Platypus da sorgente, uguale su Windows, macOS e Linux.
//   node scripts/launch.js              finestra desktop (Electron)
//   node scripts/launch.js --web        solo browser: non serve installare nulla
//   node scripts/launch.js --demo       con la demo accesa
//   node scripts/launch.js --background avvia e restituisce subito il terminale
//   node scripts/launch.js --setup      installa le dipendenze e basta
//   node scripts/launch.js --shortcut   crea il collegamento sul desktop / nel menu delle app
//   node scripts/launch.js --shell tauri  il guscio Tauri sperimentale, se è compilato (altrimenti Electron)
// Alla prima esecuzione (e dopo ogni "git pull" che cambia le dipendenze) installa da solo
// quello che serve con npm. Se la finestra desktop non può partire, apre l'ufficio nel browser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// copia una volta i dati del vecchio Agent Office; con PLATYPUS_DATA_DIR è quella cartella (anche per launch.log)
const DATA_DIR = require(path.join(ROOT, 'src', 'paths')).dataDir();
const args = process.argv.slice(2);
const has = f => args.includes(f);
// --shell tauri (o --shell=tauri): quale guscio desktop; senza, Electron
const shellAt = args.indexOf('--shell');
const SHELL = ((args.find(a => a.startsWith('--shell=')) || '').slice(8) || (shellAt >= 0 ? args[shellAt + 1] || '' : '')).toLowerCase();
const passThrough = args.filter((a, i) => !['--web', '--background', '--setup', '--shortcut', '--electron'].includes(a) &&
  !a.startsWith('--shell=') && !(shellAt >= 0 && (i === shellAt || i === shellAt + 1)));
const IS_WIN = process.platform === 'win32';
const LOG_DIR = DATA_DIR;
const LOG = path.join(LOG_DIR, 'launch.log');
const { openLaunchLog, readSince } = require('./launch-log');
let LOG_START = 0; // dove comincia, nel registro, questo avvio

function say(msg) { console.log('[platypus] ' + msg); }
function fail(msg) { console.error('[platypus] ' + msg); process.exitCode = 1; }

// ---------------------------------------------------------------- requisiti
// Node.js 22.13 o più recente, per la finestra e per la modalità browser: il motore usa node:sqlite (src/requirements.js)
const { nodeOk, nodeMessages } = require('../src/requirements');
if (!nodeOk(process.versions.node)) {
  for (const line of nodeMessages(process.versions.node)) fail(line);
  process.exit(1);
}

// ---------------------------------------------------------------- dipendenze
function lockHash() {
  try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'package-lock.json'))).update(fs.readFileSync(path.join(ROOT, 'package.json'))).digest('hex'); }
  catch { return 'none'; }
}
const MARK = path.join(ROOT, 'node_modules', '.platypus-deps');
function electronPath() {
  try {
    const p = require(path.join(ROOT, 'node_modules', 'electron'));
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch { return null; }
}
function depsOk() {
  try { return fs.readFileSync(MARK, 'utf8').trim() === lockHash() && !!electronPath(); } catch { return false; }
}
function installDeps() {
  say('Installo le dipendenze (solo la prima volta o dopo un aggiornamento, ~120 MB da scaricare)…');
  say('Installing dependencies (first run or after an update, ~120 MB download)…');
  const npm = IS_WIN ? 'npm.cmd' : 'npm';
  const useCi = fs.existsSync(path.join(ROOT, 'package-lock.json'));
  // l'unica dipendenza è Electron: npm scarica da solo quella giusta per il sistema (Windows, macOS, Linux; x64 o arm64)
  const npmArgs = [useCi ? 'ci' : 'install', '--no-audit', '--no-fund'];
  // su Windows npm è un .cmd, che vuole la shell; con una riga sola (senza argomenti separati) Node 24 non stampa l'avviso DEP0190
  const r = IS_WIN
    ? spawnSync(`${npm} ${npmArgs.join(' ')}`, { cwd: ROOT, stdio: 'inherit', shell: true })
    : spawnSync(npm, npmArgs, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    fail('npm non è riuscito a installare le dipendenze. Controlla la connessione (o il proxy aziendale: vedi docs/INSTALLAZIONE.md) e riprova.');
    return false;
  }
  try { fs.writeFileSync(MARK, lockHash()); } catch {}
  return !!electronPath();
}

// ---------------------------------------------------------------- modalità browser
function runWeb() {
  say('Apro l\'ufficio nel browser · opening the office in your browser');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'standalone.js'), ...passThrough], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', code => process.exit(code || 0));
}

// ---------------------------------------------------------------- finestra desktop
function canShowWindow() {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
// Wayland: compatibilità XWayland scelta dal menu dell'icona (config.json dell'app) o con PLATYPUS_X11=1
function wantsX11() {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return false;
  if (process.env.PLATYPUS_X11 === '1') return true;
  if (process.env.PLATYPUS_X11 === '0') return false;
  const conf = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Platypus', 'config.json');
  try { return JSON.parse(fs.readFileSync(conf, 'utf8')).x11 === true; } catch { return false; }
}
function startElectron(extra, background) {
  const exe = electronPath();
  // il registro dell'avvio di prima diventa launch.log.1: mai svuotarlo (scripts/launch-log.js)
  const log = openLaunchLog(LOG_DIR);
  LOG_START = log.start;
  const errFd = log.fd;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // se è impostata, Electron partirebbe come Node senza finestra
  const child = spawn(exe, [ROOT, ...extra, ...passThrough], {
    cwd: ROOT,
    detached: background,
    stdio: background ? ['ignore', errFd, errFd] : ['ignore', 'inherit', errFd],
    env,
    windowsHide: false,
  });
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('exit', code => finish({ ok: code === 0, exited: true, code }));
    // se dopo qualche secondo è ancora viva, è partita
    setTimeout(() => finish({ ok: true, child }), 5000);
  });
}
function logText() { return readSince(LOG, LOG_START); }

async function runDesktop() {
  if (!canShowWindow()) { say('Nessuno schermo grafico (DISPLAY/WAYLAND_DISPLAY): passo alla modalità browser.'); return runWeb(); }
  if (!depsOk() && !installDeps()) { say('Senza le dipendenze apro la modalità browser, che non ne ha bisogno.'); return runWeb(); }
  const background = has('--background');
  const extra = [];
  if (process.platform === 'linux' && process.env.PLATYPUS_NO_SANDBOX === '1') extra.push('--no-sandbox');
  if (wantsX11()) extra.push('--ozone-platform=x11');
  let r = await startElectron(extra, background);
  // alcune distribuzioni Linux (es. Ubuntu 24.04 con AppArmor) bloccano la sandbox di Electron scaricato da npm
  if (r.exited && process.platform === 'linux' && !extra.includes('--no-sandbox') && /sandbox/i.test(logText())) {
    say('La sandbox di Electron non è disponibile su questo sistema: riavvio con --no-sandbox (vedi docs/INSTALLAZIONE.md).');
    extra.push('--no-sandbox');
    r = await startElectron(extra, background);
  }
  if (r.exited && r.code !== 0) {
    const log = logText().trim().split('\n').slice(-8).join('\n');
    if (/porta|port|EADDRINUSE|già aperto/i.test(log)) { say('Platypus è già aperto.'); process.exit(0); }
    say('La finestra desktop non è partita:\n' + log);
    say('Apro la modalità browser al suo posto.');
    return runWeb();
  }
  if (r.error) { say('Electron non si avvia (' + r.error + '): apro la modalità browser.'); return runWeb(); }
  if (background) { if (r.child) r.child.unref(); say('Platypus è partito. Puoi chiudere questo terminale.'); process.exit(0); }
  if (r.child) r.child.on('exit', code => process.exit(code || 0));
}

// ---------------------------------------------------------------- guscio Tauri (sperimentale, docs/plans/tauri-shell.md)
// Il programma compilato con "npm run tauri:build"; il motore lo avvia lui (node src/standalone.js).
function tauriExe() {
  const p = path.join(ROOT, 'shells', 'tauri', 'src-tauri', 'target', 'release', IS_WIN ? 'platypus.exe' : 'platypus');
  return fs.existsSync(p) ? p : null;
}
function runTauri() {
  const exe = tauriExe();
  if (!exe) {
    say('Il guscio Tauri non è compilato. Serve Rust (vedi la sezione Tauri di docs/ARCHITETTURA.md), poi: npm run tauri:build');
    say('The Tauri shell is not built. It needs Rust (see the Tauri section of docs/ARCHITECTURE.md), then: npm run tauri:build');
    say('Intanto apro Electron · opening Electron meanwhile');
    return runDesktop();
  }
  const background = has('--background');
  // in background i messaggi del guscio e del motore vanno in launch.log, ruotato come per Electron (scripts/launch-log.js)
  let out = 'inherit';
  if (background) { const log = openLaunchLog(LOG_DIR); LOG_START = log.start; out = ['ignore', log.fd, log.fd]; }
  const child = spawn(exe, passThrough, { cwd: ROOT, detached: background, stdio: out, windowsHide: false });
  child.on('error', e => { say('Il guscio Tauri non si avvia (' + e.message + '): apro Electron.'); runDesktop(); });
  child.on('spawn', () => {
    if (background) { child.unref(); say('Platypus (Tauri) è partito. Puoi chiudere questo terminale.'); process.exit(0); }
  });
  if (!background) child.on('exit', code => process.exit(code || 0));
}

// ---------------------------------------------------------------- main
(async () => {
  if ((has('--setup') || has('--shortcut')) && !nodeForWindow) process.exit(1); // Electron non si installa: il motivo è già scritto sopra
  if (has('--setup')) { process.exit(depsOk() || installDeps() ? 0 : 1); }
  if (has('--shortcut')) {
    if (!depsOk() && !installDeps()) process.exit(1);
    const r = require('./shortcut').install({ root: ROOT, electron: electronPath() });
    for (const line of r) say(line);
    return;
  }
  if (has('--web')) return runWeb();
  if (SHELL === 'tauri') return runTauri();
  if (SHELL && SHELL !== 'electron') say(`Guscio sconosciuto «${SHELL}»: uso Electron · unknown shell, using Electron`);
  return runDesktop();
})();
