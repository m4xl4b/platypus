'use strict';
// Lo store di Platypus: un piccolo archivio di documenti dietro una sola interfaccia, uguale per ogni backend.
//   const store = openStore({ backend: 'memory' });
//   store.declare('steps', { indexes: [['project', 't']], retention: { days: 90 } });
//   const steps = store.collection('steps');
//   steps.append({ project: key, t: Date.now(), action: 'edit' });
//   steps.find({ project: key, t: { $gte: since } }, { sort: { t: -1 }, limit: 50 });
//
// COLLEZIONE  get(id) · put(doc) · patch(id, parziale) · delete(id) · find(filtro, { sort, limit, skip, fields })
//             count(filtro) · deleteMany(filtro) · append(doc)
// STORE       collection(nome) · declare(nome, { fields, indexes, retention, projectField }) · transaction(fn)
//             forgetProject(chiave) · export(nome, cartella) · import(nome, file) · flush() · info() · close()
//
// Documenti, filtri e ordinamento: le regole sono in common.js, e sono le stesse per tutti.
//
// SINCRONO O NO. I backend di questo computer (memory, sqlite) rispondono subito, senza Promise: il motore li usa
// così. Un backend di rete (MongoDB, 3.0) risponderà con Promise. Il codice che deve girare su tutti e due, a
// cominciare da scripts/store-conformance.js, mette `await` davanti a ogni chiamata: con i backend locali non costa
// niente. `store.sync` dice quale dei due casi è.
//
// PRIVACY. Ogni scrittura passa dalla guardia (privacy.js): restano solo i campi dichiarati, del tipo dichiarato;
// i percorsi diventano relativi, gli estratti perdono i segreti. Opzioni: guard ('reject' | 'drop'), requireFields.
//
// SCRITTURE. put, patch, delete e deleteMany valgono subito. append è per i registri: restituisce l'_id e può
// restare in coda (in sqlite al massimo 2 s); chi vuole rileggere subito chiama prima flush().
// transaction(fn): tutto o niente. Se fn lancia un errore (o la sua Promise fallisce), niente resta scritto.

const fs = require('fs');
const path = require('path');
const C = require('./common');
const privacy = require('./privacy');
const { StoreError, fail } = C;

class Collection {
  constructor(store, decl) { this.store = store; this.decl = decl; this.name = decl.name; }

  get(id) {
    const d = this.store.use();
    return C.clone(d.get(this.name, C.checkId(id))) || null;
  }
  // salva il documento intero, al posto di quello che c'era con lo stesso _id; restituisce quello salvato
  put(doc) {
    const d = this.store.use();
    const clean = this.store.guard(this.decl, C.cleanDoc(doc, this.store.clock()));
    d.put(this.name, clean);
    return C.clone(clean);
  }
  // cambia solo i campi indicati (al primo livello); null se il documento non c'è
  patch(id, partial) {
    C.checkId(id);
    if (!C.isPlain(partial)) fail('invalid-document', 'patch vuole un oggetto con i campi da cambiare');
    if (partial._id !== undefined && partial._id !== id) fail('invalid-document', 'patch non può cambiare _id');
    return this.store.transaction(() => {
      const d = this.store.use();
      const cur = d.get(this.name, id);
      if (!cur) return null;
      const clean = this.store.guard(this.decl, C.cleanDoc({ ...cur, ...partial, _id: id }, this.store.clock()));
      d.put(this.name, clean);
      return C.clone(clean);
    });
  }
  delete(id) { return this.store.use().delete(this.name, C.checkId(id)); }

  find(filter, opts) {
    const d = this.store.use();
    return d.find(this.name, C.parseFilter(filter), C.parseFindOptions(opts)).map(C.clone);
  }
  count(filter) { return this.store.use().count(this.name, C.parseFilter(filter)); }
  deleteMany(filter) { return this.store.use().deleteMany(this.name, C.parseFilter(filter)); }

  // per i registri: aggiunge soltanto (un _id già usato è un errore) e restituisce l'_id
  append(doc) {
    const d = this.store.use();
    const clean = this.store.guard(this.decl, C.cleanDoc(doc, this.store.clock()));
    d.insert(this.name, clean);
    return clean._id;
  }
}

class Store {
  constructor(driver, opts = {}) {
    this.driver = driver;
    this.backend = driver.name;
    this.sync = true;
    this.clock = typeof opts.clock === 'function' ? opts.clock : Date.now;
    this.decls = new Map();
    this.colls = new Map();
    this.depth = 0;
    this.closed = false;
    this.fallback = null; // se questo store è un ripiego: perché (vedi openStoreSafe)
    // la guardia della privacy (privacy.js): 'reject' = un campo non dichiarato è un errore (sviluppo e prove),
    // 'drop' = si scarta e lo si scrive una volta nel registro. requireFields: ogni collezione deve dichiarare i campi.
    const mode = opts.guard || process.env.PLATYPUS_STORE_GUARD || (process.env.PLATYPUS_DEBUG === '1' ? 'reject' : 'drop');
    if (mode !== 'reject' && mode !== 'drop') fail('invalid-argument', `guard può essere 'reject' o 'drop' (ricevuto ${JSON.stringify(mode)})`);
    this.guardMode = mode;
    this.requireFields = !!opts.requireFields;
    this.onGuard = typeof opts.onGuard === 'function' ? opts.onGuard : msg => console.error('[platypus] store: ' + msg);
    this.guardSeen = new Set();
  }
  use() {
    if (this.closed) fail('closed', 'lo store è chiuso');
    return this.driver;
  }

  // Fa rispettare i campi dichiarati a un documento che sta per essere scritto. Una collezione senza `fields`
  // non è sorvegliata: va bene per le prove, non per il motore (che apre lo store con requireFields).
  guard(decl, doc) {
    if (!decl.fields) return doc;
    const problems = [];
    const out = privacy.guardDoc(doc, decl.fields, problems);
    if (!problems.length) return out;
    if (this.guardMode === 'reject') fail('undeclared-field', `${decl.name}: ${problems.map(p => `${p.field} (${p.why})`).join(', ')}`);
    for (const p of problems) {
      const key = `${decl.name}.${p.field}:${p.why}`;
      if (this.guardSeen.has(key) || this.guardSeen.size > 500) continue;
      this.guardSeen.add(key);
      try { this.onGuard(`${decl.name}.${p.field}: ${p.why}, non salvato`); } catch {}
    }
    return out;
  }

  // dichiarare due volte la stessa collezione va bene: vale l'ultima dichiarazione
  declare(name, spec) {
    const d = this.use();
    const decl = C.parseDeclaration(name, spec);
    if (this.requireFields && !decl.fields) fail('invalid-argument', `declare(${name}): questo store vuole i campi dichiarati (fields)`);
    d.ensureCollection(decl);
    this.decls.set(name, decl);
    const c = this.colls.get(name);
    if (c) c.decl = decl;
  }
  collection(name) {
    this.use();
    C.checkName(name);
    const decl = this.decls.get(name);
    if (!decl) fail('undeclared-collection', `collezione non dichiarata: ${name} (serve prima store.declare)`);
    let c = this.colls.get(name);
    if (!c) this.colls.set(name, c = new Collection(this, decl));
    return c;
  }

  transaction(fn) {
    const d = this.use();
    if (typeof fn !== 'function') fail('invalid-argument', 'transaction vuole una funzione');
    if (this.depth > 0) return fn(this); // già dentro: fa parte di quella di fuori
    d.begin();
    this.depth = 1;
    const end = okay => { this.depth = 0; if (okay) d.commit(); else d.rollback(); };
    let r;
    try { r = fn(this); } catch (e) { end(false); throw e; }
    if (r && typeof r.then === 'function') return r.then(v => { end(true); return v; }, e => { end(false); throw e; });
    end(true);
    return r;
  }

  // toglie tutto quello che riguarda un progetto, in ogni collezione; restituisce quanti documenti ha tolto
  forgetProject(key) {
    if (typeof key !== 'string' || !key) fail('invalid-argument', 'forgetProject vuole la chiave del progetto');
    return this.transaction(() => {
      const d = this.use();
      let n = 0;
      for (const decl of this.decls.values()) {
        if (decl.projectField === '_id') n += d.delete(decl.name, key) ? 1 : 0;
        else n += d.deleteMany(decl.name, C.parseFilter({ project: key }));
      }
      return n;
    });
  }

  // un file JSONL (un documento per riga, in ordine di _id) nella cartella indicata
  export(name, dir) {
    const c = this.collection(name);
    if (typeof dir !== 'string' || !dir) fail('invalid-argument', 'export vuole la cartella di destinazione');
    this.flush();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.jsonl`);
    const fd = fs.openSync(file, 'w', 0o600);
    let count = 0, last = null;
    try {
      for (;;) {
        const page = this.driver.find(name, C.parseFilter(last === null ? {} : { _id: { $gt: last } }), C.parseFindOptions({ sort: { _id: 1 }, limit: 1000 }));
        if (!page.length) break;
        fs.writeSync(fd, page.map(d => JSON.stringify(d) + '\n').join(''));
        count += page.length;
        last = page[page.length - 1]._id;
      }
    } finally { fs.closeSync(fd); }
    return { file, count, collection: c.name };
  }
  // il contrario: ogni riga è un documento, che prende il posto di quello con lo stesso _id. Tutto o niente.
  import(name, file) {
    const c = this.collection(name);
    if (typeof file !== 'string' || !file) fail('invalid-argument', 'import vuole il file da leggere');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return this.transaction(() => {
      let count = 0;
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        let doc;
        try { doc = JSON.parse(line); } catch { fail('invalid-document', `${path.basename(file)}, riga ${i + 1}: non è JSON`); }
        if (!C.isPlain(doc) || typeof doc._id !== 'string') fail('invalid-document', `${path.basename(file)}, riga ${i + 1}: manca _id`);
        c.put(doc);
        count++;
      });
      return { count, collection: c.name };
    });
  }

  flush() { this.use().flush(); }
  info() {
    const d = this.use();
    d.flush();
    const all = C.parseFilter({});
    return {
      backend: this.backend,
      persistent: !!d.persistent,
      fallback: this.fallback ? C.clone(this.fallback) : null,
      ...d.info(),
      collections: [...this.decls.values()].map(decl => ({ name: decl.name, count: d.count(decl.name, all), indexes: C.clone(decl.indexes), retention: C.clone(decl.retention), guarded: !!decl.fields })),
    };
  }
  close() {
    if (this.closed) return;
    try { this.driver.flush(); } finally { this.driver.close(); this.closed = true; }
  }
}

// ---------------------------------------------------------------- backend
// nome → funzione che apre lo store. Il pacchetto del server (3.0) aggiunge qui `mongo` senza che il motore
// dipenda da lui.
const backends = new Map();
function registerBackend(name, factory) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name) || typeof factory !== 'function') fail('invalid-argument', 'registerBackend(nome, funzione)');
  backends.set(name, factory);
}
registerBackend('memory', opts => new Store(new (require('./memory').MemoryDriver)(), opts));
registerBackend('sqlite', opts => {
  const driver = new (require('./sqlite').SqliteDriver)(opts);
  try { return new Store(driver, opts); }
  catch (e) { driver.close(); throw e; } // un'opzione sbagliata non deve lasciare il file aperto
});

// openStore({ backend, dir, clock }): backend 'memory' se non è indicato; dir è la cartella dei dati (per i backend su
// disco: sqlite ci tiene platypus.db). Per sqlite anche flushMs e flushDocs (la coda di append) e onError.
function openStore(opts = {}) {
  const name = opts.backend || 'memory';
  const factory = backends.get(name);
  if (!factory) fail('unknown-backend', `backend dello store sconosciuto: ${name} (ci sono: ${[...backends.keys()].join(', ')})`);
  return factory({ ...opts, backend: name });
}

// ---------------------------------------------------------------- quando il database non si apre (S4)
// I motivi per cui si ripiega sulla memoria invece di fermarsi. Gli altri errori (un nome di backend sbagliato,
// un'opzione non valida) sono errori di chi scrive il codice e restano errori.
const FALLBACK_CODES = ['corrupt', 'unopenable', 'newer-schema', 'migration-failed', 'backend-unavailable'];

// mette da parte un database rovinato: platypus.db → platypus.db.broken-<data>. Restituisce il nuovo nome, o null
function setAside(file, when) {
  const d = new Date(when), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let target = `${file}.broken-${stamp}`;
  for (let k = 2; fs.existsSync(target); k++) target = `${file}.broken-${stamp}-${k}`;
  try { fs.renameSync(file, target); } catch { return null; }
  for (const ext of ['-wal', '-shm']) { try { fs.renameSync(file + ext, target + ext); } catch {} }
  return target;
}

// Come openStore, ma non si ferma mai per colpa del database: se non si apre, restituisce uno store in memoria
// con `fallback` = { code, detail, brokenFile, wanted }. Platypus continua a funzionare senza storico, e lo dice
// (fallbackReason dà la frase da mostrare). Un database rovinato viene messo da parte: al prossimo avvio se ne
// crea uno nuovo.
function openStoreSafe(opts = {}) {
  try { return openStore(opts); }
  catch (e) {
    if (!(e instanceof StoreError) || !FALLBACK_CODES.includes(e.code)) throw e;
    const fallback = { code: e.code, detail: e.message, brokenFile: null, wanted: opts.backend || 'memory' };
    if (e.code === 'corrupt' && opts.dir) fallback.brokenFile = setAside(path.join(opts.dir, 'platypus.db'), (typeof opts.clock === 'function' ? opts.clock : Date.now)());
    const store = openStore({ ...opts, backend: 'memory' });
    store.fallback = fallback;
    return store;
  }
}

// la frase per l'avviso nell'ufficio: «storico non disponibile: <motivo>», nella lingua in uso
function fallbackReason(fallback) {
  if (!fallback) return '';
  const { tr } = require('../../i18n');
  const why = {
    corrupt: fallback.brokenFile
      ? tr('il database era rovinato: l\'ho messo da parte come {file}', { file: path.basename(fallback.brokenFile) })
      : tr('il database è rovinato'),
    unopenable: tr('non riesco ad aprire o a scrivere il database'),
    'newer-schema': tr('il database è stato scritto da un Platypus più recente di questo'),
    'migration-failed': tr('l\'aggiornamento del database non è riuscito'),
    'backend-unavailable': tr('questo Node.js non ha SQLite: serve la 22.13 o più recente'),
  }[fallback.code] || tr('non riesco ad aprire o a scrivere il database');
  return tr('storico non disponibile: {reason}', { reason: why });
}

module.exports = {
  openStore, openStoreSafe, fallbackReason, registerBackend, Store, Collection, StoreError, ulid: C.ulid, ulidTime: C.ulidTime,
  relPath: privacy.relPath, scrub: privacy.scrub, excerpt: privacy.excerpt,
};
