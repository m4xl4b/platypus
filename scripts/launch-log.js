'use strict';
// Il registro del lanciatore (launch.log, nella cartella dei dati): a ogni avvio il precedente diventa launch.log.1
// (quello di prima ancora si perde), e si comincia un file nuovo. Mai svuotare il registro di un avvio precedente:
// può essere quello di un Platypus ancora aperto, o l'unica traccia di un errore.
// Se Windows non lascia rinominare il file (un processo lo tiene aperto senza permetterlo), si scrive in coda.
const fs = require('fs');
const path = require('path');

// apre il registro per un nuovo avvio: { fd, file, start } (start = da dove comincia questo avvio nel file)
function openLaunchLog(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, 'launch.log');
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  if (size > 0) {
    try { fs.renameSync(file, file + '.1'); size = 0; } catch { /* non si può rinominare: si va in coda */ }
  }
  if (size > 0) {
    const fd = fs.openSync(file, 'a');
    const head = '\n--- ' + new Date().toISOString() + ' ---\n';
    try { fs.writeSync(fd, head); } catch {}
    return { fd, file, start: size + Buffer.byteLength(head) };
  }
  return { fd: fs.openSync(file, 'w'), file, start: 0 };
}

// il testo scritto da questo avvio (non quello degli avvii precedenti, se si è finiti in coda)
function readSince(file, start) {
  try { return fs.readFileSync(file).subarray(start || 0).toString('utf8'); } catch { return ''; }
}

module.exports = { openLaunchLog, readSince };
