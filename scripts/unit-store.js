#!/usr/bin/env node
'use strict';
// Prove del backend sqlite dello store (src/core/store/sqlite.js, S3 di docs/plans/2.13-storage.md): quello che
// le prove di conformità non guardano perché vale solo per lui. Il file, le opzioni di SQLite, le tabelle, gli
// indici, la coda di scrittura, i valori mai dentro il testo dell'SQL.
// Le richiama smoke-test.js; si possono lanciare anche da sole. Scrivono solo in una cartella temporanea loro.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(ok) {
  console.log('store: backend sqlite');
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { loadSqlite } = require(path.join(ROOT, 'src', 'core', 'store', 'sqlite-load'));
  const { FLUSH_MS, FLUSH_DOCS } = require(path.join(ROOT, 'src', 'core', 'store', 'sqlite'));
  const { DatabaseSync } = loadSqlite();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-sqlite-'));
  const open = [];
  const store = (dir, extra) => { const s = openStore({ backend: 'sqlite', dir, ...extra }); open.push(s); return s; };
  // un'altra connessione allo stesso file: vede solo quello che è davvero su disco
  const raw = (dir, fn) => { const db = new DatabaseSync(path.join(dir, 'platypus.db')); try { return fn(db); } finally { db.close(); } };
  try {
    // ---------------------------------------------------------- file, opzioni, tabelle
    const d1 = path.join(tmp, 'uno', 'dati');
    const s = store(d1);
    const db = s.driver.db, pragma = n => Object.values(db.prepare(`PRAGMA ${n}`).get())[0];
    ok(fs.existsSync(path.join(d1, 'platypus.db')) && s.info().file === path.join(d1, 'platypus.db') && s.info().persistent === true && s.info().sizeBytes > 0, 'il database è platypus.db nella cartella indicata (creata se manca)');
    ok(pragma('journal_mode') === 'wal' && pragma('synchronous') === 1 && pragma('busy_timeout') === 3000 && pragma('foreign_keys') === 1, 'SQLite: journal_mode=WAL, synchronous=NORMAL, busy_timeout=3000, foreign_keys=ON');
    ok(FLUSH_MS === 2000 && FLUSH_DOCS === 500, 'coda di scrittura: al massimo 2 s o 500 documenti');
    s.declare('steps', { indexes: [['project', 't'], 'action', 'meta.phase'] });
    const steps = s.collection('steps');
    steps.put({ _id: 'x1', project: 'chiave-progetto', t: 1234, action: 'edit', meta: { phase: 'build' } });
    const cols = db.prepare('PRAGMA table_info(c_steps)').all().map(c => `${c.name} ${c.type}${c.pk ? ' pk' : ''}`).join(', ');
    const rawRow = db.prepare('SELECT * FROM c_steps').get();
    ok(cols === '_id TEXT pk, project TEXT, t INTEGER, doc TEXT' && rawRow._id === 'x1' && rawRow.project === 'chiave-progetto' && rawRow.t === 1234 && rawRow.doc === '{"action":"edit","meta":{"phase":"build"}}',
      'una tabella per collezione: _id, project, t e il documento in JSON, che non ripete quei tre');

    // ---------------------------------------------------------- indici
    const indexes = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'c_steps' AND name LIKE 'ix%'").all();
    const ix = indexes();
    ok(ix.length === 3 && ix.some(i => /\(project, t\)/.test(i.sql)) && ix.some(i => i.sql.includes(`json_extract(doc,'$."action"')`)) && ix.some(i => i.sql.includes(`json_extract(doc,'$."meta"."phase"')`)),
      'gli indici dichiarati: sulle colonne per project e t, su json_extract per gli altri campi');
    const plan = (filter, opts) => {
      const before = new Set(s.driver.stmts.keys());
      steps.find(filter, opts);
      const sql = [...s.driver.stmts.keys()].find(k => !before.has(k) && k.startsWith('SELECT _id, project, t, doc'));
      return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(sql.match(/\?/g) || []).map(() => 0)).map(r => r.detail).join(' | ');
    };
    const p1 = plan({ project: 'chiave-progetto', t: { $gte: 1000 } }, { sort: { t: -1 }, limit: 10 }), p2 = plan({ action: 'edit' }), p3 = plan({ 'meta.phase': { $in: ['build', 'test'] } });
    ok(/USING INDEX ix_steps_/.test(p1) && /project=\? AND t>\?/.test(p1) && !/USE TEMP B-TREE FOR ORDER BY/.test(p1), 'cercare per progetto e tempo, i più recenti per primi: usa l\'indice, senza ordinare tutto');
    ok(/USING INDEX ix_steps_/.test(p2) && /USING INDEX ix_steps_/.test(p3), 'cercare per un campo indicizzato del documento (uguaglianza, $in): usa l\'indice');
    s.declare('steps', { indexes: [['project', 't']] });
    ok(indexes().length === 1 && steps.get('x1').action === 'edit', 'dichiarare di nuovo con meno indici toglie quelli che non servono più, non i dati');
    ok((() => { try { s.declare('bad', { indexes: ['a"); DROP TABLE c_steps; --'] }); } catch (e) { return e.code === 'invalid-argument'; } return false; })() && steps.count({}) === 1, 'un indice su un nome di campo strano è rifiutato');

    // ---------------------------------------------------------- i valori non entrano mai nel testo dell'SQL
    const SECRET = 'VALORE-SEGRETO-9f3a', FIELD = 'campo \' strano "x"';
    steps.put({ _id: 'x2', project: SECRET, t: 5, action: SECRET, [FIELD]: SECRET, n: 42.5 });
    steps.find({ project: SECRET, action: { $in: [SECRET, 'altro'] }, n: { $gt: 41.25 }, $or: [{ 'meta.phase': SECRET }, { t: { $lt: 77123 } }] }, { sort: { action: 1 }, limit: 3, skip: 0 });
    steps.count({ action: SECRET }); steps.get(SECRET); steps.patch('x2', { action: SECRET + '2' }); steps.find({ [FIELD]: SECRET });
    const sqls = [...s.driver.stmts.keys()].join('\n');
    ok(!sqls.includes(SECRET) && !sqls.includes('41.25') && !sqls.includes('77123') && !sqls.includes('strano') && steps.find({ [FIELD]: SECRET }).length === 1,
      'nessun valore (e nessun nome di campo strano) nel testo delle istruzioni SQL: solo parametri');
    steps.put({ _id: 'x3', [FIELD]: 'altro', n: 1 });
    ok(steps.count({ [FIELD]: SECRET }) === 1 && steps.find({ [FIELD]: { $exists: true } }, { sort: { [FIELD]: -1 }, limit: 1 })[0]._id === 'x3' && steps.deleteMany({ [FIELD]: SECRET }) === 1 && steps.get('x2') === null && steps.count({}) === 2,
      'un nome di campo che non può stare nell\'SQL: filtro, ordinamento e deleteMany funzionano lo stesso');

    // ---------------------------------------------------------- coda di scrittura
    const d2 = path.join(tmp, 'due');
    const q = store(d2, { flushMs: 80, flushDocs: 50 });
    q.declare('log', {});
    const log = q.collection('log');
    const onDisk = () => raw(d2, x => x.prepare('SELECT COUNT(*) AS n FROM c_log').get().n);
    const first = [];
    for (let i = 0; i < 10; i++) first.push(log.append({ t: i, i }));
    const waiting = onDisk();
    ok(waiting === 0 && log.count({}) === 10 && log.get(first[3]).i === 3 && onDisk() === 10, 'append resta in coda (niente su disco); la prima lettura la svuota e vede tutto');
    for (let i = 0; i < 10; i++) log.append({ t: 100 + i });
    const still = onDisk();
    await sleep(400);
    ok(still === 10 && onDisk() === 20, 'senza letture la coda va su disco da sola dopo il tempo stabilito');
    for (let i = 0; i < 49; i++) log.append({ t: 200 + i });
    const at49 = onDisk();
    log.append({ t: 249 });
    ok(at49 === 20 && onDisk() === 70, 'la coda va su disco appena raggiunge il numero massimo di documenti');
    const dup = log.append({ _id: 'fisso', t: 300 });
    let dupErr = null;
    try { log.append({ _id: 'fisso', t: 301 }); } catch (e) { dupErr = e; }
    ok(dup === 'fisso' && dupErr && dupErr.code === 'duplicate-id' && log.count({ _id: 'fisso' }) === 1 && log.get('fisso').t === 300, 'append con un _id che è ancora in coda: un errore subito, e la riga in coda resta buona');
    log.append({ t: 400 }); log.append({ t: 401 });
    let txErr = null;
    try { q.transaction(() => { log.append({ t: 500 }); throw new Error('annulla'); }); } catch (e) { txErr = e; }
    ok(txErr && log.count({ t: { $gte: 400 } }) === 2, 'una transazione annullata toglie i suoi append, non quelli che erano in coda prima');
    log.append({ t: 600 }); log.append({ t: 601 }); log.append({ t: 602 });
    const beforeClose = onDisk();
    q.close();
    ok(beforeClose === 73 && onDisk() === 76, 'alla chiusura la coda va su disco');

    // ---------------------------------------------------------- si riapre e i dati ci sono
    const again = store(d2);
    again.declare('log', {});
    ok(again.collection('log').count({}) === 76 && again.collection('log').get('fisso').t === 300 && again.collection('log').find({}, { sort: { t: -1 }, limit: 1 })[0].t === 602, 'riaprendo lo store i dati ci sono ancora');
    const d3 = path.join(tmp, 'tre');
    const a = store(d3), b = store(d3);
    a.declare('k', {}); b.declare('k', {});
    a.collection('k').put({ _id: 'da-a', v: 1 }); b.collection('k').put({ _id: 'da-b', v: 2 });
    ok(a.collection('k').count({}) === 2 && b.collection('k').get('da-a').v === 1, 'due store aperti sulla stessa cartella vedono gli stessi dati');
  } finally {
    for (const s of open) { try { s.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { run };
if (require.main === module) {
  let failed = 0;
  run((c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failed++; })
    .then(() => { console.log(failed ? `\n${failed} prove fallite.` : '\nTutto a posto.'); process.exit(failed ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
