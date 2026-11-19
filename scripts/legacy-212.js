'use strict';
// Come scriveva i suoi file la 2.12, per le prove: il registro dei messaggi agli agenti in
// <cartella>/<chiave>.jsonl. Il motore non lo usa più (dalla 2.13 il registro sta nello store, vedi
// src/core/feedbacklog.js): serve a costruire dati di prima veri per le prove del passaggio (src/core/store/legacy.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathKey: projectKey } = require('../src/core/store/project-key');

const MAX_BYTES = 5 * 1024 * 1024; // oltre, il file diventa <chiave>.1.jsonl (uno solo) e si riparte

class FileFeedbackLog {
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


// il Libro della bottega come lo scriveva la 2.12: un file JSON per cartella, <cartella>/<chiave>.json, con la cartella dentro
const { Bottega, projectKey: folderKey } = require('../src/core/bottega');
class FileBottega extends Bottega {
  constructor(dir) { super({}); this.dir = dir; }
  keyOf(cwd) { return folderKey(cwd); }
  loadBook(key, cwd) {
    const b = super.loadBook(key, cwd), fresh = b.name;
    try { Object.assign(b, JSON.parse(fs.readFileSync(path.join(this.dir, key + '.json'), 'utf8')), { key }); } catch {}
    b.strays = new Set();
    b.dirty = false;
    if (fresh && b.name !== fresh) { b.name = fresh; b.dirty = true; }
    return b;
  }
  save() {
    for (const b of this.books.values()) {
      if (!b.dirty || b.demo) continue;
      b.dirty = false;
      const { dirty, job, demo, strays, ...data } = b;
      if (!data.mute) delete data.mute;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, b.key + '.json'), JSON.stringify(data));
    }
  }
}

module.exports = { FileFeedbackLog, FileBottega, MAX_BYTES };
