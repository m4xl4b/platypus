'use strict';
// "Mappa contro territorio": confronta quello che l'agente sa (la sua mappa, vedi worldmap.js)
// con quello che c'è davvero: il disco e quello che hanno fatto gli altri agenti della sessione.
//  - ricordi scaduti: un file che ha letto è poi cambiato e lui non l'ha più riletto;
//  - modifiche alla cieca: modifica un file cambiato da un altro agente senza averlo riletto
//    (o Claude Code gliela rifiuta perché il file è cambiato: presa in tempo);
//  - percorsi inventati ("fantasmi"): file che cerca, apre o cita e che non esistono;
//  - affermazioni ("i test passano", "ho corretto X"): ancorate se c'è un fatto che le prova.
// Tutto pigro: si calcola solo quando qualcuno lo chiede, e il disco si guarda al massimo ogni 10 s.

const fs = require('fs');
const path = require('path');
const { isProjectFile, pathsInCommand, relKey, scanTree, EXT } = require('./worldmap');
const { isTestCommand } = require('./releases');
const { tr } = require('../i18n');

const SLACK = 1500;      // ms di tolleranza tra l'esito di una lettura e l'mtime del file
const DISK_TTL = 10000;  // il disco di una sessione si riguarda al massimo ogni 10 s
const MAX_STAT = 400;    // file controllati sul disco per richiesta
const MAX_ITEMS = 200;

// cache dei controlli sul disco: sid -> {t, cwd, mtimes: Map(key -> mtime | null se non c'è più)}
const diskCache = new Map();

// un file esiste nell'albero del progetto? Va bene anche citato da una sottocartella ("auth/session.ts")
function treeIndex(files) {
  const byBase = new Map();
  for (const f of files || []) {
    const p = Array.isArray(f) ? f[0] : f;
    const b = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p.toLowerCase());
  }
  return key => {
    const k = String(key).toLowerCase().replace(/^\.\//, '');
    return (byBase.get(k.slice(k.lastIndexOf('/') + 1)) || []).some(p => p === k || p.endsWith('/' + k));
  };
}

// il disco come lo vede la sessione:
//  stat(key)   -> mtime (null: il file non c'è, undefined: non si sa)
//  exists(key) -> true/false (undefined: non si sa)
function diskOf(session, cwd, { replay } = {}) {
  if (session.demo) {
    const d = session.demoDisk; // il disco finto della demo: key -> {mtime, exists}
    if (!d) return { reason: tr('Demo: i file dei piani non esistono sul disco') };
    const stat = key => { const e = d instanceof Map ? d.get(key) : d[key]; return !e ? undefined : e.exists === false ? null : e.mtime; };
    const inTree = treeIndex(session.demoTree);
    return { stat, exists: key => { const v = stat(key); return v === null ? false : v !== undefined || inTree(key); } };
  }
  if (replay) return { reason: tr('Replay: il disco di oggi non è quello di allora') };
  if (session.kind === 'cowork') return { reason: tr('Sessione Cowork: i suoi file non sono su questo disco') };
  let root;
  try { root = path.resolve(cwd); if (!cwd || !fs.statSync(root).isDirectory()) throw new Error(); }
  catch { return { reason: tr('La cartella della sessione non si legge da qui (WSL non montato, disco esterno o cartella cancellata)') }; }
  let c = diskCache.get(session.id);
  if (!c || c.cwd !== root || Date.now() - c.t > DISK_TTL) {
    c = { t: Date.now(), cwd: root, mtimes: new Map() };
    diskCache.set(session.id, c);
    if (diskCache.size > 50) diskCache.delete(diskCache.keys().next().value);
  }
  let budget = MAX_STAT;
  const stat = key => {
    if (c.mtimes.has(key)) return c.mtimes.get(key);
    if (budget-- <= 0) return undefined;
    let v;
    try { v = fs.statSync(path.join(root, key)).mtimeMs; } catch (e) { v = e && e.code === 'ENOENT' ? null : undefined; }
    if (v !== undefined) c.mtimes.set(key, v);
    return v;
  };
  // prima l'albero del progetto (già in cache per la mappa), poi il disco per le cartelle che l'albero salta,
  // poi i worktree di Claude Code del progetto (gli agenti che lavorano lì citano percorsi relativi al worktree)
  let inTree = null, truncated = false, worktrees = null;
  const known = new Map();
  const wts = () => worktrees || (worktrees = (() => {
    try { return fs.readdirSync(path.join(root, '.claude', 'worktrees'), { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 20).map(d => path.join(root, '.claude', 'worktrees', d.name)); } catch { return []; }
  })());
  const exists = key => {
    if (!inTree) { const tree = scanTree(root); truncated = !!tree.truncated; inTree = tree.available ? treeIndex(tree.files) : () => false; }
    if (inTree(key)) return true;
    const v = stat(key);
    if (typeof v === 'number') return true;
    for (const w of wts()) { try { fs.statSync(path.join(w, key)); return true; } catch {} }
    // un nome senza cartella, in un progetto troppo grande per l'albero: non si può dire
    if (truncated && !key.includes('/')) return undefined;
    return v === undefined ? undefined : false;
  };
  return { stat, exists: key => { if (!known.has(key)) known.set(key, exists(key)); return known.get(key); } };
}

// percorsi citati in una risposta: tra backtick anche un nome da solo, nel testo solo "cartella/file.ext".
// I blocchi di codice non contano (dentro ci sono esempi, non affermazioni sul progetto).
const NOT_FILES = /^(node|vue|next|nuxt|express|three|d3|chart|moment|react|angular|ember|backbone|p5|alpine|solid|svelte|socket\.io)\.js$/i;
function pathsInReply(text) {
  const out = [];
  const add = (p, i, s) => { if (!NOT_FILES.test(p) && !out.some(o => o.path === p)) out.push({ path: p, line: lineAt(s, i) }); };
  const s = String(text || '').slice(0, 8000).replace(/```[\s\S]*?(```|$)/g, m => ' '.repeat(m.length));
  const code = /`([^`\n]{1,200})`/g;
  let m;
  while ((m = code.exec(s))) for (const p of pathsInCommand(m[1])) add(p, m.index, s);
  const plain = s.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
  let at = 0;
  for (const line of plain.split('\n')) {
    for (const p of pathsInCommand(line.replace(/[.,;:!?)\]]+(?=\s|$)/g, ''))) if (/[\/\\]/.test(p) && EXT.test(p)) add(p, at, s);
    at += line.length + 1;
  }
  return out.slice(0, 40);
}
function lineAt(s, i) {
  const a = s.lastIndexOf('\n', i) + 1, b = s.indexOf('\n', i);
  return s.slice(a, b < 0 ? s.length : b).trim().slice(0, 160);
}

// percorsi inventati: dagli errori e dall'output (registrati nella mappa) e dalle risposte (controllati qui, sul disco)
function findGhosts(session, agents, cwd, { only = null, replay = false } = {}) {
  const ghosts = [];
  // quando un file è apparso nella sessione: creato o modificato da qualcuno, o letto con successo
  const appeared = new Map();
  for (const a of agents) {
    if (!a.world) continue;
    for (const [key, nd] of a.world.nodes) {
      const t = Math.max(nd.lastSync || 0, nd.edits && nd.edits.length ? nd.edits[nd.edits.length - 1] : 0, nd.created ? nd.edit || 0 : 0);
      if (t && t > (appeared.get(key) || 0)) appeared.set(key, t);
    }
  }
  const disk = diskOf(session, cwd, { replay });
  for (const a of agents) {
    if (!a.world || (only && !only.has(a.id))) continue;
    const seen = new Set();
    for (const [key, nd] of a.world.nodes) {
      if (!nd.ghost) continue;
      seen.add(key);
      // poi è stato creato: non era un'allucinazione, era un'intenzione
      // (sul disco conta il percorso esatto: un percorso sbagliato non diventa "creato" perché il file sta altrove)
      const later = (appeared.get(key) || 0) > nd.ghostAt || (disk.stat && isProjectFile(key) && typeof disk.stat(key) === 'number');
      ghosts.push({ key, agent: a.id, agentName: a.name, t: nd.ghostAt, source: nd.ghostSrc, excerpt: nd.ghostLine || '', createdLater: !!later });
    }
    if (!disk.exists) continue; // senza disco non si può dire se un file citato esiste
    for (const r of a.world.replies) {
      for (const p of pathsInReply(r.text)) {
        const key = relKey(p.path, cwd);
        // un nome senza cartella è troppo ambiguo (file di altri progetti, della home, delle librerie): non si giudica
        if (!isProjectFile(key) || !key.includes('/') || seen.has(key) || appeared.has(key)) continue;
        seen.add(key);
        if (disk.exists(key) !== false) continue;
        ghosts.push({ key, agent: a.id, agentName: a.name, t: r.t, source: 'reply', excerpt: p.line, createdLater: false });
      }
    }
  }
  ghosts.sort((x, y) => y.t - x.t);
  return { ghosts: ghosts.slice(0, MAX_ITEMS) };
}

// agents: tutti gli agenti della sessione [{id, name, world}]; only: Set degli id da esaminare (null = tutti)
// disk: false per usare solo quello che si sa in memoria (gli avvisi, che si ricalcolano spesso)
function checkStale(session, agents, cwd, { only = null, replay = false, disk: useDisk = true } = {}) {
  const stale = [], blindEdits = [];
  // chi ha modificato cosa, e quando (solo modifiche riuscite)
  const editsByKey = new Map();
  for (const a of agents) {
    if (!a.world) continue;
    for (const [key, nd] of a.world.nodes) {
      if (!nd.edits || !nd.edits.length || !isProjectFile(key)) continue;
      let l = editsByKey.get(key);
      if (!l) editsByKey.set(key, (l = []));
      for (const t of nd.edits) l.push({ t, id: a.id, name: a.name });
    }
  }
  // l'ultima modifica di un altro agente nell'intervallo (from, to]
  const otherEdit = (key, id, from, to) => {
    let best = null;
    for (const e of editsByKey.get(key) || []) if (e.id !== id && e.t > from && e.t <= to && (!best || e.t > best.t)) best = e;
    return best;
  };
  const disk = useDisk ? diskOf(session, cwd, { replay }) : { reason: '' };
  for (const a of agents) {
    if (!a.world || (only && !only.has(a.id))) continue;
    for (const [key, nd] of a.world.nodes) {
      if (!nd.lastSync || !isProjectFile(key)) continue;
      const by = otherEdit(key, a.id, nd.lastSync, Infinity);
      const mtime = disk.stat ? disk.stat(key) : undefined;
      const changedOnDisk = typeof mtime === 'number' && mtime > nd.lastSync + SLACK;
      const gone = mtime === null;
      if (!by && !changedOnDisk && !gone) continue;
      stale.push({
        key, agent: a.id, agentName: a.name,
        readAt: nd.lastSync,
        mtime: typeof mtime === 'number' ? mtime : null,
        changedAt: by ? by.t : changedOnDisk ? mtime : null,
        changedBy: by ? by.name : null, changedById: by ? by.id : null,
        outside: !by, gone,
      });
    }
    for (const st of a.world.steps) {
      if (st.act !== 'edit' || !isProjectFile(st.target)) continue;
      const by = st.prevSync ? otherEdit(st.target, a.id, st.prevSync, st.t) : null;
      if (!by && !st.staleErr) continue;
      blindEdits.push({ key: st.target, agent: a.id, agentName: a.name, t: st.t, changedBy: by ? by.name : null, changedById: by ? by.id : null, caught: !!st.staleErr });
    }
  }
  stale.sort((x, y) => (y.changedAt || 0) - (x.changedAt || 0));
  blindEdits.sort((x, y) => y.t - x.t);
  return { stale: stale.slice(0, MAX_ITEMS), blindEdits: blindEdits.slice(0, MAX_ITEMS), disk: { checked: !!disk.stat, reason: disk.reason || '' } };
}

// ---- affermazioni nelle risposte: regole semplici e leggibili, in italiano e inglese
// Una frase è un'affermazione solo se dice che qualcosa È successo: niente domande, condizioni
// ("se i test passano"), intenzioni ("ora verifico", "I'll run"), consigli ("make sure") o negazioni.
const CLAIM_RULES = [
  ['tests', /\b(?:all |tutti i )?tests? (?:now )?(?:pass(?:es|ed)?|are (?:all )?(?:passing|green)|(?:are )?green)\b|\ball green\b|\btutto verde\b|\bsuite (?:è )?verde\b|\b(?:i |tutti i )?test (?:ora )?(?:passano|sono (?:tutti )?(?:verdi|passati)|tornano verdi)\b/i],
  ['verified', /\b(?:ho |l'ho |abbiamo )?verificat[oaie]\b|\b(?:I(?:'ve| have)? )?verified\b|\bconfermat[oaie]\b|\bconfirmed\b|\bfunziona(?:no)?\b|\b(?:it |now it |that )?works\b|\bis working\b/i],
  // in italiano serve l'ausiliare: "è corretta" vuol dire "è giusta", non "l'ho corretta"
  ['fixed', /(?<![A-Za-zÀ-ÿ'])(?:ho|abbiamo|l'ho|l'abbiamo|è stat[oa]|sono stat[ie])\s+(?:già\s+|appena\s+)?(?:corrett[oaie]|sistemat[oaie]|risolt[oaie]|fixat[oaie])\b|\b(?:I(?:'ve| have)? )?fixed\b|\bresolved\b/i],
  ['created', /\b(?:ho |abbiamo )?(?:creat[oaie]|aggiunt[oaie])\b|\b(?:I(?:'ve| have)? )?(?:created|added)\b/i],
  ['done', /\b(?:completat[oaie]|finit[oaie]|terminat[oaie])\b|(?<!\b(?:il|un|del|al|nel|dal|sul) )\bfatto\b|\b(?:done|completed|finished)\b/i],
];
const NOT_A_CLAIM = /\b(?:se|if|quando|when|once|unless|finché|until|dopo che|prima che|before|whether|will|going to|let me|let's|I'll|we'll|vado a|devo|dobbiamo|dovrebbe(?:ro)?|should|need to|needs to|bisogna|occorre|make sure|assicur\w*|controlla(?:re)? che|check|controllo|verificare|verify (?:that|whether|if)|to verify|per verificare|spero|hope|potrebbe(?:ro)?|might|may|probabilmente|probably|try to|proviamo|prova a|come|how|what|cosa|perché|why)\b/i;
// subito dopo il verbo: "created nothing", "risolto niente"
const EMPTY_AFTER = /^\s*(?:nothing|anything|niente|nulla|no\b)/i;
const NEGATION = /\b(?:non|not|never|mai|nessun\w*|neither|nor)\b|n't\b/i;

function sentences(text) {
  const s = String(text || '').slice(0, 8000).replace(/```[\s\S]*?(```|$)/g, ' ');
  return s.split(/(?<=[.!?…])\s+|\n+|(?:^|\s)[-*•]\s+/).map(x => x.trim()).filter(x => x.length > 2 && x.length < 400);
}
function extractClaims(text) {
  const out = [];
  for (const sent of sentences(text)) {
    if (/\?\s*$/.test(sent)) continue;
    const kinds = [];
    for (const [kind, re] of CLAIM_RULES) {
      if (kind === 'done' && kinds.length) continue; // "fatto" dentro un'altra affermazione non aggiunge nulla
      const m = re.exec(sent);
      if (!m) continue;
      const before = sent.slice(0, m.index), near = sent.slice(Math.max(0, m.index - 30), m.index + m[0].length);
      if (NOT_A_CLAIM.test(before) || NOT_A_CLAIM.test(m[0]) || NEGATION.test(near)) continue;
      if (EMPTY_AFTER.test(sent.slice(m.index + m[0].length))) continue;
      if (/[«"“`']\s*$/.test(before)) continue; // una parola tra virgolette è citata, non affermata
      kinds.push(kind);
      const p = (kind === 'fixed' || kind === 'created') ? pathsInReply(sent.slice(m.index))[0] : null;
      out.push({ kind, text: sent.slice(0, 200), file: p ? p.path : null });
    }
  }
  return out.slice(0, 40);
}

// le prove nello stesso turno: dalla richiesta dell'utente (capo) o dall'inizio del compito (sottoagente)
function judgeClaim(c, steps, from, to, fileKey) {
  const turn = steps.filter(s => s.t >= from && s.t < to && s.err !== null);
  const edits = turn.filter(s => s.act === 'edit');
  const lastEdit = edits.filter(s => !s.err).pop();
  const after = lastEdit ? turn.filter(s => s.t > lastEdit.t) : turn;
  const verdict = (pool) => {
    if (!pool.length) return { status: 'ungrounded', step: null };
    const last = pool[pool.length - 1];
    if (last.err) return { status: 'contradicted', step: last };
    return { status: 'grounded', step: last };
  };
  const isTest = s => s.act === 'verify' && isTestCommand(String(s.sig || '').replace(/^run:/, ''));
  switch (c.kind) {
    case 'tests': return verdict(after.filter(isTest));
    case 'verified': return verdict(after.filter(s => s.act === 'verify' || s.act === 'run'));
    case 'fixed': case 'created': {
      const base = fileKey ? fileKey.slice(fileKey.lastIndexOf('/') + 1).toLowerCase() : null;
      // senza un file citato vale anche uno strumento esterno riuscito (es. un ticket creato via MCP)
      const pool = fileKey ? edits.filter(s => s.target === fileKey || String(s.target || '').toLowerCase().endsWith('/' + base) || String(s.target || '').toLowerCase() === base) : turn.filter(s => s.act === 'edit' || s.act === 'tool');
      if (pool.some(s => !s.err)) return { status: pool[pool.length - 1].err ? 'contradicted' : 'grounded', step: pool[pool.length - 1] };
      return verdict(pool);
    }
    default: { // done: nessuna prova richiesta, ma non con un test fallito e mai tornato verde
      const tests = turn.filter(isTest);
      const last = tests[tests.length - 1];
      return last && last.err ? { status: 'ungrounded', step: last } : { status: 'grounded', step: null };
    }
  }
}

// agents: [{id, name, world, mind}]
function checkClaims(session, agents, cwd, { only = null } = {}) {
  const claims = [];
  for (const a of agents) {
    if (!a.world || (only && !only.has(a.id))) continue;
    const goals = (a.mind && a.mind.goals) || [];
    for (const r of a.world.replies) {
      const from = a.id === 'main' ? goals.reduce((x, g) => (g.t <= r.t && g.t > x ? g.t : x), 0) : 0;
      for (const c of extractClaims(r.text)) {
        const key = c.file ? relKey(c.file, cwd) : null;
        const j = judgeClaim(c, a.world.steps, from, r.t, key);
        claims.push({ ...c, file: key, agent: a.id, agentName: a.name, t: r.t, status: j.status, evidence: j.step ? { t: j.step.t, tool: j.step.tool, act: j.step.act, target: j.step.target, err: !!j.step.err } : null });
      }
    }
  }
  claims.sort((x, y) => y.t - x.t);
  const grounded = claims.filter(c => c.status === 'grounded').length;
  return { claims: claims.slice(0, MAX_ITEMS), score: claims.length ? { grounded, total: claims.length, pct: Math.round(100 * grounded / claims.length) } : null };
}

module.exports = { checkStale, findGhosts, checkClaims, extractClaims, judgeClaim, pathsInReply, SLACK, DISK_TTL };
