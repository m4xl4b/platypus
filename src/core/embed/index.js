'use strict';
// Significato con gli embedding neurali (piano docs/plans/neural-embeddings.md).
//
// Tre fonti, in ordine di preferenza: Ollama in locale (se gira, con un modello di embedding già scaricato), il
// modello ONNX facoltativo (se installato a parte), il TF-IDF di semantic.js (sempre, e fa da ripiego).
// Niente dipendenze npm: Ollama si chiama con http di Node (ollama.js), il modulo ONNX si carica con require
// solo se c'è (onnx.js).
//
// Contratto di un provider: { id, dim, embed(texts, kind) → Promise<Float32Array[]>, ready() → Promise<boolean> }
//   id    la fonte: 'ollama:<modello>', 'onnx:<modello>' o 'tfidf'
//   kind  'query' (il compito) o 'document' (i pezzi del contesto), per i modelli che vogliono prefissi diversi
//   e inoltre, per le opzioni: state ('ready' | 'not-found' | 'not-installed' | 'error' | 'unknown'), model, detail, hint
//
// Mai bloccare l'ufficio: le richieste vanno in una coda unica, a lotti di al massimo 16 testi, con 5 s di tempo
// ciascuna; chi chiede un vettore che non c'è ancora riceve null e intanto usa il TF-IDF. Una fonte che fallisce
// 3 volte di fila resta sospesa per 5 minuti. La cache tiene solo vettori e hash, mai il testo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIM } = require('../semantic');
const { loopbackUrl, DEFAULT_URL } = require('./ollama');

const ENGINES = ['auto', 'ollama', 'onnx', 'tfidf'];
const CHAIN = ['ollama', 'onnx'];
const MEM_CAP = 5000;
const DISK_CAP = 50 * 1024 * 1024;
const BATCH = 16;
const TIMEOUT_MS = 5000;
const FAILS = 3;
const SUSPEND_MS = 5 * 60 * 1000;
const RECHECK_MS = 60 * 1000;
const QUEUE_MAX = 4000;

const keyOf = (kind, text) => crypto.createHash('sha1').update(kind + '\n' + text).digest('hex');
const fileOf = src => String(src).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) + '.bin';

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error((what || 'embed') + ': timeout ' + ms + ' ms')), ms); if (timer.unref) timer.unref(); }),
  ]);
}

// ---------------------------------------------------------------- cache in memoria (LRU)
class Lru {
  constructor(cap = MEM_CAP) { this.cap = cap; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; }
  has(k) { return this.map.has(k); }
  set(k, v) { this.map.delete(k); this.map.set(k, v); while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// ---------------------------------------------------------------- cache su disco, una per fonte
// <dir>/<fonte>.bin: intestazione di 16 byte ('PLEMB001', dim) e poi record di 20 byte di sha1 + dim float32.
// Solo vettori e hash. Oltre il tetto si riscrive tenendo la metà più recente.
const MAGIC = Buffer.from('PLEMB001');
const HEAD = 16;
class DiskCache {
  constructor(dir, src, cap = DISK_CAP) { this.dir = dir; this.src = src; this.cap = cap; this.file = path.join(dir, fileOf(src)); this.index = null; this.dim = 0; this.chain = Promise.resolve(); }
  rec() { return 20 + this.dim * 4; }
  async open(dim) {
    if (this.index && this.dim === dim) return;
    this.index = new Map(); this.dim = dim;
    let buf;
    try { buf = await fs.promises.readFile(this.file); } catch { return; }
    if (buf.length < HEAD || !buf.subarray(0, 8).equals(MAGIC) || buf.readUInt32LE(8) !== dim) { await fs.promises.rm(this.file, { force: true }); return; } // un altro modello con lo stesso nome: si riparte
    const r = this.rec();
    for (let off = HEAD; off + r <= buf.length; off += r) this.index.set(buf.toString('hex', off, off + 20), off);
  }
  async get(keys) {
    const out = new Map();
    if (!this.index || !this.index.size) return out;
    let fh;
    try {
      fh = await fs.promises.open(this.file, 'r');
      for (const k of keys) {
        const off = this.index.get(k);
        if (off == null) continue;
        const b = Buffer.alloc(this.dim * 4);
        const { bytesRead } = await fh.read(b, 0, b.length, off + 20);
        if (bytesRead === b.length) out.set(k, new Float32Array(b.buffer, b.byteOffset, this.dim).slice());
      }
    } catch { /* la cache è solo un aiuto */ } finally { if (fh) await fh.close().catch(() => {}); }
    return out;
  }
  put(entries) { // [[key, Float32Array]]
    this.chain = this.chain.then(() => this.write(entries)).catch(() => {});
    return this.chain;
  }
  async write(entries) {
    if (!this.index || !entries.length) return;
    const fresh = entries.filter(([k, v]) => !this.index.has(k) && v.length === this.dim);
    if (!fresh.length) return;
    await fs.promises.mkdir(this.dir, { recursive: true });
    let size = 0;
    try { size = (await fs.promises.stat(this.file)).size; } catch {}
    if (!size) { const h = Buffer.alloc(HEAD); MAGIC.copy(h); h.writeUInt32LE(this.dim, 8); await fs.promises.writeFile(this.file, h); size = HEAD; }
    const r = this.rec(), buf = Buffer.alloc(fresh.length * r);
    fresh.forEach(([k, v], i) => { buf.write(k, i * r, 20, 'hex'); Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, i * r + 20); this.index.set(k, size + i * r); });
    await fs.promises.appendFile(this.file, buf);
    if (size + buf.length > this.cap) await this.shrink();
  }
  async shrink() {
    const buf = await fs.promises.readFile(this.file), r = this.rec();
    const n = Math.floor((buf.length - HEAD) / r), keep = Math.max(0, Math.floor(((this.cap / 2) - HEAD) / r));
    const from = HEAD + (n - Math.min(n, keep)) * r;
    const out = Buffer.concat([buf.subarray(0, HEAD), buf.subarray(from, HEAD + n * r)]);
    await fs.promises.writeFile(this.file, out);
    this.index = new Map();
    for (let off = HEAD; off + r <= out.length; off += r) this.index.set(out.toString('hex', off, off + 20), off);
  }
  size() { try { return fs.statSync(this.file).size; } catch { return 0; } }
}

// ---------------------------------------------------------------- i provider
// TF-IDF: sempre pronto, ma i suoi vettori si calcolano in semantic.js (tfidfSpace), non qui.
const tfidf = { id: 'tfidf', dim: DIM, state: 'ready', model: '', ready: async () => true, embed: async () => { throw new Error('tfidf: vectors come from semantic.js'); } };

// Un provider che non c'è (modulo mancante): la catena passa oltre.
function missing(kind, detail) { return { id: kind, dim: 0, state: 'not-installed', model: '', detail, ready: async () => false, embed: async () => { throw new Error(kind + ': not installed'); } }; }

function defaultFactory(kind) {
  return (settings, deps) => {
    let mod;
    try { mod = require('./' + kind); } catch (e) { return missing(kind, e.message); }
    return mod.create(settings, deps);
  };
}
const FACTORIES = { ollama: defaultFactory('ollama'), onnx: defaultFactory('onnx') };

function cleanEngine(v) { return ENGINES.includes(v) ? v : 'auto'; }
// le opzioni del significato, ripulite (state.setSettings): un indirizzo di Ollama che non è di loopback si rifiuta
const SETTINGS = ['embedEngine', 'embedModel', 'ollamaUrl'];
function cleanSetting(k, v, prev) {
  if (k === 'embedEngine') return cleanEngine(String(v || '').trim());
  if (k === 'embedModel') return String(v || '').trim().replace(/[^A-Za-z0-9._:/@-]/g, '').slice(0, 80);
  if (k === 'ollamaUrl') return loopbackUrl(v) || prev || DEFAULT_URL;
  return v;
}

// La catena: con 'auto' Ollama se risponde, poi ONNX se è installato, altrimenti TF-IDF. Con una fonte precisa si usa
// quella e, se non va, il TF-IDF, dicendolo (fallback). sources: le fonti già create (per non rifarle), skip: le sospese.
async function resolveChain(engine, sources, { skip = () => false, timeoutMs = TIMEOUT_MS } = {}) {
  const wanted = cleanEngine(engine);
  if (wanted === 'tfidf') return { provider: tfidf, wanted, fallback: null };
  const order = wanted === 'auto' ? CHAIN : [wanted];
  let reason = null;
  for (const k of order) {
    const p = sources[k];
    if (!p) continue;
    if (skip(k)) { reason = reason || { source: k, state: 'error', detail: 'suspended' }; continue; }
    let okp = false;
    try { okp = await withTimeout(p.ready(), timeoutMs, k); } catch (e) { p.state = 'error'; p.detail = e.message; }
    if (okp && p.dim > 0) return { provider: p, wanted, fallback: null };
    reason = reason || { source: k, state: p.state || 'error', detail: p.detail || '' };
  }
  // in automatico il TF-IDF è una scelta, non un ripiego; altrimenti si dice perché
  return { provider: tfidf, wanted, fallback: wanted === 'auto' ? null : reason };
}

// la catena come un provider solo (il contratto del piano): getProvider(settings).ready() sceglie la fonte
function getProvider(settings, { factories = FACTORIES, deps } = {}) {
  const sources = {};
  for (const k of CHAIN) sources[k] = (factories[k] || FACTORIES[k])(settings || {}, deps);
  const chain = { id: 'tfidf', dim: DIM, active: tfidf, wanted: cleanEngine(settings && settings.embedEngine), fallback: null, sources };
  chain.ready = async () => {
    const r = await resolveChain(chain.wanted, sources);
    Object.assign(chain, { active: r.provider, id: r.provider.id, dim: r.provider.dim, fallback: r.fallback });
    return r.provider !== tfidf;
  };
  chain.embed = (texts, kind) => chain.active.embed(texts, kind);
  return chain;
}

// ---------------------------------------------------------------- tutto il motore: catena, cache e coda
class Embedder {
  constructor({ settings = {}, dir, factories = FACTORIES, deps, now = Date.now, memCap = MEM_CAP, diskCap = DISK_CAP, batch = BATCH, timeoutMs = TIMEOUT_MS, recheckMs = RECHECK_MS } = {}) {
    Object.assign(this, { dir, factories, deps, now, diskCap, batch, timeoutMs, recheckMs });
    this.mem = new Lru(memCap);
    this.disks = new Map();
    this.queue = new Map(); // key → {src, key, text, kind, prio, seq}
    this.seq = 0;
    this.version = 0;
    this.fails = new Map(); // fonte → fallimenti di fila
    this.suspended = new Map(); // fonte → fino a quando
    this.provider = tfidf;
    this.fallback = null;
    this.resolvedAt = 0;
    this.resolving = null;
    this.busy = false;
    this.listeners = new Set();
    this.keys = new WeakMap(); // pezzo o compito → {text, key}
    this.configure(settings, true);
  }
  // cambia una delle opzioni del significato: si rifà la catena
  configure(settings, first) {
    const s = settings || {};
    const sig = [cleanEngine(s.embedEngine), s.embedModel || '', s.ollamaUrl || ''].join('|');
    if (!first && sig === this.sig) return false;
    this.sig = sig;
    this.settings = { embedEngine: cleanEngine(s.embedEngine), embedModel: s.embedModel || '', ollamaUrl: s.ollamaUrl || '' };
    for (const p of Object.values(this.sources || {})) if (p && p.stop) p.stop();
    this.sources = {};
    for (const k of CHAIN) this.sources[k] = (this.factories[k] || FACTORIES[k])(this.settings, this.deps);
    this.fails.clear(); this.suspended.clear();
    this.queue.clear();
    this.setProvider(tfidf, null);
    this.resolvedAt = 0;
    return true;
  }
  isSuspended(k) { const u = this.suspended.get(k); if (u && u <= this.now()) { this.suspended.delete(k); this.fails.delete(k); return false; } return !!u; }
  setProvider(p, fallback) {
    const changed = p.id !== this.provider.id;
    this.provider = p; this.fallback = fallback;
    if (changed) { this.version++; this.queue.clear(); this.emit(); }
  }
  // sceglie la fonte (una richiesta alla volta); con un risultato in ripiego ci si riprova ogni tanto
  resolve() {
    if (this.resolving) return this.resolving;
    const sources = this.sources;
    this.resolving = resolveChain(this.settings.embedEngine, sources, { skip: k => this.isSuspended(k), timeoutMs: this.timeoutMs })
      .then(r => { if (sources === this.sources) { this.setProvider(r.provider, r.fallback); this.resolvedAt = this.now(); } return this.provider; })
      .finally(() => { this.resolving = null; });
    return this.resolving;
  }
  maybeResolve() {
    if (this.resolving) return;
    const settled = this.provider !== tfidf && !this.isSuspended(this.kindOf(this.provider));
    if (!this.resolvedAt || (!settled && this.now() - this.resolvedAt >= this.recheckMs)) this.resolve().catch(() => {});
  }
  kindOf(p) { return String(p.id).split(':')[0]; }
  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) { try { fn(this.version); } catch {} } }
  disk(src) {
    if (!this.dir) return null;
    let d = this.disks.get(src);
    if (!d) { d = new DiskCache(this.dir, src, this.diskCap); this.disks.set(src, d); }
    return d;
  }

  // Lo spazio di significato per semantic.js, con la fonte attiva; null se la fonte è il TF-IDF.
  // prio: 0 per gli agenti che si stanno guardando, 1 per il resto (es. la regola della deriva negli hook).
  space(prio = 1) {
    this.maybeResolve();
    const p = this.provider;
    if (p === tfidf || this.isSuspended(this.kindOf(p))) return null;
    const src = p.id, zero = new Float32Array(p.dim);
    const look = (x, kind) => {
      const text = x && x.text;
      if (!text) return zero;
      let k = this.keys.get(x);
      if (!k || k.text !== text || k.kind !== kind) { k = { text, kind, key: keyOf(kind, text) }; this.keys.set(x, k); }
      const v = this.mem.get(src + '|' + k.key);
      if (v) return v;
      this.want(src, k.key, text, kind, prio);
      return null;
    };
    return { src, version: this.version, goal: g => look(g, 'query'), piece: x => look(x, 'document') };
  }
  want(src, key, text, kind, prio) {
    const q = this.queue.get(key);
    if (q) { if (prio < q.prio) q.prio = prio; return; }
    if (this.queue.size >= QUEUE_MAX) return; // si richiederà più tardi
    this.queue.set(key, { src, key, text, kind, prio, seq: ++this.seq });
    this.kick();
  }
  kick() {
    if (this.busy || this.kicked) return;
    this.kicked = true;
    setImmediate(() => { this.kicked = false; this.pump().catch(() => {}); });
  }
  // il prossimo lotto: la priorità migliore, poi l'ordine di arrivo; stessa fonte e stesso tipo del primo
  nextBatch() {
    const all = [...this.queue.values()].sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    if (!all.length) return [];
    const first = all[0], out = [];
    for (const x of all) { if (x.src === first.src && x.kind === first.kind) out.push(x); if (out.length >= this.batch) break; }
    for (const x of out) this.queue.delete(x.key);
    return out;
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const p = this.provider;
        if (p === tfidf || this.isSuspended(this.kindOf(p))) { this.queue.clear(); return; }
        const b = this.nextBatch().filter(x => x.src === p.id);
        if (!b.length) { if (!this.queue.size) return; continue; }
        let got = 0;
        const d = this.disk(p.id);
        if (d) {
          try { await d.open(p.dim); } catch {}
          const hit = await d.get(b.map(x => x.key));
          for (const [k, v] of hit) { this.mem.set(p.id + '|' + k, v); got++; }
        }
        const rest = b.filter(x => !this.mem.has(p.id + '|' + x.key));
        if (rest.length) {
          try {
            const vecs = await withTimeout(p.embed(rest.map(x => x.text), rest[0].kind), this.timeoutMs, p.id);
            if (!Array.isArray(vecs) || vecs.length !== rest.length || vecs.some(v => !v || v.length !== p.dim)) throw new Error(p.id + ': wrong answer');
            const entries = rest.map((x, i) => [x.key, normalize(Float32Array.from(vecs[i]))]);
            if (this.provider !== p) continue; // la fonte è cambiata nel frattempo: vettori buttati
            for (const [k, v] of entries) this.mem.set(p.id + '|' + k, v);
            got += entries.length;
            this.fails.delete(this.kindOf(p));
            if (d) d.put(entries);
          } catch (e) {
            this.fail(p, e);
          }
        }
        if (got) { this.version++; this.emit(); }
      }
    } finally { this.busy = false; if (this.queue.size && this.provider !== tfidf) this.kick(); }
  }
  fail(p, e) {
    const k = this.kindOf(p), n = (this.fails.get(k) || 0) + 1;
    this.fails.set(k, n);
    p.detail = e && e.message ? e.message : String(e);
    if (n < FAILS) return;
    this.suspended.set(k, this.now() + SUSPEND_MS);
    p.state = 'error';
    this.queue.clear();
    this.setProvider(tfidf, this.settings.embedEngine === 'auto' ? null : { source: k, state: 'error', detail: p.detail });
    this.resolve().catch(() => {}); // in automatico la catena passa alla fonte dopo
  }
  // per le opzioni: lo stato di ogni fonte, quella in uso, la cache
  status() {
    const sources = { tfidf: { state: 'ready', model: '' } };
    for (const k of CHAIN) {
      const p = this.sources[k] || {};
      sources[k] = { state: this.isSuspended(k) ? 'error' : (p.state || 'unknown'), model: p.model || '', detail: p.detail || '', hint: p.hint || '' };
      if (this.isSuspended(k)) sources[k].until = this.suspended.get(k);
    }
    let disk = 0;
    if (this.dir) { try { for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.bin')) disk += fs.statSync(path.join(this.dir, f)).size; } catch {} }
    return { engine: this.settings.embedEngine, active: this.provider.id, dim: this.provider.dim, fallback: this.fallback, sources, cache: { vectors: this.mem.size, diskBytes: disk }, queue: this.queue.size, version: this.version };
  }
  // svuota la cache (in memoria e su disco): dalle opzioni
  async clearCache() {
    this.mem.clear();
    for (const d of this.disks.values()) await d.chain.catch(() => {});
    this.disks.clear();
    if (this.dir) { try { for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.bin')) fs.rmSync(path.join(this.dir, f), { force: true }); } catch {} }
    this.version++; this.emit();
  }
  stop() { for (const p of Object.values(this.sources || {})) if (p && p.stop) p.stop(); this.queue.clear(); this.listeners.clear(); }
}
function normalize(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v; }

module.exports = { Embedder, getProvider, resolveChain, DiskCache, Lru, keyOf, fileOf, cleanEngine, cleanSetting, SETTINGS, tfidf, ENGINES, BATCH, TIMEOUT_MS, MEM_CAP, DISK_CAP, FAILS, SUSPEND_MS };
