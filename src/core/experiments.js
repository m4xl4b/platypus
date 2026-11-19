'use strict';
// La modalità "esperimento" del feedback agli agenti (S11 di docs/plans/2.13-storage.md).
// Una funzione in esperimento non è né accesa né in ombra per tutti: ogni sessione nuova finisce in uno dei due gruppi,
// metà e metà, deciso dall'impronta dell'id della sessione con il nome della funzione (sempre lo stesso per la stessa
// sessione, e indipendente tra una funzione e l'altra). Nel gruppo "on" i messaggi partono, nel gruppo "shadow" si
// registrano soltanto. Perché così e non "prima e dopo": i due gruppi lavorano negli stessi giorni, con gli stessi
// modelli e sugli stessi progetti; un confronto prima/dopo mescolerebbe l'effetto del messaggio con tutto quello che è
// cambiato nel frattempo (un modello nuovo, un progetto diverso).
//
// Che cosa si confronta:
//   elder, loop       per ogni messaggio, l'esito già calcolato (outcomes.js): la quota di "probabilmente utile" tra
//                     quelli giudicati, nel gruppo on contro il gruppo shadow (che dice che cosa fanno gli agenti da soli)
//   sessionLessons    per ogni sessione, gli errori ogni 100 azioni (dai riassunti delle sessioni): con le lezioni a
//                     inizio sessione contro senza
// Sempre con il numero di casi e un intervallo al 95%; sotto MIN_N casi per gruppo, "dati insufficienti", mai un verdetto.

const crypto = require('crypto');

const MIN_N = 10;          // casi per gruppo sotto cui non si dice niente
const MIN_ACTIONS = 5;     // una sessione con meno azioni non dice niente sugli errori
const Z = 1.96;            // 95%
const MESSAGE_FEATURES = ['elder', 'loop', 'fear'];
const SESSION_FEATURES = ['sessionLessons'];
const FEATURES = [...SESSION_FEATURES, ...MESSAGE_FEATURES]; // le funzioni che possono stare in esperimento (quelle che possono essere accese)

// il gruppo di una sessione per una funzione: 'on' o 'shadow', metà e metà, sempre lo stesso
function groupOf(sid, feature) {
  const h = crypto.createHash('sha1').update(String(sid || '') + ':' + String(feature || '')).digest();
  return h[0] & 1 ? 'on' : 'shadow';
}

// intervallo di Wilson per una proporzione x/n
function wilson(x, n) {
  if (!n) return [0, 1];
  const p = x / n, z2 = Z * Z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = (Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
// differenza tra due proporzioni (p1 - p2) con l'intervallo di Newcombe (dai due intervalli di Wilson): regge anche con pochi casi
function propDiff(x1, n1, x2, n2) {
  const p1 = n1 ? x1 / n1 : 0, p2 = n2 ? x2 / n2 : 0, [l1, u1] = wilson(x1, n1), [l2, u2] = wilson(x2, n2);
  const d = p1 - p2;
  return { p1, p2, diff: d, lo: d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), hi: d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2) };
}
// differenza tra due medie (a - b) con l'approssimazione normale di Welch
function meanDiff(a, b) {
  const mean = x => x.reduce((s, v) => s + v, 0) / x.length;
  const vari = (x, m) => (x.length > 1 ? x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1) : 0);
  const ma = mean(a), mb = mean(b), se = Math.sqrt(vari(a, ma) / a.length + vari(b, mb) / b.length);
  const d = ma - mb;
  return { m1: ma, m2: mb, diff: d, lo: d - Z * se, hi: d + Z * se };
}

// I risultati dello storico, per una funzione. projects: le chiavi dei progetti (null = tutti)
function resultFor(store, feature, projects = null) {
  const where = projects ? { project: { $in: projects } } : {};
  if (MESSAGE_FEATURES.includes(feature)) {
    const c = { on: { helped: 0, ignored: 0, unclear: 0, waiting: 0 }, shadow: { helped: 0, ignored: 0, unclear: 0, waiting: 0 } };
    for (const e of store.collection('feedback').find({ ...where, feature, group: { $in: ['on', 'shadow'] } }, { fields: ['group', 'outcome'] })) {
      const g = c[e.group];
      if (e.outcome === 'helped' || e.outcome === 'ignored' || e.outcome === 'unclear') g[e.outcome]++;
      else if (e.outcome !== 'late') g.waiting++;
    }
    const n = { on: c.on.helped + c.on.ignored, shadow: c.shadow.helped + c.shadow.ignored };
    const out = { feature, kind: 'messages', counts: c, n, enough: n.on >= MIN_N && n.shadow >= MIN_N };
    if (out.enough) out.result = propDiff(c.on.helped, n.on, c.shadow.helped, n.shadow);
    return out;
  }
  if (SESSION_FEATURES.includes(feature)) {
    const groups = { on: [], shadow: [] };
    const assigned = store.collection('experiments').find({ ...where, feature }, { fields: ['sid', 'group'] });
    const sessions = store.collection('sessions');
    for (const x of assigned) {
      if (!groups[x.group]) continue;
      const s = sessions.get(x.sid);
      if (!s || !(s.actions >= MIN_ACTIONS)) continue;
      groups[x.group].push(100 * (s.errors || 0) / s.actions);
    }
    const n = { on: groups.on.length, shadow: groups.shadow.length };
    const out = { feature, kind: 'sessions', n, assigned: assigned.length, enough: n.on >= MIN_N && n.shadow >= MIN_N };
    if (out.enough) out.result = meanDiff(groups.on, groups.shadow);
    return out;
  }
  return null;
}
function results(store, projects = null) {
  return FEATURES.map(f => resultFor(store, f, projects));
}

module.exports = { groupOf, wilson, propDiff, meanDiff, resultFor, results, FEATURES, MESSAGE_FEATURES, SESSION_FEATURES, MIN_N, MIN_ACTIONS };
