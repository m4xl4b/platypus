'use strict';
// Registro dei messaggi agli agenti (mandati o in ombra), un file per progetto: ~/.platypus/feedback/<chiave>.jsonl
// Solo aggiunte in coda: una riga per messaggio, e una riga per l'esito quando si viene a sapere che cosa è successo dopo.
// L'interfaccia è piccola apposta (append, recent, setOutcome): lo storage della 2.12 la sostituirà senza toccare chi la usa.
//   messaggio   { id, t, sid, agent, feature, mode, event, lessonId, text }
//   esito       { id, outcome, at, why? }   (outcome: helped | ignored | unclear | late, vedi outcomes.js)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectKey } = require('./bottega');

const MAX_BYTES = 5 * 1024 * 1024; // oltre, il file diventa <chiave>.1.jsonl (uno solo) e si riparte

class FeedbackLog {
  constructor(dir = path.join(require('../paths').dataDir(), 'feedback'), { maxBytes = MAX_BYTES } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.made = false;
  }
  file(cwd, old) { return path.join(this.dir, projectKey(cwd) + (old ? '.1' : '') + '.jsonl'); }
  write(cwd, obj) {
    if (!this.made) { fs.mkdirSync(this.dir, { recursive: true }); this.made = true; }
    const f = this.file(cwd);
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    if (size > this.maxBytes) fs.renameSync(f, this.file(cwd, true)); // il giro precedente si perde: il registro non cresce senza fine
    fs.appendFileSync(f, JSON.stringify(obj) + '\n');
  }
  // aggiunge un messaggio e gli dà un identificativo
  append(cwd, entry) {
    const e = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), ...entry };
    this.write(cwd, e);
    return e;
  }
  // che cosa è successo dopo quel messaggio (lo decide chi guarda i fatti: vedi C2 nel piano)
  setOutcome(cwd, id, outcome, why) {
    if (!id || !outcome) return false;
    this.write(cwd, { id, outcome: String(outcome), at: Date.now(), ...(why ? { why: String(why).slice(0, 200) } : {}) });
    return true;
  }
  // gli ultimi messaggi del progetto, dal più recente, ognuno con il suo esito se c'è
  recent(cwd, n = 200) {
    const rows = [];
    for (const f of [this.file(cwd, true), this.file(cwd)]) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const l of text.split('\n')) { if (!l) continue; try { rows.push(JSON.parse(l)); } catch {} }
    }
    const outcomes = new Map();
    for (const r of rows) if (r.outcome && r.id) outcomes.set(r.id, { outcome: r.outcome, at: r.at, ...(r.why ? { why: r.why } : {}) });
    return rows.filter(r => r.text).map(r => ({ ...r, ...(outcomes.get(r.id) || {}) })).sort((a, b) => b.t - a.t).slice(0, n);
  }
  // quanti messaggi per funzione da un certo momento in poi, in tutti i progetti: { funzione: { on, shadow } }.
  // Una risposta arrivata tardi (outcome «late») non è stata mandata: non conta tra quelle mandate.
  counts(since = 0) {
    const out = {};
    let files = [];
    try { files = fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl')); } catch { return out; }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(this.dir, f), 'utf8'); } catch { continue; }
      const rows = [], late = new Set();
      for (const l of text.split('\n')) {
        if (!l) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (r.outcome === 'late') late.add(r.id);
        else if (r.text && r.t >= since && r.feature) rows.push(r);
      }
      for (const r of rows) {
        if (late.has(r.id)) continue;
        const c = out[r.feature] || (out[r.feature] = { on: 0, shadow: 0 });
        if (r.mode === 'on') c.on++; else c.shadow++;
      }
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

module.exports = { FeedbackLog, MemoryFeedbackLog, MAX_BYTES };
