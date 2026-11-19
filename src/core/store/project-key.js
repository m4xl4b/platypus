'use strict';
// La chiave di un progetto (S5 di docs/plans/2.13-storage.md).
// Fino alla 2.12 era la cartella: sha1 del percorso. Dalla 3.0 lo stesso repository su più computer deve avere
// un Libro solo, quindi la chiave diventa il repository:
//   - se la cartella ha un remote `origin` in rete: sha1 del suo indirizzo normalizzato (normalizeRemote);
//   - altrimenti, come prima: sha1 della cartella (stessa funzione che usava bottega.js, quindi stessa chiave).
// In tutti e due i casi 16 caratteri esadecimali, come le chiavi che ci sono già.
// Le vecchie chiavi restano riconosciute: la collezione `projects` tiene, per ogni progetto, gli alias (le chiavi
// delle cartelle da cui lo si è visto).
//
// Cosa finisce nello store, e cosa no: l'indirizzo del remote SENZA credenziali (host/percorso), il nome
// dell'ultima cartella, le chiavi (che sono impronte). Mai utente, password o token dell'indirizzo, mai il
// percorso assoluto della cartella.
//
// git si legge una volta per cartella, in un processo a parte (mai nel percorso degli eventi): keyNow() risponde
// subito con quello che si sa già, resolve() dà la risposta definitiva.

const crypto = require('crypto');
const { execFile } = require('child_process');

const sha16 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// la cartella normalizzata (minuscole dove i percorsi non distinguono le maiuscole): come in bottega.js
function normDir(cwd) {
  let d = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || /^[a-z]:\//i.test(d)) d = d.toLowerCase();
  return d;
}
const dirName = cwd => String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
// la chiave di una cartella: quella di sempre
function pathKey(cwd) { return sha16(normDir(cwd)); }

// L'indirizzo di un remote → "host/percorso": host in minuscolo, senza schema, credenziali, porta, ".git",
// barre in fondo, query. ssh e https dello stesso repository danno lo stesso risultato.
// null se non è un indirizzo di rete (una cartella, file://, vuoto): quello non identifica il repository altrove.
function normalizeRemote(url) {
  let s = String(url || '').trim();
  if (!s || /[\r\n\0]/.test(s)) return null;
  let host, p;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    if (/^file$/i.test(scheme[1])) return null;
    let u;
    try { u = new URL(s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, 'https://')); } catch { return null; } // https: per avere sempre lo stesso modo di leggere host e percorso
    host = u.hostname;
    p = u.pathname;
  } else {
    if (/^[a-z]:[\\/]/i.test(s) || /^[.~\\/]/.test(s)) return null; // C:\…, /…, ./…, ~/…: una cartella
    // la forma corta di ssh: [utente@]host:percorso
    const m = /^(?:[^@/\\:]*@)?(\[[0-9a-f:.]+\]|[^@/\\:]+):(?!\/\/)(.+)$/i.exec(s);
    if (!m || m[1].length < 2) return null; // una lettera sola è un disco di Windows
    host = m[1];
    p = m[2].replace(/[?#].*$/, '');
  }
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  p = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !p || /[@\s]/.test(host)) return null;
  return `${host}/${p}`;
}

// git, in un processo a parte e senza mai chiedere niente a nessuno; null se non c'è, non risponde o non è un repository
function gitExec(cwd, args) {
  return new Promise(resolve => {
    try {
      execFile('git', ['-C', cwd, ...args], { timeout: 3000, windowsHide: true, maxBuffer: 65536, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, out) => resolve(err ? null : String(out || '').split(/\r?\n/)[0].trim() || null));
    } catch { resolve(null); }
  });
}

// la chiave di una cartella dato il suo remote (già letto): { key, remote, aliases }
function keyFor(cwd, remoteUrl) {
  const remote = normalizeRemote(remoteUrl), alias = pathKey(cwd);
  return remote ? { key: sha16(remote), remote, aliases: [alias] } : { key: alias, remote: null, aliases: [] };
}

class ProjectKeys {
  // store: facoltativo, con la collezione `projects` dichiarata (projectField: '_id'); exec e clock per le prove
  constructor({ store = null, exec = gitExec, clock = Date.now } = {}) {
    this.store = store;
    this.exec = exec;
    this.clock = clock;
    this.byDir = new Map();   // cartella normalizzata → { key, remote, name, aliases } quando si sa
    this.pending = new Map(); // cartella normalizzata → Promise, mentre git risponde
    this.canon = new Map();   // alias → chiave
  }

  // Subito, senza aspettare git: la chiave definitiva se si sa già, altrimenti quella della cartella (che ne
  // resterà un alias) mentre parte la lettura. Per il percorso degli eventi.
  keyNow(cwd) {
    const known = this.byDir.get(normDir(cwd));
    if (known) return known.key;
    this.resolve(cwd).catch(() => {});
    return this.canonical(pathKey(cwd));
  }

  // La risposta definitiva: { key, remote, name, aliases }. git si legge una volta sola per cartella.
  resolve(cwd) {
    const dir = normDir(cwd);
    const known = this.byDir.get(dir);
    if (known) return Promise.resolve(known);
    let p = this.pending.get(dir);
    if (!p) {
      p = this.read(cwd).then(info => { this.byDir.set(dir, info); this.pending.delete(dir); return info; }, e => { this.pending.delete(dir); throw e; });
      this.pending.set(dir, p);
    }
    return p;
  }

  async read(cwd) {
    let url = null;
    try { url = await this.exec(String(cwd), ['remote', 'get-url', 'origin']); } catch {}
    const k = keyFor(cwd, url);
    const info = { key: k.key, remote: k.remote, name: dirName(cwd), aliases: k.aliases };
    for (const a of info.aliases) this.canon.set(a, info.key);
    try { this.remember(info); } catch {} // lo storico può mancare: la chiave vale lo stesso
    return info;
  }

  // scrive (o aggiorna) il progetto nello store: mai credenziali, mai il percorso
  remember(info) {
    if (!this.store) return;
    const projects = this.store.collection('projects'), now = this.clock();
    const cur = projects.get(info.key);
    const aliases = { ...(cur && cur.aliases) };
    for (const a of info.aliases) if (!aliases[a]) aliases[a] = now;
    // gli altri campi del progetto (quelli del Libro: lezioni dimenticate, sessioni già lette, mute) restano com'erano
    const doc = { ...(cur || {}), _id: info.key, name: info.name || (cur && cur.name) || '', aliases, firstSeen: (cur && cur.firstSeen) || now, lastSeen: now };
    const remote = info.remote || (cur && cur.remote);
    if (remote) doc.remote = remote;
    projects.put(doc);
  }

  // da una vecchia chiave (quella della cartella) alla chiave del progetto; se non la conosce, resta lei
  canonical(key) {
    const hit = this.canon.get(key);
    if (hit) return hit;
    if (this.store && /^[0-9a-f]{16}$/.test(String(key))) {
      try {
        const found = this.store.collection('projects').find({ [`aliases.${key}`]: { $exists: true } }, { limit: 1, fields: [] });
        if (found.length) { this.canon.set(key, found[0]._id); return found[0]._id; }
      } catch {}
    }
    return key;
  }
  // tutte le chiavi con cui un progetto è stato salvato: la sua e gli alias (per "dimentica questo progetto", S10)
  allKeys(key) {
    const k = this.canonical(key), out = new Set([k]);
    for (const [a, c] of this.canon) if (c === k) out.add(a);
    if (this.store) { try { const doc = this.store.collection('projects').get(k); for (const a of Object.keys((doc && doc.aliases) || {})) out.add(a); } catch {} }
    return [...out];
  }
}

module.exports = { ProjectKeys, normalizeRemote, keyFor, pathKey, normDir, dirName, gitExec };
