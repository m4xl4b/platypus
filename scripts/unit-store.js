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
    // un database grande si controlla dopo, in un thread a parte: qui "grande" è tutto (checkLimit 1)
    {
      const { History } = require(path.join(ROOT, 'src', 'core', 'history'));
      const dirH = path.join(tmp, 'grande'), fH = path.join(dirH, 'platypus.db'), hlog = [];
      const mkH = () => new History({ dir: dirH, backend: 'sqlite', checkLimit: 1, log: m => hlog.push(m) });
      let h = mkH();
      h.store.transaction(() => { for (let i = 0; i < 4000; i++) h.store.collection('steps').put({ _id: 's:' + i, project: 'p', t: i, session: 's', action: 'read', tool: 'Read', outcome: 'ok', target: 'src/a' + i + '.js' }); });
      const later = h.store.driver.checkLater;
      await h.start();
      ok(later === true && h.check && h.check.ok === true && h.notice() === '' && h.imported && h.imported.done === true, 'un database grande non si controlla all\'apertura ma subito dopo, in un thread a parte: sano, nessun avviso');
      h.stop();
      // rovinato verso la fine: si apre, e il controllo in background se ne accorge
      const size = fs.statSync(fH).size, fd = fs.openSync(fH, 'r+');
      for (let off = Math.floor(size * 0.6 / 4096) * 4096; off + 4096 <= size; off += 8192) fs.writeSync(fd, crypto.randomBytes(4096), 0, 4096, off);
      fs.closeSync(fd);
      h = mkH();
      const opened = h.store.backend;
      await h.start();
      const bad = h.check, notice = h.notice();
      h.stop();
      h = mkH();
      const third = h.store.backend, aside = fs.readdirSync(dirH).filter(n => n.startsWith('platypus.db.broken-'));
      h.stop();
      ok(size > 400000 && opened === 'sqlite' && bad && bad.ok === false && bad.detail.length <= 320 && notice === 'storico non disponibile: il database è rovinato' && hlog.some(m => /al prossimo avvio lo metto da parte/.test(m)) &&
        third === 'memory' && aside.length === 1, 'rovinato verso la fine: il controllo in background lo trova e l\'ufficio lo dice; all\'avvio dopo il controllo si fa subito e il file viene messo da parte');
    }
    ok(code(() => openStoreSafe({ backend: 'non-esiste' })) === 'unknown-backend' && code(() => openStoreSafe({ backend: 'sqlite' })) === 'invalid-argument' && openStoreSafe({}).fallback === null,
      'gli errori di chi scrive il codice (backend sconosciuto, cartella mancante) restano errori');
  } finally {
    for (const s of open) { try { s.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S5: la chiave del progetto dal remote di git, gli alias, e niente credenziali nello store
async function projectKeyTests(ok) {
  console.log('store: chiave del progetto');
  const { spawnSync } = require('child_process');
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const PK = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const bottega = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const { normalizeRemote, keyFor, pathKey, ProjectKeys } = PK;
  const TOKEN = 'ghp_S3GRETO9f3aXyZ', USER = 'utente-segreto';
  // lo stesso repository scritto in tanti modi
  const same = [
    'https://github.com/m4xl4b/platypus.git', 'https://github.com/m4xl4b/platypus', 'https://github.com/m4xl4b/platypus/', 'https://github.com/m4xl4b/platypus.git/',
    'git@github.com:m4xl4b/platypus.git', 'git@github.com:m4xl4b/platypus', 'github.com:m4xl4b/platypus.git', 'ssh://git@github.com/m4xl4b/platypus.git', 'ssh://git@GitHub.com:22/m4xl4b/platypus',
    `https://${USER}:${TOKEN}@github.com/m4xl4b/platypus.git`, `https://${TOKEN}@GITHUB.COM/m4xl4b/platypus`, `https://oauth2:${TOKEN}@github.com:443/m4xl4b/platypus.git?x=${TOKEN}#${TOKEN}`,
    'git+https://github.com/m4xl4b/platypus.git', 'git://github.com/m4xl4b/platypus.git', 'http://github.com:8080/m4xl4b/platypus.git', '  https://github.com/m4xl4b/platypus.git\n'.trim(), `${USER}@github.com:/m4xl4b/platypus.git`,
  ];
  const norms = same.map(normalizeRemote);
  ok(norms.every(n => n === 'github.com/m4xl4b/platypus'), `lo stesso repository scritto in ${same.length} modi (https, ssh, con token, con porta, con .git) dà lo stesso indirizzo` + (norms.every(n => n === 'github.com/m4xl4b/platypus') ? '' : ': ' + JSON.stringify(same.filter((u, i) => norms[i] !== 'github.com/m4xl4b/platypus').map(u => [u, normalizeRemote(u)]))));
  ok(new Set(same.map(u => keyFor('/x', u).key)).size === 1 && /^[0-9a-f]{16}$/.test(keyFor('/x', same[0]).key), 'e quindi la stessa chiave: 16 caratteri esadecimali');
  ok(normalizeRemote('https://gitlab.com/Gruppo/Sotto/Repo.git') === 'gitlab.com/Gruppo/Sotto/Repo' && normalizeRemote('git@GitLab.com:Gruppo/Sotto/Repo.git') === 'gitlab.com/Gruppo/Sotto/Repo' &&
    normalizeRemote('ssh://git@[::1]:2222/r.git') === '[::1]/r' && normalizeRemote('deploy@host.example:percorso/al/repo.git') === 'host.example/percorso/al/repo' &&
    keyFor('/x', 'https://github.com/m4xl4b/platypus').key !== keyFor('/x', 'https://github.com/m4xl4b/altro').key,
    'l\'host va in minuscolo, il percorso resta com\'è; repository diversi, chiavi diverse');
  const local = ['', null, undefined, '/srv/git/repo.git', './repo', '../repo.git', '~/repo', 'C:\\repos\\x.git', 'c:/repos/x', 'D:\\', 'file:///srv/git/repo.git', '\\\\server\\share\\repo.git', 'https://', 'non un indirizzo', 'https://github.com/', 'a\nb@host:x'];
  ok(local.every(u => normalizeRemote(u) === null), 'una cartella, file://, un disco di Windows, un testo qualsiasi: non sono un remote in rete');
  ok(same.concat(['https://a:b@h.example/x', `ssh://${USER}:${TOKEN}@h.example:2222/x.git`]).map(normalizeRemote).every(n => n && !n.includes(TOKEN) && !n.includes(USER) && !n.includes('@') && !n.includes('?')), 'nell\'indirizzo normalizzato non restano utente, password o token');

  // senza remote: la chiave della cartella, la stessa di sempre
  const winA = 'C:\\Dev\\Mio Progetto\\', winB = 'c:/dev/mio progetto', posix = '/home/max/Progetto';
  ok(pathKey(winA) === pathKey(winB) && keyFor(winA, null).key === bottega.projectKey(winA) && keyFor(posix, '').key === bottega.projectKey(posix) && keyFor(posix, '/srv/git/x.git').key === bottega.projectKey(posix) &&
    keyFor(posix, null).remote === null && keyFor(posix, null).aliases.length === 0 && pathKey(posix) !== pathKey(posix + '/sub'),
    'senza remote la chiave è quella della cartella, uguale a quella che usava il Libro (percorsi di Windows: barre e maiuscole non contano)');
  const kf = keyFor(winA, same[9]);
  ok(kf.remote === 'github.com/m4xl4b/platypus' && kf.aliases.length === 1 && kf.aliases[0] === bottega.projectKey(winA) && kf.key !== kf.aliases[0], 'con un remote la vecchia chiave della cartella diventa un alias');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-chiave-'));
  const open = [];
  try {
    // ---------------------------------------------------------- nello store: mai credenziali, mai il percorso
    for (const backend of ['memory', 'sqlite']) {
      const dir = path.join(tmp, backend);
      const store = openStore({ backend, dir });
      open.push(store);
      store.declare('projects', { projectField: '_id' });
      let calls = 0, now = 1000;
      const remotes = { [PK.normDir(winA)]: same[9], [PK.normDir('C:\\Altro\\Clone')]: 'git@github.com:m4xl4b/platypus.git', [PK.normDir(posix)]: null };
      const exec = async (cwd, args) => { calls++; if (args.join(' ') !== 'remote get-url origin') throw new Error('comando inatteso'); return remotes[PK.normDir(cwd)] || null; };
      const keys = new ProjectKeys({ store, exec, clock: () => now });
      const early = keys.keyNow(winA);
      const info = await keys.resolve(winA);
      const [i2, i3] = await Promise.all([keys.resolve(winB), keys.resolve(winA)]);
      ok(early === bottega.projectKey(winA) && info.key === keyFor(winA, same[9]).key && keys.keyNow(winA) === info.key && i2 === info && i3 === info && calls === 1,
        `${backend}: keyNow risponde subito con la chiave della cartella; poi vale quella del repository, e git si legge una volta sola`);
      now = 2000;
      const clone = await keys.resolve('C:\\Altro\\Clone');
      const doc = store.collection('projects').get(info.key);
      ok(clone.key === info.key && doc.remote === 'github.com/m4xl4b/platypus' && doc.name === 'Clone' && store.collection('projects').count({}) === 1, `${backend}: due cartelle dello stesso repository sono lo stesso progetto`);
      ok(doc.firstSeen === 1000 && doc.lastSeen === 2000 && Object.keys(doc.aliases).sort().join() === [bottega.projectKey(winA), bottega.projectKey('C:\\Altro\\Clone')].sort().join() &&
        keys.canonical(bottega.projectKey(winA)) === info.key && new ProjectKeys({ store }).canonical(bottega.projectKey('C:\\Altro\\Clone')) === info.key && keys.canonical('0123456789abcdef') === '0123456789abcdef' &&
        keys.allKeys(bottega.projectKey(winA)).sort().join() === [info.key, ...Object.keys(doc.aliases)].sort().join(),
        `${backend}: gli alias restano nello store, e da una vecchia chiave si arriva a quella del progetto (anche dopo un riavvio)`);
      const plain = await keys.resolve(posix);
      const pdoc = store.collection('projects').get(plain.key);
      ok(plain.key === bottega.projectKey(posix) && plain.remote === null && pdoc.name === 'Progetto' && !('remote' in pdoc) && Object.keys(pdoc.aliases).length === 0 && store.collection('projects').count({}) === 2,
        `${backend}: un progetto senza remote tiene la chiave della cartella`);
      const failing = new ProjectKeys({ store, exec: async () => { throw new Error('git non c\'è'); } });
      ok((await failing.resolve('/qualche/cartella')).key === pathKey('/qualche/cartella') && new ProjectKeys({ exec: async () => same[0] }).keyNow('/senza/store') === pathKey('/senza/store'), `${backend}: se git non risponde, o senza store, la chiave c'è lo stesso`);
      const everything = JSON.stringify(store.collection('projects').find({}));
      store.close();
      let rawBytes = '';
      if (backend === 'sqlite') for (const f of fs.readdirSync(dir)) rawBytes += fs.readFileSync(path.join(dir, f)).toString('latin1');
      const leaks = [TOKEN, USER, 'Dev\\Mio', 'dev/mio', 'Altro\\Clone', 'altro/clone', '/home/max', 'qualche/cartella'].filter(x => everything.includes(x) || rawBytes.includes(x));
      ok(leaks.length === 0 && (backend !== 'sqlite' || rawBytes.includes('github.com/m4xl4b/platypus')), `${backend}: nello store${backend === 'sqlite' ? ' (anche leggendo il file così com\'è)' : ''} non ci sono token, utenti né percorsi delle cartelle` + (leaks.length ? ': ' + leaks.join(', ') : ''));
    }

    // ---------------------------------------------------------- con git vero
    const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
    if (!hasGit) console.log('  --   git non c\'è: prova con un repository vero saltata');
    else {
      const repo = path.join(tmp, 'Repo Vero'), sub = path.join(repo, 'src', 'dentro'), noRepo = path.join(tmp, 'senza-git');
      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(noRepo, { recursive: true });
      const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', windowsHide: true });
      git('init', '-q');
      const keys = new ProjectKeys();
      const before = await new ProjectKeys().resolve(repo);
      git('remote', 'add', 'origin', `https://${USER}:${TOKEN}@github.com/m4xl4b/platypus.git`);
      const t0 = Date.now();
      const [r, r2, none] = await Promise.all([keys.resolve(repo), keys.resolve(sub), keys.resolve(noRepo)]);
      ok(before.remote === null && before.key === pathKey(repo) && r.remote === 'github.com/m4xl4b/platypus' && r.key === keyFor('/x', same[0]).key && r2.key === r.key && r.name === 'Repo Vero' &&
        none.remote === null && none.key === pathKey(noRepo) && !JSON.stringify([r, r2]).includes(TOKEN) && Date.now() - t0 < 10000,
        'con git vero: un repository con il token nel remote e una sua sottocartella hanno la stessa chiave, senza token; una cartella senza git ha la sua');
    }
  } finally {
    for (const s of open) { try { s.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S6: la guardia della privacy. Filtro dei segreti, percorsi, e cosa resta davvero scritto nel file del database
async function privacyTests(ok) {
  console.log('store: privacy');
  const { openStore, relPath, scrub, excerpt } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { ibanOk } = require(path.join(ROOT, 'src', 'core', 'store', 'privacy'));

  // ---------------------------------------------------------- filtro dei segreti
  const SECRETS = {
    'token di GitHub': 'ghp_abcdefghijklmnopqrstuvwxyz012345', 'token fine di GitHub': 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz', 'chiave Anthropic': 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    'chiave OpenAI': 'sk-proj-AbCdEfGhIjKlMnOpQrSt', 'chiave AWS': 'AKIAIOSFODNN7EXAMPLE', 'chiave Google': 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q', 'token Slack': 'xoxb-123456789012-abcdefghijkl', 'token GitLab': 'glpat-AbCdEfGhIjKlMnOpQrSt',
    'token npm': 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'chiave Stripe': 'sk_' + 'live_AbCdEfGhIjKlMnOpQrStUvWx', 'JWT': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'sequenza lunga': 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9vX2',
  };
  const lines = [
    ...Object.values(SECRETS).map(v => `prima ${v} dopo`),
    'export DB_PASSWORD=hunter2-molto-segreta', 'password: "frase con spazi segreta"', 'curl -H "Authorization: Bearer abcDEF123456.xyz" https://api.example.org/v1', 'mysql --password hunter2segreta -u root',
    'app --api-key=XYZ-123-segreta --verbose', 'Server=db;User Id=sa;Password=Sup3rSegreta;Database=x', 'postgres://admin:hunter2segreta@db.internal:5432/app', 'mongodb+srv://utente:paroladordine@cluster0.example.net/test',
    'https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/x/y.git', 'scrivi a mario.rossi@example.com oppure a Luigi.Verdi+test@posta.example.co.uk', 'bonifico su IT60 X054 2811 1010 0000 0123 456 entro venerdì', 'IBAN DE89370400440532013000',
    'client_secret = \'abc123segreta\'', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsegretissima\n-----END RSA PRIVATE KEY-----',
  ];
  const leaked = ['hunter2', 'segreta', 'paroladordine', 'mario.rossi', 'Luigi.Verdi', 'X054', '370400440532', 'MIIE', 'abcDEF123456', ...Object.values(SECRETS)];
  const cleaned = lines.map(scrub);
  const bad = cleaned.filter(c => leaked.some(x => c.includes(x)));
  ok(bad.length === 0, `il filtro toglie token, chiavi, password, stringhe di connessione, e-mail e IBAN (${lines.length} righe di prova)` + (bad.length ? ': ' + JSON.stringify(bad) : ''));
  ok(scrub('prima ' + SECRETS['token di GitHub'] + ' dopo') === 'prima [token] dopo' && scrub('export DB_PASSWORD=hunter2') === 'export DB_PASSWORD=[secret]' && scrub('postgres://admin:hunter2@db.internal:5432/app') === 'postgres://[credentials]@db.internal:5432/app' &&
    scrub('scrivi a mario.rossi@example.com') === 'scrivi a [email]' && scrub('su IT60 X054 2811 1010 0000 0123 456 ok') === 'su [iban] ok', 'al posto del segreto resta un segnaposto: si capisce cosa c\'era, non cos\'era');
  const harmless = ['npm test -- src/core/state.js', 'TS2345: Argument of type string is not assignable to parameter of type number', 'commit 5af13ea1b2c3d4e5f60718293a4b5c6d7e8f9012 su main', 'ENOENT: no such file or directory, open src/a.js',
    'exit code 1: cargo build --release', 'git push origin dev-2.13-storage', 'AssertionError: expected 3 to equal 4', 'il token di accesso è scaduto', 'tokens: 1500 in, 300 out', 'authors=3 passwordless: true', 'IT12 3456 non è un IBAN', 'node scripts/store-bench.js --n 200000', 'author: Massimiliano', 'https://github.com/m4xl4b/platypus/pull/18'];
  ok(harmless.every(h => scrub(h) === h), 'le righe innocue (comandi, errori, impronte di commit, indirizzi senza credenziali) restano uguali' + (harmless.every(h => scrub(h) === h) ? '' : ': ' + JSON.stringify(harmless.filter(h => scrub(h) !== h).map(scrub))));
  ok(ibanOk('IT60X0542811101000000123456') && ibanOk('GB82 WEST 1234 5698 7654 32') && !ibanOk('IT60X0542811101000000123457') && !ibanOk('AB12'), 'IBAN: si riconosce dalla cifra di controllo');
  ok(excerpt('  uno\n\tdue   tre  ') === 'uno due tre' && excerpt('x'.repeat(500)).length === 200 && excerpt('x'.repeat(500)).endsWith('…') && excerpt(null) === '' && excerpt(`a ${SECRETS.JWT} ${'b'.repeat(300)}`).startsWith('a [token] b') && excerpt(42) === '42',
    'un estratto: una riga sola, spazi compattati, segreti tolti prima di tagliare, al massimo 200 caratteri');

  // ---------------------------------------------------------- percorsi
  ok(relPath('/home/max/proj/src/a.js', '/home/max/proj') === 'src/a.js' && relPath('/home/max/proj/src/../lib/./b.js', '/home/max/proj/') === 'lib/b.js' && relPath('/home/max/proj', '/home/max/proj') === '' && relPath('src\\ui\\c.js', '/qualsiasi') === 'src/ui/c.js' &&
    relPath('./src//a.js') === 'src/a.js' && relPath('', '/r') === '' && relPath(null) === '', 'percorsi: dentro il progetto diventano relativi, con le barre dritte');
  ok(relPath('C:\\Dev\\Mio Progetto\\src\\a.js', 'c:/dev/mio progetto') === 'src/a.js' && relPath('c:/dev/mio progetto/SRC/A.js', 'C:\\Dev\\Mio Progetto\\') === 'SRC/A.js', 'percorsi di Windows: lettere del disco, barre e maiuscole della radice non contano');
  const out = [relPath('/home/max/.ssh/id_rsa', '/home/max/proj'), relPath('C:\\Users\\mario\\Documenti\\segreto.txt', 'C:\\Dev\\Proj'), relPath('/home/max/proj-altro/a.js', '/home/max/proj'), relPath('../../fuori/b.js', '/r'), relPath('/home/max/proj/../x.js', '/home/max/proj'),
    relPath('~/note.txt'), relPath('\\\\server\\condivisa\\c.txt'), relPath('file:///etc/passwd'), relPath('/etc/passwd')];
  ok(out.every(o => /^ext:[0-9a-f]{10}\/[^/\\]+$/.test(o)) && out[0].endsWith('/id_rsa') && out[1].endsWith('/segreto.txt') && !out.join(' ').match(/max|mario|Users|home|server|etc|Documenti|fuori/) &&
    relPath('/home/max/.ssh/id_rsa', '/a') === relPath('/home/max/.ssh/id_rsa', '/b') && relPath('/x/id_rsa') !== relPath('/y/id_rsa') && relPath(out[0], '/r') === out[0],
    'percorsi fuori dal progetto: impronta e nome del file. Lo stesso file ha la stessa impronta, file diversi con lo stesso nome no');

  // ---------------------------------------------------------- nel file del database, così com'è
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-privacy-'));
  try {
    const dir = path.join(tmp, 'db');
    const store = openStore({ backend: 'sqlite', dir, guard: 'drop', requireFields: true, onGuard() {} });
    store.declare('steps', { fields: { session: 'id', action: 'string', target: 'path', err: 'excerpt', outcome: 'string', meta: { phase: 'string' }, counts: { '*': 'number' }, files: ['path'] }, indexes: [['project', 't'], 'action'] });
    const steps = store.collection('steps');
    const FORBIDDEN = {
      prompt: 'PROMPT-VIETATO: riscrivi tutto il modulo ordini', reply: 'RISPOSTA-VIETATA: certo, ecco il codice', toolOutput: 'USCITA-VIETATA: 42 righe di log', fileContent: 'CONTENUTO-VIETATO: const x = 1',
      credentials: { user: 'UTENTE-VIETATO', password: 'PASSWORD-VIETATA' }, email: 'vietata@example.com', cwd: 'C:\\Users\\mario-vietato\\progetto', env: { HOME: '/home/casa-vietata' }, text: ['RIGA-VIETATA-1', 'RIGA-VIETATA-2'],
    };
    const doc = {
      project: '0123456789abcdef', t: 1700000000000, session: 'sess-0001', action: 'run', outcome: 'error',
      target: 'C:\\Users\\mario-vietato\\Desktop\\conti.xlsx',
      err: `connessione a postgres://admin:PASSWORD-VIETATA@db-interno.example.net/app fallita per vietata@example.com, token ${'ghp_' + 'VIETATO'.repeat(4)}0123 IBAN IT60X0542811101000000123456`,
      meta: { phase: 'test', prompt: FORBIDDEN.prompt }, counts: { ok: 1, testo: 'CONTEGGIO-VIETATO' }, files: ['src/a.js', '/home/casa-vietata/.ssh/id_rsa', 7],
      action2: 'AZIONE-NON-DICHIARATA', ...FORBIDDEN,
    };
    const a1 = steps.put({ _id: 'put-1', ...doc });
    const a2 = steps.append(doc);
    steps.put({ _id: 'patch-1', project: doc.project, t: 1, action: 'edit' });
    steps.patch('patch-1', { ...FORBIDDEN, target: doc.target, err: doc.err, outcome: 'TESTO-VIETATO-SU-PIU-RIGHE\nseconda riga' });
    store.transaction(() => { steps.append({ ...doc, _id: 'tx-1' }); });
    const file = path.join(tmp, 'f.jsonl');
    fs.writeFileSync(file, JSON.stringify({ _id: 'import-1', ...doc }) + '\n');
    store.import('steps', file);
    store.flush();
    const saved = steps.get(a2);
    ok(steps.count({}) === 5 && Object.keys(saved).sort().join() === '_id,action,counts,err,files,meta,outcome,project,session,t,target' && JSON.stringify(saved.meta) === '{"phase":"test"}' && JSON.stringify(saved.counts) === '{"ok":1}' &&
      saved.files.length === 2 && saved.files[0] === 'src/a.js' && /^ext:[0-9a-f]{10}\/id_rsa$/.test(saved.files[1]) && /^ext:[0-9a-f]{10}\/conti\.xlsx$/.test(saved.target) &&
      saved.err === 'connessione a postgres://[credentials]@db-interno.example.net/app fallita per [email], token [token] IBAN [iban]' && a1._id === 'put-1' && steps.get('patch-1').outcome === undefined,
      'un documento pieno di campi vietati e di segreti: restano solo i campi dichiarati, puliti (put, append, patch, transazione, import)');
    const exported = fs.readFileSync(store.export('steps', path.join(tmp, 'export')).file, 'latin1');
    store.close();
    let rawBytes = '';
    for (const f of fs.readdirSync(dir)) rawBytes += fs.readFileSync(path.join(dir, f)).toString('latin1') + fs.readFileSync(path.join(dir, f)).toString('utf16le');
    const words = ['VIETAT', 'vietat', 'mario', 'casa-', 'PASSWORD', 'ghp_', 'IT60X', 'admin:', 'Users', 'Desktop', '.ssh/', 'NON-DICHIARATA', 'seconda riga'];
    const found = words.filter(w => rawBytes.includes(w) || exported.includes(w));
    ok(found.length === 0 && rawBytes.includes('/conti.xlsx') && rawBytes.includes('db-interno.example.net') && rawBytes.includes('sess-0001') && fs.readdirSync(dir).length >= 1,
      'leggendo il file del database così com\'è (e l\'esportazione) non si trova nessuna di quelle stringhe' + (found.length ? ': ' + found.join(', ') : ''));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S7: le collezioni dello storico. Che cosa entra in ognuna, con quali indici e per quanto tempo
async function collectionsTests(ok) {
  console.log('store: collezioni');
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { COLLECTIONS, NAMES, declareCollections, defaultRetention } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
  const { ProjectKeys } = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const code = fn => { try { fn(); } catch (e) { return e.code; } return null; };
  ok(NAMES.join() === 'projects,lessons,steps,sessions,feedback,experiments,daily' && JSON.stringify(defaultRetention()) === '{"projects":0,"lessons":180,"steps":90,"sessions":365,"feedback":365,"experiments":365,"daily":0}',
    'le sette collezioni, con la conservazione di partenza: passi 90 giorni, sessioni e feedback 365, lezioni 180, progetti e statistiche per sempre');
  const P = '0123456789abcdef', T = 1763500000000;
  // un documento per collezione, con la forma che i dati hanno oggi nel motore
  const samples = {
    projects: { _id: P, name: 'platypus', remote: 'github.com/m4xl4b/platypus', aliases: { fedcba9876543210: T }, firstSeen: T, lastSeen: T + 5, forgotten: { '1a2b3c4d5e6f': T }, learned: { 'sess-0001': T } },
    lessons: { _id: `${P}:1a2b3c4d5e6f`, project: P, t: T, lesson: '1a2b3c4d5e6f', kind: 'flaky-command', key: 'npm run test:e2e', count: 3, sessions: ['sess-0001', 'sess-0002'], first: T - 9, last: T,
      evidence: [{ sid: 'sess-0001', t: T, agent: 'Claude', excerpt: 'FAIL src/a.test.js: expected 3 to equal 4' }], seen: ['sess-0001|1763500000000|Claude'], pinned: false, ignored: false },
    steps: { _id: 'step-1', project: P, t: T, session: 'sess-0001', agent: 'main', action: 'verify', tool: 'Bash', target: 'cmd:npm test', outcome: 'error', err: 'AssertionError: expected N to equal N', fail: 'test', cmd: 'npm test', phase: 'test', dur: 4200 },
    sessions: { _id: 'sess-0001', project: P, t: T, end: T + 60000, kind: 'code', model: 'claude-fable-5-2[1m]', effort: 'high', agents: 3, actions: 120, errors: 7, surprises: 2, claims: 1, loops: 1, stale: 0, lessons: 2, cost: 1.25, tokens: 250000 },
    feedback: { _id: 'mb1x2y3', project: P, t: T, sid: 'sess-0001', agent: 'main', name: 'Claude', feature: 'loop', mode: 'shadow', event: 'PreToolUse', lessonId: '1a2b3c4d5e6f', tag: 'tests/ungrounded', toolUseId: 'toolu_01AbC',
      text: 'Platypus: this command failed 4 times in a row with the same error.\nChange something before running it again.', local: 'Platypus: questo comando è fallito 4 volte di fila con lo stesso errore.',
      about: { kind: 'loop', cmd: 'npm test', pat: 'FAIL <path>', file: 'src/a.js' }, group: 'on', outcome: 'helped', at: T + 9000, why: 'il comando è poi riuscito' },
    experiments: { _id: 'sess-0001:loop', project: P, t: T, sid: 'sess-0001', feature: 'loop', group: 'shadow' },
    daily: { _id: 'day:2026-11-19', t: T, kind: 'day', day: '2026-11-19', alerts: 2,
      projects: { platypus: { cost: 1.5, tokens: 300000, completed: 4, commits: 2, prs: 1, tests: 3, sessions: ['sess-0001'], wing: 'code' } },
      releases: [{ t: T, kind: 'commit', text: 'S6: add the privacy guard of the store', url: 'https://github.com/m4xl4b/platypus/pull/18', agent: 'Claude', project: 'platypus' }] },
  };
  const week = { _id: 'week:2026-W47', t: T, kind: 'week', week: '2026-W47', types: { Claude: { completed: 10, errors: 1, tools: 200, cost: 3.5 }, Explore: { completed: 2, errors: 0, tools: 40, cost: 0.4 } } };
  const last = { _id: 'last:sess-0001', t: T, kind: 'last', last: { cost: 1.5, tok: 300000, completed: 4, cbt: { Claude: 4 }, err: { Claude: 1 }, tools: { Claude: 80 }, costType: { Claude: 1.5 }, rel: 'r-12', alerts: ['a1', 'a2'], name: 'platypus' } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-collezioni-'));
  try {
    for (const backend of ['memory', 'sqlite']) {
      const dir = path.join(tmp, backend);
      const store = declareCollections(openStore({ backend, dir, guard: 'reject', requireFields: true }));
      const info = store.info();
      ok(info.collections.map(c => c.name).join() === NAMES.join() && info.collections.every(c => c.guarded) && info.collections.find(c => c.name === 'steps').retention.days === 90 && info.collections.find(c => c.name === 'daily').retention === null &&
        JSON.stringify(info.collections.find(c => c.name === 'steps').indexes) === '[["project","t"],["session","t"]]', `${backend}: tutte dichiarate con i loro campi, indici e conservazione`);
      let same = true;
      for (const [name, doc] of Object.entries({ ...samples, 'daily (settimana)': week, 'daily (ultimo stato)': last })) {
        const c = store.collection(name.split(' ')[0]);
        const back = c.put(doc), got = c.get(doc._id);
        const norm = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v));
        if (norm(back) !== norm(doc) || norm(got) !== norm(doc)) { same = false; ok(false, `${backend}: ${name} non torna uguale: ${norm(got).slice(0, 300)}`); }
      }
      ok(same, `${backend}: un documento vero per ogni collezione entra ed esce uguale, con la guardia che rifiuta ogni campo in più`);
      const extras = NAMES.map(n => code(() => store.collection(n).put({ ...samples[n], _id: 'x-' + n, prompt: 'testo' })));
      ok(extras.every(c => c === 'undeclared-field') && code(() => store.collection('steps').put({ ...samples.steps, _id: 'x1', output: 'righe di log' })) === 'undeclared-field' &&
        code(() => store.collection('sessions').put({ ...samples.sessions, _id: 'x2', title: 'titolo della sessione' })) === 'undeclared-field' && code(() => store.collection('feedback').put({ ...samples.feedback, _id: 'x3', about: { kind: 'loop', output: 'x' } })) === 'undeclared-field' &&
        code(() => store.collection('daily').put({ ...samples.daily, _id: 'x4', projects: { p: { cost: 1, note: 'x' } } })) === 'undeclared-field', `${backend}: in nessuna collezione entra un campo non dichiarato (prompt, output, titolo…)`);
      // i campi che possono portare testo passano dai filtri
      const st = store.collection('steps').put({ ...samples.steps, _id: 'step-2', target: 'abs:C:/Users/mario/Desktop/conti.xlsx', err: 'login fallito per mario.rossi@example.com con password=hunter2', cmd: 'curl -H "Authorization: Bearer abcDEF123456" https://api.example.org' });
      const fbk = store.collection('feedback').put({ ...samples.feedback, _id: 'fb-2', text: `riga uno\nriga due con token ghp_abcdefghijklmnopqrstuvwxyz012345\n${'x'.repeat(3000)}`, about: { file: '/home/mario/.ssh/id_rsa' } });
      const dl = store.collection('daily').put({ ...samples.daily, _id: 'day:2026-11-18', releases: [{ t: T, kind: 'commit', text: 'fix: rimuove la chiave sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345', url: 'https://utente:parola@git.example.org/x/y/pull/3' }] });
      ok(/^ext:[0-9a-f]{10}\/conti\.xlsx$/.test(st.target) && st.err === 'login fallito per [email] con password=[secret]' && !st.cmd.includes('abcDEF') && fbk.text.startsWith('riga uno\nriga due con token [token]\n') && fbk.text.length === 2000 &&
        /^ext:[0-9a-f]{10}\/id_rsa$/.test(fbk.about.file) && dl.releases[0].text === 'fix: rimuove la chiave [token]' && dl.releases[0].url === 'https://[credentials]@git.example.org/x/y/pull/3',
        `${backend}: percorsi, righe d'errore, comandi, messaggi e titoli dei commit passano dai filtri`);
      // la chiave del progetto e "dimentica"
      const keys = new ProjectKeys({ store, exec: async () => 'git@github.com:m4xl4b/altro.git', clock: () => T });
      const other = await keys.resolve('/home/max/altro');
      store.collection('steps').append({ project: other.key, t: T, session: 's9', action: 'read', tool: 'Read', target: 'README.md', outcome: 'ok' });
      store.flush();
      const before = store.collection('steps').count({});
      ok(store.collection('projects').get(other.key).remote === 'github.com/m4xl4b/altro' && store.forgetProject(P) === 8 && store.collection('projects').get(P) === null && store.collection('steps').count({ project: P }) === 0 &&
        store.collection('steps').count({}) === before - 2 && store.collection('projects').get(other.key) !== null && store.collection('daily').count({}) === 4,
        `${backend}: la collezione projects accetta quello che scrive la chiave del progetto; "dimentica" toglie il progetto dalle collezioni che hanno la sua chiave`);
      store.close();
      // conservazione scelta nelle opzioni
      const custom = declareCollections(openStore({ backend, dir: path.join(tmp, backend + '-2'), requireFields: true }), { retention: { steps: 30, sessions: 0, daily: 400, lessons: 60 } });
      const r = Object.fromEntries(custom.info().collections.map(c => [c.name, c.retention]));
      ok(r.steps.days === 30 && r.sessions === null && r.daily.days === 400 && r.lessons.days === 60 && r.lessons.onlyIf === 'low-weight' && r.feedback.days === 365 && r.projects === null, `${backend}: la conservazione si può cambiare per collezione (0 = per sempre)`);
      custom.close();
    }
    const m = () => openStore({ requireFields: true });
    ok(code(() => declareCollections(m(), { retention: { steps: -1 } })) === 'invalid-argument' && code(() => declareCollections(m(), { retention: { steps: 1.5 } })) === 'invalid-argument' && code(() => declareCollections(m(), { retention: { steps: '30' } })) === 'invalid-argument' &&
      code(() => declareCollections(m(), { retention: { steps: 99999 } })) === 'invalid-argument' && code(() => declareCollections(m(), { retention: { boh: 3 } })) === 'invalid-argument' && code(() => declareCollections(m(), { retention: [30] })) === 'invalid-argument',
      'una conservazione che non ha senso (negativa, non intera, di una collezione che non c\'è) è un errore');
    // nessuna collezione ha un campo libero senza limiti: solo i tipi della guardia
    const types = new Set();
    const walk = spec => { if (typeof spec === 'string') types.add(spec); else if (Array.isArray(spec)) walk(spec[0]); else for (const v of Object.values(spec)) walk(v); };
    for (const n of NAMES) walk(COLLECTIONS[n].fields);
    const notes = [];
    const find = (spec, at) => { if (spec === 'note') notes.push(at); else if (Array.isArray(spec)) find(spec[0], at + '[]'); else if (typeof spec === 'object') for (const [k, v] of Object.entries(spec)) find(v, at + '.' + k); };
    for (const n of NAMES) find(COLLECTIONS[n].fields, n);
    ok([...types].sort().join() === 'boolean,excerpt,id,note,number,path,string' && notes.join() === 'feedback.text,feedback.local', 'il testo su più righe è ammesso in due campi soli: il messaggio di Platypus all\'agente, nelle due lingue');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S8: i dati di prima (Libri, statistiche, registro dei messaggi) entrano nello store, una volta sola
async function legacyTests(ok) {
  console.log('store: dati di prima');
  const crypto = require('crypto');
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { declareCollections } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
  const { importLegacy, weekStart, dayStart } = require(path.join(ROOT, 'src', 'core', 'store', 'legacy'));
  const { ProjectKeys, normDir, keyFor } = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const { projectKey } = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const { FileBottega: Bottega } = require(path.join(ROOT, 'scripts', 'legacy-212')); // il Libro come lo scriveva la 2.12
  const { FileFeedbackLog: FeedbackLog } = require(path.join(ROOT, 'scripts', 'legacy-212')); // il registro come lo scriveva la 2.12
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-prima-'));
  const T = 1763500000000, NOW = T + 86400000;
  const A = '/home/max-segreto/lavoro/platypus', B = '/home/max-segreto/copie/platypus-due', C = '/home/max-segreto/senza-remote';
  const REMOTE = 'git@github.com:m4xl4b/platypus.git';
  const hashDir = dir => { const h = crypto.createHash('sha1'); const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else h.update(e.name).update(fs.readFileSync(f)); } }; walk(dir); return h.digest('hex'); };
  // scrive i file come li scriveva la 2.12, con le sue stesse classi
  const makeOld = dataDir => {
    const bot = new Bottega(path.join(dataDir, 'bottega'));
    const c = (kind, key, sid, t, excerpt) => ({ kind, key, sid, t, agent: 'Claude', excerpt });
    bot.learn(A, [c('flaky-command', 'npm run test:e2e', 'sess-a1', T, 'FAIL e2e/login.spec.js'), c('flaky-command', 'npm run test:e2e', 'sess-a2', T + 1000, 'FAIL e2e/login.spec.js con token ghp_abcdefghijklmnopqrstuvwxyz012345'),
      c('fragile-file', 'src/core/state.js', 'sess-a1', T + 2000, 'TypeError: x is not a function'), c('ghost-path', 'src/auth/oldToken.ts', 'sess-a2', T + 3000, 'ENOENT'), c('slow-step', 'npm run build', 'sess-a2', T + 4000, '7 min')]);
    bot.learn(B, [c('flaky-command', 'npm run test:e2e', 'sess-b1', T + 5000, 'FAIL e2e/cart.spec.js'), c('loop-trap', 'cargo build', 'sess-b1', T + 6000, 'error[E0308]')]);
    bot.learn(C, [c('known-fix', 'ENOENT <path> → package.json', 'sess-c1', T + 7000, 'ENOENT: no such file')]);
    const idOf = (cwd, kind) => Object.values(bot.book(cwd).lessons).find(l => l.kind === kind).id;
    const pinned = idOf(A, 'fragile-file'), forgotten = idOf(A, 'slow-step');
    bot.act(A, 'pin', pinned);
    bot.act(A, 'forget', forgotten);
    bot.book(A).learned = { 'sess-arch-1': T - 5 };
    bot.book(A).dirty = true;
    bot.stop();
    const log = new FeedbackLog(path.join(dataDir, 'feedback'));
    const m1 = log.append(A, { t: T + 10, sid: 'sess-a1', agent: 'main', feature: 'loop', mode: 'on', event: 'PreToolUse', lessonId: idOf(A, 'flaky-command'), text: 'Platypus: this command failed 4 times in a row.\nChange something first.', local: 'Platypus: questo comando è fallito 4 volte di fila.', about: { kind: 'loop', cmd: 'npm run test:e2e', pat: 'FAIL <path>' }, toolUseId: 'toolu_01AbC', name: 'Claude' });
    const m2 = log.append(A, { t: T + 20, sid: 'sess-a2', agent: 'agent-7', feature: 'claims', mode: 'shadow', event: 'Stop', text: 'Platypus: you said the tests pass, but no test ran.', tag: 'tests/ungrounded', about: { kind: 'tests' } });
    const m3 = log.append(B, { t: T + 30, sid: 'sess-b1', agent: 'main', feature: 'stale', mode: 'shadow', event: 'PreToolUse', text: 'Platypus: src/a.js changed since you read it.', about: { file: 'src/a.js' } });
    const m4 = log.append(C, { t: T + 40, sid: 'sess-c1', agent: 'main', feature: 'elder', mode: 'on', event: 'PreToolUse', text: 'Platypus: password=hunter2 was in the last error.' });
    log.setOutcome(A, m1.id, 'helped', 'il comando è poi riuscito');
    log.setOutcome(B, m3.id, 'ignored');
    log.setOutcome(A, 'messaggio-perso', 'unclear');
    // un file ruotato (il giro di prima) con un altro messaggio, e una riga rotta
    fs.writeFileSync(path.join(dataDir, 'feedback', projectKey(A) + '.1.jsonl'), JSON.stringify({ id: 'vecchio1', t: T - 100, sid: 'sess-a0', agent: 'main', feature: 'loop', mode: 'shadow', event: 'PreToolUse', text: 'Platypus: older message.' }) + '\nquesta riga è rotta\n');
    const stats = {
      days: {
        '2026-11-17': { projects: { platypus: { cost: 1.5, tokens: 300000, sessions: ['sess-a1'], completed: 4, commits: 2, prs: 1, tests: 3, wing: 'code' }, ['Report trimestrale ' + 'x'.repeat(200)]: { cost: 0.5, tokens: 1000, sessions: ['sess-w1'], completed: 1, commits: 0, prs: 0, tests: 0, wing: 'cowork' } },
          releases: [{ t: T - 9, kind: 'commit', text: 'S5: add the project key', url: 'https://github.com/m4xl4b/platypus/commit/07c3f20', agent: 'Claude', project: 'platypus' }, { t: T - 8, kind: 'tests', text: '12 passed', agent: 'Claude', project: 'platypus' }], alerts: 2 },
        '2026-11-18': { projects: { platypus: { cost: 2.25, tokens: 500000, sessions: ['sess-a2', 'sess-b1'], completed: 6, commits: 1, prs: 0, tests: 5, wing: 'code' } }, releases: [], alerts: 0 },
      },
      weeks: { '2026-W47': { Claude: { completed: 10, errors: 1, tools: 200, cost: 3.75 }, Explore: { completed: 2, errors: 0, tools: 40, cost: 0.5 } } },
      last: { 'sess-a2': { t: T, cost: 2.25, tok: 500000, completed: 6, cbt: { Claude: 6 }, err: { Claude: 1 }, tools: { Claude: 80 }, costType: { Claude: 2.25 }, rel: 'r-3', alerts: ['a1'], name: 'platypus' } },
    };
    fs.writeFileSync(path.join(dataDir, 'stats.json'), JSON.stringify(stats));
    return { pinned, forgotten, ids: { m1: m1.id, m2: m2.id, m3: m3.id, m4: m4.id }, stats, flakyA: idOf(A, 'flaky-command') };
  };
  const open = [];
  // uguali, qualunque sia l'ordine delle chiavi
  const sorted = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : Array.isArray(v) ? v.map(sorted) : v);
  const same = (x, y) => JSON.stringify(sorted(x)) === JSON.stringify(sorted(y));
  try {
    ok(new Date(weekStart('2026-W47')).getDay() === 1 && new Date(weekStart('2026-W47')).getDate() === 16 && new Date(weekStart('2026-W01')).getFullYear() === 2025 && new Date(dayStart('2026-11-19')).getDate() === 19 && weekStart('boh') === 0, 'giorni e settimane ISO diventano date (il lunedì della settimana)');
    for (const backend of ['memory', 'sqlite']) {
      const dataDir = path.join(tmp, backend, 'dati');
      fs.mkdirSync(dataDir, { recursive: true });
      const old = makeOld(dataDir);
      const before = hashDir(dataDir);
      const mk = extra => { const st = declareCollections(openStore({ backend, dir: path.join(tmp, backend, 'db'), guard: 'drop', requireFields: true, onGuard() {}, ...extra })); open.push(st); return st; };
      let store = mk();
      const exec = async cwd => ({ [normDir(A)]: REMOTE, [normDir(B)]: 'https://github.com/m4xl4b/platypus' }[normDir(cwd)] || null);
      const keys = new ProjectKeys({ store, exec, clock: () => NOW });
      const r = await importLegacy(store, dataDir, { keys, clock: () => NOW });
      store.flush();
      const K = keyFor(A, REMOTE).key, KC = projectKey(C);
      const lessons = store.collection('lessons'), projects = store.collection('projects'), daily = store.collection('daily'), fb = store.collection('feedback');
      ok(r.done === true && JSON.stringify(r.imported) === '{"projects":2,"lessons":5,"daily":4,"feedback":5}' && r.skipped.feedback === 1 && r.skipped.outcomes === 1 && lessons.count({}) === 5 && projects.count({}) === 2 && daily.count({}) === 4 && fb.count({}) === 5,
        `${backend}: tre Libri (sei lezioni, di cui una in due cartelle dello stesso repository), le statistiche e i messaggi entrano nello store, e i conti tornano`);
      // lezioni: ogni lezione dei vecchi file c'è, sotto la chiave del repository; due cartelle dello stesso repository si sommano
      const bot = new Bottega(path.join(dataDir, 'bottega'));
      let all = true;
      for (const cwd of [A, B, C]) for (const l of Object.values(bot.book(cwd).lessons)) {
        const d = lessons.get(`${cwd === C ? KC : K}:${l.id}`);
        if (!d || d.kind !== l.kind || d.lesson !== l.id || d.count < l.count || d.pinned !== (cwd === A ? l.pinned : d.pinned) || !l.sessions.every(x => d.sessions.includes(x))) { all = false; ok(false, `${backend}: lezione persa o diversa: ${l.kind} ${l.key}`); }
      }
      const oldCounts = [A, B, C].map(cwd => Object.keys(bot.book(cwd).lessons).length);
      bot.stop();
      const flaky = lessons.get(`${K}:${old.flakyA}`);
      ok(all && oldCounts.join() === '3,2,1' && flaky.count === 3 && flaky.sessions.length === 3 && flaky.evidence.length === 3 && flaky.evidence[0].t === T + 5000 && flaky.last === T + 5000 && flaky.t === T + 5000 && flaky.first === T &&
        lessons.get(`${K}:${old.pinned}`).pinned === true && lessons.count({ project: K }) === 4 && lessons.count({ project: KC, kind: 'known-fix' }) === 1,
        `${backend}: ogni lezione dei vecchi Libri si ritrova; la stessa lezione in due cartelle dello stesso repository diventa una, con i casi di tutte e due`);
      const pk = projects.get(K), pc = projects.get(KC);
      ok(pk.remote === 'github.com/m4xl4b/platypus' && Object.keys(pk.aliases).sort().join() === [projectKey(A), projectKey(B)].sort().join() && pk.forgotten[old.forgotten] > 0 && pk.learned['sess-arch-1'] === T - 5 && pk.firstSeen === T &&
        pc.name === 'senza-remote' && !('remote' in pc) && Object.keys(pc.aliases).length === 0 && lessons.get(`${K}:${old.forgotten}`) === null,
        `${backend}: il progetto tiene il remote, le vecchie chiavi come alias, le lezioni dimenticate e le sessioni già lette`);
      // messaggi: con l'esito, sotto il progetto giusto, senza segreti
      const f1 = fb.get(old.ids.m1), f3 = fb.get(old.ids.m3), f4 = fb.get(old.ids.m4), fOld = fb.get('vecchio1');
      ok(f1.project === K && f1.outcome === 'helped' && f1.why === 'il comando è poi riuscito' && f1.at > 0 && f1.text.includes('\nChange something first.') && f1.local.startsWith('Platypus: questo') && f1.about.cmd === 'npm run test:e2e' && f1.toolUseId === 'toolu_01AbC' && f1.name === 'Claude' &&
        fb.get(old.ids.m2).outcome === undefined && fb.get(old.ids.m2).tag === 'tests/ungrounded' && f3.project === K && f3.outcome === 'ignored' && f3.about.file === 'src/a.js' && f4.project === KC && f4.text === 'Platypus: password=[secret] was in the last error.' && fOld.project === K && fOld.t === T - 100 &&
        fb.count({ project: K, feature: 'loop' }) === 2 && fb.count({ mode: 'on' }) === 2,
        `${backend}: ogni messaggio si ritrova con il suo esito, anche quelli del file ruotato; i segreti nei testi non passano`);
      // statistiche: gli stessi numeri
      const d17 = daily.get('day:2026-11-17'), d18 = daily.get('day:2026-11-18'), wk = daily.get('week:2026-W47'), ls = daily.get('last:sess-a2');
      const longName = Object.keys(d17.projects).find(n => n.startsWith('Report'));
      ok(same(d17.projects.platypus, old.stats.days['2026-11-17'].projects.platypus) && d17.alerts === 2 && d17.releases.length === 2 && d17.releases[0].text === 'S5: add the project key' && d17.releases[0].url.endsWith('/commit/07c3f20') && d17.releases[1].url === undefined &&
        longName.length === 128 && d17.projects[longName].cost === 0.5 && d17.t === dayStart('2026-11-17') && d18.projects.platypus.cost === 2.25 && d18.projects.platypus.sessions.length === 2 && same(wk.types, old.stats.weeks['2026-W47']) && wk.t === weekStart('2026-W47') &&
        ls.t === T && ls.last.cost === 2.25 && ls.last.cbt.Claude === 6 && ls.last.alerts[0] === 'a1' && daily.count({ kind: 'day' }) === 2,
        `${backend}: ogni giorno, settimana e ultimo stato delle statistiche si ritrova con gli stessi numeri`);
      // gli originali: copiati, non toccati; la 2.12 li rilegge
      const copyOk = fs.existsSync(path.join(r.legacyDir, 'stats.json')) && fs.readdirSync(path.join(r.legacyDir, 'bottega')).length === 3 && fs.readdirSync(path.join(r.legacyDir, 'feedback')).length === 4 && r.files === 8 && /^legacy-\d{8}$/.test(path.basename(r.legacyDir));
      const untouched = (() => { const h = crypto.createHash('sha1'); for (const sub of ['bottega', 'feedback']) for (const n of fs.readdirSync(path.join(dataDir, sub)).sort()) h.update(n).update(fs.readFileSync(path.join(dataDir, sub, n))); return h.update(fs.readFileSync(path.join(dataDir, 'stats.json'))).digest('hex'); })();
      const copied = (() => { const h = crypto.createHash('sha1'); for (const sub of ['bottega', 'feedback']) for (const n of fs.readdirSync(path.join(r.legacyDir, sub)).sort()) h.update(n).update(fs.readFileSync(path.join(r.legacyDir, sub, n))); return h.update(fs.readFileSync(path.join(r.legacyDir, 'stats.json'))).digest('hex'); })();
      const log2 = new FeedbackLog(path.join(dataDir, 'feedback'));
      ok(copyOk && untouched === copied && fs.readdirSync(dataDir).filter(n => n.startsWith('legacy-')).length === 1 && log2.recent(A).length === 3 && log2.recent(A).find(x => x.id === old.ids.m1).outcome === 'helped' && before !== hashDir(dataDir),
        `${backend}: gli originali restano dove sono, identici, con una copia in legacy-<data>; la 2.12 li rilegge come prima`);
      // una volta sola, anche dopo un riavvio
      const again = await importLegacy(store, dataDir, { keys, clock: () => NOW + 5 });
      fs.writeFileSync(path.join(dataDir, 'stats.json'), JSON.stringify({ days: { '2026-11-19': { projects: {}, releases: [], alerts: 9 } }, weeks: {}, last: {} }));
      if (backend === 'sqlite') { store.close(); store = mk(); }
      const third = await importLegacy(store, dataDir, { clock: () => NOW + 9 });
      ok(again.done === false && again.reason === 'already' && again.at === NOW && third.done === false && store.collection('daily').count({}) === 4 && store.collection('lessons').count({}) === 5 && store.collection('feedback').count({}) === 5 && store.getMeta('legacyImported') === String(NOW),
        `${backend}: rifarlo non cambia niente${backend === 'sqlite' ? ', nemmeno dopo aver chiuso e riaperto' : ''}`);
      if (backend === 'sqlite') {
        store.close();
        let rawBytes = '';
        for (const f of fs.readdirSync(path.join(tmp, backend, 'db'))) rawBytes += fs.readFileSync(path.join(tmp, backend, 'db', f)).toString('latin1');
        const leaks = ['max-segreto', 'lavoro/platypus', 'copie/', 'hunter2', 'ghp_abcdefghijklmnop'].filter(x => rawBytes.includes(x));
        ok(leaks.length === 0 && rawBytes.includes('github.com/m4xl4b/platypus') && rawBytes.includes('senza-remote'), 'sqlite: nel file del database non ci sono le cartelle dei vecchi Libri né i segreti che stavano nei testi' + (leaks.length ? ': ' + leaks.join(', ') : ''));
      }

      // se fallisce a metà non resta niente, e al prossimo avvio riprova
      const dataDir2 = path.join(tmp, backend, 'dati-2');
      fs.mkdirSync(dataDir2, { recursive: true });
      makeOld(dataDir2);
      const strict = mk({ dir: path.join(tmp, backend, 'db-2'), guard: 'reject' });
      const st2 = JSON.parse(fs.readFileSync(path.join(dataDir2, 'stats.json'), 'utf8'));
      const good = JSON.stringify(st2);
      st2.days['2026-11-18'].projects.platypus.sessions = ['una sessione con spazi'];
      fs.writeFileSync(path.join(dataDir2, 'stats.json'), JSON.stringify(st2));
      let err = null;
      try { await importLegacy(strict, dataDir2, { clock: () => NOW }); } catch (e) { err = e; }
      strict.flush();
      const empty = ['projects', 'lessons', 'daily', 'feedback'].every(n => strict.collection(n).count({}) === 0);
      fs.writeFileSync(path.join(dataDir2, 'stats.json'), good);
      const retry = await importLegacy(strict, dataDir2, { clock: () => NOW + 1 });
      ok(err && err.code === 'undeclared-field' && empty && retry.done === true && strict.collection('lessons').count({}) === 6 && strict.collection('daily').count({}) === 4 && strict.collection('projects').count({}) === 3 && strict.getMeta('legacyImported') === String(NOW + 1) &&
        fs.readdirSync(dataDir2).filter(n => n.startsWith('legacy-')).length === 1,
        `${backend}: se l'importazione fallisce a metà nello store non resta niente e il segno non c'è; al tentativo dopo va a buon fine (senza chiavi dei repository: un progetto per cartella)`);
      // una cartella dei dati vuota: installazione nuova
      const dataDir3 = path.join(tmp, backend, 'dati-3');
      fs.mkdirSync(dataDir3, { recursive: true });
      const fresh = mk({ dir: path.join(tmp, backend, 'db-3') });
      const none = await importLegacy(fresh, dataDir3, { clock: () => NOW });
      ok(none.done === true && JSON.stringify(none.imported) === '{"projects":0,"lessons":0,"daily":0,"feedback":0}' && none.legacyDir === null && fs.readdirSync(dataDir3).length === 0 && (await importLegacy(fresh, dataDir3)).reason === 'already',
        `${backend}: su un'installazione nuova non c'è niente da portare, non si creano cartelle e non si guarda più`);
    }
  } finally {
    for (const s of open) { try { s.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S9: il Libro della bottega nello storico (le lezioni in `lessons`, il resto nel documento del progetto)
async function bookTests(ok) {
  console.log('store: il Libro nello storico');
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { declareCollections } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
  const { ProjectKeys, keyFor, normDir } = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const { Bottega, projectKey } = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-libro-'));
  const A = path.join(tmp, 'Lavoro', 'Platypus'), B = path.join(tmp, 'copie', 'platypus-due'), C = path.join(tmp, 'senza-remote');
  const REMOTE = 'git@github.com:m4xl4b/platypus.git', K = keyFor(A, REMOTE).key;
  const remotes = { [normDir(A)]: REMOTE, [normDir(B)]: 'https://github.com/m4xl4b/platypus.git' };
  const T = Date.now() - 60000;
  const c = (kind, key, sid, t, excerpt = 'riga') => ({ kind, key, sid, t, agent: 'Claude', excerpt });
  const dir = path.join(tmp, 'db');
  const open = [];
  // lo storico come lo apre il motore: sqlite, guardia che rifiuta, collezioni vere; git finto
  const mk = (cwdOf = () => '') => {
    const store = declareCollections(openStore({ backend: 'sqlite', dir, guard: 'reject', requireFields: true }));
    const keys = new ProjectKeys({ store, exec: async cwd => remotes[normDir(cwd)] || null });
    const book = new Bottega({ store, keys, cwdOf, log() {} });
    open.push(store);
    return { store, keys, book, close() { book.stop(); store.close(); } };
  };
  try {
    let h = mk();
    await h.keys.resolve(A); await h.keys.resolve(B); await h.keys.resolve(C);
    h.book.learn(A, [c('flaky-command', 'npm run test:e2e', 's1', T), c('flaky-command', 'npm run test:e2e', 's2', T + 1), c('fragile-file', 'src/a.js', 's1', T + 2, 'TypeError in C:\\Users\\mario\\x.js con password=hunter2')]);
    h.book.learn(B, [c('flaky-command', 'npm run test:e2e', 's3', T + 3), c('ghost-path', 'src/old.ts', 's3', T + 4)]);
    h.book.learn(C, [c('loop-trap', 'cargo build', 's4', T + 5)]);
    const fragile = Object.values(h.book.book(A).lessons).find(l => l.kind === 'fragile-file').id;
    h.book.act(A, 'pin', fragile);
    h.book.setMute(B, true);
    h.book.book(A).learned = { 'sess-arch': T }; h.book.book(A).dirty = true;
    const vA = h.book.view(A), vB = h.book.view(B);
    ok(vA.key === K && vB.key === K && vA.lessons.length === 3 && vA.lessons.find(l => l.kind === 'flaky-command').count === 3 && h.book.view(C).key === projectKey(C) && h.book.view(C).lessons.length === 1,
      'due cartelle dello stesso repository hanno un Libro solo; una cartella senza remote ha il suo');
    h.close();
    // dopo un riavvio: tutto c'è, dallo storico
    h = mk();
    await h.keys.resolve(A);
    const rA = h.book.view(A), flaky = rA.lessons.find(l => l.kind === 'flaky-command');
    ok(rA.lessons.length === 3 && flaky.count === 3 && flaky.sessions.length === 3 && rA.lessons.find(l => l.id === fragile).pinned === true && rA.mute === true && rA.learnedSessions === 1 && h.book.view(C).lessons[0].key === 'cargo build',
      'dopo un riavvio il Libro si rilegge dallo storico: lezioni, conteggi, lezioni fissate, "non parlare agli agenti", sessioni già lette');
    const ev = rA.lessons.find(l => l.id === fragile).evidence[0].excerpt;
    ok(ev === 'TypeError in C:\\Users\\mario\\x.js con password=[secret]' || !ev.includes('hunter2'), 'le prove delle lezioni passano dal filtro dei segreti');
    h.book.act(A, 'forget', fragile);
    h.book.save();
    ok(h.store.collection('lessons').get(`${K}:${fragile}`) === null && h.store.collection('projects').get(K).forgotten[fragile] > 0 && h.store.collection('lessons').count({ project: K }) === 2,
      '«Dimentica» toglie la lezione anche dallo storico, e se ne ricorda');
    h.close();

    // la chiave arriva da git dopo: il Libro aperto con la chiave della cartella passa al progetto, senza doppioni
    const D = path.join(tmp, 'terza-copia', 'platypus');
    remotes[normDir(D)] = 'ssh://git@github.com/m4xl4b/platypus';
    h = mk();
    let release;
    const slow = new Promise(r => { release = r; });
    h.keys.exec = async cwd => { await slow; return remotes[normDir(cwd)] || null; };
    h.book.learn(D, [c('slow-step', 'npm run build', 's5', T + 6, '7 min')]);
    const early = h.book.view(D).key;
    h.book.save(); // salvato con la chiave della cartella, prima che git risponda
    const storedEarly = h.store.collection('lessons').count({ project: projectKey(D) });
    release(); await h.keys.resolve(D);
    const after = h.book.view(D);
    h.book.save();
    ok(early === projectKey(D) && storedEarly === 1 && after.key === K && after.lessons.some(l => l.kind === 'slow-step') && after.lessons.length === 3 && h.store.collection('lessons').count({ project: projectKey(D) }) === 0 &&
      h.store.collection('lessons').count({ project: K }) === 3 && h.store.collection('projects').get(projectKey(D)) === null && Object.keys(h.store.collection('projects').get(K).aliases).includes(projectKey(D)),
      'un Libro aperto prima che git risponda passa sotto la chiave del progetto, anche nello storico, senza lasciare doppioni');
    h.close();

    // la demo non scrive niente nello storico, nemmeno il progetto
    h = mk();
    const before = JSON.stringify(['projects', 'lessons'].map(n => h.store.collection(n).count({})));
    h.book.seedDemo('C:/Progetti/portale-clienti', [c('ghost-path', 'src/x.ts', 'demo-1', T), c('ghost-path', 'src/x.ts', 'demo-2', T + 1)]);
    h.book.learn('C:/Progetti/portale-clienti', [c('flaky-command', 'npm test', 'demo-3', T + 2)]);
    const demoView = h.book.view('C:/Progetti/portale-clienti');
    h.book.save();
    ok(demoView.lessons.length === 2 && JSON.stringify(['projects', 'lessons'].map(n => h.store.collection(n).count({}))) === before && h.keys.byDir.size === 0 && h.keys.pending.size === 0 && h.book.list().some(b => b.cwd === 'C:/Progetti/portale-clienti'),
      'il Libro della demo resta in memoria: niente nello storico, nemmeno una domanda a git; nella scheda dell\'atrio si vede');
    h.book.dropDemo();
    h.close();

    // la scheda dell'atrio: solo i Libri di cui si conosce la cartella
    h = mk(key => (key === K ? A : ''));
    const list = h.book.list();
    ok(list.length === 1 && list[0].key === K && list[0].cwd === A && list[0].lessons === 3 && list[0].name === 'platypus' && h.book.cwdOfKey(K) === A && h.book.cwdOfKey(projectKey(C)) === '',
      'la scheda dell\'atrio elenca i Libri dello storico di cui il motore conosce la cartella');
    h.close();

    let rawBytes = '';
    for (const f of fs.readdirSync(dir)) rawBytes += fs.readFileSync(path.join(dir, f)).toString('latin1');
    const leaks = [tmp.replace(/\\/g, '/'), tmp, 'Lavoro', 'copie', 'terza-copia', 'mario', 'hunter2'].filter(x => rawBytes.includes(x));
    ok(leaks.length === 0 && rawBytes.includes('npm run test:e2e') && !fs.existsSync(path.join(tmp, 'bottega')), 'nel file del database non c\'è la cartella di nessun progetto, e non c\'è più una cartella bottega' + (leaks.length ? ': ' + leaks.join(', ') : ''));
  } finally {
    for (const st of open) { try { st.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S9: i passi e i riassunti delle sessioni, come li scrive il motore (src/core/history.js)
async function historyTests(ok) {
  console.log('store: passi e sessioni');
  const { History, FLUSH_DOCS } = require(path.join(ROOT, 'src', 'core', 'history'));
  const { pathKey } = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-passi-'));
  const logs = [];
  const mk = () => { const h = new History({ dir: path.join(tmp, 'dati'), backend: 'sqlite', log: m => logs.push(m) }); h.keys.exec = async () => null; return h; };
  const CWD = path.join(tmp, 'Progetto Segreto'), T = 1763500000000;
  const sess = (id, extra = {}) => ({ id, cwd: CWD, kind: 'code', createdAt: T, lastActivity: T + 5000, ended: false, demo: false, main: { id: 'main', model: 'claude-opus-5-5', effort: 'high' }, subs: new Map([['a1', {}]]),
    tok: { in: 100, out: 50, cr: 10, cw: 5 }, toolsByType: { Claude: 7, Explore: 2 }, errByType: { Claude: 1 }, ...extra });
  const step = (id, extra = {}) => ({ id, t: T + 1000, tool: 'Bash', act: 'verify', target: 'cmd:npm', sig: 'run:cd app && CI=1 npm test 2>&1 | tail', err: true, dur: 4200, phase: 'test',
    fail: { kind: 'test', excerpt: 'FAIL src/a.test.js:12 expected "x" to equal 3' }, ...extra });
  let h;
  try {
    h = mk();
    const s1 = sess('sess-0001'), main = { id: 'main' };
    h.recordStep(s1, main, step('toolu_1'));
    h.recordStep(s1, main, step('toolu_1')); // la stessa azione, riletta all'avvio
    h.recordStep(s1, { id: 'agent-7' }, step('toolu_2', { act: 'edit', tool: 'Edit', target: 'src/a.js', sig: 'Edit:src/a.js', err: false, fail: null, phase: '' }));
    h.recordStep(s1, main, step('toolu_3', { act: 'web', tool: 'WebSearch', target: 'web:?come rubare password del vicino', err: false, fail: null }));
    h.recordStep(s1, main, step('toolu_4', { act: 'web', tool: 'WebFetch', target: 'web:api.example.org/v1/ghp_abcdefghijklmnopqrstuvwxyz012345', err: false, fail: null }));
    h.recordStep({ ...s1, id: 'demo-1', demo: true }, main, step('toolu_5'));
    h.recordStep({ ...s1, id: 'no-cwd', cwd: '' }, main, step('toolu_6'));
    h.recordStep(s1, main, { ...step('toolu_7'), id: undefined });
    const steps = h.store.collection('steps');
    const before = steps.count({});
    const n = h.flush();
    const s0 = steps.get('sess-0001:toolu_1'), s2 = steps.get('sess-0001:toolu_2');
    ok(before === 0 && n === 4 && steps.count({}) === 4 && steps.count({ session: 'demo-1' }) === 0 && steps.count({ session: 'no-cwd' }) === 0,
      'i passi aspettano in coda e vanno nello storico tutti insieme; la stessa azione due volte è un passo solo; la demo e le sessioni senza cartella non lasciano niente');
    ok(s0.project === pathKey(CWD) && s0.t === T + 1000 && s0.session === 'sess-0001' && s0.agent === 'main' && s0.action === 'verify' && s0.tool === 'Bash' && s0.target === 'cmd:npm' && s0.outcome === 'error' &&
      s0.cmd === 'npm test' && s0.fail === 'test' && s0.err === 'FAIL <path>:N expected <…> to equal N' && s0.dur === 4200 && s0.phase === 'test' && s2.agent === 'agent-7' && s2.outcome === 'ok' && s2.target === 'src/a.js' && !('err' in s2) && !('cmd' in s2),
      'un passo: progetto, quando, chi, che cosa, su che cosa, com\'è finita, il cuore del comando e la firma dell\'errore');
    ok(steps.get('sess-0001:toolu_3').target === 'web:?' && steps.get('sess-0001:toolu_4').target === 'web:api.example.org/v1/[token]', 'di una ricerca resta solo che c\'è stata; un token nell\'indirizzo non passa');
    // a 500 si scrive subito, senza aspettare
    for (let i = 0; i < FLUSH_DOCS; i++) h.recordStep(s1, main, step('bulk-' + i, { err: false, fail: null }));
    ok(h.pending.size === 0 && steps.count({}) === 4 + FLUSH_DOCS, `con ${FLUSH_DOCS} passi in coda si scrive subito, in una volta`);
    // i riassunti: solo quando cambiano
    const state = { sessions: new Map([[s1.id, s1], ['demo-1', { ...s1, id: 'demo-1', demo: true }]]), costOf: s => (s.id === 'sess-0001' ? 1.25 : 9) };
    const w1 = h.summarize(state), w2 = h.summarize(state);
    s1.toolsByType.Claude = 8; s1.ended = true; s1.endedAt = T + 9000;
    const w3 = h.summarize(state);
    h.flush();
    const sum = h.store.collection('sessions').get('sess-0001');
    ok(w1 === 1 && w2 === 0 && w3 === 1 && sum.project === pathKey(CWD) && sum.t === T && sum.end === T + 9000 && sum.kind === 'code' && sum.model === 'claude-opus-5-5' && sum.effort === 'high' && sum.agents === 2 &&
      sum.actions === 10 && sum.errors === 1 && sum.cost === 1.25 && sum.tokens === 165 && h.store.collection('sessions').count({}) === 1,
      'il riassunto di una sessione: si riscrive solo quando cambia, mai per la demo');
    // un documento che la guardia rifiuta non fa perdere gli altri
    h.store.guardMode = 'reject';
    h.recordStep(s1, main, step('ok-1', { err: false, fail: null }));
    h.recordStep({ ...s1, id: 'sessione con spazi' }, main, step('bad-1'));
    h.recordStep(s1, main, step('ok-2', { err: false, fail: null }));
    const got = h.flush();
    ok(got === 2 && steps.get('sess-0001:ok-1') && steps.get('sess-0001:ok-2') && !steps.get('sessione con spazi:bad-1') && logs.some(m => /1 documenti non salvati/.test(m)), 'un passo che la guardia rifiuta non fa perdere gli altri, e si scrive nel registro');
    // alla chiusura la coda va nello storico
    h.recordStep(s1, main, step('last-1', { err: false, fail: null }));
    h.stop();
    h = mk();
    ok(h.store.collection('steps').get('sess-0001:last-1') !== null, 'alla chiusura la coda va nello storico');
    let rawBytes = '';
    h.stop(); h = null;
    for (const f of fs.readdirSync(path.join(tmp, 'dati'))) if (f.startsWith('platypus.db')) rawBytes += fs.readFileSync(path.join(tmp, 'dati', f)).toString('latin1');
    const leaks = ['Progetto Segreto', 'rubare', 'ghp_abcdef', 'cd app', 'tail', 'CI=1', 'a.test.js:12'].filter(x => rawBytes.includes(x));
    ok(leaks.length === 0 && rawBytes.includes('npm test'), 'nel file del database non c\'è la cartella, la ricerca, i token né il comando intero' + (leaks.length ? ': ' + leaks.join(', ') : ''));
  } finally {
    if (h) { try { h.stop(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S10: conservazione per collezione e limite di dimensione (src/core/retention.js)
async function retentionTests(ok) {
  console.log('store: conservazione e dimensione');
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { declareCollections } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
  const { runRetention, retentionFromSettings, maxBytes } = require(path.join(ROOT, 'src', 'core', 'retention'));
  const { Bottega } = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const { ProjectKeys } = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const DAY = 86400000, NOW = Date.now();
  ok(JSON.stringify(retentionFromSettings({ storeKeepSteps: 30, storeKeepSessions: 0, storeKeepFeedback: '400', storeKeepLessons: -5, other: 1 })) === '{"steps":30,"sessions":0,"feedback":400,"experiments":400}' &&
    JSON.stringify(retentionFromSettings({ storeKeepSteps: 99999 })) === '{"steps":3650}' && maxBytes({}) === 200 * 1048576 && maxBytes({ storeMaxMB: 0 }) === 0 && maxBytes({ storeMaxMB: 'boh' }) === 0,
    'dalle opzioni: giorni per collezione (0 = per sempre, al massimo 10 anni, i valori senza senso non contano) e il limite in MB');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-conserva-'));
  const open = [];
  try {
    for (const backend of ['memory', 'sqlite']) {
      const store = declareCollections(openStore({ backend, dir: path.join(tmp, backend), guard: 'reject', requireFields: true }));
      open.push(store);
      const steps = store.collection('steps'), sessions = store.collection('sessions'), fb = store.collection('feedback'), ex = store.collection('experiments'), les = store.collection('lessons'), daily = store.collection('daily'), projects = store.collection('projects');
      store.transaction(() => {
        for (let d = 0; d < 200; d++) for (let k = 0; k < 6; k++) steps.put({ _id: `s${d}-${k}`, project: 'p', t: NOW - d * DAY - k, session: 's' + d, action: 'read', tool: 'Read', outcome: 'ok' });
        for (let d = 0; d < 400; d += 10) { sessions.put({ _id: 'sess' + d, project: 'p', t: NOW - d * DAY, actions: 1 }); fb.put({ _id: 'fb' + d, project: 'p', t: NOW - d * DAY, feature: 'loop', mode: 'on', text: 'Platypus: x' }); ex.put({ _id: 'ex' + d, project: 'p', t: NOW - d * DAY, sid: 's', feature: 'loop', group: 'on' }); }
        const L = (id, days, count, sess, pinned) => les.put({ _id: 'p:' + id, project: 'p', t: NOW - days * DAY, lesson: id, kind: 'flaky-command', key: 'npm test ' + id, count, sessions: Array.from({ length: sess }, (_, i) => 's' + i), first: NOW - days * DAY, last: NOW - days * DAY, evidence: [], seen: [], pinned, ignored: false });
        L('old-weak', 200, 1, 1, false); L('old-pinned', 300, 1, 1, true); L('old-strong', 200, 400, 50, false); L('new-weak', 10, 1, 1, false);
        daily.put({ _id: 'day:2020-01-01', t: NOW - 2000 * DAY, kind: 'day', day: '2020-01-01', alerts: 1 });
        projects.put({ _id: 'p', name: 'progetto', firstSeen: NOW - 3000 * DAY, lastSeen: NOW });
      });
      const book = new Bottega({ store, keys: new ProjectKeys({ store, exec: async () => null }), log() {} });
      book.books.set('p', { key: 'p', name: 'progetto', cwd: '/p', lessons: { 'old-weak': { id: 'old-weak' }, 'new-weak': { id: 'new-weak' } }, learned: {}, forgotten: {}, mute: false, strays: new Set(), dirty: false });
      const r = await runRetention({ store, bottega: book, settings: {}, now: NOW });
      ok(r.removed.steps === 659 && steps.count({}) === 541 && steps.find({}, { sort: { t: 1 }, limit: 1 })[0].t >= NOW - 90 * DAY && r.removed.sessions === 3 && sessions.count({}) === 37 && r.removed.feedback === 3 && r.removed.experiments === 3,
        `${backend}: di base i passi restano 90 giorni, sessioni, messaggi ed esperimenti 365 (${JSON.stringify(r.removed)})`);
      ok(les.get('p:old-weak') === null && les.get('p:old-pinned') !== null && les.get('p:old-strong') !== null && les.get('p:new-weak') !== null && r.removed.lessons === 1 && !book.books.get('p').lessons['old-weak'] && book.books.get('p').lessons['new-weak'],
        `${backend}: delle lezioni vecchie se ne vanno solo le deboli non fissate, anche dal Libro in memoria`);
      ok(daily.get('day:2020-01-01') !== null && projects.get('p') !== null && JSON.parse(store.getMeta('retentionLast')).at === NOW, `${backend}: statistiche e progetti restano; quello che è successo resta scritto per le opzioni`);
      const r2 = await runRetention({ store, bottega: book, settings: { storeKeepSteps: 30, storeKeepSessions: 0 }, now: NOW });
      ok(steps.count({}) === 181 && sessions.count({}) === 37 && r2.removed.steps === 360 && !('sessions' in r2.removed), `${backend}: la conservazione scelta nelle opzioni (passi 30 giorni, sessioni per sempre)`);
      const again = await runRetention({ store, bottega: book, settings: { storeKeepSteps: 30, storeKeepSessions: 0 }, now: NOW });
      ok(Object.values(again.removed).every(n => n === 0) && again.trimmedForSize === 0, `${backend}: rifarlo subito non toglie niente`);
      book.stop();
    }
    // il limite di dimensione: con sqlite, i passi più vecchi se ne vanno finché lo storico ci sta
    const dir = path.join(tmp, 'grande');
    const store = declareCollections(openStore({ backend: 'sqlite', dir, guard: 'reject', requireFields: true }));
    open.push(store);
    const steps = store.collection('steps');
    for (let b = 0; b < 20; b++) store.transaction(() => { for (let i = 0; i < 1000; i++) { const n = b * 1000 + i; steps.put({ _id: 'x' + String(n).padStart(6, '0'), project: 'p', t: NOW - (20000 - n) * 1000, session: 's', action: 'read', tool: 'Read', outcome: 'ok', target: 'src/' + 'cartella/'.repeat(8) + n + '.js' }); } });
    const before = store.driver.usedBytes(), limitMB = Math.floor(before / 1048576 / 2) || 1;
    const t0 = Date.now();
    const r = await runRetention({ store, settings: { storeMaxMB: limitMB }, now: NOW });
    const left = steps.find({}, { sort: { t: 1 }, limit: 1 })[0];
    ok(before > 2 * 1048576 && r.trimmedForSize > 0 && r.usedBytes <= limitMB * 1048576 && steps.count({}) === 20000 - r.trimmedForSize && left._id === 'x' + String(r.trimmedForSize).padStart(6, '0') && Date.now() - t0 < 10000,
      `limite di dimensione: da ${(before / 1048576).toFixed(1)} MB a sotto ${limitMB} MB togliendo i ${r.trimmedForSize} passi più vecchi`);
    const r3 = await runRetention({ store, settings: { storeMaxMB: 0 }, now: NOW });
    ok(r3.trimmedForSize === 0 && r3.limitBytes === 0, 'senza limite (0) non si toglie niente per la dimensione');
    const mem = declareCollections(openStore({ backend: 'memory' }));
    ok((await runRetention({ store: mem, settings: { storeMaxMB: 1 }, now: NOW })).usedBytes === null && await runRetention({ store: null }) === null, 'in memoria la dimensione non conta; senza store non fa niente');
  } finally {
    for (const st of open) { try { st.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// S10: "Dimentica questo progetto", "Compatta", "Esporta"
async function forgetTests(ok) {
  console.log('store: dimentica, compatta, esporta');
  const { History } = require(path.join(ROOT, 'src', 'core', 'history'));
  const { Bottega } = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const { Stats } = require(path.join(ROOT, 'src', 'core', 'stats'));
  const { FeedbackLog } = require(path.join(ROOT, 'src', 'core', 'feedbacklog'));
  const { keyFor, pathKey, normDir } = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-dimentica-'));
  const A = path.join(tmp, 'progetto-segreto'), B = path.join(tmp, 'altro-lavoro');
  const RA = 'git@github.com:m4xl4b/repo-segretissimo.git', KA = keyFor(A, RA).key, KB = pathKey(B);
  const T = Date.now() - 3600000;
  let h;
  try {
    h = new History({ dir: path.join(tmp, 'dati'), backend: 'sqlite', log() {} });
    h.keys.exec = async cwd => (normDir(cwd) === normDir(A) ? RA : null);
    await h.keys.resolve(A); await h.keys.resolve(B);
    const sess = (id, cwd) => ({ id, cwd, kind: 'code', createdAt: T, lastActivity: T + 1, main: { id: 'main', model: 'm' }, subs: new Map(), tok: { in: 1, out: 1, cr: 0, cw: 0 }, toolsByType: { Claude: 1 }, errByType: {}, completedByType: {}, wByType: {}, completed: 0, releases: [], alerts: [], project: path.basename(cwd) });
    const sA = sess('sess-segreta-1', A), sB = sess('sess-altra-1', B);
    const state = { sessions: new Map([[sA.id, sA], [sB.id, sB]]), label: s => s.project, costOf: () => 0.5, rateOf: () => 0 };
    const bottega = new Bottega({ store: h.store, keys: h.keys, log() {} });
    const stats = new Stats(state, { store: h.store, log() {} });
    const log = new FeedbackLog({ store: h.store, keys: h.keys });
    const c = (kind, key, sid) => ({ kind, key, sid, t: T, agent: 'Claude', excerpt: 'riga' });
    bottega.learn(A, [c('flaky-command', 'npm run e2e-segreto', 'sess-segreta-1'), c('ghost-path', 'src/segreto.ts', 'sess-segreta-1')]);
    bottega.learn(B, [c('flaky-command', 'cargo test', 'sess-altra-1')]);
    bottega.save();
    for (const [s0, id] of [[sA, 't1'], [sA, 't2'], [sB, 't3']]) h.recordStep(s0, { id: 'main' }, { id, t: T, tool: 'Bash', act: 'run', target: 'cmd:npm', sig: 'run:npm test', err: false, dur: 1, phase: '' });
    h.summarize(state);
    log.append(A, { t: T, sid: sA.id, agent: 'main', feature: 'loop', mode: 'on', event: 'PreToolUse', text: 'Platypus: progetto-segreto loop' });
    log.append(B, { t: T, sid: sB.id, agent: 'main', feature: 'loop', mode: 'on', event: 'PreToolUse', text: 'Platypus: altro' });
    h.store.collection('experiments').put({ _id: sA.id + ':loop', project: KA, t: T, sid: sA.id, feature: 'loop', group: 'on' });
    stats.data.days['2026-11-18'] = { projects: { 'progetto-segreto': { cost: 1, tokens: 1, sessions: [sA.id], completed: 1, commits: 1, prs: 0, tests: 0, wing: 'code' }, 'altro-lavoro': { cost: 2, tokens: 2, sessions: [sB.id], completed: 1, commits: 0, prs: 0, tests: 0, wing: 'code' } },
      releases: [{ t: T, kind: 'commit', text: 'fix progetto-segreto', agent: 'Claude', project: 'progetto-segreto' }, { t: T, kind: 'commit', text: 'altro', agent: 'Claude', project: 'altro-lavoro' }], alerts: 0 };
    stats.data.last[sA.id] = { t: T, cost: 1, tok: 1, completed: 1, cbt: {}, err: {}, tools: {}, costType: {}, rel: '', alerts: [], name: 'progetto-segreto' };
    stats.data.last[sB.id] = { t: T, cost: 2, tok: 2, completed: 1, cbt: {}, err: {}, tools: {}, costType: {}, rel: '', alerts: [], name: 'altro-lavoro' };
    stats.dirty = true; stats.save(); h.flush();
    const count = key => ['lessons', 'steps', 'sessions', 'feedback', 'experiments'].reduce((n, x) => n + h.store.collection(x).count({ project: key }), 0) + (h.store.collection('projects').get(key) ? 1 : 0);
    const beforeA = count(KA), beforeB = count(KB);
    // in coda, non ancora scritto: anche questo va dimenticato
    h.recordStep(sA, { id: 'main' }, { id: 't9', t: T, tool: 'Read', act: 'read', target: 'src/segreto.ts', sig: 'Read', err: false, dur: 1, phase: '' });
    const r = h.forgetProject(KA, { state, bottega, stats });
    const day = stats.data.days['2026-11-18'], stored = h.store.collection('daily').get('day:2026-11-18');
    ok(beforeA === 8 && r.documents === 8 && count(KA) === 0 && count(pathKey(A)) === 0 && h.store.collection('steps').count({ session: sA.id }) === 0 && count(KB) === beforeB && bottega.view(B).lessons.length === 1,
      `dimentica: ${r.documents} documenti del progetto via da ogni collezione (anche quello in coda); l'altro progetto resta com'era`);
    ok(!day.projects['progetto-segreto'] && day.projects['altro-lavoro'] && day.releases.length === 1 && !stats.data.last[sA.id] && stats.data.last[sB.id] && !stored.projects['progetto-segreto'] && stored.releases.every(x => x.project !== 'progetto-segreto') && r.stats === 2,
      'dimentica: anche le statistiche, che tengono i progetti per nome (la voce del giorno, i suoi rilasci, l\'ultimo stato della sessione)');
    ok(!bottega.books.has(KA) && r.books === 1 && r.size && r.size.after <= r.size.before, 'dimentica: il Libro esce dalla memoria e il database viene compattato');
    stats.stop(); bottega.stop();
    let raw = '';
    for (const f of fs.readdirSync(path.join(tmp, 'dati'))) if (f.startsWith('platypus.db')) raw += fs.readFileSync(path.join(tmp, 'dati', f)).toString('latin1');
    const leaks = [KA, pathKey(A), 'progetto-segreto', 'repo-segretissimo', 'e2e-segreto', 'segreto.ts', 'sess-segreta-1', A.replace(/\\/g, '/'), A].filter(x => raw.includes(x));
    ok(leaks.length === 0 && raw.includes('altro-lavoro') && raw.includes('cargo test'), 'dimentica: nel file del database (e nel WAL) non c\'è più la chiave, la cartella, il nome, il remote né le lezioni del progetto' + (leaks.length ? ': ' + leaks.join(', ') : ''));
    // dopo, il progetto può ricominciare da capo
    const b2 = new Bottega({ store: h.store, keys: h.keys, log() {} });
    b2.learn(A, [c('loop-trap', 'make', 'sess-nuova')]);
    ok(b2.view(A).lessons.length === 1 && b2.view(A).lessons[0].kind === 'loop-trap', 'dopo «Dimentica» il progetto ricomincia con un Libro vuoto');
    b2.stop();
    ok(h.forgetProject('non-una-chiave') === null && h.forgetProject('0123456789abcdef').documents === 0, 'dimentica: una chiave non valida è rifiutata, una sconosciuta non toglie niente');
    // compatta ed esporta
    const cp = h.compact();
    ok(cp && cp.after <= cp.before && cp.after > 0, `compatta: ${cp.before} → ${cp.after} byte`);
    const out = path.join(tmp, 'export');
    const ex = h.exportAll(out);
    const files = fs.readdirSync(out).sort();
    const lines = f => fs.readFileSync(path.join(out, f), 'utf8').split('\n').filter(Boolean).length;
    ok(ex.dir === out && files.join() === 'daily.jsonl,experiments.jsonl,feedback.jsonl,lessons.jsonl,projects.jsonl,sessions.jsonl,steps.jsonl' && ex.files.every(f => lines(f.file) === f.count && f.count === h.store.collection(f.collection).count({})),
      'esporta: un file JSONL per collezione, con tutti i documenti');
    const home = path.join(tmp, 'casa'), prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const d1 = h.exportAll(), d2 = h.exportAll();
      ok(path.dirname(d1.dir) === path.join(home, 'Downloads') && /^platypus-export-\d{8}-\d{4}$/.test(path.basename(d1.dir)) && d2.dir === d1.dir + '-2' && fs.readdirSync(d2.dir).length === 7, 'esporta: di base in Scaricati/platypus-export-<data>, senza mai sovrascrivere un\'esportazione di prima');
    } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  } finally {
    if (h) { try { h.stop(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { run: async ok => { await run(ok); await failureTests(ok); await projectKeyTests(ok); await privacyTests(ok); await collectionsTests(ok); await legacyTests(ok); await bookTests(ok); await historyTests(ok); await retentionTests(ok); await forgetTests(ok); } };
if (require.main === module) {
  let failed = 0;
  module.exports.run((c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failed++; })
    .then(() => { console.log(failed ? `\n${failed} prove fallite.` : '\nTutto a posto.'); process.exit(failed ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
