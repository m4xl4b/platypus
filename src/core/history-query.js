'use strict';
// Lo storico nel tempo (S12 di docs/plans/2.13-storage.md): come vanno le cose, settimana per settimana o giorno per
// giorno, per un progetto o per tutti. Si legge dai riassunti delle sessioni (uno per sessione: pochi documenti anche
// su mesi) e, per il feedback, dai messaggi agli agenti. Mai dai passi uno per uno.
//
// query(store, { projects, metric, from, to, bucket }) -> { metric, bucket, from, to, buckets: [...] }
//   per una metrica delle sessioni ogni secchio è { start, sessions, sum, perSession }
//   per 'feedback' ogni secchio è { start, on, shadow, judgedOn, helpedOn, judgedShadow, helpedShadow }
// trend(buckets) -> la lettura in una frase: le ultime 4 settimane contro le 4 prima, per sessione, con il numero di
// sessioni dietro; "dati insufficienti" sotto MIN_SESSIONS per parte.

const DAY = 86400000;
// le metriche: per sessione (dai riassunti), e il feedback (dai messaggi). "più è basso, meglio è" per tutte tranne lessons
const SESSION_METRICS = ['loops', 'stuck', 'surprises', 'flaky', 'claims', 'stale', 'lessons', 'errors', 'actions', 'cost'];
const METRICS = [...SESSION_METRICS, 'feedback'];
const LOWER_IS_BETTER = new Set(['loops', 'stuck', 'surprises', 'flaky', 'claims', 'stale', 'errors']);
const MIN_SESSIONS = 5;   // per ognuna delle due parti del confronto
const WINDOW_WEEKS = 4;
const MAX_RANGE = 2 * 366 * DAY;

// l'inizio del secchio di un istante (ora locale): mezzanotte, o il lunedì della settimana
function bucketStart(t, bucket) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  if (bucket === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
// N giorni dopo (o prima) sul calendario: con l'ora legale un giorno non è sempre 24 ore
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
function nextBucket(t, bucket) {
  const d = new Date(t);
  d.setDate(d.getDate() + (bucket === 'week' ? 7 : 1));
  return d.getTime();
}

function check({ metric, bucket, from, to }) {
  if (!METRICS.includes(metric)) throw Object.assign(new Error(`metrica sconosciuta: ${metric}`), { code: 'bad-metric' });
  if (bucket !== 'day' && bucket !== 'week') throw Object.assign(new Error('bucket: day o week'), { code: 'bad-bucket' });
  if (!(Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= MAX_RANGE)) throw Object.assign(new Error('intervallo non valido (al massimo due anni)'), { code: 'bad-range' });
}

function query(store, { projects = null, metric, from, to, bucket = 'week' }) {
  check({ metric, bucket, from, to });
  // tutti i secchi dell'intervallo, anche quelli vuoti: una settimana senza sessioni è un'informazione
  const buckets = new Map();
  for (let b = bucketStart(from, bucket); b < to; b = nextBucket(b, bucket)) buckets.set(b, null);
  const where = { t: { $gte: from, $lt: to }, ...(projects ? { project: { $in: projects } } : {}) };
  if (metric === 'feedback') {
    const empty = () => ({ on: 0, shadow: 0, judgedOn: 0, helpedOn: 0, judgedShadow: 0, helpedShadow: 0 });
    for (const [b] of buckets) buckets.set(b, empty());
    for (const e of store.collection('feedback').find(where, { fields: ['t', 'mode', 'outcome'] })) {
      const x = buckets.get(bucketStart(e.t, bucket));
      if (!x || e.outcome === 'late') continue;
      const on = e.mode === 'on';
      x[on ? 'on' : 'shadow']++;
      if (e.outcome === 'helped' || e.outcome === 'ignored') { x[on ? 'judgedOn' : 'judgedShadow']++; if (e.outcome === 'helped') x[on ? 'helpedOn' : 'helpedShadow']++; }
    }
    return { metric, bucket, from, to, buckets: [...buckets].map(([start, x]) => ({ start, ...x })) };
  }
  for (const [b] of buckets) buckets.set(b, { sessions: 0, sum: 0, counted: 0 });
  for (const s of store.collection('sessions').find(where, { fields: ['t', metric] })) {
    const x = buckets.get(bucketStart(s.t, bucket));
    if (!x) continue;
    x.sessions++;
    // una sessione scritta prima dei conteggi (S12) non ha il valore: conta tra le sessioni, non nella media
    if (Number.isFinite(s[metric])) { x.sum += s[metric]; x.counted++; }
  }
  return {
    metric, bucket, from, to,
    buckets: [...buckets].map(([start, x]) => ({ start, sessions: x.sessions, counted: x.counted, sum: x.sum, perSession: x.counted ? x.sum / x.counted : null })),
  };
}

// Tutte le metriche delle sessioni in una lettura sola (le sessioni si leggono una volta, non una per metrica):
// { metrica: risultato come query() }. È quello che usano il Libro e la rotta con metric=all.
function queryAll(store, { projects = null, from, to, bucket = 'week', metrics = SESSION_METRICS }) {
  for (const m of metrics) if (!SESSION_METRICS.includes(m)) throw Object.assign(new Error(`metrica sconosciuta: ${m}`), { code: 'bad-metric' });
  check({ metric: metrics[0] || 'loops', bucket, from, to });
  const starts = [];
  for (let b = bucketStart(from, bucket); b < to; b = nextBucket(b, bucket)) starts.push(b);
  const index = new Map(starts.map((b, i) => [b, i]));
  const acc = Object.fromEntries(metrics.map(m => [m, starts.map(() => ({ sessions: 0, sum: 0, counted: 0 }))]));
  const where = { t: { $gte: from, $lt: to }, ...(projects ? { project: { $in: projects } } : {}) };
  for (const s of store.collection('sessions').find(where, { fields: ['t', ...metrics] })) {
    const i = index.get(bucketStart(s.t, bucket));
    if (i === undefined) continue;
    for (const m of metrics) { const x = acc[m][i]; x.sessions++; if (Number.isFinite(s[m])) { x.sum += s[m]; x.counted++; } }
  }
  return Object.fromEntries(metrics.map(m => [m, { metric: m, bucket, from, to,
    buckets: starts.map((start, i) => { const x = acc[m][i]; return { start, sessions: x.sessions, counted: x.counted, sum: x.sum, perSession: x.counted ? x.sum / x.counted : null }; }) }]));
}

// La lettura: le ultime WINDOW_WEEKS settimane contro le WINDOW_WEEKS prima, per sessione.
//   { verdict: 'fewer' | 'more' | 'same' | 'not-enough', recent: { sessions, perSession }, before: { sessions, perSession }, better }
// "same" quando la differenza è sotto il 15% e sotto 0,1 per sessione: meglio dire "più o meno uguale" che inventare una tendenza.
function trend(result, now = Date.now()) {
  const w = result.buckets.filter(b => b.counted !== undefined);
  // le ultime WINDOW_WEEKS settimane, compresa quella in corso, e le WINDOW_WEEKS prima (anche con secchi giornalieri)
  const recentFrom = addDays(bucketStart(now, 'week'), -7 * (WINDOW_WEEKS - 1)), beforeFrom = addDays(recentFrom, -7 * WINDOW_WEEKS);
  const part = (lo, hi) => {
    const xs = w.filter(b => b.start >= lo && b.start < hi);
    const sessions = xs.reduce((a, b) => a + b.counted, 0), sum = xs.reduce((a, b) => a + b.sum, 0);
    return { sessions, perSession: sessions ? sum / sessions : null };
  };
  const recent = part(recentFrom, now + 1), before = part(beforeFrom, recentFrom);
  if (recent.sessions < MIN_SESSIONS || before.sessions < MIN_SESSIONS) return { verdict: 'not-enough', recent, before, min: MIN_SESSIONS };
  const d = recent.perSession - before.perSession, rel = before.perSession ? Math.abs(d) / before.perSession : Math.abs(d);
  const verdict = Math.abs(d) < 0.1 || rel < 0.15 ? 'same' : d < 0 ? 'fewer' : 'more';
  const better = verdict === 'same' ? null : LOWER_IS_BETTER.has(result.metric) ? verdict === 'fewer' : result.metric === 'lessons' ? verdict === 'more' : null;
  return { verdict, recent, before, better };
}

// La riga di tendenza del report giornaliero: alcune metriche, tutti i progetti, al momento `at` (la fine del giorno del
// report). { metrics: { metrica: trend }, recent, before } con le sessioni delle due parti
const REPORT_METRICS = ['loops', 'stuck', 'surprises', 'claims'];
function reportTrend(store, at) {
  const from = addDays(bucketStart(at, 'week'), -7 * (2 * WINDOW_WEEKS - 1));
  const all = queryAll(store, { from, to: at + 1, bucket: 'week', metrics: REPORT_METRICS });
  const metrics = Object.fromEntries(REPORT_METRICS.map(m => [m, trend(all[m], at)]));
  const t = metrics.loops;
  return { metrics, recent: t.recent.sessions, before: t.before.sessions, min: MIN_SESSIONS };
}

module.exports = { query, queryAll, trend, reportTrend, REPORT_METRICS, bucketStart, addDays, METRICS, SESSION_METRICS, LOWER_IS_BETTER, MIN_SESSIONS, WINDOW_WEEKS, DAY };
