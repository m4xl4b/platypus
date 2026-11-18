'use strict';
// Esiti dei messaggi agli agenti (piano 2.11, C2): dopo un messaggio, che cosa ha fatto l'agente nei passi successivi.
// Solo fatti già tracciati (i passi dell'agente, le sue risposte, le richieste dell'utente), con etichette oneste:
//   helped    «probabilmente ha aiutato»: ha fatto quello che il messaggio suggeriva, o è andata bene
//   ignored   «ignorato»: ha rifatto proprio quello che il messaggio sconsigliava, o non ha fatto niente di quello che chiedeva
//   unclear   «non si può dire»
// I messaggi in ombra ricevono lo stesso giudizio: sono il termine di paragone, quello che fanno gli agenti quando
// nessuno li avvisa. Un esito è un indizio, non una prova: l'agente avrebbe potuto fare lo stesso anche senza messaggio.
//
// judge(entry, agent, now) -> null (ancora presto) | { outcome, why }
//   entry   la riga del registro: { t, agent, feature, about: { kind, cmd, pat, file }, toolUseId }
//   agent   l'agente come lo vede l'ufficio: { steps, goals, replies } (null se la sessione non c'è più)
// why è nella lingua dell'ufficio: lo leggono le persone, nel Libro.

const { tr } = require('../i18n');
const { cmdCore, errorPattern } = require('./bottega');
const { isTestCommand } = require('./releases');

const WINDOW_STEPS = 8;           // i passi dopo il messaggio che contano
const WINDOW_MS = 15 * 60000;     // e il tempo: dopo, si decide con quello che c'è
const GIVE_UP_MS = 60 * 60000;    // una sessione che non si vede più: dopo un'ora, «non si può dire»
// l'agente ritira l'affermazione: dice che non è verificato, o che i test non li ha lanciati
const WITHDRAW = /\bnot (?:yet )?(?:verified|tested|been run)\b|\bhave(?:n'?t| not) (?:yet )?(?:run|tested|verified)\b|\bdid(?:n'?t| not) (?:run|test|verify)\b|\bnon (?:ancora )?(?:verificat\w*|testat\w*|provat\w*)\b|\bnon ho (?:ancora )?(?:lanciato|verificato|eseguito|provato)\b/i;

const say = (outcome, why) => ({ outcome, why });
const cmdOfStep = s => (/^run:/.test(s.sig || '') ? s.sig.slice(4) : '');
const sameCmd = (s, cmd) => !!cmd && !!cmdOfStep(s) && cmdCore(cmdOfStep(s)) === cmdCore(cmd);
const isTest = s => s.act === 'verify' && isTestCommand(cmdOfStep(s));
const sameFile = (s, f) => !!f && !!s.target && (s.target === f || s.target.endsWith('/' + f) || f.endsWith('/' + s.target));

function judge(e, ag, now = Date.now()) {
  if (!e || !e.feature) return null;
  const a = e.about || {};
  // le lezioni a inizio sessione: servirebbe confrontare sessioni con e senza, con la storia lunga della 2.12
  if (e.feature === 'sessionLessons') return say('unclear', tr('per ora non si può misurare: servirebbe confrontare sessioni con e senza le lezioni'));
  // il motore lessicale non distingue una deviazione necessaria da una deriva: non giudichiamo se è tornato al compito
  if (e.feature === 'drift') return say('unclear', tr('il motore non distingue una deviazione necessaria da una deriva'));
  if (!ag || !Array.isArray(ag.steps)) return now - e.t > GIVE_UP_MS ? say('unclear', tr('la sessione non si vede più')) : null;
  // i passi dopo il messaggio: dopo il passo dell'hook se lo conosciamo, altrimenti quelli partiti dopo
  const k = e.toolUseId ? ag.steps.findIndex(s => s.id === e.toolUseId) : -1;
  let after = k >= 0 ? ag.steps.slice(k + 1) : ag.steps.filter(s => s.t > e.t);
  // per il principale conta solo il turno in corso: una nuova richiesta dell'utente cambia la storia
  const next = e.agent === 'main' ? (ag.goals || []).map(g => g.t).filter(t => t > e.t).sort((x, y) => x - y)[0] : undefined;
  if (next) after = after.filter(s => s.t < next);
  after = after.slice(0, WINDOW_STEPS);
  const closed = !!next || after.length >= WINDOW_STEPS || now - e.t > WINDOW_MS;
  const stopped = !!next; // il turno è finito prima della finestra
  switch (e.feature === 'loop' ? 'loop' : e.feature === 'elder' ? a.kind : e.feature) {
    // B3, e il Nonno su un comando appena fallito: la volta dopo è andata, o ha cambiato qualcosa prima di riprovare,
    // oppure lo stesso fallimento di nuovo
    case 'loop': case 'flaky-command': case 'loop-trap': {
      for (const s of after) {
        if (s.err === null) return null; // ancora in corso: si aspetta l'esito
        if (s.act === 'edit' && s.err === false) return say('helped', tr('ha cambiato qualcosa prima di rilanciarlo'));
        if (!sameCmd(s, a.cmd)) continue;
        if (!s.err) return say('helped', tr('la volta dopo è andata'));
        const same = !a.pat || (s.fail && errorPattern(s.fail.excerpt) === a.pat);
        if (!same) return say('unclear', tr('rilanciato, è fallito con un altro errore'));
        // per un comando instabile il consiglio era proprio rilanciarlo: se fallisce uguale non è colpa dell'agente
        return a.kind === 'flaky-command' ? say('unclear', tr('rilanciato, è fallito allo stesso modo')) : say('ignored', tr('rilanciato senza cambiare niente: lo stesso errore'));
      }
      if (!closed) return null;
      if (stopped && e.feature === 'loop') return say('helped', tr('si è fermato invece di riprovare'));
      return say('unclear', tr('non l\'ha più rilanciato'));
    }
    // il Nonno su un errore già sistemato: ha messo mano al file dove era stato sistemato?
    case 'known-fix': {
      for (const s of after) {
        if (s.err === null && s.act === 'edit') return null;
        if (s.act === 'edit' && s.err === false && sameFile(s, a.file)) return say('helped', tr('ha modificato {file}', { file: a.file }));
        if (s.act === 'read' && s.err === false && sameFile(s, a.file)) return say('helped', tr('ha letto {file}', { file: a.file }));
      }
      return closed ? say('ignored', tr('non ha toccato {file}', { file: a.file || '?' })) : null;
    }
    // il Nonno su un file fragile appena modificato: «lancia i test adesso»
    case 'fragile-file': {
      for (const s of after) if (isTest(s)) return s.err === null && !closed ? null : say('helped', tr('ha lanciato i test'));
      return closed ? say('ignored', tr('nessun test dopo la modifica')) : null;
    }
    // il Nonno su un file che non c'è: l'ha cercato di nuovo?
    case 'ghost-path': {
      for (const s of after) if ((s.act === 'read' || s.act === 'search') && sameFile(s, a.file)) return say('ignored', tr('l\'ha cercato di nuovo'));
      return closed ? say('helped', tr('non l\'ha più cercato')) : null;
    }
    // B4 · memoria non aggiornata: il passo dopo su quel file è una lettura, o un'altra modifica alla cieca?
    case 'stale': {
      for (const s of after) {
        if (!sameFile(s, a.file)) continue;
        if (s.err === null) return null;
        if (s.act === 'read') return say('helped', tr('l\'ha riletto'));
        if (s.act === 'edit') return say('ignored', tr('l\'ha modificato di nuovo senza rileggerlo'));
      }
      return closed ? say('unclear', tr('non ha più toccato il file')) : null;
    }
    // B5 · affermazioni senza prove: prima della richiesta successiva ha lanciato un controllo, o ha ritirato l'affermazione?
    case 'claims': {
      const check = a.kind === 'tests' ? isTest : s => s.act === 'verify' || s.act === 'run';
      for (const s of after) if (check(s)) return s.err === null && !closed ? null : say('helped', a.kind === 'tests' ? tr('ha lanciato i test') : tr('ha lanciato un controllo'));
      const until = next || Infinity;
      if ((ag.replies || []).some(r => r.t > e.t && r.t < until && WITHDRAW.test(String(r.text || '')))) return say('helped', tr('ha detto che non era verificato'));
      return closed ? say('ignored', stopped ? tr('niente prima della richiesta successiva') : tr('nessun controllo nei passi successivi')) : null;
    }
    // il Nonno su un comando lento («lancialo in background»): i passi non dicono come è stato lanciato
    case 'slow-step': return say('unclear', tr('i passi non dicono se l\'ha lanciato in background'));
    default: return closed ? say('unclear', tr('nessuna regola per giudicarlo')) : null;
  }
}

module.exports = { judge, WINDOW_STEPS, WINDOW_MS, GIVE_UP_MS };
