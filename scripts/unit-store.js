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

// S4: versione dello schema, copie prima delle migrazioni, e cosa succede quando il database non si apre
async function failureTests(ok) {
  console.log('store: schema, copie e guasti');
  const crypto = require('crypto');
  const { openStore, openStoreSafe, fallbackReason } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { MIGRATIONS, backups } = require(path.join(ROOT, 'src', 'core', 'store', 'migrations'));
  const { withLang } = require(path.join(ROOT, 'src', 'i18n'));
  const { DatabaseSync } = require(path.join(ROOT, 'src', 'core', 'store', 'sqlite-load')).loadSqlite();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-guasti-'));
  const open = [];
  const keep = s => { open.push(s); return s; };
  const raw = (file, fn) => { const db = new DatabaseSync(file); try { return fn(db); } finally { db.close(); } };
  const code = fn => { try { fn(); } catch (e) { return e.code; } return null; };
  const version = file => raw(file, db => db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get().value);
  const names = dir => fs.readdirSync(dir).sort().join(' ');
  try {
    // ---------------------------------------------------------- versione e migrazioni
    const d1 = path.join(tmp, 'schema'), f1 = path.join(d1, 'platypus.db');
    let s = keep(openStore({ backend: 'sqlite', dir: d1 }));
    s.declare('things', {});
    for (let i = 0; i < 50; i++) s.collection('things').put({ _id: 'k' + i, n: i });
    ok(s.info().schemaVersion === MIGRATIONS.length && MIGRATIONS.length >= 1 && names(d1).startsWith('platypus.db') && !names(d1).includes('bak') && !names(d1).includes('broken'), 'un database nuovo nasce alla versione corrente dello schema, senza copie');
    s.close();
    const m2 = { version: MIGRATIONS.length + 1, name: 'finta', up(db) { db.exec('CREATE TABLE extra (x TEXT)'); db.prepare('INSERT INTO extra VALUES (?)').run('fatta'); } };
    s = keep(openStore({ backend: 'sqlite', dir: d1, migrations: [...MIGRATIONS, m2] }));
    s.declare('things', {});
    const bak1 = `${f1}.bak-${MIGRATIONS.length}`;
    ok(s.info().schemaVersion === m2.version && s.driver.migration.from === MIGRATIONS.length && s.driver.migration.backup === bak1 && s.driver.db.prepare('SELECT x FROM extra').get().x === 'fatta' && s.collection('things').count({}) === 50,
      'una migrazione finta: lo schema sale di versione e i dati restano');
    ok(fs.existsSync(bak1) && version(bak1) === String(MIGRATIONS.length) && raw(bak1, db => db.prepare('SELECT COUNT(*) AS n FROM c_things').get().n) === 50 && raw(bak1, db => !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'extra'").get()),
      'prima della migrazione c\'è una copia del database com\'era (platypus.db.bak-<versione>)');
    s.close();
    s = keep(openStore({ backend: 'sqlite', dir: d1, migrations: [...MIGRATIONS, m2] }));
    ok(s.driver.migration.backup === null && backups(f1).length === 1, 'riaprire alla stessa versione non rifà né la migrazione né la copia');
    s.close();
    // una migrazione che fallisce a metà
    const bad = { version: m2.version + 1, name: 'rotta', up(db) { db.exec('CREATE TABLE half (x TEXT)'); db.exec('DELETE FROM c_things'); throw new Error('a metà'); } };
    ok(code(() => openStore({ backend: 'sqlite', dir: d1, migrations: [...MIGRATIONS, m2, bad] })) === 'migration-failed', 'una migrazione che fallisce: openStore lo dice (migration-failed)');
    const fb = keep(openStoreSafe({ backend: 'sqlite', dir: d1, migrations: [...MIGRATIONS, m2, bad] }));
    fb.declare('things', {});
    fb.collection('things').put({ _id: 'in-memoria' });
    ok(fb.backend === 'memory' && fb.fallback.code === 'migration-failed' && fb.fallback.brokenFile === null && fb.info().fallback.code === 'migration-failed' && fb.collection('things').count({}) === 1,
      'openStoreSafe in quel caso ripiega sulla memoria, e lo store funziona');
    ok(version(f1) === String(m2.version) && raw(f1, db => db.prepare('SELECT COUNT(*) AS n FROM c_things').get().n) === 50 && raw(f1, db => !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get()) && fs.existsSync(f1),
      'la migrazione fallita non lascia niente a metà: versione, tabelle e dati sono quelli di prima');
    // altre due migrazioni buone: restano le ultime due copie
    const m3 = { version: m2.version + 1, name: 'terza', up() {} }, m4 = { version: m2.version + 2, name: 'quarta', up() {} };
    keep(openStore({ backend: 'sqlite', dir: d1, migrations: [...MIGRATIONS, m2, m3] })).close();
    await sleep(30);
    keep(openStore({ backend: 'sqlite', dir: d1, migrations: [...MIGRATIONS, m2, m3, m4] })).close();
    ok(backups(f1).map(b => b.version).join(',') === `${m3.version},${m2.version}` && !fs.existsSync(bak1) && version(f1) === String(m4.version), 'delle copie si tengono le ultime due');
    // un database più nuovo di questo Platypus non si tocca
    const before = fs.statSync(f1).size;
    ok(code(() => openStore({ backend: 'sqlite', dir: d1 })) === 'newer-schema', 'un database di una versione più nuova: openStore lo dice (newer-schema)');
    const nw = keep(openStoreSafe({ backend: 'sqlite', dir: d1 }));
    ok(nw.backend === 'memory' && nw.fallback.code === 'newer-schema' && fs.existsSync(f1) && fs.statSync(f1).size === before && version(f1) === String(m4.version) && !fs.readdirSync(d1).some(n => n.includes('broken')),
      'openStoreSafe ripiega sulla memoria e lascia il database com\'è');

    // ---------------------------------------------------------- un file rovinato
    const d2 = path.join(tmp, 'rovinato'), f2 = path.join(d2, 'platypus.db');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(f2, crypto.randomBytes(20000));
    ok(code(() => openStore({ backend: 'sqlite', dir: d2 })) === 'corrupt' && fs.existsSync(f2), 'un file che non è un database: openStore lo dice (corrupt) e non tocca niente');
    const when = new Date(2026, 10, 19, 9, 5, 7).getTime();
    const c = keep(openStoreSafe({ backend: 'sqlite', dir: d2, clock: () => when }));
    c.declare('things', {});
    c.collection('things').put({ _id: 'a', v: 1 });
    ok(c.backend === 'memory' && c.fallback.code === 'corrupt' && c.fallback.wanted === 'sqlite' && path.basename(c.fallback.brokenFile) === 'platypus.db.broken-20261119-090507' && fs.existsSync(c.fallback.brokenFile) &&
      fs.statSync(c.fallback.brokenFile).size === 20000 && !fs.existsSync(f2) && c.collection('things').get('a').v === 1,
      'openStoreSafe lo mette da parte come platypus.db.broken-<data> e continua in memoria: niente si ferma');
    const it = fallbackReason(c.fallback), en = withLang('en', () => fallbackReason(c.fallback));
    ok(it === 'storico non disponibile: il database era rovinato: l\'ho messo da parte come platypus.db.broken-20261119-090507' && en === 'history not available: the database was damaged: I set it aside as platypus.db.broken-20261119-090507' &&
      fallbackReason(null) === '' && withLang('en', () => fallbackReason(nw.fallback)) === 'history not available: the database was written by a newer Platypus than this one',
      'il motivo per l\'avviso nell\'ufficio, in italiano e in inglese');
    const fresh = keep(openStoreSafe({ backend: 'sqlite', dir: d2 }));
    fresh.declare('things', {});
    ok(fresh.backend === 'sqlite' && fresh.fallback === null && fresh.info().fallback === null && fresh.collection('things').count({}) === 0 && fs.existsSync(c.fallback.brokenFile), 'all\'avvio dopo si riparte con un database nuovo; quello rovinato resta da parte');
    fresh.close();
    // rovinato in mezzo: l'intestazione è buona, le pagine no
    const d3 = path.join(tmp, 'pagine'), f3 = path.join(d3, 'platypus.db');
    s = keep(openStore({ backend: 'sqlite', dir: d3 }));
    s.declare('things', { indexes: ['n'] });
    s.transaction(() => { for (let i = 0; i < 4000; i++) s.collection('things').put({ _id: 'k' + String(i).padStart(5, '0'), n: i, pad: 'x'.repeat(100) }); });
    s.close();
    const fd = fs.openSync(f3, 'r+');
    const size = fs.statSync(f3).size;
    for (let off = 4096; off + 4096 <= size; off += 8192) fs.writeSync(fd, crypto.randomBytes(4096), 0, 4096, off);
    fs.closeSync(fd);
    const pg = keep(openStoreSafe({ backend: 'sqlite', dir: d3 }));
    ok(size > 400000 && pg.backend === 'memory' && pg.fallback.code === 'corrupt' && pg.fallback.brokenFile && fs.existsSync(pg.fallback.brokenFile) && !fs.existsSync(f3), 'pagine rovinate in mezzo al file: quick_check se ne accorge all\'avvio, stesso ripiego');

    // ---------------------------------------------------------- non si apre o non si scrive
    const notDir = path.join(tmp, 'un-file.txt');
    fs.writeFileSync(notDir, 'non sono una cartella');
    const u = keep(openStoreSafe({ backend: 'sqlite', dir: path.join(notDir, 'dati') }));
    u.declare('things', {});
    ok(code(() => openStore({ backend: 'sqlite', dir: path.join(notDir, 'dati') })) === 'unopenable' && u.backend === 'memory' && u.fallback.code === 'unopenable' && u.fallback.brokenFile === null && u.collection('things').put({ v: 1 }).v === 1 &&
      fs.readFileSync(notDir, 'utf8') === 'non sono una cartella', 'una cartella dei dati che non si può creare: ripiego sulla memoria, niente si ferma');
    const d4 = path.join(tmp, 'sola-lettura'), f4 = path.join(d4, 'platypus.db');
    s = keep(openStore({ backend: 'sqlite', dir: d4 }));
    s.declare('things', {});
    s.collection('things').put({ _id: 'prima', v: 1 });
    s.close();
    const root = typeof process.getuid === 'function' && process.getuid() === 0; // root scrive anche dove non si può
    fs.chmodSync(f4, 0o444);
    if (process.platform !== 'win32') fs.chmodSync(d4, 0o555);
    try {
      if (root) console.log('  --   sola lettura: le prove girano come root, controllo saltato');
      else {
        const ro = keep(openStoreSafe({ backend: 'sqlite', dir: d4 }));
        ro.declare('things', {});
        ok(ro.backend === 'memory' && ro.fallback.code === 'unopenable' && ro.fallback.brokenFile === null && fs.existsSync(f4) && !fs.readdirSync(d4).some(n => n.includes('broken')) && ro.collection('things').put({ v: 2 }).v === 2,
          'un database di sola lettura: ripiego sulla memoria, il file resta dov\'è');
      }
    } finally {
      if (process.platform !== 'win32') fs.chmodSync(d4, 0o755);
      fs.chmodSync(f4, 0o644);
    }
    const back = keep(openStoreSafe({ backend: 'sqlite', dir: d4 }));
    back.declare('things', {});
    ok(back.backend === 'sqlite' && back.fallback === null && back.collection('things').get('prima').v === 1, 'tornato scrivibile, il database si riapre con i suoi dati');
    ok(code(() => openStoreSafe({ backend: 'non-esiste' })) === 'unknown-backend' && code(() => openStoreSafe({ backend: 'sqlite' })) === 'invalid-argument' && openStoreSafe({}).fallback === null,
      'gli errori di chi scrive il codice (backend sconosciuto, cartella mancante) restano errori');
  } finally {
    for (const s of open) { try { s.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { run: async ok => { await run(ok); await failureTests(ok); } };
if (require.main === module) {
  let failed = 0;
  module.exports.run((c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failed++; })
    .then(() => { console.log(failed ? `\n${failed} prove fallite.` : '\nTutto a posto.'); process.exit(failed ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
