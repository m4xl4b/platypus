'use strict';
// Backend `memory`: tutto in RAM, niente su disco. Lo usano le prove, la demo (che non deve mai scrivere nel
// database vero) e il ripiego d'emergenza quando il database non si apre (S4).
// È un "driver": le operazioni elementari su documenti già controllati e copiati da Store (index.js), che fa
// il resto. Lo stesso contratto vale per sqlite.js (S3):
//   ensureCollection(decl) · get · put · insert · delete · find(ast, opts) · count(ast) · deleteMany(ast)
//   begin · commit · rollback · flush · info · close · getMeta(chiave) · setMeta(chiave, valore)

const { matches, comparator, project, fail } = require('./common');

const META = '\u0000meta';

class MemoryDriver {
  constructor() {
    this.name = 'memory';
    this.persistent = false;
    this.data = new Map(); // collezione → Map(_id → documento)
    this.undo = null;      // dentro una transazione: cosa rimettere a posto se fallisce
    this.data.set(META, new Map()); // i segni dello store (getMeta/setMeta): una collezione nascosta, così seguono le transazioni
  }

  getMeta(key) { const d = this.coll(META).get(key); return d ? d.value : null; }
  setMeta(key, value) { this.put(META, { _id: key, value: String(value) }); }

  ensureCollection(decl) { if (!this.data.has(decl.name)) this.data.set(decl.name, new Map()); }
  coll(name) { return this.data.get(name); }

  remember(name, id) {
    if (!this.undo) return;
    const m = this.coll(name);
    this.undo.push({ name, id, had: m.has(id), prev: m.get(id) });
  }

  get(name, id) { return this.coll(name).get(id); }
  put(name, doc) { this.remember(name, doc._id); this.coll(name).set(doc._id, doc); }
  insert(name, doc) {
    if (this.coll(name).has(doc._id)) fail('duplicate-id', `${name}: esiste già un documento con _id ${doc._id}`);
    this.put(name, doc);
  }
  delete(name, id) {
    if (!this.coll(name).has(id)) return false;
    this.remember(name, id);
    this.coll(name).delete(id);
    return true;
  }

  select(name, ast) {
    const out = [];
    for (const doc of this.coll(name).values()) if (matches(ast, doc)) out.push(doc);
    return out;
  }
  find(name, ast, opts) {
    let rows = this.select(name, ast).sort(comparator(opts.sort));
    if (opts.skip) rows = rows.slice(opts.skip);
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map(d => project(d, opts.fields));
  }
  count(name, ast) { return this.select(name, ast).length; }
  deleteMany(name, ast) {
    const rows = this.select(name, ast);
    for (const d of rows) this.delete(name, d._id);
    return rows.length;
  }

  begin() { this.undo = []; }
  commit() { this.undo = null; }
  rollback() {
    const undo = this.undo || [];
    this.undo = null;
    for (let i = undo.length - 1; i >= 0; i--) {
      const u = undo[i], m = this.coll(u.name);
      if (u.had) m.set(u.id, u.prev); else m.delete(u.id);
    }
  }

  flush() {}
  info() { return { file: null, sizeBytes: null }; }
  close() { this.data.clear(); this.undo = null; }
}

module.exports = { MemoryDriver };
