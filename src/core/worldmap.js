'use strict';
// "Mappa della realtà" di un agente, ricostruita da quello che fa (non dai suoi pensieri, che non vediamo):
//  - territorio: i file e i luoghi del progetto che ha visto, letto, modificato o creato
//    (con la "nebbia" su tutto il resto del progetto);
//  - traiettoria: a ogni strumento usato, un punto in uno spazio a 7 dimensioni
//    (esplora, costruisce, verifica, novità, errori, ripetizione, contesto) che dice come sta lavorando.

const fs = require('fs');
const path = require('path');
const { isTestCommand } = require('./releases');

const ACT = {
  Read: 'read', NotebookRead: 'read', Grep: 'search', Glob: 'search', LS: 'search',
  WebFetch: 'web', WebSearch: 'web', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write',
  Bash: 'run', PowerShell: 'run', Agent: 'delegate', Task: 'delegate', TodoWrite: 'plan', TaskCreate: 'plan', TaskUpdate: 'plan', ExitPlanMode: 'plan',
};
const DIMS = ['explore', 'build', 'verify', 'novelty', 'errors', 'repeat', 'context'];
const WINDOW = 8;
const MAX_STEPS = 500, MAX_NODES = 6000;
// livello di conoscenza di un luogo: 1 visto di sfuggita (frontiera), 2 letto, 3 modificato
const LV = { seen: 1, read: 2, edit: 3 };
const MAX_EDITS = 20;
// Claude Code rifiuta la modifica di un file cambiato dopo l'ultima lettura: il ricordo scaduto è preso in tempo
const STALE_ERR = /modified since (it was )?(last )?read|has been (unexpectedly )?modified|changed since (it was )?(last )?read/i;
// i luoghi che sono file del progetto (non comandi, siti, sottoagenti o file fuori dalla cartella)
function isProjectFile(key) { return !!key && key !== '.' && !/^(abs|web|cmd|agent|tool):/.test(key); }
const MAX_REPLIES = 20, REPLY_CHARS = 8000;
// i parser dei fallimenti stanno in surprise.js, che a sua volta usa relKey di questo file: si carica al primo uso
let surpriseMod = null;
const surpriseLib = () => surpriseMod || (surpriseMod = require('./surprise'));
// file che non ci sono: errori di Read/Edit e righe dell'output dei comandi (inglese e italiano)
const MISSING_TOOL = /does not exist|ENOENT|No such file|non esiste|File o directory non esistente/i;
const MISSING_OUT = [
  /^(?:[\w.\-]+: )*(?:cannot access |cannot open |can't open )?(['"`]?)([^'"`\n]+?)\1: (?:No such file or directory|File o directory non esistente)/gim, // cat: x: No such file…
  /No such file or directory: (['"`]?)([^'"`\n]+)\1/gi,                                                        // Python
  /no such file or directory, \w+ (['"`])([^'"`\n]+)\1/gi,                                                   // Node (ENOENT)
  /can't open file (['"`])([^'"`\n]+)\1/gi,                                                                    // python x.py
  /cannot find (?:module |file |path )?(['"`])([^'"`\n]+)\1/gi,                                              // Node, tsc, PowerShell
  /Impossibile trovare (?:il percorso |il file |il modulo )?(['"`])([^'"`\n]+)\1/gi,                         // PowerShell in italiano
  /pathspec (['"`])([^'"`\n]+)\1 did not match any files?/gi,                                                  // git
];
// percorsi dei file mancanti citati in un output (validati con le stesse regole dei comandi)
function missingPathsInOutput(text) {
  const out = [];
  const s = String(text || '').slice(0, 60000);
  if (!/No such file|ENOENT|cannot find|can't open|Impossibile trovare|non esistente|did not match any file/i.test(s)) return out;
  for (const re of MISSING_OUT) {
    re.lastIndex = 0;
    let m, guard = 0;
    while ((m = re.exec(s)) && guard++ < 200) {
      const cand = m[2].trim().replace(/\\\\/g, '\\').replace(/[.,;]+$/, '');
      const ok = /\s/.test(cand) ? /^([A-Za-z]:[\\/]|\/|\.{0,2}[\\/])/.test(cand) && EXT.test(cand) : pathsInCommand(cand)[0] === cand;
      if (ok && !out.some(o => o.path === cand)) out.push({ path: cand, line: lineAround(s, m.index) });
    }
  }
  return out.slice(0, 20);
}
function lineAround(s, i) {
  const a = s.lastIndexOf('\n', i) + 1, b = s.indexOf('\n', i);
  return s.slice(a, b < 0 ? s.length : b).trim().slice(0, 160);
}

function normSlashes(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); }
// percorso relativo alla cartella della sessione; fuori dal progetto diventa "abs:<percorso>"
function relKey(p, cwd) {
  let x = normSlashes(p).trim().replace(/^["']|["']$/g, '');
  if (!x) return null;
  if (/^https?:\/\//i.test(x)) return webKey(x);
  const c = normSlashes(cwd);
  // Git Bash su Windows (la shell di Claude Code): /d/dev/x e /cygdrive/d/dev/x sono D:/dev/x
  if (/^[A-Za-z]:\//.test(c)) { const m = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/|$)/.exec(x); if (m) x = m[1].toUpperCase() + ':/' + x.slice(m[0].length); }
  if (c && (x.toLowerCase() === c.toLowerCase())) return '.';
  if (c && x.toLowerCase().startsWith(c.toLowerCase() + '/')) return x.slice(c.length + 1);
  if (/^([A-Za-z]:\/|\/|~)/.test(x)) return 'abs:' + x;
  return x.replace(/^\.\//, '');
}
function webKey(u) {
  try { const url = new URL(u); return 'web:' + url.host + (url.pathname.length > 1 ? url.pathname.slice(0, 60) : ''); } catch { return 'web:' + String(u).slice(0, 80); }
}
function resultText(block, line) {
  let t = '';
  const c = block && block.content;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = c.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return t.length > 200000 ? t.slice(0, 200000) : t;
}
const EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|mdx|txt|py|ipynb|rb|go|rs|java|kt|kts|cs|cpp|cc|c|h|hpp|css|scss|less|html|htm|xml|yml|yaml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|psm1|bat|cmd|sql|csv|tsv|xlsx|xls|docx|doc|pptx|pdf|png|jpe?g|gif|svg|ico|webp|zip|lock|log|vue|svelte|php|swift|dart|lua|r|tf|proto|gradle|properties|dockerfile)$/i;
// percorsi citati in un comando (es. "npm test src/auth" o "cat docs/a.md"); dei comandi con
// "heredoc" (<<EOF ... EOF) guardiamo solo la prima riga: il resto è codice, non percorsi
function pathsInCommand(cmd) {
  const out = [];
  let c = String(cmd || '');
  if (/<<\s*['"]?\w+/.test(c)) c = c.split('\n')[0];
  // sed/perl/awk: le espressioni tra virgolette ("s/a/b/g", "y/a/b/", "/x/d") non sono percorsi, nemmeno con gli spazi dentro
  if (/(^|[\s|;&(])(sed|perl|awk|gawk)\s/.test(c)) {
    c = c.replace(/(["'])[sy]\/(?:(?!\1).)*\/[a-zA-Z]*\1/g, ' ').replace(/(["'])\/(?:(?!\1).)*\/[dpPqQ]\1/g, ' ');
    if (/(^|[\s|;&(])g?awk\s/.test(c)) c = c.replace(/(["'])\/(?:(?!\1).)*\/\1/g, ' ');
  }
  for (const tok of c.split(/[\s|;&<>()]+/)) {
    const x = tok.replace(/^["'`]|["'`,:]$/g, '');
    if (!x || x.startsWith('-') || /^https?:/i.test(x) || x.length > 160 || !/^[\w@.~\-\/\\:]+$/.test(x)) continue;
    const looksPath = /[\/\\]/.test(x) ? !/^\/(dev|proc|sys)\b/.test(x) && (EXT.test(x) || /\/$/.test(x) || /^[.~]?\//.test(x) || /^[A-Za-z]:[\\/]/.test(x)) : EXT.test(x) && /^[\w@.\-]+$/.test(x) && !/^\d/.test(x);
    if (looksPath && !/^(console|window|document|process|this|self|module|exports|Math|JSON|Object|Array|Promise|res|req|e|el|fs|os|path)\./.test(x)) out.push(x.replace(/\/$/, ''));
  }
  return out.slice(0, 12);
}
// il comando "vero" dentro una riga di shell (salta cd, variabili, sudo...) e che tipo di azione è
const LOOK = /^(ls|dir|cat|type|head|tail|less|more|grep|rg|ag|find|fd|tree|wc|file|stat|du|df|pwd|which|where|whoami|ps|pgrep|env|printenv|echo|jq|awk|Get-ChildItem|Get-Content|Select-String)$/i;
const MULTI = /^(git|npm|pnpm|yarn|npx|bun|docker|gh|cargo|go|dotnet|kubectl|pip|pip3|uv|poetry|make|mvn|gradle|terraform|az|aws|gcloud)$/i;
function mainCommand(cmd) {
  const parts = String(cmd).split(/&&|\|\||;|\n/).map(x => x.trim()).filter(Boolean);
  let seg = parts.find(x => !/^(cd|pushd|popd|set|export|source|\.)\b/.test(x)) || parts[0] || '';
  const words = seg.split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !/^(sudo|time|nohup|exec)$/.test(w));
  let w0 = (words[0] || '').replace(/^.*[\/\\]/, '').replace(/^\(+/, '');
  let label = w0;
  if (MULTI.test(w0) && words[1] && !words[1].startsWith('-')) label += ' ' + words[1];
  const sub = (words[1] || '').toLowerCase();
  const sedI = w0 === 'sed' && /\s(-[a-zA-Z]*i|--in-place)\b/.test(seg); // sed -i modifica il file
  const look = LOOK.test(w0) || (w0 === 'sed' && !sedI) || (/^git$/i.test(w0) && /^(status|log|diff|show|blame|branch|remote)$/.test(sub)) || (/^curl$/i.test(w0) && !/\s-X\s*(POST|PUT|DELETE|PATCH)/i.test(seg));
  const check = /^(tsc|eslint|ruff|flake8|mypy|pylint|prettier)$/i.test(w0) || /\s--check\b|\blint\b/.test(seg) || (/^(npm|pnpm|yarn)$/i.test(w0) && /\b(build|lint|typecheck)\b/.test(seg));
  const writes = sedI || /^(mv|cp|rm|mkdir|touch|tee|move|copy|del)$/i.test(w0) || /\s>\s*\S/.test(seg);
  // cp/mv: solo l'ultimo percorso (la destinazione) viene scritto, gli altri sono solo visti
  return { label: (label || 'shell').slice(0, 40), look, check, writes, toLast: /^(mv|cp|move|copy)$/i.test(w0), seg };
}

// file importati o collegati da un file letto: diventano frontiera
function referencesIn(text, fromRel) {
  const refs = new Set();
  const add = r => { if (r && r.length < 160 && !/^https?:/i.test(r)) refs.add(r); };
  let m;
  const reImp = /(?:import\s[^'"\n]*?from\s*|import\s*\(\s*|require\(\s*|from\s+)['"](\.{1,2}\/[^'"\n]+)['"]/g;
  while ((m = reImp.exec(text))) add(m[1]);
  const reMd = /\]\((\.{0,2}\/?[^)\s#:]+\.[A-Za-z0-9]{1,6})\)/g;
  while ((m = reMd.exec(text))) add(m[1]);
  const rePy = /^\s*from\s+(\.+[\w.]*)\s+import/gm;
  while ((m = rePy.exec(text))) add(m[1].replace(/^\.+/, d => d.length === 1 ? './' : '../'.repeat(d.length - 1)).replace(/\./g, '/') + '.py');
  const dir = path.posix.dirname(fromRel || '');
  return [...refs].slice(0, 40).map(r => path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, r)));
}
function listedPaths(text, r) {
  if (r && Array.isArray(r.filenames)) return r.filenames.slice(0, 200);
  const out = [];
  for (const line of String(text || '').split('\n').slice(0, 400)) {
    const m = /^([A-Za-z]:[\\/][^:\n]+|[^:\n]+?)(?::\d+(?:[:-]|$)|$)/.exec(line.trim());
    if (m && m[1] && (/[\/\\]/.test(m[1]) || EXT.test(m[1])) && !/\s/.test(m[1]) && m[1].length < 200) out.push(m[1]);
  }
  return out.slice(0, 200);
}

class AgentWorld {
  constructor() {
    this.nodes = new Map(); // key -> {seen, read, edit, created, n, last, lastSync, edits}
    this.steps = [];
    this.open = new Map();  // toolUseId -> step
    this.shellCwd = null;   // cartella corrente della shell dell'agente
    this.replies = [];      // ultime risposte complete {t, text}, solo in memoria
  }
  reply(t, text) {
    const x = String(text || '').trim();
    if (!x) return;
    this.replies.push({ t, text: x.slice(0, REPLY_CHARS) });
    if (this.replies.length > MAX_REPLIES) this.replies.shift();
  }
  // un file che l'agente cerca e che non c'è: "fantasma" (la prima volta che succede)
  ghost(key, t, src, line) {
    if (!isProjectFile(key) && !String(key || '').startsWith('abs:')) return;
    this.touch(key, LV.seen, t);
    const nd = this.nodes.get(key);
    if (nd && !nd.ghost) Object.assign(nd, { ghost: true, ghostAt: t, ghostSrc: src, ghostLine: String(line || '').slice(0, 160) });
  }
  touch(key, level, t, created) {
    if (!key) return null;
    let n = this.nodes.get(key);
    const fresh = !n;
    if (!n) {
      if (this.nodes.size >= MAX_NODES) return null;
      // lastSync: ultimo esito riuscito che gli ha mostrato il contenuto vero (lettura o sua modifica)
      // edits: quando le sue modifiche sono riuscite (servono a dire "cambiato da …" agli altri agenti)
      n = { seen: 0, read: 0, edit: 0, created: false, n: 0, last: 0, lastSync: 0, edits: [] };
      this.nodes.set(key, n);
    }
    if (level >= LV.seen && !n.seen) n.seen = t;
    if (level >= LV.read && !n.read) n.read = t;
    if (level >= LV.edit && !n.edit) n.edit = t;
    if (created && fresh) n.created = true;
    if (level >= LV.read) n.n++;
    if (level >= LV.read) n.last = t;
    return fresh;
  }

  start(id, name, input, t, cwd, ctx) {
    if (id && this.open.has(id)) return;
    input = input || {};
    let act = ACT[name] || (/^mcp__/.test(name) ? 'tool' : 'other');
    let target = null, isNew = false, sig = name;
    const fp = input.file_path || input.notebook_path || input.path;
    switch (act) {
      case 'read': target = relKey(fp, cwd); isNew = !!this.touch(target, LV.read, t); break;
      case 'edit': target = relKey(fp, cwd); isNew = !!this.touch(target, LV.edit, t); break;
      case 'write': target = relKey(fp, cwd); isNew = !!this.touch(target, LV.edit, t, !this.nodes.has(target)); act = 'edit'; break;
      case 'search': {
        target = relKey(input.path || cwd || '.', cwd) || '.';
        if (target === '.' || !target) target = '.';
        isNew = !!this.touch(target, LV.seen, t);
        sig = name + ':' + (input.pattern || '') + ':' + target;
        break;
      }
      case 'web': target = input.url ? webKey(input.url) : 'web:?' + String(input.query || '').slice(0, 60); isNew = !!this.touch(target, LV.read, t); break;
      case 'run': {
        const cmd = String(input.command || '').trim();
        const main = mainCommand(cmd);
        target = 'cmd:' + main.label;
        act = isTestCommand(cmd) || main.check ? 'verify' : main.look ? 'look' : 'run';
        isNew = !!this.touch(target, LV.read, t);
        // "cd cartella && ..." : i percorsi relativi partono da lì
        // la shell di Claude Code ricorda la cartella tra un comando e l'altro: la seguiamo anche noi
        const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*(?:&&|;|$)/.exec(cmd);
        let base = this.shellCwd || null;
        if (cd) { const d = normSlashes(cd[1] || cd[2] || cd[3]); base = /^([A-Za-z]:\/|\/|~)/.test(d) ? d : path.posix.join(base || normSlashes(cwd) || '.', d); this.shellCwd = base; }
        const dst = main.toLast ? pathsInCommand(main.seg).pop() : null;
        for (const p of pathsInCommand(cmd)) {
          const full = base && !/^([A-Za-z]:[\\/]|\/|~)/.test(p) ? base + '/' + p : p;
          this.touch(relKey(full, cwd), act === 'run' && main.writes && (!main.toLast || p === dst) ? LV.edit : LV.seen, t);
        }
        sig = 'run:' + cmd.slice(0, 200);
        break;
      }
      case 'delegate': target = 'agent:' + String(input.subagent_type || 'general-purpose'); this.touch(target, LV.read, t); break;
      case 'tool': target = 'tool:' + name; isNew = !!this.touch(target, LV.read, t); break;
      default: target = null;
    }
    if (act === 'read' || act === 'edit') sig = name + ':' + target;
    const step = { id, t, tool: name, act, target, isNew, sig, err: null, ctx: ctx || 0, vec: null, phase: '' };
    // per le modifiche: l'ultimo contatto col file prima di questa (serve a scoprire le modifiche alla cieca)
    if (act === 'edit' && isProjectFile(target)) { const nd = this.nodes.get(target); step.prevSync = nd ? nd.lastSync : 0; }
    this.steps.push(step);
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS);
    if (id) this.open.set(id, step);
    this.compute(this.steps.length - 1);
    if (this.open.size > 200) this.open.delete(this.open.keys().next().value);
  }

  end(id, isErr, block, line, t, cwd) {
    const step = this.open.get(id);
    if (!step) return;
    this.open.delete(id);
    step.err = !!isErr;
    step.dur = Math.max(0, t - step.t);
    if (!isErr) {
      const text = resultText(block, line);
      const r = line && line.toolUseResult;
      // fino a fine riga: la cartella può avere spazi (es. C:\Users\Mario Rossi\shop)
      const reset = /Shell cwd was reset to ([^\r\n]+)/.exec(text);
      if (reset) this.shellCwd = normSlashes(reset[1].trim());
      // gli elenchi di Grep/Glob hanno percorsi assoluti o già comprensivi della cartella cercata
      if (step.act === 'search') for (const p of listedPaths(text, r)) this.touch(relKey(p, cwd), LV.seen, t);
      else if (step.act === 'read' && step.target && !step.target.startsWith('web:')) {
        const from = step.target.startsWith('abs:') ? null : step.target;
        if (from) for (const p of referencesIn(text, from)) this.touch(p, LV.seen, t);
      }
      // fa fede l'esito: da qui l'agente conosce il contenuto vero del file
      if ((step.act === 'read' || step.act === 'edit') && isProjectFile(step.target)) {
        const nd = this.nodes.get(step.target);
        if (nd) {
          nd.lastSync = t;
          if (step.act === 'edit') { nd.edits.push(t); if (nd.edits.length > MAX_EDITS) nd.edits.shift(); }
        }
      }
    } else if (step.act === 'edit' || step.act === 'read') {
      const text = resultText(block, line);
      if (step.act === 'edit' && STALE_ERR.test(text)) step.staleErr = true;
      if (MISSING_TOOL.test(text)) this.ghost(step.target, t, 'tool', text.split('\n')[0]);
    }
    // un fallimento: che tipo è, la riga che lo dice e i file che cita (l'output non lo teniamo)
    if (isErr) {
      try {
        const lib = surpriseLib(), text = resultText(block, line), cmd = String(step.sig || '').startsWith('run:') ? step.sig.slice(4) : '';
        const f = lib.classifyFailure(text, cmd);
        step.fail = f || { kind: 'command', framework: '', excerpt: lib.errorExcerpt(text) };
        const r = lib.extractErrorRefs(text, cwd, this.shellCwd);
        if (r.refs.length || r.discarded) step.refs = { refs: r.refs.slice(0, 10), discarded: r.discarded };
      } catch {}
    }
    // l'output dei comandi può dire che un file non c'è, anche quando il comando nel complesso riesce
    if (step.act === 'run' || step.act === 'verify' || step.act === 'look') {
      const base = this.shellCwd;
      for (const g of missingPathsInOutput(resultText(block, line))) {
        const full = base && !/^([A-Za-z]:[\\/]|\/|~)/.test(g.path) ? base + '/' + g.path : g.path;
        this.ghost(relKey(full, cwd), t, 'output', g.line);
      }
    }
    const i = this.steps.lastIndexOf(step);
    if (i >= 0) this.compute(i);
  }

  // vettore a 7 dimensioni (tutte tra 0 e 1) calcolato sugli ultimi WINDOW passi
  compute(i) {
    const w = this.steps.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const n = w.length || 1;
    const cnt = k => w.filter(s => s.act === k).length;
    const explore = (cnt('read') + cnt('search') + cnt('web') + cnt('look')) / n;
    const build = (cnt('edit') + 0.5 * cnt('run')) / n;
    const verify = cnt('verify') / n;
    const novelty = w.filter(s => s.isNew).length / n;
    const ended = w.filter(s => s.err !== null);
    const errors = ended.length ? ended.filter(s => s.err).length / ended.length : 0;
    const sigs = new Map();
    for (const s of w) sigs.set(s.sig, (sigs.get(s.sig) || 0) + 1);
    let dup = 0;
    for (const v of sigs.values()) if (v > 1) dup += v - 1;
    const repeat = n > 1 ? dup / (n - 1) : 0;
    const st = this.steps[i];
    const limit = st.ctx > 200000 ? 1000000 : 200000;
    const context = Math.min(1, (st.ctx || 0) / limit);
    st.vec = [explore, build, Math.min(1, verify), novelty, errors, repeat, context].map(v => Math.round(v * 1000) / 1000);
    st.phase = phaseOf(st.vec, n);
  }

  toJSON(owner) {
    const nodes = [];
    for (const [k, v] of this.nodes) nodes.push([k, v.seen, v.read, v.edit, v.created ? 1 : 0, v.n, v.last, owner || '']);
    const steps = this.steps.map(s => [s.t, s.act, s.tool, s.target, s.err === null ? -1 : s.err ? 1 : 0, s.vec, s.phase]);
    return { nodes, steps };
  }
}

// fase di lavoro leggibile a partire dal vettore
function phaseOf(v, n) {
  const [explore, build, verify, novelty, errors, repeat] = v;
  if (n >= 4 && (repeat >= 0.5 || (errors >= 0.5 && repeat >= 0.25))) return 'stuck';
  if (errors >= 0.5) return 'struggle';
  if (verify >= 0.35) return 'verify';
  if (build >= 0.35) return 'build';
  if (explore >= 0.55) return novelty >= 0.4 ? 'explore' : 'study';
  return 'orient';
}

// ---- il progetto sul disco: serve a disegnare la nebbia su ciò che l'agente non ha ancora visto
const SKIP = /^(node_modules|\.git|\.hg|\.svn|dist|build|out|target|coverage|\.next|\.nuxt|\.venv|venv|__pycache__|\.mypy_cache|\.pytest_cache|\.idea|\.vs|\.gradle|bin|obj|vendor|\.cache|\.turbo|\.parcel-cache)$/i;
const treeCache = new Map();
function scanTree(cwd, { maxFiles = 4000, ttl = 60000 } = {}) {
  if (!cwd) return { available: false, files: [] };
  const hit = treeCache.get(cwd);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  let v;
  try {
    const root = path.resolve(cwd);
    if (!fs.statSync(root).isDirectory()) throw new Error('not dir');
    const files = [];
    let truncated = false;
    const queue = [['', 0]];
    while (queue.length) {
      const [rel, depth] = queue.shift();
      let ents;
      try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
      ents.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of ents) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          if (SKIP.test(e.name) || (e.name.startsWith('.') && !/^\.(github|claude|vscode)$/.test(e.name))) continue;
          if (depth < 10) queue.push([r, depth + 1]);
        } else if (e.isFile()) {
          if (files.length >= maxFiles) { truncated = true; break; }
          let size = 0;
          try { size = fs.statSync(path.join(root, r)).size; } catch {}
          files.push([r, size]);
        }
      }
      if (truncated) break;
    }
    v = { available: true, files, truncated };
  } catch { v = { available: false, files: [] }; }
  treeCache.set(cwd, { t: Date.now(), v });
  if (treeCache.size > 50) treeCache.delete(treeCache.keys().next().value);
  return v;
}

// file citati senza estensione (es. import './session') → il file vero del progetto
function resolveAgainstTree(nodes, tree) {
  if (!tree || !tree.files || !tree.files.length) return nodes;
  const set = new Set(tree.files.map(f => f[0]));
  const lower = new Map(tree.files.map(f => [f[0].toLowerCase(), f[0]]));
  const byStem = new Map();
  for (const [f] of tree.files) { const stem = f.replace(/\.[^./]+$/, ''); if (!byStem.has(stem)) byStem.set(stem, f); const idx = f.replace(/\/index\.[^./]+$/, ''); if (idx !== f && !byStem.has(idx)) byStem.set(idx, f); }
  // nome di file senza cartella (es. "game.js" in un elenco): se nel progetto ce n'è uno solo, è quello
  const byBase = new Map();
  for (const [f] of tree.files) { const b = f.slice(f.lastIndexOf('/') + 1); byBase.set(b, byBase.has(b) ? null : f); }
  const merged = new Map();
  for (const row of nodes) {
    let k = row[0];
    if (!set.has(k) && !/^(abs|web|cmd|agent|tool):/.test(k)) k = lower.get(k.toLowerCase()) || byStem.get(k) || (!k.includes('/') && byBase.get(k)) || k;
    const prev = merged.get(k);
    if (!prev) merged.set(k, [k, ...row.slice(1)]);
    else { // stessi dati su due chiavi: tieni il meglio
      const mn = (a, b) => (a && b ? Math.min(a, b) : a || b);
      prev[1] = mn(prev[1], row[1]); prev[2] = mn(prev[2], row[2]); prev[3] = mn(prev[3], row[3]);
      prev[4] = prev[4] || row[4]; prev[5] += row[5]; prev[6] = Math.max(prev[6], row[6]);
    }
  }
  return [...merged.values()];
}

module.exports = { mainCommand, AgentWorld, scanTree, resolveAgainstTree, relKey, referencesIn, listedPaths, pathsInCommand, missingPathsInOutput, isProjectFile, EXT, DIMS, phaseOf };
