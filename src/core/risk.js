'use strict';
// Il classificatore del rischio (2.14, R1): data un'azione che un agente sta per fare, dice quanto è difficile tornare indietro.
//   classify({ tool, input, cwd, root, ...quello che Platypus sa già })
//     → { level 0–3, ruleIds, category, reasons, reach, undo, prudence, shape, targets, marks }
// LEGGE SOLTANTO: non esegue comandi, non apre file o database, non chiama la rete. Sono funzioni pure
// sull'input dello strumento e su quello che chi chiama gli passa (lo stato di git di un file, il branch, il turno).
// Riconosce schemi noti: può non vedere quello che non conosce. Non è una protezione.
// Le regole stanno in risk-rules.js; qui c'è chi le riconosce:
//   - lex()      spezza una riga di shell (bash, PowerShell, cmd) in comandi e parole, senza espandere niente;
//   - Scan       guarda ogni comando, entra in sudo/env/xargs/bash -c/$(…) e raccoglie le regole che scattano;
//   - where()    dice dove cade un percorso rispetto al progetto (dentro, fuori, home, radice, temporanei).

const os = require('os');
const { RULES, REGENERABLE, LOCKFILES, CONFIG_FILES, CONFIG_DIRS, SHARED_BRANCHES, MAIN_BRANCHES, MCP_EFFECT, MCP_READ, REACH } = require('./risk-rules');

const MAX_DEPTH = 6;      // bash -c dentro bash -c dentro …
const MAX_INPUT = 20000;  // oltre, si guarda solo l'inizio: il tempo resta sotto controllo

// ------------------------------------------------------------------ percorsi
const slash = p => String(p || '').replace(/\\/g, '/');
// toglie . e .. e le barre doppie; tiene la radice (/ oppure c:/)
function squash(p) {
  const m = /^([a-zA-Z]:)?(\/?)(.*)$/.exec(p);
  const out = [];
  for (const seg of m[3].split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!m[2]) out.push('..'); continue; }
    out.push(seg);
  }
  return (m[1] || '') + m[2] + out.join('/');
}
const isAbs = p => /^([a-zA-Z]:)?\//.test(p);

function makePaths({ cwd, root, home }) {
  const win = /^[a-zA-Z]:/.test(slash(root || cwd || ''));
  // su Windows: senza distinguere maiuscole, e /c/Users di Git Bash è C:/Users
  const canon = p => {
    p = slash(p);
    if (win) { const g = /^\/([a-zA-Z])(\/|$)/.exec(p); if (g) p = g[1] + ':/' + p.slice(3); p = p.toLowerCase(); }
    return squash(p);
  };
  const R = root || cwd ? canon(root || cwd) : '';
  const H = canon(home || os.homedir());
  const TMP = [canon(os.tmpdir()), '/tmp', '/var/tmp', '/private/tmp'];
  const under = (p, dir) => !!dir && (p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/'));

  // dove cade un percorso scritto in un comando: { kind, abs, rel, glob }
  //   root · home · above (contiene il progetto) · project-root · git (la cartella .git) · inside · outside · temp · unknown
  function where(raw, cwdNow) {
    let p = slash(String(raw || '').trim());
    if (!p) return { kind: 'unknown' };
    if (/^(\/dev\/(null|stdout|stderr|tty|zero|urandom|random|fd\/\d+)|nul|\$null|con)$/i.test(p)) return { kind: 'temp' };
    if (/^(\$\{?(TMPDIR|TEMP|TMP)\}?|%(TEMP|TMP)%|\$env:(TEMP|TMP))(\/|$)/i.test(p)) return { kind: 'temp' };
    p = p.replace(/^(\$\{?HOME\}?|\$env:(USERPROFILE|HOME)|%(USERPROFILE|HOMEPATH)%)(?=\/|$)/i, '~').replace(/^(\$\{?PWD\}?)(?=\/|$)/, '.');
    if (/[$`]|%[A-Za-z_]\w*%/.test(p)) return { kind: 'unknown' }; // variabili e sostituzioni che qui non si possono conoscere
    let glob = false;
    const stripped = p.replace(/(\/(\*\*?|\.))+\/?$/, m => { glob = glob || /\*/.test(m); return ''; });
    p = stripped || (p.startsWith('/') ? '/' : stripped);
    if (p === '*' || p === '**') { p = '.'; glob = true; }
    const star = p.search(/[*?[]/);
    if (star >= 0) { glob = true; p = p.slice(0, star).replace(/[^/]*$/, '') || '.'; }
    let abs;
    if (p === '~') abs = H;
    else if (p.startsWith('~/')) abs = canon(H + '/' + p.slice(2));
    else if (isAbs(p)) abs = canon(p);
    else if (win && /^[a-zA-Z]:/.test(p)) abs = canon(p);
    else { if (!cwdNow) return { kind: 'unknown' }; abs = canon(canon(cwdNow) + '/' + p); }
    if (abs !== '/' && !/^[a-z]:\/$/i.test(abs)) abs = abs.replace(/\/+$/, '');
    let kind;
    if (abs === '/' || /^[a-zA-Z]:\/?$/.test(abs)) kind = 'root';
    else if (abs === H) kind = 'home';
    else if (R && abs === R) kind = 'project-root';
    else if (R && under(abs, R)) kind = /^\.git(\/|$)/.test(abs.slice(R.length + 1)) ? 'git' : 'inside';
    else if (R && under(R, abs)) kind = 'above';
    else if (TMP.some(t => under(abs, t))) kind = 'temp';
    else kind = 'outside';
    const rel = kind === 'inside' || kind === 'git' ? abs.slice(R.length + 1) : '';
    return { kind, abs, rel, glob };
  }
  return { where, canon, root: R, home: H };
}

const baseName = p => slash(p).replace(/\/+$/, '').split('/').pop().toLowerCase();
const regenerable = rel => slash(rel).toLowerCase().split('/').some(seg => REGENERABLE.has(seg)) || /\.(pyc|log|tmp|tsbuildinfo)$/i.test(rel);
const isEnvFile = p => { const b = baseName(p); return /^\.env(\.|$)/.test(b) && !/\.(example|sample|template|dist)$/.test(b); };
const isSecretPath = p => { const s = slash(p).toLowerCase(); return /(^|\/)\.(ssh|aws)(\/|$)/.test(s) || isEnvFile(s) || /(^|\/)id_(rsa|ed25519|ecdsa)$/.test(s); };
const isConfig = rel => { const s = slash(rel).toLowerCase(); return CONFIG_FILES.has(baseName(s)) || CONFIG_DIRS.some(d => s.startsWith(d) || s.includes('/' + d)); };

// ------------------------------------------------------------------ dalla riga ai comandi
// Ogni comando: { words: [{ v, q }], redirs: [{ op, target }], heredoc, prev (l'operatore prima), before (il comando prima) }
// q = la parola era tra virgolette o con escape. subs = il contenuto di $(…) e `…`, che la shell esegue.
function lex(src, dialect) {
  const bash = dialect === 'bash';
  const cmds = [], subs = [], waiting = [];
  let cur = { words: [], redirs: [], prev: '' }, w = null, expect = null, i = 0;
  const n = src.length;
  const word = () => w || (w = { v: '', q: false });
  const pushWord = () => {
    if (!w) return;
    if (expect) {
      if (expect === '<<' || expect === '<<-') waiting.push({ cmd: cur, delim: w.v, strip: expect === '<<-' });
      else cur.redirs.push({ op: expect, target: w.v });
      expect = null;
    } else cur.words.push(w);
    w = null;
  };
  const endCmd = op => {
    pushWord(); expect = null;
    if (cur.words.length || cur.redirs.length) { cur.next = op; cmds.push(cur); }
    cur = { words: [], redirs: [], prev: op, before: cmds[cmds.length - 1] || null };
  };
  // $( … ) con le parentesi annidate: restituisce l'indice dopo la chiusa
  const sub = from => {
    let depth = 1, j = from;
    while (j < n && depth) { const c = src[j]; if (c === '(') depth++; else if (c === ')') depth--; else if (bash && c === '\\') j++; j++; }
    subs.push(src.slice(from, depth ? j : j - 1));
    return j;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      pushWord();
      // i corpi degli heredoc cominciano dalla riga dopo
      i++;
      for (const h of waiting.splice(0)) {
        const lines = [];
        while (i < n) {
          let end = src.indexOf('\n', i); if (end < 0) end = n;
          const line = src.slice(i, end).replace(/\r$/, ''); i = Math.min(n, end + 1);
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        h.cmd.heredoc = lines.join('\n');
      }
      endCmd('\n');
      continue;
    }
    if (c === ' ' || c === '\t') { pushWord(); i++; continue; }
    if (bash && c === '\\') { if (d === '\n') { i += 2; continue; } if (d === '\r' && src[i + 2] === '\n') { i += 3; continue; } word().v += d === undefined ? '' : d; w.q = true; i += 2; continue; }
    if (!bash && (c === '`' || (dialect === 'cmd' && c === '^'))) { if (d === '\n') { i += 2; continue; } word().v += d === undefined ? '' : d; w.q = true; i += 2; continue; }
    if (c === "'") {
      word().q = true; i++;
      while (i < n) { if (src[i] === "'") { if (!bash && src[i + 1] === "'") { w.v += "'"; i += 2; continue; } break; } w.v += src[i++]; }
      i++; continue;
    }
    if (c === '"') {
      word().q = true; i++;
      while (i < n && src[i] !== '"') {
        const e = src[i];
        if (bash && e === '\\' && i + 1 < n) { w.v += src[i + 1]; i += 2; continue; }
        if (!bash && e === '`' && i + 1 < n) { w.v += src[i + 1]; i += 2; continue; }
        if (!bash && e === '"' && src[i + 1] === '"') { w.v += '"'; i += 2; continue; }
        if (e === '$' && src[i + 1] === '(') { i = sub(i + 2); w.v += '$(…)'; continue; }
        if (bash && e === '`') { const end = src.indexOf('`', i + 1); if (end > 0) { subs.push(src.slice(i + 1, end)); w.v += '$(…)'; i = end + 1; continue; } }
        w.v += e; i++;
      }
      i++; continue;
    }
    if (c === '$' && d === '(') { i = sub(i + 2); word().v += '$(…)'; continue; }
    if (bash && c === '`') { const end = src.indexOf('`', i + 1); if (end > 0) { subs.push(src.slice(i + 1, end)); word().v += '$(…)'; i = end + 1; continue; } }
    if (c === '#' && !w && dialect !== 'cmd') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === ';') { endCmd(';'); i++; continue; }
    if (c === '&') {
      if (d === '&') { endCmd('&&'); i += 2; continue; }
      if (d === '>') { pushWord(); expect = src[i + 2] === '>' ? '>>' : '>'; i += expect.length + 1; continue; }
      endCmd('&'); i++; continue;
    }
    if (c === '|') { if (d === '|') { endCmd('||'); i += 2; } else { endCmd('|'); i += d === '&' ? 2 : 1; } continue; }
    if (c === '(' || c === ')' || (!bash && (c === '{' || c === '}'))) { endCmd(c); i++; continue; }
    if (c === '>' || c === '<') {
      if (w && !w.q && /^\d+$/.test(w.v)) w = null; else pushWord(); // "2>" : il numero è il descrittore, non una parola
      let op = c;
      if (c === '>' && (d === '>' || d === '|')) op = c + d;
      else if (c === '<' && d === '<') op = src[i + 2] === '<' ? '<<<' : src[i + 2] === '-' ? '<<-' : '<<';
      i += op.length;
      if (src[i] === '&' && /[\d-]/.test(src[i + 1] || '')) { i += 2; while (/\d/.test(src[i] || '')) i++; continue; } // 2>&1
      expect = op;
      continue;
    }
    word().v += c; i++;
  }
  endCmd('');
  return { cmds, subs };
}

// ------------------------------------------------------------------ SQL
const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'sqlcmd', 'duckdb', 'clickhouse-client', 'clickhouse', 'bq', 'snowsql', 'cockroach', 'usql', 'pgcli', 'mycli', 'turso', 'wrangler', 'supabase']);
function sqlRules(text) {
  const out = [];
  if (!/\b(drop|truncate|delete|update)\b/i.test(text)) return out;
  // senza commenti e senza il contenuto delle stringhe: "WHERE note = 'drop table'" non è un DROP
  const clean = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, ' ');
  for (const raw of clean.split(';')) {
    const s = raw.trim();
    if (/^(drop\s+(table|database|schema|index|view|materialized|sequence|type|function|role|user|trigger|column|tablespace|keyspace)\b)/i.test(s) || /^alter\s+table\b.*\bdrop\s+(column|constraint)?\b/i.test(s)) out.push('sql-drop');
    else if (/^truncate\b/i.test(s)) out.push('sql-truncate');
    else {
      // un WHERE che non filtra niente vale come nessun WHERE
      const filtered = /\bwhere\b/i.test(s) && !/\bwhere\s+(1\s*=\s*1|true|''\s*=\s*'')\s*$/i.test(s);
      if (/^(with\b.*\)\s*)?delete\s+from\b/i.test(s) && !filtered) out.push('sql-delete-all');
      else if (/^(with\b.*\)\s*)?update\b.*\bset\b/i.test(s) && !filtered) out.push('sql-update-all');
    }
  }
  return out;
}

// ------------------------------------------------------------------ i comandi
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done', '&']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const PASS = { npx: 0, pnpx: 0, bunx: 0, uvx: 0, time: 0, nohup: 0, exec: 0, command: 0, builtin: 0, nice: 0, ionice: 0, stdbuf: 0, timeout: 1, watch: 0, caffeinate: 0, chronic: 0, setsid: 0, 'start-process': 0, call: 0, start: 0 };
const NETWORK = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'scp', 'sftp', 'ftp', 'telnet', 'ssh', 'http', 'https', 'xh', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'rsync', 'aws', 'gsutil', 'az', 'gcloud']);
const PS_REMOVE = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir']);
const PS_WRITE = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'copy-item', 'cpi', 'move-item', 'mi', 'clear-content', 'clc', 'export-csv', 'tee-object']);
const DEP_ADD = { npm: ['install', 'i', 'add'], pnpm: ['add', 'install', 'i'], yarn: ['add'], bun: ['add', 'install', 'i'], pip: ['install'], pip3: ['install'], uv: ['add'], poetry: ['add'], cargo: ['add', 'install'], go: ['get'], composer: ['require'], gem: ['install'], bundle: ['add'], pipx: ['install'], brew: ['install'], conda: ['install'], dotnet: ['add'] };
const PUBLISH = { npm: ['publish', 'unpublish', 'deprecate'], pnpm: ['publish'], yarn: ['publish'], bun: ['publish'], cargo: ['publish', 'yank'], twine: ['upload'], gem: ['push', 'yank'], poetry: ['publish'], flit: ['publish'], hatch: ['publish'], docker: ['push'], podman: ['push'], vsce: ['publish'], pod: ['trunk'] };
const DEPLOY = { vercel: null, netlify: ['deploy'], firebase: ['deploy'], fly: ['deploy'], flyctl: ['deploy'], wrangler: ['deploy', 'publish'], serverless: ['deploy', 'remove'], sls: ['deploy', 'remove'], cdk: ['deploy', 'destroy'], sam: ['deploy', 'delete'], railway: ['up'], render: ['deploy'], amplify: ['publish'], eb: ['deploy', 'terminate'], cap: ['deploy'], kamal: ['deploy'] };

const cmdName = v => baseName(v).replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
const isFlag = w => !w.q && /^-/.test(w.v);
const shortHas = (args, ch) => args.some(a => !a.q && /^-[A-Za-z]+$/.test(a.v) && a.v.includes(ch));
const has = (args, ...names) => args.some(a => !a.q && names.some(nm => a.v === nm || a.v.startsWith(nm + '=')));
const positional = args => { const out = []; let rest = false; for (const a of args) { if (!rest && !a.q && a.v === '--') { rest = true; continue; } if (rest || !isFlag(a)) out.push(a); } return out; };
// parametri di PowerShell: senza distinguere maiuscole, e abbreviati finché non sono ambigui (-Rec, -Fo)
const psHas = (args, name, min) => args.some(a => !a.q && /^-[A-Za-z]+/.test(a.v) && (() => { const k = a.v.slice(1).split(':')[0].toLowerCase(); return k.length >= min && name.startsWith(k); })());
const psValue = (args, names) => { for (let i = 0; i < args.length - 1; i++) { const k = /^-([A-Za-z]+)$/.exec(args[i].q ? '' : args[i].v); if (k && names.some(nm => nm.startsWith(k[1].toLowerCase()) && k[1].length >= 2)) return args[i + 1].v; } return null; };
const dry = args => has(args, '--dry-run', '--dryrun', '--what-if', '-WhatIf', '-whatif', '--check', '--simulate', '--no-act') || psHas(args, 'whatif', 2);

class Scan {
  constructor(ctx) {
    this.ctx = ctx;
    this.paths = makePaths(ctx);
    this.hits = new Map(); // id della regola → { targets: Set }
    this.marks = { readsSecret: false, network: false };
  }
  hit(id, target) {
    if (!RULES[id]) return;
    let h = this.hits.get(id);
    if (!h) this.hits.set(id, h = { targets: new Set() });
    if (target && target.rel) h.targets.add(target.rel);
  }
  // lo stato di git di un percorso, se chi chiama lo sa: 'tracked' | 'untracked' | 'missing' | undefined
  tracked(w) { try { return w && w.abs && typeof this.ctx.fileState === 'function' ? this.ctx.fileState(w.abs, w.rel) : undefined; } catch { return undefined; } }

  // un file che sta per essere scritto (strumento Write/Edit, redirezione, tee, sed -i…)
  writeTo(raw, cwd, { overwrite = false } = {}) {
    const w = this.paths.where(raw, cwd);
    if (w.kind === 'unknown' || w.kind === 'temp') return w;
    if (w.kind !== 'inside' && w.kind !== 'git') { this.hit('write-outside', w); return w; }
    if (LOCKFILES.has(baseName(w.rel))) this.hit('lockfile', w);
    if (isEnvFile(w.rel)) this.hit('env-file', w);
    if (isConfig(w.rel)) this.hit('ci-config', w);
    if (overwrite && this.tracked(w) === 'untracked') this.hit('overwrite-untracked', w);
    return w;
  }
  // una cancellazione: i bersagli e se scende nelle cartelle
  remove(targets, cwd, recursive, unknownArgs) {
    if (unknownArgs || !targets.length) { if (recursive) this.hit('rm-recursive'); return; }
    for (const t of targets) {
      const w = this.paths.where(t.v === undefined ? t : t.v, cwd);
      if (w.kind === 'temp') continue;
      if (w.kind === 'root' || w.kind === 'home' || w.kind === 'above') { if (recursive || w.glob) this.hit('rm-home-root', w); continue; }
      if (w.kind === 'project-root' || w.kind === 'git') {
        if (recursive && !(w.kind === 'project-root' && w.glob && this.ctx.unknownCwd)) this.hit(w.kind === 'git' || !w.glob ? 'rm-project-root' : 'rm-recursive', w);
        continue;
      }
      if (w.kind === 'outside') { if (!REGENERABLE.has(baseName(w.abs))) this.hit(recursive ? 'rm-outside' : 'rm-outside-file', w); continue; }
      if (w.kind === 'unknown') { if (recursive) this.hit('rm-recursive', w); continue; }
      // dentro il progetto
      if (regenerable(w.rel)) continue;
      if (recursive) { if (this.tracked(w) !== 'tracked') this.hit('rm-recursive', w); continue; }
      if (LOCKFILES.has(baseName(w.rel))) this.hit('lockfile', w);
      if (isEnvFile(w.rel)) this.hit('env-file', w);
    }
  }

  script(src, dialect, env, depth = 0) {
    if (depth > MAX_DEPTH || !src) return;
    const { cmds, subs } = lex(String(src).slice(0, MAX_INPUT), dialect);
    const st = { ...env };
    for (const c of cmds) {
      // dopo "|" il cd di prima non vale; dopo && ; e a capo sì
      this.command(c, c.words, dialect, st, depth);
    }
    for (const s of subs) this.script(s, dialect, env, depth + 1);
  }

  command(c, words, dialect, st, depth) {
    let ws = words.slice();
    // parole chiave e variabili davanti al comando (anche VAR="con spazi")
    while (ws.length && ((!ws[0].q && KEYWORDS.has(ws[0].v)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0].v) || /^\$env:\w+=/.test(ws[0].v))) ws.shift();
    // le redirezioni valgono per il comando intero
    if (words === c.words) {
      for (const r of c.redirs) {
        if (r.op[0] === '>') this.writeTo(r.target, st.cwd, { overwrite: r.op !== '>>' });
        else if (r.op === '<' && isSecretPath(r.target)) this.marks.readsSecret = true;
      }
    }
    if (!ws.length) return;
    const name = cmdName(ws[0].v), args = ws.slice(1);
    for (const a of ws) if (a.v.split(/[=@,]/).some(isSecretPath)) this.marks.readsSecret = true; // anche -d @.env e f=@.env
    if (NETWORK.has(name)) this.marks.network = true;
    const again = rest => this.command(c, rest, dialect, st, depth + 1);
    const joined = list => list.map(a => a.v).join(' ');
    if (depth > MAX_DEPTH) return;

    // ---- chi lancia un altro comando
    if (name === 'sudo' || name === 'doas' || name === 'runas') {
      this.hit('sudo');
      let i = 0;
      while (i < args.length && isFlag(args[i])) { if (args[i].v === '--') { i++; break; } i += /^-[ughpCrtTD]$/.test(args[i].v) ? 2 : 1; }
      return again(args.slice(i));
    }
    if (name === 'env') { let i = 0; while (i < args.length && (isFlag(args[i]) || /^[A-Za-z_]\w*=/.test(args[i].v))) i += args[i].v === '-u' ? 2 : 1; return again(args.slice(i)); }
    if (name in PASS) {
      let i = 0;
      while (i < args.length && isFlag(args[i])) i += /^-(n|c|s|k|o|e|i)$/.test(args[i].v) ? 2 : 1;
      return again(args.slice(i + (i < args.length ? PASS[name] : 0)));
    }
    if (name === 'xargs') {
      let i = 0;
      while (i < args.length && isFlag(args[i])) i += /^-(n|I|P|d|L|s|E|a)$/.test(args[i].v) ? 2 : 1;
      return this.command(c, args.slice(i), dialect, { ...st, unknownArgs: true }, depth + 1);
    }
    if (SHELLS.has(name)) {
      const i = args.findIndex(a => !a.q && /^-[a-zA-Z]*c$/.test(a.v));
      if (i >= 0 && args[i + 1]) this.script(args[i + 1].v, 'bash', st, depth + 1);
      if (c.heredoc) this.script(c.heredoc, 'bash', st, depth + 1);
      for (const r of c.redirs) if (r.op === '<<<') this.script(r.target, 'bash', st, depth + 1);
      if (c.prev === '|' && c.before && /^(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)$/.test(cmdName((c.before.words[0] || {}).v || ''))) this.hit('pipe-to-shell');
      return;
    }
    if (name === 'cmd') { const i = args.findIndex(a => /^\/[ck]$/i.test(a.v)); if (i >= 0) this.script(joined(args.slice(i + 1)), 'cmd', st, depth + 1); return; }
    if (name === 'powershell' || name === 'pwsh') {
      const i = args.findIndex(a => /^-(c|command)$/i.test(a.v));
      if (i >= 0) this.script(joined(args.slice(i + 1)), 'ps', st, depth + 1);
      else { const rest = args.filter(a => !/^-(noprofile|nologo|noninteractive|executionpolicy|ep|file|f)$/i.test(a.v)); if (rest.length && !has(args, '-File', '-file', '-f')) this.script(joined(rest), 'ps', st, depth + 1); }
      return;
    }
    if (name === 'eval' || name === 'invoke-expression' || name === 'iex') {
      if (name !== 'eval' && c.prev === '|' && c.before && /^(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)$/.test(cmdName((c.before.words[0] || {}).v || ''))) this.hit('pipe-to-shell');
      return this.script(joined(args), dialect, st, depth + 1);
    }
    if (name === 'ssh') {
      // il comando dopo l'host gira su un'altra macchina: lì niente è "dentro il progetto"
      let i = 0;
      while (i < args.length && isFlag(args[i])) i += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[i].v) ? 2 : 1;
      if (args.length > i + 1) new RemoteScan(this).script(joined(args.slice(i + 1)), 'bash', {}, depth + 1);
      return;
    }

    // ---- cd: i percorsi relativi dei comandi dopo partono da lì
    if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'sl' || name === 'chdir') {
      const t = positional(args)[0];
      if (t && c.next !== '|' && c.prev !== '|') { const w = this.paths.where(t.v, st.cwd); st.cwd = w.abs || null; if (!w.abs) st.unknownCwd = true; }
      return;
    }

    const pos = positional(args);
    const sub = pos[0] ? pos[0].v.toLowerCase() : '';

    // ---- cancellare
    if (dialect !== 'bash' && PS_REMOVE.has(name)) {
      const dos = args.filter(a => /^\/[a-zA-Z]$/.test(a.v));
      const recursive = psHas(args, 'recurse', 1) || dos.some(a => /^\/s$/i.test(a.v)) || shortHas(args, 'r');
      if (dry(args)) return;
      const explicit = psValue(args, ['path', 'literalpath']);
      const targets = (explicit ? [{ v: explicit }] : pos.filter(a => !/^\/[a-zA-Z]$/.test(a.v))).flatMap(a => a.v.split(',').map(v => ({ v: v.trim() })).filter(x => x.v));
      return this.remove(targets, st.cwd, recursive, st.unknownArgs);
    }
    if (name === 'rm' || name === 'unlink' || name === 'shred' || name === 'trash' || name === 'rimraf' || name === 'del' || name === 'rd' || (name === 'rmdir' && args.some(a => /^\/s$/i.test(a.v)))) {
      const dos = name === 'del' || name === 'rd' || name === 'rmdir';
      const recursive = name === 'rimraf' || (dos ? args.some(a => /^\/s$/i.test(a.v)) : shortHas(args, 'r') || shortHas(args, 'R') || has(args, '--recursive'));
      return this.remove(dos ? pos.filter(a => !/^\/[a-zA-Z]$/.test(a.v)) : pos, st.cwd, recursive, st.unknownArgs);
    }
    if (name === 'find') {
      const iExec = args.findIndex(a => /^-(exec|execdir|ok|okdir)$/.test(a.v));
      const start = args.find(a => !isFlag(a)) || { v: '.' };
      // find che cerca solo cose che tornano da sole (*.pyc, node_modules) non è un rischio
      const names = args.filter((a, k) => k > 0 && /^-i?name$/.test(args[k - 1].v)).map(a => a.v.replace(/^\*+/, 'x'));
      const harmless = names.length > 0 && names.every(regenerable);
      if (has(args, '-delete') && !harmless) { const w = this.paths.where(start.v, st.cwd); if (w.rel && regenerable(w.rel)) return; this.hit(w.kind === 'inside' || w.kind === 'project-root' || w.kind === 'unknown' ? 'find-delete' : w.kind === 'temp' ? '' : 'rm-outside', w); }
      if (iExec >= 0 && !harmless) {
        const end = args.findIndex((a, k) => k > iExec && (a.v === ';' || a.v === '+'));
        const inner = args.slice(iExec + 1, end < 0 ? undefined : end).filter(a => a.v !== '{}');
        const w = this.paths.where(start.v, st.cwd);
        this.command(c, inner, dialect, { ...st, unknownArgs: true, findOutside: w.kind !== 'inside' && w.kind !== 'project-root' && w.kind !== 'temp' && w.kind !== 'unknown' }, depth + 1);
      }
      return;
    }

    // ---- git
    if (name === 'git') return this.git(args, st);

    // ---- database
    if (SQL_CLIENTS.has(name) || name === 'mongosh' || name === 'mongo') {
      const texts = args.filter(a => a.q || /\s/.test(a.v)).map(a => a.v);
      for (const a of args) { const m = /^--(?:command|execute|query|eval)=(.*)$/s.exec(a.v); if (m) texts.push(m[1]); }
      if (c.heredoc) texts.push(c.heredoc);
      for (const r of c.redirs) if (r.op === '<<<') texts.push(r.target);
      if (c.prev === '|' && c.before && /^(echo|printf|cat)$/.test(cmdName((c.before.words[0] || {}).v || ''))) { texts.push(joined(c.before.words.slice(1))); if (c.before.heredoc) texts.push(c.before.heredoc); }
      for (const t of texts) {
        for (const id of sqlRules(t)) this.hit(id);
        if (/\.(dropDatabase|drop)\s*\(|\.deleteMany\s*\(\s*\{\s*\}\s*\)|\.remove\s*\(\s*\{\s*\}\s*\)/.test(t)) this.hit('sql-drop');
      }
      if (name === 'supabase' && sub === 'db' && pos[1] && pos[1].v === 'reset') this.hit('db-reset');
      if (name !== 'wrangler') return;
    }
    if (name === 'dropdb' || name === 'dropuser') return this.hit('sql-drop');
    if ((name === 'rails' || name === 'rake') && pos.some(a => /^db:(drop|reset|purge|schema:load|migrate:reset)/.test(a.v))) return this.hit('db-reset');
    if (name === 'prisma' && ((sub === 'migrate' && pos[1] && pos[1].v === 'reset') || (sub === 'db' && has(args, '--force-reset')))) return this.hit('db-reset');
    if ((name === 'python' || name === 'python3' || name === 'manage.py' || name === 'django-admin') && pos.some(a => a.v === 'flush' || a.v === 'reset_db')) return this.hit('db-reset');
    if (name === 'redis-cli' && pos.some(a => /^flush(all|db)$/i.test(a.v))) return this.hit('sql-truncate');

    // ---- infrastruttura
    if (name === 'terraform' || name === 'tofu' || name === 'terragrunt') { if (sub === 'apply' || sub === 'destroy' || (sub === 'run-all' && pos[1] && /^(apply|destroy)$/.test(pos[1].v))) this.hit('terraform-apply'); return; }
    if (name === 'pulumi') { if (sub === 'up' || sub === 'destroy' || sub === 'update') this.hit('terraform-apply'); return; }
    if (name === 'kubectl' || name === 'oc' || name === 'k') { if (sub === 'delete' && !has(args, '--dry-run')) this.hit('kubectl-delete'); return; }
    if (name === 'helm') { if ((sub === 'uninstall' || sub === 'delete' || sub === 'del') && !has(args, '--dry-run')) this.hit('helm-uninstall'); return; }
    if (name === 'docker' || name === 'podman' || name === 'docker-compose') {
      const second = pos[1] ? pos[1].v : '';
      if ((sub === 'system' && second === 'prune' && (shortHas(args, 'a') || has(args, '--all', '--volumes'))) || (/^(image|builder|container)$/.test(sub) && second === 'prune' && (shortHas(args, 'a') || has(args, '--all')))) this.hit('docker-prune');
      else if (sub === 'volume' && /^(rm|remove|prune)$/.test(second)) this.hit('docker-volume-rm');
      else if ((sub === 'compose' && second === 'down' || (name === 'docker-compose' && sub === 'down')) && (shortHas(args, 'v') || has(args, '--volumes'))) this.hit('docker-volume-rm');
      else if (sub === 'push' && !dry(args)) this.hit('publish');
      return;
    }
    if (name === 'aws') {
      const second = pos[1] ? pos[1].v : '';
      if (sub === 's3' && ((second === 'rm' && has(args, '--recursive')) || second === 'rb' || (second === 'sync' && has(args, '--delete')))) { if (!dry(args)) this.hit('cloud-delete'); }
      else if (/^(delete|terminate|deregister|purge)-/.test(second) && !dry(args)) this.hit('cloud-delete');
      return;
    }
    if (name === 'gcloud' || name === 'az' || name === 'doctl' || name === 'gsutil') {
      if (name === 'gsutil' ? (sub === 'rm' && shortHas(args, 'r')) || sub === 'rb' : pos.some(a => /^(delete|purge)$/.test(a.v))) this.hit('cloud-delete');
      else if (name === 'gcloud' && pos.some(a => a.v === 'deploy')) this.hit('deploy');
      return;
    }

    // ---- pubblicare e mettere in produzione
    if (name === 'gh') {
      const second = pos[1] ? pos[1].v : '';
      if (sub === 'release' && second === 'create') this.hit('publish');
      else if ((sub === 'release' || sub === 'repo') && second === 'delete') this.hit('gh-delete');
      return;
    }
    if (PUBLISH[name] && PUBLISH[name].includes(sub) || (name === 'yarn' && sub === 'npm' && pos[1] && pos[1].v === 'publish') || (name === 'dotnet' && sub === 'nuget' && pos[1] && pos[1].v === 'push') || (name === 'mvn' && pos.some(a => a.v === 'deploy'))) {
      if (!dry(args)) this.hit('publish');
      return;
    }
    if (name in DEPLOY) {
      const prod = has(args, '--prod', '--production');
      if (name === 'vercel' ? prod : DEPLOY[name].includes(sub) && (name !== 'netlify' || prod)) { if (!dry(args)) this.hit('deploy'); }
      return;
    }

    // ---- sistema
    if ((name === 'chmod' || name === 'chown' || name === 'chgrp') && (shortHas(args, 'R') || has(args, '--recursive'))) return this.hit('chmod-recursive');
    if (name === 'icacls' && args.some(a => /^\/t$/i.test(a.v))) return this.hit('chmod-recursive');
    if (name === 'dd') { const of = args.find(a => /^of=/.test(a.v)); if (of) { if (/^of=\/dev\/(?!null|zero|stdout|stderr)/.test(of.v)) this.hit('disk-write'); else this.writeTo(of.v.slice(3), st.cwd, { overwrite: true }); } return; }
    if (/^mkfs(\.|$)/.test(name) || name === 'format' && /^[a-zA-Z]:$/.test(sub) || name === 'diskpart' || name === 'wipefs') return this.hit('disk-write');

    // ---- scrivere file
    if (name === 'tee') { for (const t of pos) this.writeTo(t.v, st.cwd, { overwrite: !shortHas(args, 'a') }); return; }
    if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln' || name === 'rsync' || name === 'copy' || name === 'move' || name === 'xcopy' || name === 'robocopy') {
      if (pos.length >= 2 && !st.unknownArgs && !/:/.test(pos[pos.length - 1].v.replace(/^[a-zA-Z]:/, ''))) {
        const w = this.paths.where(pos[pos.length - 1].v, st.cwd);
        if (w.kind !== 'inside' && w.kind !== 'project-root' && w.kind !== 'git' && w.kind !== 'temp' && w.kind !== 'unknown') this.hit('write-outside', w);
      }
      if ((name === 'rsync' && has(args, '--delete', '--delete-after', '--delete-before')) || (name === 'robocopy' && args.some(a => /^\/(mir|purge)$/i.test(a.v)))) this.hit('rm-recursive');
      return;
    }
    if (name === 'sed' && (shortHas(args, 'i') || has(args, '--in-place'))) { for (const t of pos.slice(1)) this.writeTo(t.v, st.cwd); return; }
    if (name === 'truncate') { for (const t of pos) this.writeTo(t.v, st.cwd, { overwrite: true }); return; }
    if (dialect !== 'bash' && PS_WRITE.has(name)) {
      const dest = psValue(args, ['destination']) || psValue(args, ['filepath', 'path', 'literalpath']) || (pos[name === 'copy-item' || name === 'cpi' || name === 'move-item' || name === 'mi' ? 1 : 0] || {}).v;
      if (dest && !dry(args)) this.writeTo(dest, st.cwd, { overwrite: !/^(add-content|ac)$/.test(name) });
      return;
    }

    // ---- dipendenze
    if (DEP_ADD[name] && DEP_ADD[name].includes(sub)) {
      const pkgs = pos.slice(1).filter(a => !/^(\.|\.\/.*|-e)$/.test(a.v));
      const fromFile = has(args, '-r', '--requirement', '--frozen-lockfile', '--ci');
      if (name === 'dotnet' ? pos[1] && pos[1].v === 'package' || pos[2] && pos[2].v === 'package' : pkgs.length && !fromFile) this.hit('deps-added');
      return;
    }
    if ((name === 'python' || name === 'python3' || name === 'py') && has(args, '-m') && pos[0] && pos[0].v === 'pip' && pos[1] && pos[1].v === 'install' && pos.slice(2).some(a => !/^(\.|\.\/.*)$/.test(a.v)) && !has(args, '-r', '--requirement')) return this.hit('deps-added');
  }

  git(args, st) {
    // le opzioni di git prima del sottocomando
    let i = 0, cwd = st.cwd;
    while (i < args.length && isFlag(args[i])) {
      if (args[i].v === '-C' && args[i + 1]) { const w = this.paths.where(args[i + 1].v, cwd); cwd = w.abs || null; i += 2; continue; }
      i += /^(-c|--git-dir|--work-tree|--namespace)$/.test(args[i].v) ? 2 : 1;
    }
    const sub = args[i] ? args[i].v : '', rest = args.slice(i + 1), pos = positional(rest);
    const dashdash = rest.findIndex(a => !a.q && a.v === '--');
    const discard = paths => {
      if (!paths.length) return;
      const wide = paths.length > 1 || paths.some(p => /^(\.|:\/|\*)$/.test(p.v) || /[*?]/.test(p.v) || /\/$/.test(p.v));
      this.hit(wide ? 'git-discard' : 'git-discard-file', this.paths.where(paths[0].v, cwd));
    };
    switch (sub) {
      case 'reset': if (has(rest, '--hard', '--merge', '--keep') && has(rest, '--hard')) this.hit('git-reset-hard'); return;
      case 'checkout':
        if (has(rest, '-f', '--force')) return this.hit('git-discard');
        if (dashdash >= 0) return discard(rest.slice(dashdash + 1));
        if (pos.length === 1 && pos[0].v === '.') return this.hit('git-discard');
        return;
      case 'restore':
        if ((has(rest, '--staged', '-S')) && !has(rest, '--worktree', '-W')) return;
        return discard(pos);
      case 'switch': if (has(rest, '-f', '--force', '--discard-changes')) this.hit('git-discard'); return;
      case 'clean': if ((shortHas(rest, 'f') || has(rest, '--force')) && !shortHas(rest, 'n') && !has(rest, '--dry-run')) this.hit('git-clean'); return;
      case 'stash': if (pos[0] && /^(drop|clear)$/.test(pos[0].v)) this.hit('git-stash-drop'); return;
      case 'rebase': if (!has(rest, '--abort', '--continue', '--skip', '--quit', '--edit-todo', '--show-current-patch')) this.hit('git-rebase'); return;
      case 'branch': if (shortHas(rest, 'D') || ((shortHas(rest, 'd') || has(rest, '--delete')) && (shortHas(rest, 'f') || has(rest, '--force')))) this.hit('git-branch-delete'); return;
      case 'filter-branch': case 'filter-repo': return this.hit('git-rewrite');
      case 'reflog': if (pos[0] && /^(expire|delete)$/.test(pos[0].v)) this.hit('git-rewrite'); return;
      case 'gc': if (rest.some(a => /^--prune=(now|all)$/.test(a.v))) this.hit('git-rewrite'); return;
      case 'update-ref': if (has(rest, '-d', '--delete')) this.hit('git-rewrite'); return;
      case 'push': return this.push(rest, pos);
      default: return;
    }
  }

  push(rest, pos) {
    this.marks.network = true;
    if (has(rest, '--dry-run') || shortHas(rest, 'n')) return;
    const force = has(rest, '--force', '--force-with-lease', '--force-if-includes') || shortHas(rest, 'f') || pos.slice(1).some(p => p.v.startsWith('+'));
    const everything = has(rest, '--all', '--mirror');
    const del = has(rest, '--delete') || shortHas(rest, 'd') || pos.slice(1).some(p => /^:./.test(p.v));
    // i branch di arrivo: quelli scritti, altrimenti quello corrente se chi chiama lo sa
    const named = pos.slice(1).map(p => p.v.replace(/^\+/, '')).map(v => (v.includes(':') ? v.split(':').pop() : v).replace(/^refs\/heads\//, '')).filter(v => v && !/^refs\/tags\//.test(v) && v !== 'HEAD');
    const targets = named.length ? named : this.ctx.branch ? [this.ctx.branch] : [];
    const known = targets.length > 0;
    if (targets.some(b => MAIN_BRANCHES.test(b))) this.hit('git-push-main');
    const shared = everything || targets.some(b => SHARED_BRANCHES.test(b));
    if (force) this.hit(shared ? 'git-push-force-shared' : known ? 'git-push-force-feature' : 'git-push-force');
    else if (del) this.hit(shared ? 'git-push-force-shared' : 'git-push-delete');
    else if (everything && has(rest, '--mirror')) this.hit('git-push-force-shared');
  }

  result() {
    const ids = [...this.hits.keys()].sort((a, b) => RULES[b].level - RULES[a].level);
    if (!ids.length) return { level: 0, ruleIds: [], category: '', reasons: [], reach: '', undo: '', prudence: [], shape: '', targets: [], marks: this.marks };
    const top = RULES[ids[0]];
    const level = top.level;
    // le prudenze che contano e la portata: dalle regole del livello più alto
    const tops = ids.filter(id => RULES[id].level === level);
    const targets = new Set();
    for (const id of ids) for (const t of this.hits.get(id).targets) targets.add(t);
    return {
      level,
      ruleIds: ids,
      category: top.category,
      reasons: ids.map(id => RULES[id].text()),
      reach: REACH[Math.max(...tops.map(id => REACH.indexOf(RULES[id].reach)))],
      undo: top.undo ? top.undo() : '',
      prudence: [...new Set(tops.flatMap(id => RULES[id].prudence))],
      shape: top.shape,
      targets: [...targets].slice(0, 5),
      marks: this.marks,
    };
  }
}

// il comando di un "ssh host …": stesse regole, ma niente è dentro il progetto e i segni vanno allo Scan di partenza
class RemoteScan extends Scan {
  constructor(parent) {
    super({ cwd: '/', root: '/__nessun_progetto__', home: '/__nessuna_home__' });
    this.hits = parent.hits; this.marks = parent.marks;
  }
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const mcpWords = tool => String(tool).split('__').pop().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Quello che chi chiama può aggiungere, se lo sa (tutto facoltativo):
//   home               la home, per le prove
//   branch             il branch corrente
//   fileState(abs,rel) → 'tracked' | 'untracked' | 'missing'
//   turnFilesModified  quanti file ha già modificato in questo turno
//   turnReadSecrets    in questo turno ha già letto ~/.ssh, ~/.aws o un .env
function classify(action) {
  const { tool, input, cwd, root, home, branch, fileState, turnFilesModified = 0, turnReadSecrets = false } = action && typeof action === 'object' ? action : {};
  const scan = new Scan({ cwd: cwd || root || '', root: root || cwd || '', home, branch, fileState });
  const inp = input && typeof input === 'object' ? input : {};
  const start = { cwd: cwd || root || '' };
  try {
    if (tool === 'Bash' || tool === 'BashOutput' && inp.command) scan.script(String(inp.command || ''), 'bash', start);
    else if (tool === 'PowerShell') scan.script(String(inp.command || ''), 'ps', start);
    else if (WRITE_TOOLS.has(tool)) {
      const file = inp.file_path || inp.notebook_path || inp.path;
      if (file) scan.writeTo(String(file), start.cwd, { overwrite: tool === 'Write' });
      if (turnFilesModified > 20) scan.hit('many-files');
    } else if (tool === 'Read') { if (isSecretPath(String(inp.file_path || ''))) scan.marks.readsSecret = true; }
    else if (tool === 'WebFetch' || tool === 'WebSearch') scan.marks.network = true;
    else if (/^mcp__/.test(String(tool))) {
      const words = mcpWords(tool);
      if (words.length && !MCP_READ.has(words[0]) && words.some(w => MCP_EFFECT.has(w))) scan.hit('mcp-external');
      for (const k of ['query', 'sql', 'statement', 'command']) if (typeof inp[k] === 'string') for (const id of sqlRules(inp[k].slice(0, MAX_INPUT))) scan.hit(id);
    }
  } catch { /* un comando che non si riesce a leggere non è un rischio noto: livello 0 */ }
  if (scan.marks.network && (scan.marks.readsSecret || turnReadSecrets)) scan.hit('secret-then-network');
  return scan.result();
}

module.exports = { classify, lex, sqlRules, makePaths, RULES };
