'use strict';
// Conservazione e dimensione dello storico (S10 di docs/plans/2.13-storage.md).
// All'avvio e ogni 6 ore:
//   1. per ogni collezione con un tempo di conservazione (collections.js, o quello scelto nelle opzioni) si tolgono
//      i documenti più vecchi. Le lezioni del Libro solo se sono deboli (sotto la soglia di peso) e non fissate:
//      una lezione forte resta finché è forte;
//   2. se lo storico supera il limite di dimensione (200 MB di base), si tolgono i passi più vecchi finché ci sta.
//      Lo spazio liberato lo riusa il database; il file si restringe solo con "Compatta" (VACUUM).
// Sempre a piccoli blocchi, uno per transazione, lasciando lavorare il resto tra un blocco e l'altro: mai un'attesa
// lunga per l'ufficio. Quello che è successo resta nel segno `retentionLast` (JSON), che le opzioni mostrano.

const { weightOf, LESSON_WEIGHT } = require('./bottega');
const { retentionOf, defaultRetention } = require('./store/collections');

const DAY = 86400000;
const BATCH = 500;
const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 200;
// le opzioni: i giorni di conservazione per collezione (0 = per sempre) e il limite in MB (0 = nessun limite)
const SETTINGS = { storeKeepSteps: 'steps', storeKeepSessions: 'sessions', storeKeepFeedback: 'feedback', storeKeepLessons: 'lessons' };

// dalle opzioni ai giorni per collezione: { steps: 90, sessions: 365, … } (experiments segue feedback)
function retentionFromSettings(settings = {}) {
  const out = {};
  for (const [k, coll] of Object.entries(SETTINGS)) {
    const v = settings[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n >= 0) out[coll] = Math.min(n, 3650);
  }
  if ('feedback' in out) out.experiments = out.feedback;
  return out;
}
function maxBytes(settings = {}) {
  const v = settings.storeMaxMB;
  const n = v === undefined || v === null || v === '' ? DEFAULT_MAX_MB : Number(v);
  return Number.isFinite(n) && n > 0 ? n * MB : 0;
}

const tick = () => new Promise(r => setImmediate(r));

// toglie a blocchi i documenti che corrispondono al filtro, dai più vecchi; restituisce quanti
async function deleteOld(store, name, filter) {
  const c = store.collection(name);
  let removed = 0;
  for (;;) {
    const rows = c.find(filter, { sort: { t: 1 }, limit: BATCH, fields: [] });
    if (!rows.length) break;
    store.transaction(() => { for (const d of rows) c.delete(d._id); });
    removed += rows.length;
    if (rows.length < BATCH) break;
    await tick();
  }
  return removed;
}

// i passi più vecchi, finché lo storico sta sotto il limite
async function trimForSize(store, limit) {
  const used = () => { const d = store.driver; return d && typeof d.usedBytes === 'function' ? d.usedBytes() : null; };
  let removed = 0, now = used();
  if (!limit || now === null || now <= limit) return { removed, usedBytes: now };
  const steps = store.collection('steps');
  for (let round = 0; round < 10000 && now > limit; round++) {
    const rows = steps.find({}, { sort: { t: 1 }, limit: BATCH * 4, fields: [] });
    if (!rows.length) break;
    store.transaction(() => { for (const d of rows) steps.delete(d._id); });
    removed += rows.length;
    now = used();
    await tick();
  }
  return { removed, usedBytes: now };
}

// Applica conservazione e limite. bottega: il Libro del motore (le lezioni che ha in memoria vanno tolte anche lì,
// altrimenti il prossimo salvataggio le riporterebbe). Restituisce quello che ha fatto.
async function runRetention({ store, bottega = null, settings = {}, now = Date.now() } = {}) {
  if (!store || store.closed) return null;
  if (store.fallback) return null; // in memoria non c'è niente da tenere a bada
  const overrides = retentionFromSettings(settings);
  const removed = {};
  for (const name of Object.keys(defaultRetention())) {
    const r = retentionOf(name, overrides);
    if (!r || !r.days) continue;
    const cutoff = now - r.days * DAY;
    if (name === 'lessons') {
      // solo le deboli e non fissate; anche dal Libro in memoria
      const weak = d => !d.pinned && weightOf({ count: d.count || 0, sessions: d.sessions || [], last: d.last || d.t || 0, pinned: false }, now) < LESSON_WEIGHT;
      const gone = [];
      const c = store.collection('lessons');
      for (const d of c.find({ t: { $lt: cutoff } }, { sort: { t: 1 } })) if (weak(d)) gone.push(d);
      for (let i = 0; i < gone.length; i += BATCH) {
        const part = gone.slice(i, i + BATCH);
        store.transaction(() => { for (const d of part) c.delete(d._id); });
        await tick();
      }
      if (bottega && gone.length) bottega.dropLessons(gone.map(d => ({ project: d.project, id: d.lesson })));
      removed.lessons = gone.length;
      continue;
    }
    removed[name] = await deleteOld(store, name, { t: { $lt: cutoff } });
  }
  const size = await trimForSize(store, maxBytes(settings));
  const result = { at: now, removed, trimmedForSize: size.removed, usedBytes: size.usedBytes, limitBytes: maxBytes(settings) };
  try { store.setMeta('retentionLast', JSON.stringify(result)); } catch {}
  return result;
}

module.exports = { runRetention, retentionFromSettings, maxBytes, trimForSize, SETTINGS, DEFAULT_MAX_MB, LESSON_WEIGHT };
