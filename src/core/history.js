'use strict';
// Lo storico del motore: lo store (src/core/store) aperto sulla cartella dei dati, con le sue collezioni, la
// chiave dei progetti e il passaggio dei dati della 2.12. È l'unico punto in cui il motore tocca lo store:
// statistiche, Libro e registro dei messaggi lo ricevono da qui.
//
// Non ferma mai l'ufficio: se il database non si apre, lo store è in memoria (lo storico non resta) e
// notice() dà la frase da mostrare. La demo non passa mai di qui: ha i suoi dati finti in memoria.

const { openStoreSafe, fallbackReason, scrub } = require('./store');
const { cmdCore, errorPattern } = require('./bottega');
const { declareCollections } = require('./store/collections');
const { ProjectKeys } = require('./store/project-key');
const { importLegacy } = require('./store/legacy');

const FLUSH_MS = 2000, FLUSH_DOCS = 500; // come la coda di sqlite.js: al massimo ogni 2 s, o a 500 documenti

class History {
  // dir: la cartella dei dati (dove sta platypus.db); settings: le opzioni vive del motore
  constructor({ dir, settings = {}, backend, clock = Date.now, log = msg => console.error('[platypus] ' + msg) } = {}) {
    this.dir = dir;
    this.log = log;
    this.clock = clock;
    this.store = openStoreSafe({ backend: backend || process.env.PLATYPUS_STORE_BACKEND || 'sqlite', dir, requireFields: true, clock, onGuard: m => log('store: ' + m), onError: e => log('store: ' + (e && e.message || e)) });
    // la conservazione scelta nelle opzioni; se non ha senso valgono i tempi di partenza
    try { declareCollections(this.store, { retention: settings.storeRetention || undefined }); }
    catch (e) { log('store: ' + e.message); declareCollections(this.store); }
    this.keys = new ProjectKeys({ store: this.store, clock });
    this.imported = null; // che cosa ha fatto il passaggio dei dati di prima (per le prove e per il registro)
    this.pending = new Map(); // _id -> { coll, doc }: passi e riassunti che aspettano di andare nello storico
    this.timer = null;
    this.summaries = new Map(); // id della sessione -> il riassunto scritto l'ultima volta (JSON)
    if (this.store.fallback) log('store: ' + this.store.fallback.code + ': ' + this.store.fallback.detail);
  }

  // dopo che il server è partito: porta nello store i dati della 2.12, se non è già stato fatto
  async start() {
    if (this.store.fallback) return null; // in memoria non resterebbero: si riprova al prossimo avvio
    try { this.imported = await importLegacy(this.store, this.dir, { keys: this.keys, clock: this.clock }); }
    catch (e) { this.imported = { done: false, error: e.message }; this.log('store: i dati di prima non sono entrati nello storico, riprovo al prossimo avvio (' + e.message + ')'); }
    return this.imported;
  }

  // ---- i passi: un documento per ogni azione finita, fatti e mai testo (collezione steps)
  // L'_id è la sessione con l'id dell'azione: quando il motore rilegge una sessione aperta dall'inizio (a ogni
  // avvio) gli stessi passi non si contano due volte. La demo non lascia niente.
  recordStep(s, a, step) {
    if (!s || s.demo || !s.cwd || !step || !step.id) return;
    const act = step.act || 'other', cmdLike = /^(run|verify|look)$/.test(act);
    let target = typeof step.target === 'string' ? step.target : '';
    if (target.startsWith('web:?')) target = 'web:?'; // una ricerca: si sa che c'è stata, non che cosa si cercava
    else if (/^(cmd|web|tool|agent):/.test(target)) target = scrub(target);
    const doc = {
      _id: `${s.id}:${step.id}`, project: this.keys.keyNow(s.cwd), t: step.t, session: s.id, agent: a && a.id ? String(a.id) : 'main',
      action: act, tool: String(step.tool || ''), outcome: step.err ? 'error' : 'ok', dur: step.dur || 0,
    };
    if (target) doc.target = target;
    if (step.phase) doc.phase = String(step.phase);
    if (cmdLike) { const c = cmdCore(String(step.sig || '').replace(/^run:/, '')); if (c) doc.cmd = c; }
    if (step.fail) {
      if (step.fail.kind) doc.fail = String(step.fail.kind);
      const e = step.fail.excerpt ? errorPattern(step.fail.excerpt) : '';
      if (e) doc.err = e;
    }
    this.queue('steps', doc);
  }

  // ---- il riassunto di ogni sessione (collezione sessions): si riscrive solo se è cambiato
  summarize(state) {
    if (!state || !state.sessions) return 0;
    let n = 0;
    for (const s of state.sessions.values()) {
      if (s.demo || !s.cwd) continue;
      const sum = o => Object.values(o || {}).reduce((x, y) => x + (Number(y) || 0), 0);
      const tok = s.tok ? (s.tok.in || 0) + (s.tok.out || 0) + (s.tok.cr || 0) + (s.tok.cw || 0) : 0;
      let cost = 0;
      try { cost = state.costOf(s); } catch {}
      const doc = {
        _id: s.id, project: this.keys.keyNow(s.cwd), t: s.createdAt || 0, end: s.ended ? (s.endedAt || s.lastActivity || 0) : (s.lastActivity || 0),
        kind: String(s.kind || ''), model: String((s.main && s.main.model) || ''), effort: String((s.main && s.main.effort) || ''),
        agents: 1 + (s.subs ? s.subs.size : 0), actions: sum(s.toolsByType), errors: sum(s.errByType),
        cost: Number.isFinite(cost) ? cost : 0, tokens: tok,
      };
      const json = JSON.stringify(doc);
      if (this.summaries.get(s.id) === json) continue;
      this.summaries.set(s.id, json);
      this.queue('sessions', doc);
      n++;
    }
    return n;
  }

  // ---- la coda: in memoria, poi nello storico in una transazione sola
  queue(coll, doc) {
    this.pending.set(coll + '\n' + doc._id, { coll, doc });
    if (this.pending.size >= FLUSH_DOCS) return this.flush();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending.size) return 0;
    const batch = [...this.pending.values()];
    this.pending.clear();
    // la chiave del progetto può essere arrivata da git nel frattempo
    for (const x of batch) if (x.doc.project) x.doc.project = this.keys.canonical(x.doc.project);
    const put = x => this.store.collection(x.coll).put(x.doc);
    try { this.store.transaction(() => { for (const x of batch) put(x); }); return batch.length; }
    catch (e) {
      // uno sbagliato non deve far perdere gli altri: si riprova uno per uno e si scrive nel registro chi non entra
      let n = 0, bad = 0;
      for (const x of batch) { try { put(x); n++; } catch { bad++; } }
      this.log(`store: ${bad} documenti non salvati nello storico (${e && e.message || e})`);
      return n;
    }
  }

  // la frase per l'avviso nell'ufficio («storico non disponibile: …»), o '' se va tutto bene
  notice() { return fallbackReason(this.store.fallback); }
  // per /api/state: quale backend e l'eventuale avviso
  info() { return { backend: this.store.backend, notice: this.notice() }; }

  stop() {
    try { this.flush(); } catch (e) { this.log('store: ' + e.message); }
    try { this.store.close(); } catch (e) { this.log('store: ' + e.message); }
  }
}

module.exports = { History, FLUSH_MS, FLUSH_DOCS };
