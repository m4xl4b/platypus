'use strict';
// Fonti dati locali di Claude Code:
//  - transcript JSONL in <config>/projects/<progetto>/<sessione>.jsonl
//  - sottoagenti in   <config>/projects/<progetto>/<sessione>/subagents/agent-<id>.jsonl (+ .meta.json)
//  - Workflow:        <sessione>/subagents/workflows/<runId>/agent-<id>.jsonl (+ .meta.json) e journal.jsonl
//                     (avvii, etichette, fasi, esiti), riepilogo finale in <sessione>/workflows/<runId>.json
//  - registro sessioni vive in <config>/sessions/<pid>.json
// Tutto in sola lettura.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const RECENT_MS = 25 * 60 * 1000;    // file modificati di recente da seguire
const TAIL_BYTES = 1024 * 1024;       // all'avvio leggiamo al massimo l'ultimo MB di ogni file

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class TranscriptWatcher {
  constructor(state, opts = {}) {
    this.state = state;
    this.base = opts.base || claudeDir();
    this.forceCowork = !!opts.forceCowork; // cartella di una sessione Cowork dell'app desktop
    this.projectsDir = path.join(this.base, 'projects');
    this.files = new Map(); // path -> {offset, partial, sessionId, agentId, metaPath, meta}
    this.wantSessions = new Set(); // sessioni vive (dal registro) da seguire anche se il file è vecchio
    this.trackedSessions = new Set(); // sessioni di cui stiamo leggendo il transcript principale
    this.runSummaries = new Map(); // riepiloghi dei Workflow già letti: path -> mtime
    this.timers = [];
    this.watcher = null;
  }

  start() {
    this.scan(true);
    this.timers.push(setInterval(() => this.scan(false), 4000));
    this.timers.push(setInterval(() => this.pollTracked(), 700));
    this.timers.push(setInterval(() => this.refreshMeta(), 2500));
    try {
      this.watcher = fs.watch(this.projectsDir, { recursive: true }, (_e, rel) => {
        if (!rel) return;
        const p = path.join(this.projectsDir, rel.toString());
        if (p.endsWith('.jsonl')) {
          if (this.files.has(p)) this.readNew(p);
          else this.maybeTrack(p, false);
        } else if (p.endsWith('.meta.json')) {
          this.refreshMeta();
        } else if (p.endsWith('.json')) {
          const r = path.relative(this.projectsDir, p).split(path.sep);
          if (r.length === 4 && r[2] === 'workflows' && this.trackedSessions.has(r[1])) this.readRunSummary(p, r[1]);
        }
      });
      this.watcher.on('error', () => {});
    } catch { /* fs.watch ricorsivo non disponibile: bastano i timer */ }
  }

  stop() {
    this.timers.forEach(clearInterval);
    if (this.watcher) try { this.watcher.close(); } catch {}
  }

  classify(p) {
    // .../projects/<proj>/<sid>.jsonl  oppure .../projects/<proj>/<sid>/subagents/agent-<id>.jsonl
    const rel = path.relative(this.projectsDir, p).split(path.sep);
    if (rel.length === 2 && rel[1].endsWith('.jsonl')) {
      return { sessionId: rel[1].slice(0, -6), agentId: null };
    }
    if (rel.length === 4 && rel[2] === 'subagents' && /^agent-.+\.jsonl$/.test(rel[3])) {
      const agentId = rel[3].slice(6, -6);
      return { sessionId: rel[1], agentId, metaPath: p.slice(0, -6) + '.meta.json' };
    }
    // gli agenti di un Workflow e il suo giornale: .../<sid>/subagents/workflows/<runId>/...
    if (rel.length === 6 && rel[2] === 'subagents' && rel[3] === 'workflows') {
      if (/^agent-.+\.jsonl$/.test(rel[5])) return { sessionId: rel[1], agentId: rel[5].slice(6, -6), metaPath: p.slice(0, -6) + '.meta.json', runId: rel[4] };
      if (rel[5] === 'journal.jsonl') return { sessionId: rel[1], agentId: null, runId: rel[4], journal: true };
    }
    return null;
  }

  // il riepilogo di un Workflow finito: .../<sid>/workflows/<runId>.json (si rilegge quando cambia)
  readRunSummary(p, sessionId) {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (this.runSummaries.get(p) === st.mtimeMs) return;
    const o = readJson(p);
    if (!o || typeof o !== 'object') return;
    this.runSummaries.set(p, st.mtimeMs);
    this.state.applyWorkflowSummary(sessionId, String(o.runId || path.basename(p, '.json')), o);
  }

  scan(initial) {
    let projects;
    try { projects = fs.readdirSync(this.projectsDir, { withFileTypes: true }); } catch { return; }
    const t = Date.now();
    for (const d of projects) {
      if (!d.isDirectory()) continue;
      const pdir = path.join(this.projectsDir, d.name);
      let entries;
      try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(pdir, e.name);
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          this.maybeTrack(full, initial, t);
        } else if (e.isDirectory()) {
          const sdir = path.join(full, 'subagents');
          let subs = [];
          try { subs = fs.readdirSync(sdir); } catch {}
          for (const f of subs) if (f.endsWith('.jsonl')) this.maybeTrack(path.join(sdir, f), initial, t);
          // Workflow: agenti e giornale di ogni esecuzione, poi i riepiloghi di quelle finite
          if (subs.includes('workflows')) {
            let runs = [];
            try { runs = fs.readdirSync(path.join(sdir, 'workflows'), { withFileTypes: true }).filter(x => x.isDirectory()); } catch {}
            for (const r of runs) {
              let fl = [];
              try { fl = fs.readdirSync(path.join(sdir, 'workflows', r.name)); } catch {}
              for (const f of fl) if (f.endsWith('.jsonl')) this.maybeTrack(path.join(sdir, 'workflows', r.name, f), initial, t);
            }
          }
          if (this.trackedSessions.has(e.name)) {
            let sums = [];
            try { sums = fs.readdirSync(path.join(full, 'workflows')).filter(f => f.endsWith('.json')); } catch {}
            for (const f of sums) this.readRunSummary(path.join(full, 'workflows', f), e.name);
          }
        }
      }
    }
  }

  maybeTrack(p, initial, t = Date.now()) {
    if (this.files.has(p)) return;
    const info = this.classify(p);
    if (!info) return;
    let st;
    try { st = fs.statSync(p); } catch { return; }
    const recent = t - st.mtimeMs < RECENT_MS;
    if (info.journal) {
      // il giornale di un Workflow è piccolo: si legge tutto, se è recente o la sessione è già seguita
      // (altrimenti ci si riprova al prossimo giro, quando il transcript principale è stato trovato)
      if (!recent && !this.trackedSessions.has(info.sessionId) && !this.wantSessions.has(info.sessionId)) return;
      this.files.set(p, { ...info, offset: 0, partial: '', ignored: false });
      this.readNew(p, { replay: initial || !recent });
      return;
    }
    if (!recent && !this.wantSessions.has(info.sessionId)) {
      // sottoagente vecchio di una sessione che seguiamo: contiamo solo i suoi token
      if (info.agentId && this.trackedSessions.has(info.sessionId)) {
        const rec = { ...info, ignored: true, offset: st.size, meta: info.metaPath ? normMeta(readJson(info.metaPath) || {}, info.runId) : null };
        this.files.set(p, rec);
        this.accountPrefix(p, rec, st.size, true);
      }
      return;
    }
    if (!info.agentId) this.trackedSessions.add(info.sessionId);

    let meta = null;
    if (info.metaPath) {
      meta = readJson(info.metaPath);
      // sottoagente già concluso prima che aprissimo l'ufficio: ignoralo
      if (initial && meta && meta.finished) {
        const rec = { ...info, ignored: true, offset: st.size, meta: normMeta(meta, info.runId) };
        this.files.set(p, rec);
        this.accountPrefix(p, rec, st.size, true); // i suoi token contano comunque nel costo
        return;
      }
    }
    const rec = { ...info, offset: 0, partial: '', meta: meta || info.runId ? normMeta(meta || {}, info.runId) : null, ignored: false };
    this.files.set(p, rec);
    // primo caricamento: ricostruisce lo stato senza animazioni né log rumorosi
    const start = Math.max(0, st.size - TAIL_BYTES);
    // della parte iniziale (non riletta) contiamo solo token e costi, così i totali sono giusti
    if (start > 0) this.accountPrefix(p, rec, start);
    rec.offset = start;
    this.readNew(p, { replay: initial || !recent, skipFirstLine: start > 0 });
    // la sessione è iniziata prima della coda letta: data di nascita vera (serve alle statistiche per giorno)
    const sess = !info.agentId && rec.firstTs && this.state.sessions.get(info.sessionId);
    if (sess && rec.firstTs < sess.createdAt) sess.createdAt = rec.firstTs;
    if (this.forceCowork && !info.agentId) {
      const cs = this.state.sessions.get(info.sessionId);
      if (cs && !cs.entrypoint) this.state.setEntrypoint(cs, 'local-agent');
    }
  }

  accountPrefix(p, rec, end, detached) {
    const LIMIT = 200 * 1024 * 1024;
    if (end > LIMIT) return;
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const CH = 4 * 1024 * 1024;
      let pos = 0, rest = '';
      const dec = new StringDecoder('utf8'); // un carattere spezzato tra due blocchi non diventa "�"
      while (pos < end) {
        const len = Math.min(CH, end - pos);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        pos += len;
        const lines = (rest + dec.write(buf)).split('\n');
        rest = lines.pop();
        for (const l of lines) {
          // token e costi, ma anche quello che serve alla mappa e alla "mente" (esiti, richieste, compattazioni)
          if (l.indexOf('"usage"') < 0 && l.indexOf('"cost-state"') < 0 && (detached || (l.indexOf('"tool_result"') < 0 && l.indexOf('"type":"user"') < 0 && l.indexOf('"compact_boundary"') < 0 && l.indexOf('"queued_command"') < 0))) continue;
          let obj; try { obj = JSON.parse(l); } catch { continue; }
          if (!rec.agentId && obj.timestamp && !rec.firstTs) rec.firstTs = Date.parse(obj.timestamp) || 0;
          this.state.accountLine(obj.sessionId || rec.sessionId, rec.agentId, obj, rec.meta, detached);
        }
      }
    } catch { /* ignora */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  readNew(p, opts = {}) {
    const rec = this.files.get(p);
    if (!rec) return;
    let fd;
    try {
      const st = fs.statSync(p);
      if (rec.ignored) {
        // un sottoagente vecchio o già concluso che riprende (es. SendMessage): da qui lo seguiamo dal vivo.
        // Il suo passato è già nei token (accountPrefix fino a rec.offset); se il meta dice ancora "finito" è vecchio.
        if (st.size <= rec.offset) return;
        rec.ignored = false;
        rec.partial = ''; rec.dec = null;
        // il meta.json di quel momento: finché non cambia, il suo "finished" è di prima della ripresa
        rec.wokeMeta = -1;
        if (rec.metaPath) try { rec.wokeMeta = fs.statSync(rec.metaPath).mtimeMs; } catch {}
        if (rec.meta) rec.meta = { ...rec.meta, finished: false };
      }
      if (st.size < rec.offset) { rec.offset = 0; rec.partial = ''; rec.dec = null; } // file riscritto
      if (st.size === rec.offset) return;
      fd = fs.openSync(p, 'r');
      const len = st.size - rec.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, rec.offset);
      rec.offset = st.size;
      if (!rec.dec) rec.dec = new StringDecoder('utf8'); // tiene i byte di un carattere UTF-8 spezzato fino alla lettura dopo
      let text = rec.partial + rec.dec.write(buf);
      const lines = text.split('\n');
      rec.partial = lines.pop();
      if (opts.skipFirstLine) lines.shift();
      for (const l of lines) {
        if (!l.trim()) continue;
        let obj;
        try { obj = JSON.parse(l); } catch { continue; }
        const sid = obj.sessionId || rec.sessionId;
        if (rec.journal) this.state.applyWorkflowEvent(rec.sessionId, rec.runId, obj, { replay: !!opts.replay });
        else this.state.applyTranscriptLine(sid, rec.agentId, obj, { replay: !!opts.replay, meta: rec.meta });
      }
    } catch { /* file in scrittura o rimosso */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  pollTracked() {
    for (const p of this.files.keys()) this.readNew(p);
  }

  refreshMeta() {
    for (const [, rec] of this.files) {
      if (!rec.metaPath || rec.ignored) continue;
      const m = readJson(rec.metaPath);
      if (!m) continue;
      rec.meta = normMeta(m, rec.runId);
      // ripreso dopo la fine: un "finished" scritto prima della ripresa non vale più
      if (rec.wokeMeta !== undefined && rec.meta.finished) { try { if (fs.statSync(rec.metaPath).mtimeMs === rec.wokeMeta) rec.meta.finished = false; } catch {} }
      const s = this.state.sessions.get(rec.sessionId);
      if (s && s.subs.has(rec.agentId)) this.state.applySubMeta(s, s.subs.get(rec.agentId), { ...rec.meta });
    }
  }
}

function normMeta(m, runId) {
  return {
    agentType: m.agentType,
    description: m.description,
    toolUseId: m.toolUseId,
    finished: !!m.finished,
    parentAgentId: m.parentAgentId,
    teamName: m.teamName,
    workflowPhase: m.workflowPhase,
    workflowRunId: runId || undefined,
    name: m.name,
    background: m.requestShape ? m.requestShape !== 'foreground' : undefined,
  };
}

// Registro delle sessioni vive (Claude Code recente scrive <config>/sessions/<pid>.json)
class SessionRegistry {
  constructor(state, watcher, opts = {}) {
    this.state = state;
    this.watcher = watcher;
    this.dir = path.join(opts.base || claudeDir(), 'sessions');
    this.timer = null;
  }
  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), 1500);
  }
  stop() { clearInterval(this.timer); }
  poll() {
    let files;
    try { files = fs.readdirSync(this.dir); } catch { return; }
    const entries = [];
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      const j = readJson(path.join(this.dir, f));
      if (!j || !j.sessionId) continue;
      // ignora le sessioni "di riserva" non ancora assegnate
      if (j.spare) continue;
      entries.push({
        sessionId: j.sessionId,
        pid: j.pid,
        cwd: j.cwd,
        name: j.name,
        status: j.status,
        waitingFor: j.waitingFor,
        entrypoint: j.entrypoint,
        alive: pidAlive(j.pid),
      });
    }
    for (const e of entries) if (e.alive) this.watcher.wantSessions.add(e.sessionId);
    this.state.applyRegistry(entries);
  }
}

// ------------------------------------------------------------------ sessioni Cowork dell'app desktop
// Cowork esegue Claude Code in una macchina virtuale; i dati di ogni sessione finiscono nella cartella
// dell'app Claude (es. %APPDATA%\Claude\local-agent-mode-sessions\...\.claude\projects).
// Non conoscendo in anticipo la struttura esatta, cerchiamo le cartelle "projects" con transcript.
const SKIP_DIRS = /^(cache|code cache|gpucache|dawncache|dawngraphitecache|dawnwebgpucache|shadercache|grshadercache|indexeddb|local storage|session storage|service worker|blob_storage|crashpad|crashpad_handler|logs?|node_modules|shared dictionary|webstorage|extensions|partitions|vm_bundles|claude-code-vm|sentry|component_crx_cache|.git|debug|shell-snapshots|plugins|skills|statsig|todos|file-history|backups|paste-cache|ide)$/i;

function coworkRoots(extra = '') {
  const home = os.homedir();
  const roots = [];
  if (process.platform === 'win32') {
    const ad = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    roots.push(path.join(ad, 'Claude'), path.join(la, 'Claude'), path.join(la, 'AnthropicClaude'), path.join(ad, 'Claude-3p'));
    try { // installazione da Microsoft Store / MSIX
      for (const d of fs.readdirSync(path.join(la, 'Packages'))) {
        if (/claude|anthropic/i.test(d)) roots.push(path.join(la, 'Packages', d, 'LocalCache', 'Roaming', 'Claude'), path.join(la, 'Packages', d, 'LocalCache', 'Local', 'Claude'));
      }
    } catch {}
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else {
    roots.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  }
  for (const x of String(extra || '').split(/[;\n]/)) { const t = x.trim().replace(/^"|"$/g, ''); if (t) roots.push(t.replace(/^~(?=$|[\\/])/, home)); }
  return [...new Set(roots)];
}

function hasTranscripts(projectsDir) {
  let ds;
  try { ds = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return 0; }
  let n = 0, newest = 0;
  for (const d of ds.slice(0, 60)) {
    if (!d.isDirectory()) continue;
    try {
      for (const f of fs.readdirSync(path.join(projectsDir, d.name))) {
        if (!f.endsWith('.jsonl')) continue;
        n++;
        try { newest = Math.max(newest, fs.statSync(path.join(projectsDir, d.name, f)).mtimeMs); } catch {}
      }
    } catch {}
  }
  return n ? { n, newest } : 0;
}

// ritorna le cartelle "config" (quelle che contengono projects/) trovate sotto le radici
function findCoworkBases(extra = '', exclude = []) {
  const ex = new Set(exclude.map(p => path.resolve(p).toLowerCase()));
  const roots = coworkRoots(extra).map(p => ({ path: p, exists: fs.existsSync(p) }));
  const bases = [];
  let visited = 0;
  for (const r of roots) {
    if (!r.exists) continue;
    // la radice stessa può essere già una cartella config
    const queue = [[r.path, 0]];
    while (queue.length && visited < 8000) {
      const [dir, depth] = queue.shift();
      visited++;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (e.name === 'projects') {
          const h = hasTranscripts(full);
          if (h && !ex.has(path.resolve(dir).toLowerCase()) && !bases.some(b => b.path === dir)) bases.push({ path: dir, files: h.n, newest: h.newest });
          continue;
        }
        if (depth < 9 && !SKIP_DIRS.test(e.name)) queue.push([full, depth + 1]);
      }
    }
  }
  return { roots, bases, visited };
}

module.exports = { TranscriptWatcher, SessionRegistry, claudeDir, findCoworkBases, coworkRoots };
