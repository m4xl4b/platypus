'use strict';
// Archivio delle sessioni passate e replay accelerato, ricostruiti dai transcript di Claude Code.
// Il replay usa lo stesso motore del live con un orologio virtuale.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { OfficeState, kindOf } = require('./state');
const { claudeDir } = require('./sources');
const { tr } = require('../i18n');

const HEAD = 64 * 1024, TAIL = 256 * 1024, FIRST_LINE_MAX = 8 * 1024 * 1024;
const cache = new Map(); // path -> {mtime, size, info}

function readSlice(p, start, len) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function parseLines(text, dropFirst, dropLast) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function summarize(p, st) {
  let headText = readSlice(p, 0, Math.min(HEAD, st.size));
  // prima riga più lunga di 64 KB (es. un'immagine incollata): si legge fino al suo a capo, entro un limite
  if (st.size > HEAD && headText.indexOf('\n') < 0) {
    const big = readSlice(p, 0, Math.min(FIRST_LINE_MAX, st.size)), nl = big.indexOf('\n');
    if (nl >= 0) headText = big.slice(0, nl + 1);
  }
  const head = parseLines(headText, false, st.size > HEAD);
  const tailStart = Math.max(0, st.size - TAIL);
  // sotto i 256 KB la "coda" è tutto il file (la testa si ferma a 64 KB: fine e titolo stanno più avanti)
  const tail = st.size > HEAD ? parseLines(readSlice(p, tailStart, st.size - tailStart), tailStart > 0, false) : head;
  let start = 0, end = 0, cwd = '', ep = '', title = '', prompt = '';
  for (const o of head) {
    const ts = Date.parse(o.timestamp);
    if (ts && !start) start = ts;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!ep && o.entrypoint) ep = o.entrypoint;
    if (!prompt && o.type === 'user' && typeof (o.message || {}).content === 'string' && !o.isMeta && !o.message.content.startsWith('<')) prompt = o.message.content.slice(0, 120);
  }
  for (const o of tail) {
    const ts = Date.parse(o.timestamp);
    if (ts) end = Math.max(end, ts);
    if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    if (!ep && o.entrypoint) ep = o.entrypoint;
    if (!cwd && o.cwd) cwd = o.cwd;
  }
  if (!title) for (const o of head) if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
  const id = path.basename(p, '.jsonl');
  let subagents = 0;
  try { subagents = fs.readdirSync(path.join(path.dirname(p), id, 'subagents')).filter(f => f.endsWith('.jsonl')).length; } catch {}
  let workflows = 0, wfAgents = 0; // esecuzioni di Workflow e i loro agenti
  try { for (const r of fs.readdirSync(path.join(path.dirname(p), id, 'subagents', 'workflows'), { withFileTypes: true })) { if (!r.isDirectory()) continue; workflows++; try { wfAgents += fs.readdirSync(path.join(path.dirname(p), id, 'subagents', 'workflows', r.name)).filter(f => /^agent-.+\.jsonl$/.test(f)).length; } catch {} } } catch {}
  return {
    id, key: path.basename(path.dirname(p)) + '/' + id, path: p, cwd, project: cwd ? path.basename(cwd.replace(/\\/g, '/')) : path.basename(path.dirname(p)),
    kind: kindOf(ep), title: title || prompt || '', start: start || st.mtimeMs, end: end || st.mtimeMs, size: st.size, subagents: subagents + wfAgents, workflows,
  };
}

// le sessioni più recenti, dalla più nuova
function listArchive({ base, limit = 120, liveIds = new Set() } = {}) {
  const dir = path.join(base || claudeDir(), 'projects');
  const files = [];
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    let entries = [];
    try { entries = fs.readdirSync(path.join(dir, d.name)); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, d.name, f);
      try { const st = fs.statSync(p); if (st.size > 200) files.push({ p, st }); } catch {}
    }
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const { p, st } of files.slice(0, limit)) {
    let c = cache.get(p);
    if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) { c = { mtime: st.mtimeMs, size: st.size, info: summarize(p, st) }; cache.set(p, c); }
    const info = { ...c.info, live: liveIds.has(c.info.id) };
    delete info.path;
    out.push(info);
  }
  return out;
}

// key = "<cartella progetto>/<id sessione>" (lo stesso id può comparire in più progetti)
function findSessionFile(base, key) {
  const dir = path.join(base || claudeDir(), 'projects');
  const m = /^([^/\\]{1,255})\/([A-Za-z0-9-]{8,80})$/.exec(key || '');
  if (m && !m[1].includes('..')) {
    const p = path.join(dir, m[1], m[2] + '.jsonl');
    return fs.existsSync(p) ? p : null;
  }
  const id = key;
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    const p = path.join(dir, d.name, id + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// tutte le righe della sessione (capo + sottoagenti) in ordine di tempo
function loadEvents(file) {
  const id = path.basename(file, '.jsonl');
  const events = [];
  const push = (lines, agentId, meta) => {
    let last = 0;
    for (const o of lines) {
      const ts = Date.parse(o.timestamp) || last;
      if (!ts) continue;
      last = ts;
      events.push({ ts, agentId, line: o, meta, seq: events.length });
    }
  };
  push(parseLines(fs.readFileSync(file, 'utf8')), null, null);
  const sdir = path.join(path.dirname(file), id, 'subagents');
  let subs = [];
  try { subs = fs.readdirSync(sdir).filter(f => /^agent-.+\.jsonl$/.test(f)); } catch {}
  for (const f of subs) {
    const agentId = f.slice(6, -6);
    let m = null;
    try { m = JSON.parse(fs.readFileSync(path.join(sdir, f.slice(0, -6) + '.meta.json'), 'utf8')); } catch {}
    const meta = m ? { agentType: m.agentType, description: m.description, toolUseId: m.toolUseId, parentAgentId: m.parentAgentId, teamName: m.teamName, workflowPhase: m.workflowPhase, name: m.name, background: m.requestShape ? m.requestShape !== 'foreground' : undefined } : null;
    try { push(parseLines(fs.readFileSync(path.join(sdir, f), 'utf8')), agentId, meta); } catch {}
  }
  // gli agenti dei Workflow: etichetta e fase dal giornale, esito all'ultima riga dell'agente, riepilogo alla fine
  let runs = [];
  try { runs = fs.readdirSync(path.join(sdir, 'workflows'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const runId of runs) {
    const rdir = path.join(sdir, 'workflows', runId);
    const started = new Map(), outcome = new Map();
    let journal = [];
    try { journal = parseLines(fs.readFileSync(path.join(rdir, 'journal.jsonl'), 'utf8')); } catch {}
    for (const ev of journal) {
      if (ev && ev.type === 'started' && ev.agentId) started.set(String(ev.agentId), ev);
      if (ev && (ev.type === 'result' || ev.type === 'failed') && ev.agentId) outcome.set(String(ev.agentId), ev.type);
    }
    let files = [];
    try { files = fs.readdirSync(rdir).filter(f => /^agent-.+\.jsonl$/.test(f)); } catch {}
    for (const f of files) {
      const agentId = f.slice(6, -6);
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(rdir, f.slice(0, -6) + '.meta.json'), 'utf8')); } catch {}
      const ev = started.get(agentId) || {};
      const meta = { agentType: m && m.agentType, description: m && m.description, workflowPhase: ev.phase || (m && m.workflowPhase), workflowRunId: runId, name: ev.label || undefined };
      const before = events.length;
      try { push(parseLines(fs.readFileSync(path.join(rdir, f), 'utf8')), agentId, meta); } catch {}
      const last = events.length > before ? events[events.length - 1].ts : 0;
      if (ev.agentId && last) events.push({ ts: events[before].ts, agentId: null, workflow: { runId, event: { type: 'started', agentId, key: ev.key, label: ev.label, phase: ev.phase } }, seq: events.length });
      if (outcome.has(agentId) && last) events.push({ ts: last, agentId: null, workflow: { runId, event: { type: outcome.get(agentId), agentId } }, seq: events.length });
    }
    const sum = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(file), id, 'workflows', runId + '.json'), 'utf8')); } catch { return null; } })();
    if (sum) {
      const end = (Number(sum.startTime) || 0) + (Number(sum.durationMs) || 0) || (events.length ? Math.max(...events.map(e => e.ts)) : 0);
      if (end) events.push({ ts: end, agentId: null, workflow: { runId, summary: sum }, seq: events.length });
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return { id, events };
}

// un evento di loadEvents nello stato: una riga di transcript o un fatto di un Workflow (giornale, riepilogo)
function applyEvent(state, id, e) {
  if (e.workflow) {
    if (e.workflow.summary) state.applyWorkflowSummary(id, e.workflow.runId, e.workflow.summary);
    else state.applyWorkflowEvent(id, e.workflow.runId, e.workflow.event);
    return;
  }
  state.applyTranscriptLine(id, e.agentId, e.line, { meta: e.meta ? { ...e.meta } : null });
}

class Replay extends EventEmitter {
  constructor({ file, base, settings }) {
    super();
    const { id, events } = loadEvents(file);
    if (!events.length) throw new Error(tr('sessione vuota'));
    this.id = id;
    this.events = events;
    this.settings = settings;
    this.start = events[0].ts;
    this.end = events[events.length - 1].ts;
    this.speed = 30;
    this.playing = true;
    this.done = false;
    this.skipped = 0;
    this.reset();
    this.timer = setInterval(() => this.step(100), 100);
    this.lastEmit = 0;
  }

  reset() {
    if (this.state) this.state.stop();
    this.vt = this.start - 1000;
    this.idx = 0;
    this.state = new OfficeState({ manual: true, noTimeout: true, clock: () => this.vt, settings: this.settings });
    this.done = false;
  }

  feedUntil(t) {
    while (this.idx < this.events.length && this.events[this.idx].ts <= t) {
      const e = this.events[this.idx++];
      applyEvent(this.state, this.id, e);
    }
  }

  step(realMs) {
    if (!this.playing || this.done) return;
    this.vt += realMs * this.speed;
    // salta le pause lunghe (utente via, sessione ferma): il replay non resta mai fermo a lungo
    const next = this.events[this.idx];
    if (next && next.ts - this.vt > 90000) { this.skipped += next.ts - this.vt - 3000; this.vt = next.ts - 3000; }
    this.feedUntil(this.vt);
    this.state.tick();
    if (this.idx >= this.events.length && this.vt > this.end + 8000) { this.done = true; this.playing = false; }
    const now = Date.now();
    if (now - this.lastEmit > 200 || this.done) { this.lastEmit = now; this.emit('frame', this.frame()); }
  }

  control(action, value) {
    if (action === 'play') { if (this.done) this.seek(0); this.playing = true; }
    else if (action === 'pause') this.playing = false;
    else if (action === 'speed') { const v = Number(value); if (v > 0 && v <= 3600) this.speed = v; }
    else if (action === 'seek') this.seek(Number(value) || 0);
    this.emit('frame', this.frame());
  }

  seek(f) {
    f = Math.max(0, Math.min(1, f));
    const target = this.start + f * (this.end - this.start);
    this.reset();
    // avanza velocemente fino al punto scelto, con un "tick" ogni 2 secondi virtuali
    while (this.vt < target) {
      this.vt = Math.min(target, this.vt + 2000);
      const next = this.events[this.idx];
      if (next && next.ts - this.vt > 90000 && next.ts < target) this.vt = next.ts - 3000;
      this.feedUntil(this.vt);
      this.state.tick();
    }
  }

  frame() {
    const s = this.state.sessions.get(this.id);
    return {
      id: this.id,
      start: this.start, end: this.end, vt: this.vt,
      progress: (this.vt - this.start) / Math.max(1, this.end - this.start),
      playing: this.playing, speed: this.speed, done: this.done,
      session: s ? this.state.sessionSnapshot(s) : null,
      log: this.state.log.slice(-12),
    };
  }

  stop() { clearInterval(this.timer); this.state.stop(); this.removeAllListeners(); }
}

module.exports = { listArchive, findSessionFile, loadEvents, applyEvent, Replay };
