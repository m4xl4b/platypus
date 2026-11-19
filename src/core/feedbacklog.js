'use strict';
// Registro dei messaggi agli agenti (mandati o in ombra) e di che cosa è successo dopo.
// Dalla 2.13 sta nello storico, collezione `feedback` (src/core/store/collections.js): un documento per messaggio,
// con il suo esito quando arriva. L'interfaccia è quella di sempre (append, setOutcome, recent, counts), così chi
// la usa non è cambiato.
//   messaggio   { id, t, sid, agent, feature, mode, event, lessonId, text, … }
//   esito       outcome (helped | ignored | unclear | late, vedi outcomes.js), at, why
// La chiave del progetto è quella dello storico (il repository, o la cartella): keys è il ProjectKeys del motore.

const crypto = require('crypto');

const FIELDS = ['sid', 'agent', 'name', 'feature', 'mode', 'event', 'lessonId', 'tag', 'toolUseId', 'text', 'local', 'about', 'group'];

class FeedbackLog {
  constructor({ store, keys }) {
    this.store = store;
    this.keys = keys;
  }
  coll() { return this.store.collection('feedback'); }
  // le chiavi con cui il progetto di questa cartella può essere stato salvato (la sua e gli alias)
  projects(cwd) { return this.keys.allKeys(this.keys.keyNow(cwd)); }
  row(d) { const { _id, project, ...rest } = d; return { id: _id, ...rest }; }

  // aggiunge un messaggio e gli dà un identificativo
  append(cwd, entry) {
    const doc = { project: this.keys.keyNow(cwd), t: typeof entry.t === 'number' ? entry.t : Date.now() };
    for (const f of FIELDS) if (entry[f] !== undefined && entry[f] !== null && entry[f] !== '') doc[f] = entry[f];
    const saved = this.coll().put(doc);
    return { id: saved._id, ...entry };
  }
  // che cosa è successo dopo quel messaggio (lo decide chi guarda i fatti: vedi C2 nel piano della 2.11)
  setOutcome(cwd, id, outcome, why) {
    if (!id || !outcome) return false;
    return !!this.coll().patch(String(id), { outcome: String(outcome), at: Date.now(), ...(why ? { why: String(why).slice(0, 200) } : {}) });
  }
  // gli ultimi messaggi del progetto, dal più recente, ognuno con il suo esito se c'è
  recent(cwd, n = 200) {
    return this.coll().find({ project: { $in: this.projects(cwd) } }, { sort: { t: -1, _id: -1 }, limit: n }).map(d => this.row(d));
  }
  // quanti messaggi per funzione da un certo momento in poi, in tutti i progetti: { funzione: { on, shadow } }.
  // Una risposta arrivata tardi (outcome «late») non è stata mandata: non conta tra quelle mandate.
  counts(since = 0) {
    const out = {};
    for (const r of this.coll().find({ t: { $gte: since } }, { fields: ['feature', 'mode', 'outcome'] })) {
      if (!r.feature || r.outcome === 'late') continue;
      const c = out[r.feature] || (out[r.feature] = { on: 0, shadow: 0 });
      if (r.mode === 'on') c.on++; else c.shadow++;
    }
    return out;
  }
}

// il registro della demo: la stessa interfaccia, solo in memoria (la demo non scrive niente sul disco, e si svuota quando finisce)
class MemoryFeedbackLog {
  constructor(max = 500) { this.rows = new Map(); this.max = max; } // cartella normalizzata -> righe
  key(cwd) { return require('./bottega').normDir(cwd); }
  append(cwd, entry) {
    const e = { id: 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), ...entry };
    const k = this.key(cwd), l = this.rows.get(k) || [];
    l.push(e);
    if (l.length > this.max) l.shift();
    this.rows.set(k, l);
    return { ...e };
  }
  setOutcome(cwd, id, outcome, why) {
    const e = id && (this.rows.get(this.key(cwd)) || []).find(x => x.id === id);
    if (!e || !outcome) return false;
    Object.assign(e, { outcome: String(outcome), at: Date.now() }, why ? { why: String(why).slice(0, 200) } : {});
    return true;
  }
  recent(cwd, n = 200) { return (this.rows.get(this.key(cwd)) || []).map(e => ({ ...e })).sort((a, b) => b.t - a.t).slice(0, n); }
  has(cwd) { return this.rows.has(this.key(cwd)); }
  counts() { return {}; } // i numeri delle opzioni contano solo i messaggi veri
  clear() { this.rows.clear(); }
}

module.exports = { FeedbackLog, MemoryFeedbackLog };
