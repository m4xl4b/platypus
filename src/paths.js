'use strict';
// Cartella dei dati di Platypus (~/.platypus) e compatibilità con il vecchio nome "Agent Office":
//  - i dati in ~/.agent-office vengono copiati una volta in ~/.platypus;
//  - le variabili d'ambiente AGENT_OFFICE_* valgono ancora come PLATYPUS_*.

const fs = require('fs');
const os = require('os');
const path = require('path');

for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('AGENT_OFFICE_')) { const nk = 'PLATYPUS_' + k.slice(13); if (process.env[nk] === undefined) process.env[nk] = v; }
}

let migrated = false;
// PLATYPUS_DATA_DIR: un'altra cartella al posto di ~/.platypus (prove, loop che lavorano in parallelo). La si crea se
// manca, e non si copia niente dal vecchio Agent Office: è una cartella a parte, che parte vuota.
function overrideDir() {
  const v = process.env.PLATYPUS_DATA_DIR;
  if (!v || !String(v).trim()) return null;
  const dir = path.resolve(String(v).trim());
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  } catch {}
  return dir;
}
function dataDir() {
  const over = overrideDir();
  if (over) return over;
  const dir = path.join(os.homedir(), '.platypus');
  if (!migrated) {
    migrated = true;
    const old = path.join(os.homedir(), '.agent-office');
    try {
      if (!fs.existsSync(dir) && fs.existsSync(old)) {
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fs.readdirSync(old)) {
          const src = path.join(old, f);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, f));
        }
      }
    } catch { /* si riparte da zero */ }
    // solo per il proprietario: dentro ci sono progetti, comandi ed estratti degli errori delle sessioni
    // (su Linux e macOS i permessi predefiniti la lascerebbero leggibile agli altri utenti del computer)
    if (process.platform !== 'win32') {
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); } catch {}
    }
  }
  return dir;
}

module.exports = { dataDir };
