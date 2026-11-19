'use strict';
// Il passaggio dei dati di prima nello store (S8 di docs/plans/2.13-storage.md).
// Fino alla 2.12 Platypus teneva tre cose in ~/.platypus:
//   bottega/<chiave>.json        il Libro della bottega di ogni progetto
//   stats.json                   le statistiche per giorno e per settimana
//   feedback/<chiave>[.1].jsonl  i messaggi agli agenti e i loro esiti
//   notify.json                  il giorno dell'ultimo report notificato
// importLegacy li legge e li scrive nello store, una volta sola:
//   - gli originali NON si toccano e NON si cancellano: una copia va in <dati>/legacy-<data>/, e i file restano
//     dove sono. Tornare alla 2.12 funziona: rilegge i suoi file, com'erano;
//   - tutto entra in una sola transazione insieme al segno "fatto" (meta `legacyImported`): se qualcosa fallisce
//     a metà non resta scritto niente e il prossimo avvio riprova;
//   - con il segno già messo non fa niente.
// I Libri erano per cartella; con `keys` (ProjectKeys) ogni cartella prende la chiave del suo repository, e la
// vecchia chiave resta come alias. Due cartelle dello stesso repository diventano un Libro solo.

const fs = require('fs');
const path = require('path');
const { fail } = require('./common');

const MARK = 'legacyImported';
const { toFieldName, mapKeys } = require('./common');
const MAX_NAME = 128, MAX_RELEASES = 200;

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const list = (dir, re) => { try { return fs.readdirSync(dir).filter(n => re.test(n)).sort(); } catch { return []; } };
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numMap = m => Object.fromEntries(Object.entries(obj(m)).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));

// il lunedì (ora locale) di una settimana ISO scritta come "2026-W47"
function weekStart(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key));
  if (!m) return 0;
  const jan4 = new Date(Number(m[1]), 0, 4);
  const monday = new Date(jan4.getFullYear(), 0, 4 - ((jan4.getDay() + 6) % 7) + (Number(m[2]) - 1) * 7);
  return monday.getTime();
}
function dayStart(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : 0;
}

// due versioni della stessa lezione (due cartelle dello stesso repository) diventano una
function mergeLesson(a, b) {
  const uniq = (x, max) => [...new Set(x)].slice(-max);
  const ev = [...(a.evidence || []), ...(b.evidence || [])].sort((x, y) => y.t - x.t);
  const seenEv = new Set();
  return {
    ...a,
    count: num(a.count) + num(b.count),
    sessions: uniq([...(a.sessions || []), ...(b.sessions || [])], 50),
    first: Math.min(num(a.first, Infinity), num(b.first, Infinity)), last: Math.max(num(a.last), num(b.last)),
    evidence: ev.filter(e => { const k = `${e.sid}|${e.t}|${e.agent}`; if (seenEv.has(k)) return false; seenEv.add(k); return true; }).slice(0, 8),
    seen: uniq([...(a.seen || []), ...(b.seen || [])], 200),
    pinned: !!(a.pinned || b.pinned), ignored: !!(a.ignored && b.ignored),
  };
}

// copia gli originali in <dati>/legacy-<data>/ (se la cartella c'è già, per un tentativo di prima, la riusa)
function copyOriginals(dataDir, when) {
  const d = new Date(when), p = n => String(n).padStart(2, '0');
  const target = path.join(dataDir, `legacy-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  let files = 0;
  for (const sub of ['bottega', 'feedback']) {
    const names = list(path.join(dataDir, sub), /\.jsonl?$/);
    if (!names.length) continue;
    fs.mkdirSync(path.join(target, sub), { recursive: true, mode: 0o700 });
    for (const n of names) { fs.copyFileSync(path.join(dataDir, sub, n), path.join(target, sub, n)); files++; }
  }
  for (const f of ['stats.json', 'notify.json']) if (fs.existsSync(path.join(dataDir, f))) { fs.copyFileSync(path.join(dataDir, f), path.join(target, f)); files++; }
  return { dir: target, files };
}

// legge i tre tipi di file e prepara i documenti; non scrive niente
async function readLegacy(dataDir, { keys = null, clock = Date.now } = {}) {
  const now = clock();
  const projects = new Map(), lessons = new Map(), alias = new Map(), skipped = { books: 0, feedback: 0, outcomes: 0 };

  // ---- i Libri
  for (const n of list(path.join(dataDir, 'bottega'), /^[0-9a-f]{16}\.json$/)) {
    const b = readJson(path.join(dataDir, 'bottega', n));
    if (!b || typeof b !== 'object') { skipped.books++; continue; }
    const oldKey = n.slice(0, 16);
    let key = oldKey, remote = null;
    if (keys && b.cwd) { try { const r = await keys.resolve(b.cwd); key = r.key; remote = r.remote; } catch {} }
    alias.set(oldKey, key);
    const p = projects.get(key) || { _id: key, name: '', aliases: {}, firstSeen: now, lastSeen: now, forgotten: {}, learned: {} };
    if (typeof b.name === 'string' && b.name && !p.name) p.name = b.name.slice(0, 200);
    if (remote) p.remote = remote;
    if (b.mute) p.mute = true;
    if (key !== oldKey) p.aliases[oldKey] = now;
    for (const [id, t] of Object.entries(numMap(b.forgotten))) p.forgotten[id] = Math.max(p.forgotten[id] || 0, t);
    for (const [id, t] of Object.entries(numMap(b.learned))) p.learned[id] = Math.max(p.learned[id] || 0, t);
    for (const l of Object.values(obj(b.lessons))) {
      if (!l || typeof l.id !== 'string' || !l.kind || !l.key) continue;
      const _id = `${key}:${l.id}`;
      const cur = lessons.get(_id);
      const one = {
        kind: String(l.kind), key: String(l.key), count: num(l.count), sessions: (l.sessions || []).map(String), first: num(l.first, now), last: num(l.last, now),
        evidence: (l.evidence || []).map(e => ({ sid: String(e.sid || ''), t: num(e.t), agent: String(e.agent || ''), excerpt: String(e.excerpt || '') })),
        seen: (l.seen || []).map(String), pinned: !!l.pinned, ignored: !!l.ignored,
      };
      const m = cur ? mergeLesson(cur, one) : one;
      lessons.set(_id, { ...m, _id, project: key, t: m.last, lesson: l.id });
      p.firstSeen = Math.min(p.firstSeen, m.first);
    }
    projects.set(key, p);
  }

  // ---- le statistiche
  const daily = [];
  const stats = readJson(path.join(dataDir, 'stats.json'));
  if (stats && typeof stats === 'object') {
    for (const [day, d] of Object.entries(obj(stats.days))) {
      const doc = { _id: `day:${day}`, t: dayStart(day), kind: 'day', day, projects: {}, releases: [], alerts: num(d && d.alerts) };
      for (const [name, v] of Object.entries(obj(d && d.projects))) {
        const o = { cost: num(v.cost), tokens: num(v.tokens), completed: num(v.completed), commits: num(v.commits), prs: num(v.prs), tests: num(v.tests), sessions: (v.sessions || []).map(String) };
        if (typeof v.wing === 'string') o.wing = v.wing;
        doc.projects[toFieldName(name, MAX_NAME)] = o;
      }
      for (const r of ((d && d.releases) || []).slice(-MAX_RELEASES)) {
        const o = { t: num(r.t), kind: String(r.kind || ''), text: String(r.text || '') };
        if (r.url) o.url = String(r.url);
        if (r.agent) o.agent = String(r.agent).slice(0, 200);
        if (r.project) o.project = String(r.project).slice(0, MAX_NAME);
        doc.releases.push(o);
      }
      daily.push(doc);
    }
    for (const [week, w] of Object.entries(obj(stats.weeks))) {
      const types = {};
      for (const [type, v] of Object.entries(obj(w))) types[toFieldName(type, MAX_NAME)] = { completed: num(v.completed), errors: num(v.errors), tools: num(v.tools), cost: num(v.cost) };
      daily.push({ _id: `week:${week}`, t: weekStart(week), kind: 'week', week, types });
    }
    for (const [sid, v] of Object.entries(obj(stats.last))) {
      const fk = m => mapKeys(numMap(m), k => toFieldName(k, MAX_NAME));
      const last = { cost: num(v.cost), tok: num(v.tok), completed: num(v.completed), cbt: fk(v.cbt), err: fk(v.err), tools: fk(v.tools), costType: fk(v.costType), rel: String(v.rel || ''), alerts: (v.alerts || []).map(String) };
      if (typeof v.name === 'string') last.name = v.name.slice(0, 200);
      daily.push({ _id: `last:${sid}`, t: num(v.t, now), kind: 'last', last });
    }
  }

  // ---- i messaggi agli agenti: una riga per messaggio, e una per l'esito quando è arrivato
  const feedback = [];
  const byKey = new Map();
  for (const n of list(path.join(dataDir, 'feedback'), /^[0-9a-f]{16}(\.1)?\.jsonl$/)) {
    const k = n.slice(0, 16);
    if (!byKey.has(k)) byKey.set(k, []);
    let text = '';
    try { text = fs.readFileSync(path.join(dataDir, 'feedback', n), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { byKey.get(k).push(JSON.parse(line)); } catch { skipped.feedback++; } }
  }
  for (const [oldKey, rows] of byKey) {
    const project = alias.get(oldKey) || (keys ? keys.canonical(oldKey) : oldKey);
    const outcomes = new Map();
    for (const r of rows) if (r && r.outcome && r.id) outcomes.set(r.id, r);
    const seen = new Set();
    for (const r of rows) {
      if (!r || !r.text || typeof r.id !== 'string' || seen.has(r.id)) continue;
      seen.add(r.id);
      const doc = { _id: r.id, project, t: num(r.t, now), text: String(r.text) };
      for (const f of ['sid', 'agent', 'name', 'feature', 'mode', 'event', 'lessonId', 'tag', 'toolUseId', 'local']) if (typeof r[f] === 'string' && r[f]) doc[f] = r[f];
      const about = {};
      for (const f of ['kind', 'cmd', 'pat', 'file']) if (r.about && typeof r.about[f] === 'string' && r.about[f]) about[f] = r.about[f];
      if (Object.keys(about).length) doc.about = about;
      const o = outcomes.get(r.id);
      if (o) { doc.outcome = String(o.outcome); doc.at = num(o.at, doc.t); if (o.why) doc.why = String(o.why); }
      feedback.push(doc);
    }
    for (const id of outcomes.keys()) if (!seen.has(id)) skipped.outcomes++; // l'esito di un messaggio che il registro aveva già lasciato andare
    if (!projects.has(project)) projects.set(project, { _id: project, name: '', aliases: project !== oldKey ? { [oldKey]: now } : {}, firstSeen: now, lastSeen: now, forgotten: {}, learned: {} });
  }
  // il giorno dell'ultimo report notificato (notify.json): così dopo l'aggiornamento non torna lo stesso giorno
  const notify = readJson(path.join(dataDir, 'notify.json'));
  const reportDay = notify && typeof notify.reportDay === 'string' ? notify.reportDay.slice(0, 40) : '';
  return { projects: [...projects.values()], lessons: [...lessons.values()], daily, feedback, skipped, reportDay };
}

// Porta nello store i dati di prima, se non è già stato fatto. Restituisce che cosa ha fatto:
//   { done: false, reason: 'already' }                         già fatto in un avvio di prima
//   { done: true, imported: { projects, lessons, daily, feedback }, skipped, legacyDir, files }
// Se fallisce lancia l'errore, senza aver scritto niente nello store: al prossimo avvio si riprova.
async function importLegacy(store, dataDir, options = {}) {
  if (typeof dataDir !== 'string' || !dataDir) fail('invalid-argument', 'importLegacy vuole la cartella dei dati');
  const clock = options.clock || Date.now;
  const before = store.getMeta(MARK);
  if (before) return { done: false, reason: 'already', at: Number(before) || 0 };
  const data = await readLegacy(dataDir, { keys: options.keys || null, clock });
  const total = data.projects.length + data.lessons.length + data.daily.length + data.feedback.length;
  // niente da portare (installazione nuova): si segna lo stesso, così non si guarda più
  const copy = total ? copyOriginals(dataDir, clock()) : { dir: null, files: 0 };
  store.transaction(() => {
    const put = (name, docs) => { const c = store.collection(name); for (const d of docs) c.put(d); };
    // un progetto può esserci già (lo scrive la chiave del progetto appena lo vede): si aggiunge, non si sostituisce
    const projects = store.collection('projects');
    for (const d of data.projects) {
      const cur = projects.get(d._id);
      projects.put(cur ? { ...cur, ...d, name: d.name || cur.name || '', aliases: { ...cur.aliases, ...d.aliases }, firstSeen: Math.min(cur.firstSeen || d.firstSeen, d.firstSeen), lastSeen: Math.max(cur.lastSeen || 0, d.lastSeen) } : d);
    }
    put('lessons', data.lessons);
    put('daily', data.daily);
    put('feedback', data.feedback);
    if (data.reportDay && !store.getMeta('notifyReportDay')) store.setMeta('notifyReportDay', data.reportDay);
    store.setMeta(MARK, String(clock()));
  });
  return { done: true, imported: { projects: data.projects.length, lessons: data.lessons.length, daily: data.daily.length, feedback: data.feedback.length }, skipped: data.skipped, legacyDir: copy.dir, files: copy.files };
}

module.exports = { importLegacy, readLegacy, copyOriginals, mergeLesson, weekStart, dayStart, MARK };
