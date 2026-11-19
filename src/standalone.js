'use strict';
// Modalità browser: avvia solo il server e apre l'ufficio nel browser predefinito.
//   node src/standalone.js [--no-open] [--demo] [--parent-stdin]
// prima di caricare il motore: con un Node.js troppo vecchio ci si ferma qui, con lo stesso messaggio del lanciatore
const { nodeOk, nodeMessages } = require('./requirements');
if (!nodeOk(process.versions.node)) {
  for (const line of nodeMessages(process.versions.node)) console.error('[platypus] ' + line);
  process.exit(1);
}
const { exec } = require('child_process');
const { startCore } = require('./core');
const { tr } = require('./i18n');

const core = startCore({ includeCowork: !process.argv.includes('--no-cowork') });
core.ready.then(({ port }) => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(tr('Platypus in ascolto su {url}  (Ctrl+C per uscire)', { url }));
  if (process.argv.includes('--demo')) core.demo.start();
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
}).catch(err => {
  if (err.code === 'EADDRINUSE') console.error(tr('La porta è già occupata: forse Platypus è già aperto?'));
  else console.error(err);
  process.exit(1);
});
process.on('SIGINT', () => { core.stop(); process.exit(0); });
// --parent-stdin: avviato da un guscio (Tauri) che tiene aperto il nostro stdin. Quando il guscio si chiude, anche
// in modo brusco, lo stdin finisce: salviamo e usciamo, invece di restare acceso senza nessuno
if (process.argv.includes('--parent-stdin')) {
  const quit = () => { try { core.stop(); } catch {} process.exit(0); };
  process.stdin.on('end', quit);
  process.stdin.on('error', quit);
  process.stdin.resume();
}
