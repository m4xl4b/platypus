#!/usr/bin/env node
'use strict';
// Misure dello store su disco (S3 di docs/plans/2.13-storage.md), con dati finti: quanti passi al secondo
// entrano, quanto ci vuole a cercare quelli di un progetto negli ultimi 30 giorni su un milione, quanto pesa
// il database. Scrive solo in una cartella temporanea sua, che alla fine toglie.
//   node scripts/store-bench.js                 un milione di passi (circa un minuto)
//   node scripts/store-bench.js --n 200000      meno passi
//   node scripts/store-bench.js --backend memory --n 100000
//   node scripts/store-bench.js --check         esce con 1 se un obiettivo non è raggiunto
//   node scripts/store-bench.js --json          i numeri in JSON
// Obiettivi: almeno 1000 passi al secondo in ingresso; i 100 passi più recenti di un progetto negli ultimi
// 30 giorni in meno di 50 ms.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const N = Math.max(1000, parseInt(opt('n', '1000000'), 10) || 1000000);
const BACKEND = opt('backend', 'sqlite');
const DAY = 86400000, DAYS = 90, PROJECTS = 20;
const TARGET_INGEST = 1000, TARGET_FIND_MS = 50, TARGET_HISTORY_MS = 200;

// numeri a caso ma sempre gli stessi: due giri danno gli stessi dati
let seed = 20261119;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const ms = t => Number(process.hrtime.bigint() - t) / 1e6;
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const projects = Array.from({ length: PROJECTS }, (_, i) => crypto.createHash('sha1').update('progetto-' + i).digest('hex'));
const ACTIONS = ['read', 'edit', 'run', 'search', 'write', 'plan'], TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Task'];
const OUTCOMES = ['ok', 'ok', 'ok', 'ok', 'error', 'denied'], PHASES = ['explore', 'build', 'test', 'fix'];
const ERRORS = ['TS2345: Argument of type # is not assignable', 'ENOENT: no such file #', 'AssertionError: expected # to equal #', 'exit code 1: npm test'];
const DIRS = ['src/core', 'src/ui', 'renderer', 'scripts', 'docs', 'test/unit', 'packages/api/src/handlers'];
function step(t) {
  const outcome = pick(OUTCOMES);
  const doc = {
    project: pick(projects), t,
    session: 'sess-' + Math.floor(rnd() * 4000).toString(16).padStart(8, '0'),
    agent: rnd() < 0.7 ? 'main' : 'sub-' + Math.floor(rnd() * 6),
    action: pick(ACTIONS), tool: pick(TOOLS),
    target: `${pick(DIRS)}/file-${Math.floor(rnd() * 400)}.js`,
    outcome, phase: pick(PHASES),
  };
  if (outcome === 'error') doc.err = pick(ERRORS);
  return doc;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-bench-'));
let now = Date.now();
const END = now, START = END - DAYS * DAY;
const store = openStore({ backend: BACKEND, dir: tmp, clock: () => now });
const out = { backend: BACKEND, node: process.versions.node, platform: `${process.platform} ${process.arch}`, cpu: String((os.cpus()[0] || {}).model || '?').trim(), steps: N, projects: PROJECTS, days: DAYS };
try {
  store.declare('steps', { indexes: [['project', 't'], ['session', 't']], retention: { days: 90 } });
  const steps = store.collection('steps');

  // ---------------------------------------------------------- ingresso: come nel motore, append con la coda
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { now = START + Math.floor((i / N) * DAYS * DAY); steps.append(step(now)); }
  store.flush();
  out.ingestMs = ms(t0);
  out.ingestPerSecond = Math.round(N / (out.ingestMs / 1000));
  now = END;

  // ---------------------------------------------------------- ricerche: un progetto, ultimi 30 giorni
  const since = END - 30 * DAY;
  const time = (fn, rounds) => { const all = []; let last; for (let r = 0; r < rounds; r++) { const s = process.hrtime.bigint(); last = fn(projects[r % PROJECTS]); all.push(ms(s)); } return { median: median(all), max: Math.max(...all), last }; };
  const recent = time(p => steps.find({ project: p, t: { $gte: since } }, { sort: { t: -1 }, limit: 100 }).length, 40);
  const count = time(p => steps.count({ project: p, t: { $gte: since } }), 20);
  const errors = time(p => steps.find({ project: p, t: { $gte: since }, outcome: 'error' }, { sort: { t: -1 }, limit: 100 }).length, 20);
  const fields = time(p => steps.find({ project: p, t: { $gte: since } }, { fields: ['t', 'outcome'] }).length, 5);
  const all = time(p => steps.find({ project: p, t: { $gte: since } }).length, 5);
  const session = time(() => steps.find({ session: 'sess-000007d0' }, { sort: { t: 1 } }).length, 20);
  Object.assign(out, {
    findRecent100Ms: recent.median, findRecent100MaxMs: recent.max, countMs: count.median, matching: count.last,
    findErrors100Ms: errors.median, findAllMs: all.median, findAllFieldsMs: fields.median, findSessionMs: session.median, sessionSteps: session.last,
  });

  // ---------------------------------------------------------- la ricerca nell'archivio (S12b): un file in un progetto
  {
    const { searchSteps } = require(path.join(ROOT, 'src', 'core', 'search'));
    const times = [], found = [], partial = [];
    for (const [i, name] of ['file-123.js', 'file-7.js', 'file-399.js'].entries()) {
      const s = process.hrtime.bigint();
      const r = searchSteps(store, { projects: [projects[i * 5]], file: name, limit: 50 });
      times.push(ms(s)); found.push(r.results.length); partial.push(r.partial);
    }
    out.searchMs = median(times); out.searchMaxMs = Math.max(...times); out.searchFound = found; out.searchPartial = partial.some(Boolean);
  }

  // ---------------------------------------------------------- lo storico nel tempo (S12): sei mesi di riassunti delle sessioni
  // 20 progetti, 15 sessioni a settimana ciascuno: tutte le metriche, per un progetto e per tutti, per settimana
  {
    const HQ = require(path.join(ROOT, 'src', 'core', 'history-query'));
    store.declare('sessions', { indexes: [['project', 't']] });
    const S = store.collection('sessions'), WEEK = 7 * DAY;
    let i = 0;
    for (let w = 0; w < 26; w++) store.transaction(() => { for (let p = 0; p < PROJECTS; p++) for (let k = 0; k < 15; k++) S.put({ _id: 'b' + (i++), project: projects[p], t: END - w * WEEK - k * 3600000, loops: k % 3, stuck: k % 2, surprises: k, flaky: 0, claims: 1, stale: 0, lessons: 0, errors: k, actions: 40, cost: 0.2 }); });
    out.historySessions = i;
    const run = proj => { const s = process.hrtime.bigint(); const all = HQ.queryAll(store, { projects: proj, from: END - 26 * WEEK, to: END + 1, bucket: 'week' }); for (const m of Object.keys(all)) HQ.trend(all[m], END); return ms(s); };
    out.historyProjectMs = median([run([projects[3]]), run([projects[7]]), run([projects[11]])]);
    out.historyAllMs = median([run(null), run(null), run(null)]);
  }

  // ---------------------------------------------------------- peso, e quanto ci mette a riaprirsi
  const info = store.info();
  store.close();
  if (info.file) {
    // all'avvio lo store controlla il file (PRAGMA quick_check) e la versione dello schema: il motore aspetta questo tempo
    const r0 = process.hrtime.bigint();
    const again = openStore({ backend: BACKEND, dir: tmp });
    out.reopenMs = ms(r0);
    again.close();
  }
  if (info.file) {
    out.sizeBytes = fs.statSync(info.file).size;
    out.bytesPerStep = Math.round(out.sizeBytes / N);
    out.mbPerMillion = Math.round(out.sizeBytes / N * 1e6 / 1048576);
  }
} finally {
  try { store.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

out.ingestOk = out.ingestPerSecond >= TARGET_INGEST;
out.findOk = out.findRecent100Ms < TARGET_FIND_MS;
out.historyOk = out.historyProjectMs < TARGET_HISTORY_MS && out.historyAllMs < TARGET_HISTORY_MS && out.searchMaxMs < TARGET_HISTORY_MS;
if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  const f = x => (x < 10 ? x.toFixed(2) : x.toFixed(0));
  console.log(`store-bench · backend ${out.backend} · ${out.steps.toLocaleString('en')} passi, ${PROJECTS} progetti, ${DAYS} giorni · Node ${out.node} · ${out.platform} · ${out.cpu}`);
  console.log(`  ingresso (append con la coda)              ${out.ingestPerSecond.toLocaleString('en')} passi/s   (obiettivo: almeno ${TARGET_INGEST})  ${out.ingestOk ? 'ok' : 'NON RAGGIUNTO'}`);
  console.log(`  un progetto, ultimi 30 giorni: ${out.matching.toLocaleString('en')} passi`);
  console.log(`    i 100 più recenti                        ${f(out.findRecent100Ms)} ms mediana, ${f(out.findRecent100MaxMs)} ms massimo   (obiettivo: meno di ${TARGET_FIND_MS} ms)  ${out.findOk ? 'ok' : 'NON RAGGIUNTO'}`);
  console.log(`    i 100 errori più recenti                 ${f(out.findErrors100Ms)} ms`);
  console.log(`    contarli                                 ${f(out.countMs)} ms`);
  console.log(`    leggerli tutti, solo t e outcome         ${f(out.findAllFieldsMs)} ms`);
  console.log(`    leggerli tutti, interi                   ${f(out.findAllMs)} ms`);
  console.log(`  i passi di una sessione (${out.sessionSteps})               ${f(out.findSessionMs)} ms`);
  console.log(`  ricerca di un file in un progetto            ${f(out.searchMs)} ms mediana, ${f(out.searchMaxMs)} ms massimo (${out.searchFound.join(', ')} risultati${out.searchPartial ? ', parziale' : ''})   (obiettivo: meno di ${TARGET_HISTORY_MS} ms)  ${out.searchMaxMs < TARGET_HISTORY_MS ? 'ok' : 'NON RAGGIUNTO'}`);
  console.log(`  storico, sei mesi (${out.historySessions} sessioni), tutte le metriche: un progetto ${f(out.historyProjectMs)} ms, tutti ${f(out.historyAllMs)} ms   (obiettivo: meno di ${TARGET_HISTORY_MS} ms)  ${out.historyOk ? 'ok' : 'NON RAGGIUNTO'}`);
  if (out.reopenMs !== undefined) console.log(`  riaprirlo (controllo del file all'avvio)    ${f(out.reopenMs)} ms`);
  if (out.sizeBytes) console.log(`  peso del database                          ${(out.sizeBytes / 1048576).toFixed(0)} MB, ${out.bytesPerStep} byte a passo, ${out.mbPerMillion} MB per milione di passi`);
}
if (args.includes('--check') && !(out.ingestOk && out.findOk && out.historyOk)) process.exit(1);
