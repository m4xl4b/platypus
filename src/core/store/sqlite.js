'use strict';
// Backend `sqlite`: lo store su disco, con il SQLite incorporato in Node.js (node:sqlite, nessuna dipendenza).
// Un file solo, <cartella>/platypus.db, in modalità WAL.
//
// Stesso contratto di memory.js (il "driver" sotto Store, vedi index.js). In più:
//   - una tabella per collezione, c_<nome>: _id TEXT PRIMARY KEY, project TEXT, t INTEGER, doc TEXT (JSON).
//     _id, project e t stanno solo nelle colonne: nel JSON non si ripetono (su un milione di righe conta);
//   - gli indici dichiarati sono indici su espressioni json_extract (o sulle colonne, per project, t e _id);
//   - il filtro diventa SQL con i valori sempre come parametri. I nomi dei campi finiscono nel testo dell'SQL solo
//     se sono fatti di lettere, cifre, spazi, "_" e "-"; con un nome più strano il filtro si valuta qui, in
//     JavaScript, con la stessa funzione di memory.js: più lento, ma uguale e senza rischi;
//   - coda di scrittura per append: le righe aspettano in memoria e vanno su disco in una sola transazione al
//     massimo ogni 2 s, o quando sono 500, o alla chiusura. Ogni lettura e ogni altra scrittura la svuota prima,
//     quindi chi legge vede sempre tutto;
//   - all'apertura (S4): PRAGMA quick_check (per i file grandi dopo, in un thread a parte: checkInBackground),
//     le migrazioni dello schema (migrations.js) e una scrittura di prova.
//     Se qualcosa non va il costruttore lancia uno StoreError con il motivo nel codice: 'corrupt' (file rovinato),
//     'unopenable' (non si apre o non si scrive), 'newer-schema', 'migration-failed'. Chi apre lo store con
//     openStoreSafe (index.js) a quel punto ripiega sulla memoria: niente si ferma.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { matches, comparator, project, fail, StoreError } = require('./common');
const { loadSqlite } = require('./sqlite-load');
const { migrate, setMeta, getMeta, schemaVersion } = require('./migrations');

const FLUSH_MS = 2000, FLUSH_DOCS = 500, STMT_CACHE = 200;
// oltre questa dimensione il controllo del file (PRAGMA quick_check, che legge tutte le pagine: 600 ms su 355 MB)
// non si fa all'apertura ma dopo, in un thread a parte (checkInBackground), così l'ufficio non aspetta
const CHECK_LIMIT = 64 * 1024 * 1024;
const CHECK_NEEDED = 'checkNeeded'; // segno in meta: il controllo in background ha trovato un danno, al prossimo avvio si fa subito
const SAFE_SEGMENT = /^[A-Za-z0-9_ -]+$/;
const NUM = "('integer','real')";

// dove sta un campo: una colonna, oppure un'espressione sul JSON; null se il nome non può stare nell'SQL
function fieldOf(p) {
  if (p === '_id') return { col: '_id', kind: 'text' };
  if (p === 'project') return { col: 'project', kind: 'text' };
  if (p === 't') return { col: 't', kind: 'num' };
  const segs = p.split('.');
  // sotto _id, project e t non c'è niente (sono una stringa e un numero): il campo manca sempre
  if (['_id', 'project', 't'].includes(segs[0])) return { none: true };
  if (!segs.every(s => SAFE_SEGMENT.test(s))) return null;
  const jp = `'$.${segs.map(s => `"${s}"`).join('.')}'`;
  return { e: `json_extract(doc,${jp})`, ty: `json_type(doc,${jp})` };
}

// un nodo dell'albero del filtro (common.js) → SQL; i valori vanno in `params`. null se non si può tradurre.
function nodeSql(node, params) {
  if (node.and) {
    const parts = [];
    for (const n of node.and) { const s = nodeSql(n, params); if (s === null) return null; parts.push(s); }
    return parts.length ? `(${parts.join(' AND ')})` : '1';
  }
  if (node.or) {
    const parts = [];
    for (const n of node.or) { const s = nodeSql(n, params); if (s === null) return null; parts.push(s); }
    return `(${parts.join(' OR ')})`;
  }
  const f = fieldOf(node.path);
  if (f === null) return null;
  const x = node.value;
  const eq = v => {
    if (f.none) return v === null ? '1' : '0';
    if (f.col) {
      if (v === null) return f.col === '_id' ? '0' : `${f.col} IS NULL`;
      if ((f.kind === 'text') !== (typeof v === 'string') || typeof v === 'boolean') return '0';
      params.push(v);
      return `${f.col} = ?`;
    }
    if (v === null) return `${f.e} IS NULL`;
    if (typeof v === 'boolean') return `${f.ty} = '${v}'`;
    params.push(v);
    return typeof v === 'string' ? `(${f.e} = ? AND ${f.ty} = 'text')` : `(${f.e} = ? AND ${f.ty} IN ${NUM})`;
  };
  switch (node.op) {
    case 'eq': return eq(x);
    case 'in': return x.length ? `(${x.map(eq).join(' OR ')})` : '0';
    case 'exists': {
      if (f.none) return x ? '0' : '1';
      if (f.col) return f.col === '_id' ? (x ? '1' : '0') : `${f.col} IS ${x ? 'NOT ' : ''}NULL`;
      return `${f.ty} IS ${x ? 'NOT ' : ''}NULL`;
    }
    default: {
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[node.op];
      if (f.none) return '0';
      if (f.col) {
        if ((f.kind === 'text') !== (typeof x === 'string')) return '0';
        params.push(x);
        return `${f.col} ${sym} ?`;
      }
      params.push(x);
      return typeof x === 'string' ? `(${f.e} ${sym} ? AND ${f.ty} = 'text')` : `(${f.e} ${sym} ? AND ${f.ty} IN ${NUM})`;
    }
  }
}

// ORDER BY: mancante o null, poi numeri, poi stringhe (come common.js); a parità _id crescente. null se non si può.
function orderSql(sort) {
  const parts = [];
  let hasId = false;
  for (const s of sort) {
    const f = fieldOf(s.path), dir = s.dir === -1 ? 'DESC' : 'ASC';
    if (f === null) return null;
    if (f.none) continue;
    if (f.col) { parts.push(`${f.col} ${dir}`); if (f.col === '_id') hasId = true; continue; } // NULL per primo: è già l'ordine di SQLite
    parts.push(`CASE WHEN ${f.ty} IN ${NUM} THEN 1 WHEN ${f.ty} = 'text' THEN 2 WHEN ${f.ty} IS NULL OR ${f.ty} = 'null' THEN 0 ELSE 3 END ${dir}`);
    parts.push(`CASE WHEN ${f.ty} IN ('integer','real','text') THEN ${f.e} END ${dir}`);
  }
  if (!hasId) parts.push('_id ASC');
  return parts.join(', ');
}

class SqliteDriver {
  constructor(opts = {}) {
    const sqlite = loadSqlite();
    if (!sqlite) fail('backend-unavailable', 'node:sqlite non c\'è in questo Node.js (serve la 22.13 o più recente)');
    if (typeof opts.dir !== 'string' || !opts.dir) fail('invalid-argument', 'il backend sqlite vuole la cartella dei dati (dir)');
    this.name = 'sqlite';
    this.persistent = true;
    this.file = path.join(opts.dir, 'platypus.db');
    this.db = null;
    try {
      fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
      this.db = new sqlite.DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
      const limit = Number.isFinite(opts.checkLimit) ? opts.checkLimit : CHECK_LIMIT;
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch {}
      let checkNow = size <= limit;
      if (!checkNow) { try { checkNow = getMeta(this.db, CHECK_NEEDED) === '1'; } catch { checkNow = true; } }
      if (checkNow) {
        const check = this.db.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]);
        if (check[0] !== 'ok') fail('corrupt', `quick_check: ${check.slice(0, 3).join('; ').replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      this.checkLater = !checkNow;
      this.migration = migrate(this.db, this.file, opts.migrations);
      setMeta(this.db, 'lastOpen', Date.now()); // una scrittura vera: un file o una cartella di sola lettura si scoprono qui
      if (checkNow && size > limit) setMeta(this.db, CHECK_NEEDED, '0');
    } catch (e) {
      try { if (this.db) this.db.close(); } catch {}
      this.db = null;
      if (e instanceof StoreError) throw e;
      const msg = String(e && e.message || e);
      fail(/not a database|malformed|corrupt/i.test(msg) ? 'corrupt' : 'unopenable', msg);
    }
    this.stmts = new Map();
    this.inTx = false;
    this.queue = [];       // righe di append che aspettano: { name, doc }
    this.queued = new Set(); // "collezione\n_id" delle righe in coda, per accorgersi dei doppioni
    this.timer = null;
    this.flushMs = Number.isFinite(opts.flushMs) ? opts.flushMs : FLUSH_MS;
    this.flushDocs = Number.isInteger(opts.flushDocs) && opts.flushDocs > 0 ? opts.flushDocs : FLUSH_DOCS;
    this.onError = typeof opts.onError === 'function' ? opts.onError : e => console.error('[platypus] store: ' + (e && e.message || e));
  }

  stmt(sql) {
    let s = this.stmts.get(sql);
    if (s) return s;
    if (this.stmts.size >= STMT_CACHE) this.stmts.clear();
    this.stmts.set(sql, s = this.db.prepare(sql));
    return s;
  }
  // una scrittura di più istruzioni: tutta o niente, anche fuori da una transazione di chi chiama
  atomic(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  // ------------------------------------------------------------ collezioni e indici
  ensureCollection(decl) {
    const table = `c_${decl.name}`;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (_id TEXT PRIMARY KEY, project TEXT, t INTEGER, doc TEXT NOT NULL)`);
    const want = new Map();
    for (const ix of decl.indexes) {
      const exprs = ix.map(p => { const f = fieldOf(p); return f && (f.col || f.e); });
      if (exprs.some(e => !e)) continue; // un nome che non può stare nell'SQL: niente indice (common.js li rifiuta già)
      if (exprs.length === 1 && exprs[0] === '_id') continue; // c'è già: è la chiave
      want.set(`ix_${decl.name}_${crypto.createHash('sha1').update(JSON.stringify(ix)).digest('hex').slice(0, 10)}`, exprs);
    }
    const have = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'ix\\_%' ESCAPE '\\'").all(table).map(r => r.name);
    for (const n of have) if (!want.has(n)) this.db.exec(`DROP INDEX IF EXISTS "${n}"`);
    for (const [n, exprs] of want) this.db.exec(`CREATE INDEX IF NOT EXISTS "${n}" ON ${table} (${exprs.join(', ')})`);
  }

  // ------------------------------------------------------------ righe e documenti
  toRow(doc) {
    const rest = {};
    for (const k of Object.keys(doc)) if (k !== '_id' && k !== 'project' && k !== 't') rest[k] = doc[k];
    return [doc._id, doc.project === undefined ? null : doc.project, doc.t === undefined ? null : doc.t, JSON.stringify(rest)];
  }
  toDoc(row) {
    const doc = { _id: row._id };
    if (row.project !== null) doc.project = row.project;
    if (row.t !== null) doc.t = row.t;
    return Object.assign(doc, JSON.parse(row.doc));
  }

  get(name, id) {
    this.flush();
    const row = this.stmt(`SELECT _id, project, t, doc FROM c_${name} WHERE _id = ?`).get(id);
    return row ? this.toDoc(row) : undefined;
  }
  put(name, doc) {
    this.flush();
    this.stmt(`INSERT INTO c_${name} (_id, project, t, doc) VALUES (?, ?, ?, ?) ON CONFLICT(_id) DO UPDATE SET project = excluded.project, t = excluded.t, doc = excluded.doc`).run(...this.toRow(doc));
  }
  insertNow(name, doc) {
    try { this.stmt(`INSERT INTO c_${name} (_id, project, t, doc) VALUES (?, ?, ?, ?)`).run(...this.toRow(doc)); }
    catch (e) {
      if (/UNIQUE constraint failed/.test(String(e && e.message))) fail('duplicate-id', `${name}: esiste già un documento con _id ${doc._id}`);
      throw e;
    }
  }
  // append: in coda (dentro una transazione va subito su disco, così se fallisce sparisce con il resto)
  insert(name, doc) {
    if (this.inTx) return this.insertNow(name, doc);
    const key = name + '\n' + doc._id;
    if (this.queued.has(key) || this.stmt(`SELECT 1 FROM c_${name} WHERE _id = ?`).get(doc._id)) fail('duplicate-id', `${name}: esiste già un documento con _id ${doc._id}`);
    this.queue.push({ name, doc });
    this.queued.add(key);
    if (this.queue.length >= this.flushDocs) return this.flush();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; if (!this.inTx) try { this.flush(); } catch (e) { this.onError(e); } }, this.flushMs);
      if (this.timer.unref) this.timer.unref();
    }
  }
  delete(name, id) {
    this.flush();
    return this.stmt(`DELETE FROM c_${name} WHERE _id = ?`).run(id).changes > 0;
  }

  // ------------------------------------------------------------ ricerche
  // il filtro in SQL; se non si può tradurre tutto, la parte che si può (per restringere) e exact: false
  where(ast) {
    const params = [];
    const sql = nodeSql(ast, params);
    if (sql !== null) return { sql, params, exact: true };
    const parts = [], some = [];
    for (const n of ast.and || []) {
      const p = [];
      const s = nodeSql(n, p);
      if (s !== null) { parts.push(s); some.push(...p); }
    }
    return { sql: parts.length ? parts.join(' AND ') : '1', params: some, exact: false };
  }
  // i documenti che corrispondono, quando il filtro o l'ordinamento vanno fatti in JavaScript
  scan(name, ast, w) {
    const rows = this.stmt(`SELECT _id, project, t, doc FROM c_${name} WHERE ${w.sql}`).all(...w.params);
    const out = [];
    for (const r of rows) { const d = this.toDoc(r); if (w.exact || matches(ast, d)) out.push(d); }
    return out;
  }
  find(name, ast, opts) {
    this.flush();
    const w = this.where(ast), order = w.exact ? orderSql(opts.sort) : null;
    if (order === null) {
      let docs = this.scan(name, ast, w).sort(comparator(opts.sort));
      if (opts.skip) docs = docs.slice(opts.skip);
      if (opts.limit !== undefined) docs = docs.slice(0, opts.limit);
      return docs.map(d => project(d, opts.fields));
    }
    let sql = `SELECT _id, project, t, doc FROM c_${name} WHERE ${w.sql} ORDER BY ${order}`;
    const params = w.params.slice();
    if (opts.limit !== undefined || opts.skip) { sql += ' LIMIT ? OFFSET ?'; params.push(opts.limit === undefined ? -1 : opts.limit, opts.skip || 0); }
    return this.stmt(sql).all(...params).map(r => project(this.toDoc(r), opts.fields));
  }
  count(name, ast) {
    this.flush();
    const w = this.where(ast);
    if (!w.exact) return this.scan(name, ast, w).length;
    return this.stmt(`SELECT COUNT(*) AS n FROM c_${name} WHERE ${w.sql}`).get(...w.params).n;
  }
  deleteMany(name, ast) {
    this.flush();
    const w = this.where(ast);
    if (w.exact) return this.stmt(`DELETE FROM c_${name} WHERE ${w.sql}`).run(...w.params).changes;
    const docs = this.scan(name, ast, w);
    const del = this.stmt(`DELETE FROM c_${name} WHERE _id = ?`);
    this.atomic(() => { for (const d of docs) del.run(d._id); });
    return docs.length;
  }

  // i segni dello store, nella tabella meta: stanno nel database, quindi seguono le transazioni
  getMeta(key) { return getMeta(this.db, key); }
  setMeta(key, value) { setMeta(this.db, key, value); }

  // ------------------------------------------------------------ transazioni e coda
  begin() { this.flush(); this.db.exec('BEGIN IMMEDIATE'); this.inTx = true; }
  commit() { this.inTx = false; this.db.exec('COMMIT'); }
  rollback() { this.inTx = false; try { this.db.exec('ROLLBACK'); } catch {} }

  // la coda su disco, in una transazione sola. Se fallisce le righe restano in coda per il prossimo tentativo.
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.queue.length) return;
    const batch = this.queue;
    const write = () => { for (const { name, doc } of batch) this.insertNow(name, doc); };
    if (this.inTx) write(); else this.atomic(write);
    this.queue = [];
    this.queued.clear();
  }

  // Il controllo del file in un thread a parte, su una connessione di sola lettura: il thread principale non aspetta.
  // { ok, detail, ms }. Se trova un danno lo segna in meta, così al prossimo avvio il controllo si fa subito (e un
  // file rovinato viene messo da parte, vedi openStoreSafe).
  checkInBackground() {
    const { Worker } = require('worker_threads');
    const t0 = Date.now();
    return new Promise(resolve => {
      let done = false;
      const finish = r => { if (done) return; done = true; resolve({ ...r, ms: Date.now() - t0 }); };
      let w;
      try {
        w = new Worker(`
          const { workerData, parentPort } = require('worker_threads');
          try {
            const sqlite = require(workerData.loader).loadSqlite();
            const db = new sqlite.DatabaseSync(workerData.file, { readOnly: true });
            try { db.exec('PRAGMA busy_timeout=3000'); parentPort.postMessage(db.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]).slice(0, 3)); }
            finally { db.close(); }
          } catch (e) { parentPort.postMessage(['errore: ' + (e && e.message || e)]); }
        `, { eval: true, workerData: { file: this.file, loader: require.resolve('./sqlite-load') } });
      } catch (e) { return finish({ ok: true, detail: 'controllo non avviato: ' + (e && e.message || e) }); }
      w.once('message', rows => {
        const ok = rows[0] === 'ok';
        if (!ok && this.db) { try { setMeta(this.db, CHECK_NEEDED, '1'); } catch {} }
        finish({ ok, detail: ok ? '' : `quick_check: ${rows.join('; ').replace(/\s+/g, ' ').slice(0, 300)}` });
      });
      w.once('error', e => finish({ ok: true, detail: 'controllo non riuscito: ' + (e && e.message || e) })); // un thread che non parte non è un danno
      w.once('exit', () => finish({ ok: true, detail: 'controllo interrotto' }));
    });
  }

  // i byte che lo storico occupa davvero, senza le pagine libere (che il database riusa; le ridà al disco solo VACUUM)
  usedBytes() {
    this.flush();
    const one = sql => Object.values(this.db.prepare(sql).get())[0];
    return (one('PRAGMA page_count') - one('PRAGMA freelist_count')) * one('PRAGMA page_size');
  }

  // "Compatta": riscrive il database senza le pagine libere (VACUUM) e svuota il registro WAL, così nel file non
  // resta niente dei documenti tolti. Restituisce la dimensione prima e dopo
  vacuum() {
    this.flush();
    const size = () => { let n = 0; for (const f of [this.file, this.file + '-wal']) { try { n += fs.statSync(f).size; } catch {} } return n; };
    const before = size();
    this.db.exec('VACUUM');
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    return { before, after: size() };
  }

  info() {
    let size = 0;
    for (const f of [this.file, this.file + '-wal']) { try { size += fs.statSync(f).size; } catch {} }
    return { file: this.file, sizeBytes: size, schemaVersion: schemaVersion(this.db) };
  }
  close() {
    if (!this.db) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stmts.clear();
    try { this.db.close(); } finally { this.db = null; }
  }
}

module.exports = { SqliteDriver, fieldOf, nodeSql, orderSql, FLUSH_MS, FLUSH_DOCS, CHECK_LIMIT, StoreError };
