'use strict';
// Le prove partono solo con PLATYPUS_DATA_DIR impostata su una cartella temporanea: così non scrivono mai nei dati
// veri (~/.platypus: opzioni, Libro della bottega, registro dei messaggi, launch.log).
// "Temporanea" vuol dire dentro la cartella temporanea del sistema (os.tmpdir()) o, nelle GitHub Actions, dentro
// RUNNER_TEMP. Chi lancia le prove la crea e la toglie: per esempio, in Git Bash,
//   H="$TEMP/pl-test" && rm -rf "$H" && mkdir -p "$H" && PLATYPUS_DATA_DIR="$H/data" npm test
const fs = require('fs');
const os = require('os');
const path = require('path');

const norm = p => {
  let r = path.resolve(p);
  // la parte che esiste già, risolta (macOS: /var → /private/var; Windows: nomi corti come RUNNER~1)
  let head = r, tail = '';
  while (head && !fs.existsSync(head)) { const up = path.dirname(head); if (up === head) break; tail = path.join(path.basename(head), tail); head = up; }
  try { r = path.join(fs.realpathSync.native(head), tail); } catch {}
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (p, root) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

// perché la cartella dei dati non va bene per le prove, oppure '' se va bene
function whyNot(env = process.env) {
  const v = env.PLATYPUS_DATA_DIR;
  if (!v || !String(v).trim()) return 'PLATYPUS_DATA_DIR non è impostata';
  const dir = norm(String(v).trim());
  const roots = [os.tmpdir(), env.RUNNER_TEMP].filter(Boolean).map(norm);
  if (!roots.some(r => inside(dir, r))) return `PLATYPUS_DATA_DIR (${v}) non è dentro una cartella temporanea (${roots.join(', ')})`;
  return '';
}

// da chiamare all'inizio di ogni prova lanciata da sola: se la cartella non va bene, si esce senza fare niente
function requireTempDataDir(name) {
  const why = whyNot();
  if (!why) return;
  console.error(`[${name || 'prove'}] Mi rifiuto di partire: ${why}.`);
  console.error('Le prove devono scrivere solo in una cartella temporanea, mai nei dati veri di Platypus. Per esempio, in Git Bash:');
  console.error('  H="$TEMP/pl-test" && rm -rf "$H" && mkdir -p "$H" && PLATYPUS_DATA_DIR="$H/data" npm test');
  process.exit(2);
}

module.exports = { requireTempDataDir, whyNot };
