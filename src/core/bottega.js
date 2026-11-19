'use strict';
// "Libro della bottega": la memoria storica di un progetto, dedotta dai fatti già calcolati
// (mappa contro territorio e sorprese), non da regole scritte a mano. Le lezioni sono deduzioni:
// chi le mostra deve dirlo. Tutto resta in locale, in ~/.platypus/bottega/<chiave>.json.
//   flaky-command  un comando di verifica che fallisce spesso o a intermittenza
//   fragile-file   un file che compare in molte catene causali, o che dopo una modifica fa fallire le verifiche
//   known-fix      uno schema d'errore seguito più volte dalla correzione dello stesso file
//   loop-trap      dove gli agenti girano in tondo (stessa firma, errori di fila)
//   stale-trap     file che diventano spesso ricordi scaduti (ci lavorano più agenti insieme)
//   ghost-path     percorsi inventati che tornano (es. un file rinominato cercato col vecchio nome)
//   slow-step      comandi che restano appesi a lungo

const crypto = require('crypto');
const { tr, trn } = require('../i18n');
const grounding = require('./grounding');
const surprise = require('./surprise');
const { isTestCommand } = require('./releases');

const HALF_LIFE = 30 * 86400000;   // il peso si dimezza ogni 30 giorni senza nuovi casi
const LESSON_WEIGHT = 1.5;         // sotto questa soglia (o con un caso solo) è un'osservazione
const MAX_LESSONS = 300, MAX_EVIDENCE = 8;
const SLOW_MS = 5 * 60000;         // un comando che ci mette più di così è "lento"
const KINDS = ['flaky-command', 'fragile-file', 'known-fix', 'loop-trap', 'stale-trap', 'ghost-path', 'slow-step'];

// chiave del progetto: la cartella normalizzata (minuscole dove i percorsi non distinguono le maiuscole)
function normDir(cwd) {
  let d = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || /^[a-z]:\//i.test(d)) d = d.toLowerCase();
  return d;
}
// il nome da mostrare: l'ultima cartella con le sue maiuscole (la chiave invece è minuscola su Windows)
const dirName = cwd => String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
function projectKey(cwd) { return crypto.createHash('sha1').update(normDir(cwd)).digest('hex').slice(0, 16); }
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
// un comando come "firma" leggibile: spazi compattati, niente percorsi assoluti
const cmdOf = sig => String(sig || '').replace(/^run:/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
// il cuore di un comando, per riconoscerlo quando torna: senza "cd …", variabili d'ambiente,
// redirezioni e pipe ("cd app && CI=1 npm test 2>&1 | tail -20" è "npm test")
function cmdCore(cmd) {
  const parts = String(cmd || '').replace(/^run:/, '').split(/&&|\|\||;|\n/).map(x => x.trim()).filter(Boolean);
  const seg = parts.find(x => !/^(cd|pushd|popd|set|export|source|\.)\b/.test(x)) || parts[0] || '';
  return seg.split('|')[0].replace(/\d*>&\d|\d*>>?\s*\S+|<\s*\S+/g, ' ').split(/\s+/)
    .filter(w => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !/^(sudo|time|nohup|exec)$/.test(w)).join(' ');
}
const sameCmd = (lesson, cur) => { const a = cmdCore(lesson), b = cmdCore(cur); return !!a && (a === b || b.startsWith(a + ' ')); };
// uno schema d'errore: senza numeri di riga, colonne, numeri e contenuti tra virgolette
function errorPattern(excerpt) {
  return String(excerpt || '').replace(/(?:[A-Za-z]:)?[\w.~\-]*[\\/][^\s:'"()]+/g, '<path>').replace(/(['"`]).*?\1/g, '<…>').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// ---- dagli eventi già calcolati di una sessione ai casi per il libro (nessuna nuova lettura)
// agents: [{id, name, world, mind}]; ogni caso è {kind, key, sid, t, agent, excerpt}
function digest(session, agents, now = Date.now()) {
  const out = [];
  const add = (kind, key, t, agent, excerpt) => { if (key) out.push({ kind, key: String(key).slice(0, 160), sid: session.id, t, agent, excerpt: String(excerpt || '').slice(0, 160) }); };
  const sp = surprise.surprises(agents, { now }).surprises;
  for (const s of sp) {
    if (s.reaction === 'insists') add('loop-trap', /^run:/.test(s.sig || '') ? cmdOf(s.sig) : s.target, s.t, s.agentName, s.excerpt);
    if (s.refs && s.refs.length) for (const r of s.refs.slice(0, 3)) add('fragile-file', r.file, s.t, s.agentName, s.excerpt);
    if (s.chain && s.chain.complete && s.chain.fix && s.chain.fix.cited) add('known-fix', errorPattern(s.excerpt) + ' → ' + s.chain.fix.target, s.t, s.agentName, s.excerpt);
  }
  for (const a of agents) {
    if (!a.world) continue;
    const st = a.world.steps;
    // comandi di verifica: falliscono spesso, o passano e falliscono senza modifiche in mezzo (instabili)
    const byCmd = new Map(), open = new Set(a.world.open ? a.world.open.values() : []);
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      if (s.act === 'verify' && s.err !== null) {
        const c = cmdOf(s.sig);
        if (!byCmd.has(c)) byCmd.set(c, []);
        byCmd.get(c).push(i);
      }
      if (s.act === 'edit' && s.err === false) { // modificato e subito dopo una verifica che fallisce
        const nx = st.slice(i + 1, i + 4).find(x => x.act === 'verify' && x.err !== null);
        if (nx && nx.err) add('fragile-file', s.target, nx.t, a.name, (nx.fail && nx.fail.excerpt) || cmdOf(nx.sig));
      }
      // lento: finito dopo più di 5 minuti, oppure ancora appeso da più di 5 minuti
      const dur = s.err === null ? (open.has(s) ? now - s.t : 0) : (s.dur || 0);
      if (dur > SLOW_MS && /^(run|verify|look)$/.test(s.act)) add('slow-step', cmdOf(s.sig), s.t, a.name, tr('{min} min', { min: Math.round(dur / 60000) }));
    }
    for (const [c, idx] of byCmd) {
      if (!isTestCommand(c) && !/\b(tsc|lint|build|check)\b/.test(c)) continue;
      const fails = idx.filter(i => st[i].err);
      let flips = 0;
      for (let k = 1; k < idx.length; k++) {
        const p = st[idx[k - 1]], q = st[idx[k]];
        if (p.err !== q.err && !st.slice(idx[k - 1] + 1, idx[k]).some(x => x.act === 'edit')) flips++;
      }
      if (flips || fails.length >= 3) for (const i of fails.slice(-3)) add('flaky-command', c, st[i].t, a.name, (st[i].fail && st[i].fail.excerpt) || '');
    }
    // percorsi inventati (dagli errori e dall'output: quelli delle risposte richiedono il disco)
    for (const [key, nd] of a.world.nodes) if (nd.ghost) add('ghost-path', key, nd.ghostAt, a.name, nd.ghostLine);
  }
  const g = grounding.checkStale(session, agents, session.cwd, { disk: false });
  for (const x of g.stale) add('stale-trap', x.key, x.changedAt || x.readAt, x.agentName, x.changedBy ? tr('cambiato da {who}', { who: x.changedBy }) : '');
  for (const x of g.blindEdits) add('stale-trap', x.key, x.t, x.agentName, x.caught ? tr('modifica fermata da Claude Code') : tr('modifica alla cieca'));
  return out;
}

const { mergeLesson } = require('./store/legacy');

// ---- il libro di un progetto
// Dalla 2.13 i Libri stanno nello storico (src/core/store): le lezioni nella collezione `lessons`, una per documento,
// e quello che riguarda il Libro intero (lezioni dimenticate, sessioni d'archivio già lette, "non parlare agli agenti")
// nel documento del progetto in `projects`. La chiave è quella del progetto (il repository, o la cartella): due
// cartelle dello stesso repository hanno un Libro solo.
// Lo storico non tiene percorsi assoluti: la cartella di un progetto la dà chi crea il Libro, con cwdOf(chiave)
// (il motore la cerca tra le sessioni aperte e nell'archivio di Claude Code).
// Senza store il Libro resta in memoria (la demo, le prove).
class Bottega {
  constructor({ store = null, keys = null, cwdOf = () => '', log = msg => console.error('[platypus] ' + msg) } = {}) {
    this.store = store;
    this.keys = keys;
    this.cwdOf = cwdOf;
    this.log = log;
    this.books = new Map(); // chiave -> {key, name, cwd, lessons: {id: lesson}, learned: {}, forgotten: {id: t}, mute, strays, dirty}
    this.timer = setInterval(() => this.save(), 30000);
    this.timer.unref && this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.save(); }

  // la chiave del progetto di una cartella: quella dello storico se c'è, altrimenti quella della cartella
  keyOf(cwd) { return this.keys ? this.keys.keyNow(cwd) : projectKey(cwd); }

  book(cwd) {
    const pk = projectKey(cwd);
    const own = this.books.get(pk);
    if (own && own.demo) return own; // il Libro finto della demo: mai nello storico, nemmeno per chiedere la chiave
    const key = this.keyOf(cwd);
    let b = this.books.get(key);
    if (!b) {
      b = this.loadBook(key, cwd);
      // aperto con la chiave della cartella prima che git rispondesse: quello che aveva imparato passa al progetto
      if (own && key !== pk) { this.books.delete(pk); this.absorb(b, own); }
      this.books.set(key, b);
    }
    // il nome da mostrare è quello dell'ultima cartella, con le sue maiuscole
    if (cwd) { b.cwd = String(cwd); const n = dirName(cwd); if (n && b.name !== n) { b.name = n; b.dirty = true; } }
    return b;
  }

  // un Libro vuoto, con quello che lo storico sa del progetto (anche sotto i suoi alias)
  loadBook(key, cwd) {
    const b = { key, name: dirName(cwd) || String(cwd || ''), cwd: String(cwd || ''), lessons: {}, learned: {}, forgotten: {}, mute: false, strays: new Set(), dirty: false };
    if (!this.store) return b;
    try {
      const projects = this.store.collection('projects');
      const all = this.keys ? this.keys.allKeys(key) : [key];
      for (const k of all) {
        const p = projects.get(k);
        if (!p) continue;
        if (k === key && p.name) b.name = p.name; // il nome salvato; book() lo corregge con quello della cartella
        for (const [id, t] of Object.entries(p.forgotten || {})) b.forgotten[id] = Math.max(b.forgotten[id] || 0, t);
        for (const [id, t] of Object.entries(p.learned || {})) b.learned[id] = Math.max(b.learned[id] || 0, t);
        if (p.mute) b.mute = true;
        if (k !== key && (p.forgotten || p.learned || p.mute)) b.strays.add(k);
      }
      for (const d of this.store.collection('lessons').find({ project: { $in: all } })) {
        const l = { id: d.lesson, kind: d.kind, key: d.key, count: d.count || 0, sessions: d.sessions || [], first: d.first || d.t, last: d.last || d.t, evidence: d.evidence || [], seen: d.seen || [], pinned: !!d.pinned, ignored: !!d.ignored };
        if (!l.id || !l.kind || !l.key) continue;
        if (d.project !== key) b.strays.add(d.project);
        b.lessons[l.id] = b.lessons[l.id] ? { ...mergeLesson(b.lessons[l.id], l), id: l.id } : l;
      }
      if (b.strays.size) b.dirty = true; // al prossimo salvataggio passa tutto sotto la chiave del progetto
    } catch (e) { this.log('Libro: non riesco a leggere lo storico (' + (e && e.message || e) + ')'); }
    return b;
  }

  // unisce a b un Libro aperto prima con un'altra chiave dello stesso progetto
  absorb(b, other) {
    for (const [id, l] of Object.entries(other.lessons)) b.lessons[id] = b.lessons[id] ? { ...mergeLesson(b.lessons[id], l), id } : l;
    for (const [id, t] of Object.entries(other.forgotten || {})) b.forgotten[id] = Math.max(b.forgotten[id] || 0, t);
    for (const [id, t] of Object.entries(other.learned || {})) b.learned[id] = Math.max(b.learned[id] || 0, t);
    if (other.mute) b.mute = true;
    if (other.job && !b.job) b.job = other.job;
    b.strays.add(other.key);
    for (const k of other.strays || []) b.strays.add(k);
    b.strays.delete(b.key);
    b.dirty = true;
  }

  // le lezioni che la conservazione ha tolto dallo storico ([{ project, id }]) escono anche dai Libri in memoria,
  // altrimenti il prossimo salvataggio le riscriverebbe
  dropLessons(list) {
    let n = 0;
    for (const { project, id } of list || []) {
      const b = this.books.get(project);
      if (b && !b.demo && b.lessons[id]) { delete b.lessons[id]; n++; }
    }
    return n;
  }

  // scrive nello storico i Libri cambiati, uno per transazione. Se non ci riesce resta "da salvare" e riprova
  save() {
    if (!this.store) return;
    for (const b of this.books.values()) {
      if (!b.dirty || b.demo) continue;
      try { this.store.transaction(() => this.saveBook(b)); b.dirty = false; }
      catch (e) { this.log('Libro: non riesco a salvare ' + b.key + ' (' + (e && e.message || e) + ')'); }
    }
  }
  saveBook(b) {
    const projects = this.store.collection('projects'), lessons = this.store.collection('lessons'), now = Date.now();
    // quello che stava sotto un alias (la chiave della cartella) passa sotto la chiave del progetto
    for (const k of b.strays) {
      if (k === b.key) continue;
      lessons.deleteMany({ project: k });
      const q = projects.get(k);
      if (q && !q.remote && !Object.keys(q.aliases || {}).length) projects.delete(k);
    }
    const cur = projects.get(b.key) || {};
    projects.put({
      ...cur, _id: b.key, name: b.name || cur.name || '', aliases: cur.aliases || {}, firstSeen: cur.firstSeen || now, lastSeen: now,
      forgotten: b.forgotten || {}, learned: b.learned || {}, mute: !!b.mute,
    });
    const keep = new Set();
    for (const l of Object.values(b.lessons)) {
      const _id = `${b.key}:${l.id}`;
      keep.add(_id);
      lessons.put({
        _id, project: b.key, t: l.last, lesson: l.id, kind: l.kind, key: l.key, count: l.count, sessions: l.sessions, first: l.first, last: l.last,
        evidence: l.evidence, seen: l.seen, pinned: !!l.pinned, ignored: !!l.ignored,
      });
    }
    for (const d of lessons.find({ project: b.key }, { fields: [] })) if (!keep.has(d._id)) lessons.delete(d._id);
    b.strays.clear();
  }

  // il libro finto della demo: solo in memoria, mai sul disco
  seedDemo(cwd, cases) {
    // creato qui, con la chiave della cartella: book() lo ritrova senza chiedere niente allo storico né a git
    const b = { key: projectKey(cwd), name: dirName(cwd) || String(cwd || ''), cwd: String(cwd || ''), lessons: {}, learned: {}, forgotten: {}, mute: false, strays: new Set(), dirty: false, demo: true };
    this.books.set(b.key, b);
    this.learn(cwd, cases);
    b.dirty = false;
  }
  dropDemo() { for (const [k, b] of this.books) if (b.demo) this.books.delete(k); }

  // aggiunge i casi al libro; lo stesso caso (sessione, momento, agente, tipo, chiave) non conta due volte,
  // e i casi di una lezione dimenticata non la riportano indietro (solo quelli successivi a "Dimentica")
  learn(cwd, cases) {
    const b = this.book(cwd);
    const forgotten = b.forgotten || {};
    let added = 0;
    for (const c of cases) {
      if (!KINDS.includes(c.kind) || !c.key) continue;
      const id = sha(c.kind + '|' + c.key);
      if (forgotten[id] && !(c.t > forgotten[id])) continue;
      let l = b.lessons[id];
      if (!l) l = b.lessons[id] = { id, kind: c.kind, key: c.key, count: 0, sessions: [], first: c.t, last: c.t, evidence: [], seen: [], pinned: false, ignored: false };
      const ev = c.sid + '|' + c.t + '|' + c.agent;
      if (l.seen.includes(ev)) continue;
      l.seen.push(ev); if (l.seen.length > 200) l.seen.shift();
      l.count++;
      if (!l.sessions.includes(c.sid)) l.sessions.push(c.sid);
      if (l.sessions.length > 50) l.sessions.shift();
      l.first = Math.min(l.first, c.t); l.last = Math.max(l.last, c.t);
      l.evidence.push({ sid: c.sid, t: c.t, agent: c.agent, excerpt: c.excerpt });
      l.evidence.sort((x, y) => y.t - x.t);
      l.evidence.length = Math.min(l.evidence.length, MAX_EVIDENCE);
      added++;
    }
    if (added) { b.dirty = true; this.trim(b); }
    return added;
  }

  trim(b) {
    const ids = Object.keys(b.lessons);
    if (ids.length <= MAX_LESSONS) return;
    const now = Date.now();
    ids.filter(id => !b.lessons[id].pinned).sort((x, y) => weightOf(b.lessons[x], now) - weightOf(b.lessons[y], now))
      .slice(0, ids.length - MAX_LESSONS).forEach(id => delete b.lessons[id]);
  }

  act(cwd, action, id) {
    const b = this.book(cwd), l = b.lessons[id];
    if (!l) return false;
    if (action === 'pin') { l.pinned = !l.pinned; l.ignored = false; }
    else if (action === 'ignore') { l.ignored = true; l.pinned = false; }
    else if (action === 'unignore') l.ignored = false;
    else if (action === 'forget') {
      delete b.lessons[id];
      // ricorda il momento: i casi già visti (rilette ogni minuto dalla sessione aperta) non la ricreano
      b.forgotten = b.forgotten || {};
      b.forgotten[id] = Math.max(Date.now(), l.last || 0);
      const ids = Object.keys(b.forgotten);
      if (ids.length > 500) ids.sort((x, y) => b.forgotten[x] - b.forgotten[y]).slice(0, ids.length - 500).forEach(x => delete b.forgotten[x]);
    }
    else return false;
    b.dirty = true;
    return true;
  }

  // "non parlare agli agenti di questo progetto": il feedback (feedback.js) lo rispetta prima di ogni altra cosa
  setMute(cwd, on) { const b = this.book(cwd); b.mute = !!on; b.dirty = true; return b.mute; }
  muted(cwd) { try { return !!this.book(cwd).mute; } catch { return false; } }

  // le lezioni pronte da mostrare: peso, livello e testi nella lingua di adesso
  view(cwd, now = Date.now()) {
    const b = this.book(cwd);
    const lessons = Object.values(b.lessons).map(l => {
      const weight = weightOf(l, now);
      const { seen, ...rest } = l;
      return { ...rest, weight: Math.round(weight * 100) / 100, level: l.pinned || (l.count > 1 && weight >= LESSON_WEIGHT) ? 'lesson' : 'observation', ...describe(l) };
    }).sort((x, y) => (y.pinned - x.pinned) || (y.weight - x.weight));
    const job = b.job ? { running: b.job.running, total: b.job.total, done: b.job.done, cases: b.job.cases, error: b.job.error } : null;
    return { key: b.key, name: b.name, cwd: b.cwd, mute: !!b.mute, learnedSessions: Object.keys(b.learned || {}).length, learning: job, lessons };
  }

  // i progetti che hanno un libro (nello storico o già in memoria), per la scheda BOTTEGA dell'atrio. Solo quelli di
  // cui si conosce la cartella: senza, il Libro non si può aprire
  list(now = Date.now()) {
    const groups = new Map(); // chiave -> { name, cwd, lessons }
    if (this.store) {
      try {
        for (const d of this.store.collection('lessons').find({}, { fields: ['project', 'count', 'sessions', 'last', 'pinned', 'ignored'] })) {
          const g = groups.get(d.project) || { name: '', cwd: '', lessons: [] };
          g.lessons.push({ count: d.count || 0, sessions: d.sessions || [], last: d.last || 0, pinned: !!d.pinned, ignored: !!d.ignored });
          groups.set(d.project, g);
        }
        for (const [key, g] of groups) { const p = this.store.collection('projects').get(key); if (p) g.name = p.name || ''; }
      } catch (e) { this.log('Libro: non riesco a leggere lo storico (' + (e && e.message || e) + ')'); }
    }
    // quello che è in memoria è più fresco (anche i Libri non ancora salvati e quello della demo)
    for (const [key, b] of this.books) groups.set(key, { name: b.name, cwd: b.cwd, lessons: Object.values(b.lessons) });
    const out = [];
    for (const [key, g] of groups) {
      if (!g.lessons.length) continue;
      const cwd = g.cwd || this.cwdOf(key) || '';
      if (!cwd) continue;
      const strong = g.lessons.filter(l => !l.ignored && (l.pinned || (l.count > 1 && weightOf(l, now) >= LESSON_WEIGHT))).length;
      out.push({ key, name: g.name || dirName(cwd), cwd, lessons: g.lessons.length, strong, last: Math.max(...g.lessons.map(l => l.last || 0)) });
    }
    return out.sort((x, y) => y.last - x.last);
  }
  cwdOfKey(key) { const b = this.books.get(key); return (b && b.cwd) || this.cwdOf(key) || ''; }

  // rilegge le sessioni passate del progetto (non quelle aperte, né quelle già lette e non cambiate)
  // con un OfficeState senza interfaccia, a blocchi, senza mai bloccare il server
  learnFromArchive(cwd, { base, settings, liveIds = new Set(), chunk = 1500 } = {}) {
    const b = this.book(cwd);
    if (b.job && b.job.running) return b.job;
    const { listArchive, findSessionFile, loadEvents, applyEvent } = require('./archive');
    const { OfficeState, displayName } = require('./state');
    const todo = listArchive({ base, limit: 400, liveIds }).filter(x => x.cwd && this.keyOf(x.cwd) === b.key && !x.live && (b.learned || {})[x.id] !== x.end);
    const job = b.job = { running: true, total: todo.length, done: 0, cases: 0, error: '' };
    const finish1 = (info, st) => { if (st) try { st.stop(); } catch {} if (info) { const nb = this.book(cwd); nb.learned = nb.learned || {}; nb.learned[info.id] = info.end; nb.dirty = true; } job.done++; setImmediate(next); };
    const next = () => {
      const info = todo.shift();
      if (!info) { job.running = false; return; }
      let st = null;
      try {
        const file = findSessionFile(base, info.key);
        const { id, events } = loadEvents(file);
        let vt = events.length ? events[0].ts : 0, i = 0;
        st = new OfficeState({ manual: true, noTimeout: true, clock: () => vt, settings });
        const feed = () => {
          try {
            for (const end = Math.min(events.length, i + chunk); i < end; i++) {
              const e = events[i];
              vt = e.ts;
              applyEvent(st, id, e);
            }
            if (i < events.length) return setImmediate(feed);
            const s = st.sessions.get(id);
            if (s) {
              const agents = [s.main, ...s.subs.values()].filter(a => a.world).map(a => ({ id: a.id, name: displayName(a), world: a.world, mind: a.mind }));
              // "adesso" è la fine della sessione: una sorpresa all'ultimo passo non resta "in corso"
              job.cases += this.learn(cwd, digest(s, agents, vt + 120000));
            }
            finish1(info, st);
          } catch (e) { job.error = String(e && e.message || e); finish1(null, st); }
        };
        feed();
      } catch (e) { job.error = String(e && e.message || e); finish1(null, st); }
    };
    setImmediate(next);
    return job;
  }
}

// ---- il Nonno: quando l'azione in corso di un agente corrisponde a una lezione forte, ha qualcosa da dire
const RECENT_MS = 30000;
function hints(session, agents, lessons, now = Date.now()) {
  const strong = lessons.filter(l => l.level === 'lesson' && !l.ignored);
  if (!strong.length) return [];
  const out = [];
  for (const a of agents) {
    if (!a.world) continue;
    const st = a.world.steps, cur = st[st.length - 1];
    if (!cur || (cur.err !== null && now - cur.t - (cur.dur || 0) > RECENT_MS)) continue; // in corso, o appena finita
    const cmd = /^(run|verify|look)$/.test(cur.act) ? cmdOf(cur.sig) : null;
    const match = l => {
      if (cmd && (l.kind === 'flaky-command' || l.kind === 'slow-step' || l.kind === 'loop-trap')) return sameCmd(l.key, cmd);
      if (cur.act === 'edit' && (l.kind === 'fragile-file' || l.kind === 'stale-trap')) return l.key === cur.target;
      if ((cur.act === 'read' || cur.act === 'search') && l.kind === 'ghost-path') return l.key === cur.target;
      if (l.kind === 'known-fix' && cur.err && cur.fail) return l.key.split(' → ')[0] === errorPattern(cur.fail.excerpt);
      return false;
    };
    const l = strong.filter(match).sort((x, y) => y.weight - x.weight)[0];
    if (l) out.push({ agent: a.id, agentName: a.name, lessonId: l.id, kind: l.kind, weight: l.weight, text: elderLine(l) });
  }
  return out;
}
// come lo direbbe il Nonno: breve, con le date in cui è successo
function elderLine(l) {
  const { localeTag } = require('../i18n');
  const days = [...new Set(l.evidence.slice().sort((x, y) => x.t - y.t).map(e => new Date(e.t).toLocaleDateString(localeTag(), { day: 'numeric', month: 'long' })))].slice(-2);
  const when = days.join(tr(' e '));
  const [pat, file] = l.key.split(' → ');
  const who = (l.evidence[0] && l.evidence[0].agent) || tr('qualcuno');
  switch (l.kind) {
    case 'flaky-command': return tr('L\'ultima volta {cmd} si è piantato {n} volte ({when}): rilancialo prima di indagare.', { cmd: l.key, n: l.count, when });
    case 'slow-step': return tr('{cmd} ci mette un\'eternità ({when}): lancialo in background.', { cmd: l.key, when });
    case 'loop-trap': return tr('Con {cmd} ci si gira in tondo ({when}): cambia qualcosa prima di rilanciarlo.', { cmd: l.key, when });
    case 'fragile-file': return tr('Occhio a {file}: dopo le modifiche lì i test cadono spesso ({when}).', { file: l.key, when });
    case 'stale-trap': return tr('{file} lo toccano in tanti: rileggilo prima di cambiarlo.', { file: l.key });
    case 'ghost-path': return tr('{file} non c\'è: l\'avete già cercato ({when}), forse ha cambiato nome.', { file: l.key, when });
    case 'known-fix': return tr('Quell\'errore l\'ha già sistemato {who} in {file} ({when}).', { who, file, when, pat });
    default: return l.key;
  }
}

// ---- la sezione per il CLAUDE.md del progetto: le lezioni fissate e le più forti, brevi e operative
const MAX_CLAUDEMD = 8;
// le lezioni da passare a un agente (fissate e forti, le più pesanti prima), una riga breve e operativa ciascuna:
// le stesse nel CLAUDE.md e nel messaggio di inizio sessione
function lessonLines(lessons, max = MAX_CLAUDEMD) {
  const pick = lessons.filter(l => !l.ignored && (l.pinned || l.level === 'lesson'))
    .sort((x, y) => (y.pinned - x.pinned) || (y.weight - x.weight)).slice(0, max);
  const line = l => {
    const [pat, file] = l.key.split(' → ');
    switch (l.kind) {
      case 'flaky-command': return tr('Il comando `{cmd}` è instabile: rilancialo una volta prima di indagare.', { cmd: l.key });
      case 'slow-step': return tr('`{cmd}` è lento: lancialo in background o con un limite di tempo.', { cmd: l.key });
      case 'loop-trap': return tr('Con `{cmd}` si gira in tondo: se fallisce, cambia qualcosa prima di rilanciarlo.', { cmd: l.key });
      case 'fragile-file': return tr('`{file}` è fragile: dopo averlo modificato lancia i test.', { file: l.key });
      case 'stale-trap': return tr('`{file}` lo modificano più agenti insieme: rileggilo prima di cambiarlo.', { file: l.key });
      case 'ghost-path': return tr('`{file}` non esiste (forse è stato spostato o rinominato): non cercarlo.', { file: l.key });
      case 'known-fix': return tr('L\'errore «{pat}» di solito si sistema in `{file}`.', { pat, file });
      default: return l.title || l.key;
    }
  };
  return pick.map(line);
}
function renderSection(lessons, name) {
  const lines = lessonLines(lessons);
  if (!lines.length) return '';
  return [
    '## ' + tr('Lezioni della bottega ({name})', { name }),
    '',
    tr('Dedotte da Platypus dalle sessioni di questo progetto: indizi, non regole certe.'),
    '',
    ...lines.map(l => '- ' + l),
  ].join('\n');
}

// peso: cresce con i casi e con le sessioni diverse, si dimezza ogni 30 giorni dall'ultimo caso
function weightOf(l, now = Date.now()) {
  const base = (1 + Math.log2(Math.max(1, l.count))) * (1 + 0.5 * (Math.max(1, l.sessions.length) - 1));
  return l.pinned ? base : base * Math.pow(0.5, Math.max(0, now - l.last) / HALF_LIFE);
}

function describe(l) {
  const n = l.count, m = l.sessions.length;
  const seen = trn('visto {n} volta', 'visto {n} volte', n) + ' · ' + trn('in {n} sessione', 'in {n} sessioni', m);
  switch (l.kind) {
    case 'flaky-command': return { title: tr('Comando instabile: {cmd}', { cmd: l.key }), detail: tr('Fallisce spesso o a intermittenza, anche senza modifiche in mezzo: rilancialo una volta prima di indagare.') + ' ' + seen };
    case 'fragile-file': return { title: tr('File fragile: {file}', { file: l.key }), detail: tr('Compare spesso negli errori, o dopo una modifica le verifiche falliscono.') + ' ' + seen };
    case 'known-fix': { const [pat, file] = l.key.split(' → '); return { title: tr('Errore già visto: si sistema in {file}', { file }), detail: tr('Lo schema «{pat}» è stato corretto più volte modificando lo stesso file.', { pat }) + ' ' + seen }; }
    case 'loop-trap': return { title: tr('Trappola: {cmd}', { cmd: l.key }), detail: tr('Gli agenti rilanciano lo stesso comando senza cambiare nulla e girano in tondo.') + ' ' + seen };
    case 'stale-trap': return { title: tr('File conteso: {file}', { file: l.key }), detail: tr('Ci lavorano più agenti insieme: diventa spesso un ricordo scaduto. Rileggerlo prima di modificarlo.') + ' ' + seen };
    case 'ghost-path': return { title: tr('Percorso che non esiste: {file}', { file: l.key }), detail: tr('Gli agenti lo cercano ma non c\'è: forse è stato spostato o rinominato.') + ' ' + seen };
    case 'slow-step': return { title: tr('Passo lento: {cmd}', { cmd: l.key }), detail: tr('Resta appeso a lungo: meglio lanciarlo in background o con un limite di tempo.') + ' ' + seen };
    default: return { title: l.key, detail: seen };
  }
}

module.exports = { Bottega, digest, hints, elderLine, renderSection, lessonLines, sameCmd, cmdCore, projectKey, normDir, errorPattern, weightOf, KINDS, HALF_LIFE, LESSON_WEIGHT };
