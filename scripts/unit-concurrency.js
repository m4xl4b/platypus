#!/usr/bin/env node
'use strict';
// Prove di concorrenza e di crash dello storico (S13 di docs/plans/2.13-storage.md), con processi veri:
//   - due processi che scrivono 2000 documenti ciascuno sullo stesso database: niente perso, niente doppio, nessun errore;
//   - un processo che tiene il database occupato più a lungo dell'attesa di SQLite: la coda del motore non perde niente;
//   - un processo ucciso a metà di una transazione grande: riaprendo, il file è integro e ha i dati di prima;
//   - due motori (modalità browser) su porte diverse con la stessa cartella dei dati: tutti e due funzionano.
// Le richiama smoke-test.js; si possono lanciare anche da sole. Tutto in cartelle temporanee.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// un processo Node con del codice; risolve con { code, out } quando esce
function child(code, args = [], { env = process.env, onLine = null } = {}) {
  const c = spawn(process.execPath, ['-e', code, ROOT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', d => { out += d; if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.trim(), c); });
  c.stderr.on('data', d => { out += d; });
  const done = new Promise(res => c.on('exit', code => res({ code, out })));
  return { proc: c, done };
}
const get = (port, p, method = 'GET', body) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } }, res => {
    let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } });
  });
  req.on('error', () => resolve({ status: 0, json: null }));
  if (body) req.write(body);
  req.end();
});

const WRITER = `
const path = require('path');
const [root, dir, who, n] = process.argv.slice(1);
const { openStore } = require(path.join(root, 'src/core/store'));
const { declareCollections } = require(path.join(root, 'src/core/store/collections'));
const errors = [];
const store = declareCollections(openStore({ backend: 'sqlite', dir, requireFields: true, guard: 'reject', onError: e => errors.push(String(e.message)) }));
const steps = store.collection('steps'), sessions = store.collection('sessions');
(async () => {
  for (let i = 0; i < Number(n); i++) {
    try {
      if (i % 3 === 0) steps.append({ _id: who + '-a' + i, project: 'p', t: i, session: who, action: 'read', tool: 'Read', outcome: 'ok' });
      else if (i % 3 === 1) sessions.put({ _id: who + '-s' + i, project: 'p', t: i, actions: i });
      else store.transaction(() => { steps.put({ _id: who + '-t' + i, project: 'p', t: i, session: who, action: 'edit', tool: 'Edit', outcome: 'ok' }); sessions.patch(who + '-s' + (i - 1), { errors: 1 }); });
    } catch (e) { errors.push(e.code + ': ' + e.message); }
    if (i % 100 === 0) await new Promise(r => setImmediate(r));
  }
  try { store.close(); } catch (e) { errors.push('close: ' + e.message); }
  process.stdout.write(JSON.stringify({ who, errors: errors.slice(0, 3), nErrors: errors.length }) + '\\n');
})();`;

async function run(ok) {
  console.log('storico: concorrenza e crash');
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { declareCollections } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
  const { History } = require(path.join(ROOT, 'src', 'core', 'history'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-concorrenza-'));
  const kids = [];
  try {
    // ---------------------------------------------------------- due processi, 2000 documenti ciascuno
    const d1 = path.join(tmp, 'due');
    declareCollections(openStore({ backend: 'sqlite', dir: d1 })).close(); // il database e le tabelle, prima dei due
    const ws = ['A', 'B'].map(w => child(WRITER, [d1, w, '2000']));
    const res = await Promise.all(ws.map(w => w.done));
    const rep = res.map(r => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { return { nErrors: -1, raw: r.out.slice(0, 200) }; } });
    const st = declareCollections(openStore({ backend: 'sqlite', dir: d1 }));
    const ids = st.collection('steps').find({}, { fields: [] }).map(x => x._id);
    const ss = st.collection('sessions').find({}, { fields: ['errors'] });
    const integ = st.driver.db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join();
    st.close();
    ok(res.every(r => r.code === 0) && rep.every(r => r.nErrors === 0) && ids.length === 2666 && new Set(ids).size === 2666 && ss.length === 1334 && ss.filter(x => x.errors === 1).length === 1332 && integ === 'ok',
      `due processi, 2000 documenti ciascuno sullo stesso database: ${ids.length} passi e ${ss.length} sessioni come attesi, nessun doppione, nessun errore, file integro` + (rep.some(r => r.nErrors) ? ' ' + JSON.stringify(rep) : ''));

    // ---------------------------------------------------------- il database occupato più a lungo dell'attesa di SQLite
    const d2 = path.join(tmp, 'occupato');
    const h = new History({ dir: d2, backend: 'sqlite', log() {} });
    h.keys.exec = async () => null;
    const holder = child(`
      const path = require('path'); const [root, dir] = process.argv.slice(1);
      const { DatabaseSync } = require(path.join(root, 'src/core/store/sqlite-load')).loadSqlite();
      const db = new DatabaseSync(path.join(dir, 'platypus.db'));
      db.exec('BEGIN IMMEDIATE'); process.stdout.write('held\\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); process.stdout.write('released\\n'); }, 4500);`, [d2]);
    kids.push(holder.proc);
    for (let i = 0; i < 50 && !/held/.test(await Promise.race([sleep(100).then(() => ''), new Promise(r => holder.proc.stdout.once('data', d => r(String(d))))])); i++);
    const sess = { id: 'sess-occupata', cwd: path.join(tmp, 'progetto'), demo: false };
    for (let i = 0; i < 30; i++) h.recordStep(sess, { id: 'main' }, { id: 'u' + i, t: 1000 + i, tool: 'Read', act: 'read', target: 'src/a' + i + '.js', sig: 'Read', err: false, dur: 1, phase: '' });
    const first = h.flush(); // il database è occupato: la coda resta
    const kept = h.pending.size, busy = h.busy || 0;
    await holder.done;
    const second = h.flush();
    const saved = h.store.collection('steps').count({ session: 'sess-occupata' });
    h.stop();
    ok(first === 0 && kept === 30 && busy >= 1 && second === 30 && saved === 30, `database occupato da un altro processo per 4,5 s: la coda non perde niente (${kept} passi tenuti, poi ${saved} scritti)`);

    // ---------------------------------------------------------- ucciso a metà di una transazione grande
    const d3 = path.join(tmp, 'crash');
    const crash = child(`
      const fs = require('fs'), path = require('path'); const [root, dir] = process.argv.slice(1);
      const { openStore } = require(path.join(root, 'src/core/store'));
      const { declareCollections } = require(path.join(root, 'src/core/store/collections'));
      const store = declareCollections(openStore({ backend: 'sqlite', dir }));
      const s = store.collection('sessions');
      for (let i = 0; i < 100; i++) s.put({ _id: 'prima' + i, project: 'p', t: i, actions: i });
      fs.writeSync(1, 'start\\n');
      store.transaction(() => { for (let i = 0; i < 400000; i++) s.put({ _id: 'dentro' + i, project: 'p', t: i, actions: i }); });
      fs.writeSync(1, 'finished\\n');`, [d3]);
    kids.push(crash.proc);
    // aspetta il segnale, poi lascia lavorare la transazione e uccide il processo
    const waitStart = new Promise(r => { let o = ''; crash.proc.stdout.on('data', d => { o += d; if (/start/.test(o)) r(true); }); setTimeout(() => r(false), 20000); });
    const sawStart = await waitStart;
    await sleep(400);
    crash.proc.kill('SIGKILL');
    const ended = await crash.done;
    const reopened = declareCollections(openStore({ backend: 'sqlite', dir: d3 }));
    const integ3 = reopened.driver.db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join();
    const n3 = reopened.collection('sessions').count({}), inside = reopened.collection('sessions').count({ _id: { $gte: 'dentro', $lt: 'dentrp' } });
    reopened.close();
    ok(sawStart && !/finished/.test(ended.out) && integ3 === 'ok' && n3 === 100 && inside === 0, `processo ucciso a metà di una transazione da 400.000 documenti: il file è integro e ha i ${n3} documenti di prima, niente di quella transazione`);

    // ---------------------------------------------------------- due motori sulla stessa cartella dei dati
    const home = path.join(tmp, 'casa'), data = path.join(tmp, 'dati-comuni');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ embedEngine: 'tfidf' }));
    const env = port => ({ ...process.env, PLATYPUS_PORT: String(port), PLATYPUS_DATA_DIR: data, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
    const pA = 47950 + Math.floor(Math.random() * 20), pB = pA + 30;
    const engines = [pA, pB].map(p => { const e = spawn(process.execPath, [path.join(ROOT, 'src', 'standalone.js'), '--no-open', '--no-cowork'], { env: env(p), stdio: ['ignore', 'pipe', 'pipe'] }); kids.push(e); let out = ''; e.stdout.on('data', d => { out += d; }); e.stderr.on('data', d => { out += d; }); return { e, port: p, out: () => out }; });
    let up = [];
    for (let i = 0; i < 80; i++) { up = await Promise.all(engines.map(x => get(x.port, '/api/store'))); if (up.every(r => r.status === 200)) break; await sleep(200); }
    // tutti e due scrivono, e uno compatta mentre l'altro applica la conservazione
    const [c1, c2] = await Promise.all([get(pA, '/api/store', 'POST', JSON.stringify({ action: 'compact' })), get(pB, '/api/store', 'POST', JSON.stringify({ action: 'retention' }))]);
    await Promise.all([get(pA, '/api/settings', 'POST', JSON.stringify({ storeKeepSteps: 60 })), get(pB, '/api/history?metric=all')]);
    const after = await Promise.all(engines.map(x => get(x.port, '/api/store')));
    for (const x of engines) x.e.kill();
    await sleep(500);
    const logs = engines.map(x => x.out()).join('\n');
    ok(up.every(r => r.json && r.json.backend === 'sqlite' && r.json.notice === '') && c1.json && c1.json.ok && c2.json && c2.json.ok && after.every(r => r.status === 200 && r.json.backend === 'sqlite') && !/locked|SQLITE_BUSY|errore|Error/.test(logs),
      'due motori su porte diverse con la stessa cartella dei dati: tutti e due aprono lo storico, scrivono, compattano e applicano la conservazione senza errori' + (/locked|SQLITE_BUSY|Error/.test(logs) ? ': ' + logs.slice(0, 300) : ''));

    // ---------------------------------------------------------- il primo avvio della 2.13 su una cartella della 2.12
    // (trovato migrando i dati veri: l'import arrivava dopo che statistiche e Libri erano partiti, e al primo avvio
    // l'ufficio mostrava costi, onori, report e Libri vuoti)
    {
      const old = path.join(tmp, 'dati-212'), proj = path.join(tmp, 'progetto.vecchio');
      fs.mkdirSync(proj, { recursive: true });
      fs.mkdirSync(old, { recursive: true });
      fs.writeFileSync(path.join(old, 'settings.json'), JSON.stringify({ embedEngine: 'tfidf' }));
      const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      fs.writeFileSync(path.join(old, 'stats.json'), JSON.stringify({ days: { [today]: { projects: { 'progetto.vecchio': { cost: 4.25, tokens: 1000, sessions: ['s-vecchia'], completed: 3, commits: 1, prs: 0, tests: 0, wing: 'code' } }, releases: [{ t: Date.now() - 60000, kind: 'commit', text: 'una release', project: 'progetto.vecchio' }], alerts: 1 } }, weeks: {}, last: {} }));
      const { FileBottega } = require(path.join(ROOT, 'scripts', 'legacy-212'));
      const bot = new FileBottega(path.join(old, 'bottega'));
      bot.learn(proj, [{ kind: 'flaky-command', key: 'npm run e2e', sid: 's-vecchia', t: Date.now() - 3600000, agent: 'Claude', excerpt: 'FAIL e2e' }]);
      bot.stop();
      const pC = 47990 + Math.floor(Math.random() * 9);
      const e = spawn(process.execPath, [path.join(ROOT, 'src', 'standalone.js'), '--no-open', '--no-cowork'], { env: { ...env(pC), PLATYPUS_DATA_DIR: old }, stdio: ['ignore', 'pipe', 'pipe'] });
      kids.push(e);
      let costs = null, book = null, report = null;
      for (let i = 0; i < 60; i++) {
        const c = await get(pC, '/api/stats/costs?days=3');
        const day = c.json && c.json.find && c.json.find(x => x.day === today);
        if (day && day.projects['progetto.vecchio']) { costs = day; break; }
        await sleep(250);
      }
      book = (await get(pC, '/api/bottega?cwd=' + encodeURIComponent(proj))).json;
      report = (await get(pC, '/api/report')).json;
      e.kill();
      ok(costs && costs.projects['progetto.vecchio'] === 4.25 && book && book.lessons && book.lessons.length === 1 && report && report.releases && report.releases.length === 1,
        `primo avvio su una cartella della 2.12: costi, report e Libro mostrano subito i dati di prima (${costs ? costs.projects['progetto.vecchio'] + ' $' : 'nessun costo'}, ${book && book.lessons ? book.lessons.length : 0} lezione, ${report && report.releases ? report.releases.length : 0} release)`);
    }
  } finally {
    for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

module.exports = { run };
if (require.main === module) {
  require('./test-guard').requireTempDataDir('unit-concurrency');
  let failed = 0;
  run((c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failed++; })
    .then(() => { console.log(failed ? `\n${failed} prove fallite.` : '\nTutto a posto.'); process.exit(failed ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
