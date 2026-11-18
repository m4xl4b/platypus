'use strict';
// node src/hooks-cli.js install | uninstall | status [--feedback [--curl]]
//   senza opzioni: gli hook che osservano (asincroni, non rallentano Claude Code)
//   --feedback:    gli hook di feedback (sincroni: dicono qualcosa all'agente), che si installano e si tolgono a parte
//   --curl:        con --feedback, comandi curl al posto degli hook http (per le versioni di Claude Code che non li hanno)
const hooks = require('./core/hooks');
const { DEFAULT_PORT } = require('./core');
const i18n = require('./i18n');
const { tr } = i18n;
// la lingua scelta nelle opzioni dell'ufficio (o quella del sistema)
try { i18n.setLang(i18n.resolveLang(JSON.parse(require('fs').readFileSync(require('path').join(require('./paths').dataDir(), 'settings.json'), 'utf8')).lang)); }
catch { i18n.setLang(i18n.resolveLang('auto')); }
const args = process.argv.slice(2);
const cmd = args.find(a => !a.startsWith('--')) || 'status';
const fb = args.includes('--feedback'), curl = args.includes('--curl');
try {
  if (cmd === 'install' && fb) {
    const r = hooks.installFeedback({ port: DEFAULT_PORT, curl });
    console.log(tr('Hook di feedback installati in {path} ({n} eventi).', { path: r.path, n: r.events }) + (r.backup ? '\n' + tr('Copia di sicurezza: {path}', { path: r.backup }) : ''));
    console.log(tr('Da soli non dicono niente: ogni funzione si accende dalle opzioni dell\'ufficio.'));
  } else if (cmd === 'uninstall' && fb) {
    const r = hooks.uninstallFeedback();
    console.log(r.removed ? tr('Hook di feedback rimossi da {path}.', { path: r.path }) : tr('Nessun hook di feedback da rimuovere.'));
  } else if (cmd === 'install') {
    const r = hooks.install({ port: DEFAULT_PORT });
    console.log(tr('Hook installati in {path} ({n} eventi).', { path: r.path, n: r.events }) + (r.backup ? '\n' + tr('Copia di sicurezza: {path}', { path: r.backup }) : ''));
    console.log(tr('Le sessioni di Claude Code aperte da adesso in poi manderanno gli eventi all\'ufficio.'));
  } else if (cmd === 'uninstall') {
    const r = hooks.uninstall();
    console.log(r.removed ? tr('Hook di Platypus rimossi da {path}.', { path: r.path }) : tr('Nessun file di impostazioni trovato.'));
  } else {
    console.log(hooks.status() ? tr('Hook di Platypus: INSTALLATI') : tr('Hook di Platypus: non installati'));
    console.log(hooks.feedbackStatus() ? tr('Hook di feedback: INSTALLATI') : tr('Hook di feedback: non installati'));
  }
} catch (e) {
  console.error(tr('Errore: {msg}', { msg: e.message }));
  process.exit(1);
}
