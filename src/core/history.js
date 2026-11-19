'use strict';
// Lo storico del motore: lo store (src/core/store) aperto sulla cartella dei dati, con le sue collezioni, la
// chiave dei progetti e il passaggio dei dati della 2.12. È l'unico punto in cui il motore tocca lo store:
// statistiche, Libro e registro dei messaggi lo ricevono da qui.
//
// Non ferma mai l'ufficio: se il database non si apre, lo store è in memoria (lo storico non resta) e
// notice() dà la frase da mostrare. La demo non passa mai di qui: ha i suoi dati finti in memoria.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStoreSafe, fallbackReason, scrub } = require('./store');
const { cmdCore, errorPattern } = require('./bottega');
const { cmdShape } = require('./search');
const { forgetIn } = require('./stats');
const { declareCollections } = require('./store/collections');
const { ProjectKeys } = require('./store/project-key');
const { importLegacy } = require('./store/legacy');
const { retentionFromSettings } = require('./retention');

// le copie di sicurezza accanto a platypus.db: prima delle migrazioni, database messi da parte (con -wal e -shm), file della 2.12
const BACKUP_RE = /^(platypus\.db\.(bak-\d+|broken-[\d-]+)(-wal|-shm)?|legacy-\d{8})$/;
const FLUSH_MS = 2000, FLUSH_DOCS = 500;
// il database è tenuto da un altro processo più a lungo dell'attesa di SQLite (busy_timeout, 3 s)
const isBusy = e => !!e && (e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY|database table is locked/i.test(String(e.message)));
const COUNT_MS = 5 * 60000; // i conteggi pesanti di una sessione, al massimo ogni 5 minuti
const COUNT_FIELDS = ['surprises', 'loops', 'stuck', 'flaky', 'claims', 'stale', 'lessons']; // come la coda di sqlite.js: al massimo ogni 2 s, o a 500 documenti

class History {
  // dir: la cartella dei dati (dove sta platypus.db); settings: le opzioni vive del motore
  constructor({ dir, settings = {}, backend, clock = Date.now, checkLimit, log = msg => console.error('[platypus] ' + msg) } = {}) {
    this.dir = dir;
    this.log = log;
    this.clock = clock;
    this.store = openStoreSafe({ backend: backend || process.env.PLATYPUS_STORE_BACKEND || 'sqlite', dir, requireFields: true, clock, checkLimit, onGuard: m => log('store: ' + m), onError: e => log('store: ' + (e && e.message || e)) });
    this.damaged = ''; // il controllo in background ha trovato un danno (vedi start)
    this.check = null;
    // la conservazione scelta nelle opzioni; se non ha senso valgono i tempi di partenza
    try { declareCollections(this.store, { retention: retentionFromSettings(settings) }); }
    catch (e) { log('store: ' + e.message); declareCollections(this.store); }
    this.keys = new ProjectKeys({ store: this.store, clock });
    this.imported = null; // che cosa ha fatto il passaggio dei dati di prima (per le prove e per il registro)
    this.pending = new Map(); // _id -> { coll, doc }: passi e riassunti che aspettano di andare nello storico
    this.timer = null;
    this.summaries = new Map(); // id della sessione -> il riassunto scritto l'ultima volta (JSON)
    this.countCache = new Map(); // id della sessione -> { at, activity, values }: gli ultimi conteggi pesanti
    if (this.store.fallback) log('store: ' + this.store.fallback.code + ': ' + this.store.fallback.detail);
  }

  // dopo che il server è partito: porta nello store i dati della 2.12, se non è già stato fatto
  async start() {
    if (this.store.fallback) return null; // in memoria non resterebbero: si riprova al prossimo avvio
    // un database grande si controlla qui, in un thread a parte, mentre l'ufficio lavora già
    const d = this.store.driver;
    if (d && d.checkLater && typeof d.checkInBackground === 'function') {
      this.check = await d.checkInBackground();
      if (!this.check.ok) { this.damaged = this.check.detail; this.log('store: il database è rovinato (' + this.check.detail + '): al prossimo avvio lo metto da parte'); }
    }
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
    // del comando resta solo la forma (search.js, cmdShape): le prime parole semplici, mai gli argomenti dopo un flag
    if (cmdLike) { const c = cmdShape(cmdCore(String(step.sig || '').replace(/^run:/, ''))); if (c) doc.cmd = c; }
    if (step.fail) {
      if (step.fail.kind) doc.fail = String(step.fail.kind);
      const e = step.fail.excerpt ? errorPattern(step.fail.excerpt) : '';
      if (e) doc.err = e;
    }
    this.queue('steps', doc);
  }

  // ---- le azioni rischiose (2.14, fear.js): un documento per azione, con lo stesso _id del suo passo.
  // step.risk lo mette il motore quando l'azione comincia. Si scrive con patch: rileggere una sessione all'avvio
  // non cancella com'è finita (outcome, che arriva dopo). La demo non lascia niente.
  recordRisk(s, a, step) {
    const r = step && step.risk;
    if (!s || s.demo || !s.cwd || !step || !step.id || !r || !(r.level >= 1)) return;
    const doc = {
      _id: `${s.id}:${step.id}`, project: this.keys.keyNow(s.cwd), t: step.t, session: s.id, agent: a && a.id ? String(a.id) : 'main', tool: String(step.tool || ''),
      ruleIds: (r.ruleIds || []).map(String), level: r.level, prudence: Number(r.prudence) || 0, present: r.present || [], missing: r.missing || [], missed: !!r.missed,
    };
    if (r.shape) doc.shape = String(r.shape);
    if (r.target) doc.target = String(r.target);
    if (r.feedbackGroup) doc.feedbackGroup = String(r.feedbackGroup);
    // com'è finita (le cicatrici, R4): i segni sono rimandi ad altri passi, mai testo
    if (r.outcome) { doc.outcome = String(r.outcome); doc.at = Number(r.at) || step.t; doc.evidence = (r.evidence || []).map(String).slice(0, 8); }
    this.queue('risks', doc, { merge: true });
  }

  // ---- l'esperimento sul feedback (S11): il gruppo di una sessione per una funzione, una volta sola
  recordExperiment({ cwd, sid, feature, group, t }) {
    if (!cwd || !sid || !feature || (group !== 'on' && group !== 'shadow')) return;
    this.queue('experiments', { _id: `${sid}:${feature}`, project: this.keys.keyNow(cwd), t: t || this.clock(), sid: String(sid), feature, group });
  }

  // ---- il riassunto di ogni sessione (collezione sessions): si riscrive solo se è cambiato.
  // counts(s): i conteggi pesanti (sorprese, giri in tondo, affermazioni senza prove…), che dà il motore: si rifanno al
  // massimo ogni COUNT_MS per sessione, solo se la sessione si è mossa, e sempre con final (alla chiusura)
  summarize(state, { counts = null, final = false } = {}) {
    if (!state || !state.sessions) return 0;
    let n = 0;
    const now = this.clock();
    for (const s of state.sessions.values()) {
      if (s.demo || !s.cwd) continue;
      let c = this.countCache.get(s.id);
      if (counts && (!c || (c.activity !== s.lastActivity && (final || now - c.at >= COUNT_MS)))) {
        try { c = { at: now, activity: s.lastActivity, values: counts(s) || {} }; this.countCache.set(s.id, c); } catch { /* resta il conteggio di prima */ }
      }
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
      if (c) for (const [k, v] of Object.entries(c.values)) if (COUNT_FIELDS.includes(k) && Number.isFinite(v)) doc[k] = v;
      const json = JSON.stringify(doc);
      if (this.summaries.get(s.id) === json) continue;
      this.summaries.set(s.id, json);
      this.queue('sessions', doc);
      n++;
    }
    return n;
  }

  // ---- la coda: in memoria, poi nello storico in una transazione sola
  // merge: i campi nuovi si aggiungono a quelli già scritti invece di sostituire il documento
  queue(coll, doc, { merge = false } = {}) {
    const k = coll + '\n' + doc._id, prev = merge ? this.pending.get(k) : null;
    this.pending.set(k, { coll, doc: prev ? { ...prev.doc, ...doc } : doc, merge });
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
    const put = x => { const c = this.store.collection(x.coll); const old = x.merge ? c.get(x.doc._id) : null; c.put(old ? { ...old, ...x.doc } : x.doc); };
    try { this.store.transaction(() => { for (const x of batch) put(x); }); return batch.length; }
    catch (e) {
      // un altro Platypus tiene il database (una compattazione, un "Dimentica"): niente va perso, si riprova tra poco
      if (isBusy(e)) {
        for (const x of batch) { const k = x.coll + '\n' + x.doc._id; if (!this.pending.has(k)) this.pending.set(k, x); }
        this.busy = (this.busy || 0) + 1;
        if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS); if (this.timer.unref) this.timer.unref(); }
        return 0;
      }
      // uno sbagliato non deve far perdere gli altri: si riprova uno per uno e si scrive nel registro chi non entra
      let n = 0, bad = 0;
      for (const x of batch) { try { put(x); n++; } catch { bad++; } }
      this.log(`store: ${bad} documenti non salvati nello storico (${e && e.message || e})`);
      return n;
    }
  }

  // ---- "Dimentica questo progetto" (S10): ogni documento della sua chiave e dei suoi alias, in ogni collezione; le
  // voci delle statistiche che lo riguardano; i Libri in memoria; poi VACUUM, così nel file non resta niente.
  // state: lo stato dell'ufficio (le sessioni aperte del progetto), bottega e stats: quelli del motore.
  // Anche le copie di sicurezza accanto al database si cancellano, perché contengono anche quel progetto (deciso da Max il
  // 2026-11-19): platypus.db.bak-* (prima delle migrazioni), platypus.db.broken-* (database messi da parte) e
  // legacy-*/ (la copia dei file della 2.12). E il progetto esce anche dai file della 2.12 al loro posto (deciso da Max lo
  // stesso giorno): bottega/<chiave>.json, feedback/<chiave>[.1].jsonl e le sue voci in stats.json. Chi chiede conferma lo dice.
  forgetProject(key, { state = null, bottega = null, stats = null } = {}) {
    if (typeof key !== 'string' || !/^[0-9a-f]{16}$/.test(key)) return null;
    const keys = this.keys.allKeys(key);
    const k = new Set(keys);
    const sessions = new Set(), names = new Set();
    try {
      for (const d of this.store.collection('sessions').find({ project: { $in: keys } }, { fields: [] })) sessions.add(d._id);
      for (const d of this.store.collection('steps').find({ project: { $in: keys } }, { fields: ['session'] })) if (d.session) sessions.add(d.session);
      for (const kk of keys) { const p = this.store.collection('projects').get(kk); if (p && p.name) names.add(p.name); }
    } catch (e) { this.log('store: ' + e.message); }
    if (state && state.sessions) for (const s of state.sessions.values()) {
      if (s.demo || !s.cwd) continue;
      if (k.has(this.keys.keyNow(s.cwd))) { sessions.add(s.id); try { names.add(state.label(s)); } catch {} }
    }
    if (bottega) for (const b of bottega.books.values()) if (k.has(b.key) && b.name) names.add(b.name);
    // prima quello che è in memoria, poi lo storico: nessun salvataggio deve riportarlo indietro
    const removed = { books: bottega ? bottega.forgetBooks(keys) : 0, stats: stats ? stats.forget({ sessions, names }) : 0, documents: 0, sessions: sessions.size };
    for (const [id, x] of this.pending) if (k.has(x.doc.project) || (x.coll === 'sessions' && sessions.has(x.doc._id))) this.pending.delete(id);
    for (const id of sessions) this.summaries.delete(id);
    this.flush();
    for (const kk of keys) removed.documents += this.store.forgetProject(kk);
    // i riassunti delle sessioni con la chiave della cartella (scritti prima che git rispondesse) e i passi senza progetto
    try { this.store.transaction(() => { for (const id of sessions) if (this.store.collection('sessions').delete(id)) removed.documents++; removed.documents += this.store.collection('steps').deleteMany({ session: { $in: [...sessions] } }); }); } catch {}
    this.keys.forget(keys);
    try { removed.size = this.store.compact(); } catch (e) { this.log('store: ' + e.message); }
    removed.backups = this.deleteBackups();
    removed.legacy = this.forgetLegacy(keys, { sessions, names });
    this.log(`store: progetto dimenticato (${removed.documents} documenti, ${removed.stats} voci delle statistiche)`);
    return removed;
  }

  // ---- le copie di sicurezza accanto al database: i nomi, e la cancellazione (per "Dimentica")
  backups() {
    try { return fs.readdirSync(this.dir).filter(n => BACKUP_RE.test(n)).sort(); } catch { return []; }
  }
  deleteBackups() {
    const gone = [];
    for (const n of this.backups()) {
      try { fs.rmSync(path.join(this.dir, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); gone.push(n); }
      catch (e) { this.log('store: non riesco a cancellare la copia ' + n + ' (' + e.message + ')'); }
    }
    return gone;
  }

  // ---- il progetto esce anche dai file della 2.12 (quelli che la 2.12 rilegge se si torna indietro).
  // Le chiavi della 2.12 sono quelle delle cartelle: sono tra gli alias del progetto (o sono la sua chiave, senza remote)
  forgetLegacy(keys, { sessions = new Set(), names = new Set() } = {}) {
    const out = { files: [], statsEntries: 0 };
    for (const k of keys) {
      if (!/^[0-9a-f]{16}$/.test(k)) continue;
      for (const rel of [path.join('bottega', k + '.json'), path.join('feedback', k + '.jsonl'), path.join('feedback', k + '.1.jsonl')]) {
        const f = path.join(this.dir, rel);
        try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); out.files.push(rel.split(path.sep).join('/')); } }
        catch (e) { this.log('store: non riesco a cancellare ' + rel + ' (' + e.message + ')'); }
      }
    }
    // stats.json: le voci del progetto via, il resto com'era (scritto accanto e poi rinominato: mai un file a metà)
    const sf = path.join(this.dir, 'stats.json');
    try {
      if (fs.existsSync(sf)) {
        const data = JSON.parse(fs.readFileSync(sf, 'utf8'));
        out.statsEntries = forgetIn(data, { sessions, names });
        if (out.statsEntries) { fs.writeFileSync(sf + '.tmp', JSON.stringify(data)); fs.renameSync(sf + '.tmp', sf); }
      }
    } catch (e) { this.log('store: non riesco a togliere il progetto da stats.json (' + e.message + ')'); }
    return out;
  }

  // ---- "Compatta": lo spazio libero torna al disco
  compact() { this.flush(); return this.store.compact(); }

  // ---- "Esporta": un file JSONL per collezione in una cartella nuova; di base ~/Downloads/platypus-export-<data>/
  exportAll(dir) {
    this.flush();
    let target = dir;
    if (!target) {
      const d = new Date(this.clock()), p = n => String(n).padStart(2, '0');
      const base = path.join(os.homedir(), 'Downloads', `platypus-export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`);
      target = base;
      for (let i = 2; fs.existsSync(target); i++) target = `${base}-${i}`;
    }
    const files = [];
    for (const c of this.store.info().collections) files.push(this.store.export(c.name, target));
    return { dir: target, files: files.map(f => ({ collection: f.collection, count: f.count, file: path.basename(f.file) })) };
  }

  // la frase per l'avviso nell'ufficio («storico non disponibile: …»), o '' se va tutto bene
  notice() { return fallbackReason(this.store.fallback || (this.damaged ? { code: 'corrupt' } : null)); }
  // per /api/state: quale backend e l'eventuale avviso
  info() { return { backend: this.store.backend, notice: this.notice() }; }

  stop() {
    try { this.flush(); } catch (e) { this.log('store: ' + e.message); }
    try { this.store.close(); } catch (e) { this.log('store: ' + e.message); }
  }
}

module.exports = { History, FLUSH_MS, FLUSH_DOCS, COUNT_MS, COUNT_FIELDS, isBusy };
