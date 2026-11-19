'use strict';
// Le regole comuni a tutti i backend dello store: errori, identificativi, forma dei documenti, linguaggio dei
// filtri, ordinamento. Ogni backend (memory qui, sqlite in S3, MongoDB nella 3.0) le applica allo stesso modo:
// lo controlla scripts/store-conformance.js.
//
// DOCUMENTI
//   - oggetti JSON: stringhe, numeri finiti, booleani, null, array e oggetti semplici. Niente Date, NaN,
//     funzioni: si rifiutano, non si convertono di nascosto. Un campo undefined non viene salvato, come in JSON;
//   - `_id` è una stringa non vuota; se manca la mette lo store (ULID: ordinabile per tempo);
//   - i tempi sono numeri, in millisecondi; `t` (quando) e `project` (di chi), se ci sono, sono un numero e una stringa;
//   - nessun nome di campo con "." o "$", a nessun livello: su MongoDB sono operatori e percorsi.
//
// FILTRI: un sottoinsieme di quelli di MongoDB, e niente altro
//   { campo: valore }                    uguaglianza con uno scalare (stringa, numero, booleano, null)
//   { campo: { $in: [v1, v2] } }         uno dei valori (scalari)
//   { campo: { $gt | $gte | $lt | $lte: v } }   confronto con un numero o una stringa; più operatori insieme = E
//   { campo: { $exists: true | false } } il campo c'è / non c'è
//   { $or: [ filtro, filtro ] }          almeno uno; le chiavi accanto restano in E
//   "a.b.c" come nome di campo           percorso dentro gli oggetti
//   Più chiavi nello stesso filtro sono in E. Un operatore che non è in questo elenco ($ne, $and, $regex, …)
//   è un errore (StoreError 'unsupported-filter'): mai ignorato in silenzio.
//   Come in MongoDB: { campo: null } trova sia il campo a null sia il campo che manca; i confronti valgono solo
//   tra valori dello stesso tipo (un numero non è mai "maggiore" di una stringa); true non è 1.
//   Diverso da MongoDB, quindi da non usare: filtrare su un campo che contiene un array o un oggetto (qui non
//   corrisponde mai; MongoDB guarderebbe dentro l'array).
//
// ORDINAMENTO: { campo: 1 | -1, … } nell'ordine delle chiavi; a parità, `_id` crescente.
//   Tra tipi: mancante o null, poi i numeri, poi le stringhe (per punti di codice). Non si ordina su booleani,
//   array e oggetti: i backend non sarebbero d'accordo.

const crypto = require('crypto');

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new StoreError(code, message); };

// ---------------------------------------------------------------- ULID
// 48 bit di tempo + 80 casuali, in base 32 di Crockford: 26 caratteri che in ordine alfabetico sono in ordine di tempo.
// Nello stesso millisecondo la parte casuale cresce di uno, così l'ordine resta quello di creazione.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1, lastRand = null;
function ulid(now) {
  let t = Math.floor(typeof now === 'number' ? now : Date.now());
  if (!(t >= 0) || t > 0xFFFFFFFFFFFF) fail('invalid-argument', `tempo non valido per un identificativo: ${now}`);
  if (t <= lastTime && lastRand) {
    t = lastTime;
    let i = 15;
    while (i >= 0 && lastRand[i] === 31) lastRand[i--] = 0;
    if (i < 0) { lastTime = t = t + 1; lastRand = null; } else lastRand[i]++;
  }
  if (t > lastTime || !lastRand) {
    lastTime = t;
    const bytes = crypto.randomBytes(16);
    lastRand = Array.from(bytes, b => b & 31);
    lastRand[0] &= 15; // un bit libero in cima: l'incremento non trabocca quasi mai
  }
  let head = '';
  for (let k = 0, n = t; k < 10; k++) { head = B32[n % 32] + head; n = Math.floor(n / 32); }
  return head + lastRand.map(d => B32[d]).join('');
}
// il tempo scritto in un ULID, in millisecondi (NaN se non è un ULID)
function ulidTime(id) {
  if (typeof id !== 'string' || id.length !== 26) return NaN;
  let n = 0;
  for (const c of id.slice(0, 10)) { const d = B32.indexOf(c); if (d < 0) return NaN; n = n * 32 + d; }
  return n;
}

// ---------------------------------------------------------------- nomi e documenti
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) fail('invalid-argument', `nome di collezione non valido: ${JSON.stringify(name)} (minuscole, cifre e "_", al massimo 40 caratteri)`);
  return name;
}
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// copia profonda che controlla la forma: quello che entra nello store e quello che ne esce non è mai l'oggetto di chi chiama
function cleanValue(v, where) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail('invalid-document', `${where}: numero non valido (${v})`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => cleanValue(x, `${where}[${i}]`));
  if (isPlain(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue; // come in JSON: un campo undefined non c'è
      if (k === '' || k.includes('.') || k.includes('$')) fail('invalid-document', `${where}: nome di campo non permesso ${JSON.stringify(k)} (niente "." né "$")`);
      out[k] = cleanValue(v[k], where ? `${where}.${k}` : k);
    }
    return out;
  }
  fail('invalid-document', `${where}: valore non permesso (${v === undefined ? 'undefined' : Object.prototype.toString.call(v)}); i tempi sono numeri in millisecondi`);
}
function checkId(id) {
  if (typeof id !== 'string' || !id) fail('invalid-document', `_id deve essere una stringa non vuota (ricevuto ${JSON.stringify(id)})`);
  return id;
}
// un documento pronto da salvare: copiato, controllato, con il suo _id
function cleanDoc(doc, now) {
  if (!isPlain(doc)) fail('invalid-document', 'il documento deve essere un oggetto');
  const out = cleanValue(doc, '');
  if (out._id === undefined) out._id = ulid(now); else checkId(out._id);
  if (out.t !== undefined && typeof out.t !== 'number') fail('invalid-document', '`t` deve essere un numero (millisecondi)');
  if (out.project !== undefined && typeof out.project !== 'string') fail('invalid-document', '`project` deve essere una stringa');
  return out;
}
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------- percorsi
function checkPath(p, what) {
  if (typeof p !== 'string' || !p || p.includes('$') || p.split('.').some(s => !s)) fail(what === 'filter' ? 'unsupported-filter' : 'invalid-argument', `nome di campo non valido: ${JSON.stringify(p)}`);
  return p;
}
// il valore al percorso "a.b.c": undefined se manca o se per strada non c'è un oggetto
function getPath(doc, p) {
  let v = doc;
  for (const k of p.split('.')) {
    if (!isPlain(v) || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

// ---------------------------------------------------------------- filtri
const isScalar = v => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const CMP = { $gt: 'gt', $gte: 'gte', $lt: 'lt', $lte: 'lte' };
const bad = msg => fail('unsupported-filter', msg);

// Il filtro diventa un albero semplice, uguale per tutti i backend:
//   { and: [nodo…] } · { or: [nodo…] } · { op: 'eq'|'in'|'gt'|'gte'|'lt'|'lte'|'exists', path, value }
// memory lo valuta (matches), sqlite lo traduce in SQL con parametri.
function parseFilter(filter) {
  if (filter === undefined || filter === null) return { and: [] };
  if (!isPlain(filter)) bad('il filtro deve essere un oggetto');
  const and = [];
  for (const key of Object.keys(filter)) {
    const val = filter[key];
    if (key === '$or') {
      if (!Array.isArray(val) || !val.length) bad('$or vuole un elenco non vuoto di filtri');
      and.push({ or: val.map(parseFilter) });
      continue;
    }
    if (key.startsWith('$')) bad(`operatore non supportato: ${key}`);
    const path = checkPath(key, 'filter');
    if (isScalar(val)) { and.push({ op: 'eq', path, value: val }); continue; }
    if (!isPlain(val)) bad(`${key}: si confronta solo con stringhe, numeri, booleani o null`);
    const ops = Object.keys(val);
    if (!ops.length || !ops.every(o => o.startsWith('$'))) bad(`${key}: si confronta solo con stringhe, numeri, booleani o null (non con un oggetto)`);
    for (const o of ops) {
      const x = val[o];
      if (o === '$in') {
        if (!Array.isArray(x) || !x.every(isScalar)) bad(`${key}: $in vuole un elenco di stringhe, numeri, booleani o null`);
        and.push({ op: 'in', path, value: x.slice() });
      } else if (CMP[o]) {
        if (!(typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) bad(`${key}: ${o} vuole un numero o una stringa`);
        and.push({ op: CMP[o], path, value: x });
      } else if (o === '$exists') {
        if (typeof x !== 'boolean') bad(`${key}: $exists vuole true o false`);
        and.push({ op: 'exists', path, value: x });
      } else bad(`operatore non supportato: ${o}`);
    }
  }
  return { and };
}

// stringhe in ordine di punti di codice (come SQLite e MongoDB), non di unità UTF-16
function cmpStr(a, b) { return a === b ? 0 : Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
const eqScalar = (v, x) => (x === null ? v === null || v === undefined : v === x);

function matches(node, doc) {
  if (node.and) return node.and.every(n => matches(n, doc));
  if (node.or) return node.or.some(n => matches(n, doc));
  const v = getPath(doc, node.path), x = node.value;
  switch (node.op) {
    case 'eq': return eqScalar(v, x);
    case 'in': return x.some(y => eqScalar(v, y));
    case 'exists': return (v !== undefined) === x;
    default: {
      if (typeof v !== typeof x || (typeof v === 'number' && !Number.isFinite(v))) return false;
      const c = typeof v === 'string' ? cmpStr(v, x) : v - x;
      return node.op === 'gt' ? c > 0 : node.op === 'gte' ? c >= 0 : node.op === 'lt' ? c < 0 : c <= 0;
    }
  }
}

// ---------------------------------------------------------------- opzioni di find
function parseSort(sort) {
  if (sort === undefined || sort === null) return [];
  if (!isPlain(sort)) fail('invalid-argument', 'sort deve essere un oggetto { campo: 1 | -1 }');
  return Object.keys(sort).map(k => {
    if (sort[k] !== 1 && sort[k] !== -1) fail('invalid-argument', `sort.${k}: solo 1 (crescente) o -1 (decrescente)`);
    return { path: k === '_id' ? '_id' : checkPath(k, 'sort'), dir: sort[k] };
  });
}
// mancante o null (0) < numeri (1) < stringhe (2); il resto (3) non si dovrebbe ordinare
const rank = v => (v === undefined || v === null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
function cmpValues(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return a - b;
  if (ra === 2) return cmpStr(a, b);
  return 0;
}
function comparator(sortSpec) {
  return (a, b) => {
    for (const s of sortSpec) {
      const c = cmpValues(getPath(a, s.path), getPath(b, s.path));
      if (c) return c * s.dir;
    }
    return cmpStr(a._id, b._id);
  };
}
function parseFindOptions(opts) {
  if (opts === undefined || opts === null) opts = {};
  if (!isPlain(opts)) fail('invalid-argument', 'le opzioni di find devono essere un oggetto');
  for (const k of Object.keys(opts)) if (!['sort', 'limit', 'skip', 'fields'].includes(k)) fail('invalid-argument', `opzione di find sconosciuta: ${k}`);
  const int = (v, name) => {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v) || v < 0) fail('invalid-argument', `${name} deve essere un intero non negativo`);
    return v;
  };
  let fields;
  if (opts.fields !== undefined && opts.fields !== null) {
    if (!Array.isArray(opts.fields)) fail('invalid-argument', 'fields deve essere un elenco di nomi di campo');
    fields = opts.fields.map(f => (f === '_id' ? f : checkPath(f, 'fields')));
  }
  return { sort: parseSort(opts.sort), limit: int(opts.limit, 'limit'), skip: int(opts.skip, 'skip') || 0, fields };
}
// solo i campi chiesti (anche con percorsi), più sempre _id
function project(doc, fields) {
  if (!fields) return doc;
  const out = { _id: doc._id };
  for (const f of fields) {
    const v = getPath(doc, f);
    if (v === undefined) continue;
    const keys = f.split('.');
    let o = out;
    for (let i = 0; i < keys.length - 1; i++) { if (!isPlain(o[keys[i]])) o[keys[i]] = {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = v;
  }
  return out;
}

// ---------------------------------------------------------------- dichiarazione di una collezione
// { fields, indexes, retention, projectField }: qui si controlla la forma; i campi permessi li fa rispettare S6,
// la conservazione S10. projectField: in quale campo sta la chiave del progetto ('project'; '_id' per `projects`).
function parseDeclaration(name, spec) {
  checkName(name);
  if (spec === undefined || spec === null) spec = {};
  if (!isPlain(spec)) fail('invalid-argument', `declare(${name}): la dichiarazione deve essere un oggetto`);
  for (const k of Object.keys(spec)) if (!['fields', 'indexes', 'retention', 'projectField'].includes(k)) fail('invalid-argument', `declare(${name}): voce sconosciuta ${k}`);
  const out = { name, fields: null, indexes: [], retention: null, projectField: 'project' };
  if (spec.fields !== undefined && spec.fields !== null) {
    if (!isPlain(spec.fields)) fail('invalid-argument', `declare(${name}): fields deve essere un oggetto { campo: tipo }`);
    out.fields = {};
    for (const f of Object.keys(spec.fields)) {
      if (f.includes('.') || f.includes('$') || !f) fail('invalid-argument', `declare(${name}): nome di campo non valido ${JSON.stringify(f)}`);
      if (typeof spec.fields[f] !== 'string') fail('invalid-argument', `declare(${name}): il tipo di ${f} deve essere una stringa`);
      out.fields[f] = spec.fields[f];
    }
  }
  if (spec.indexes !== undefined && spec.indexes !== null) {
    if (!Array.isArray(spec.indexes)) fail('invalid-argument', `declare(${name}): indexes deve essere un elenco`);
    out.indexes = spec.indexes.map(ix => {
      const list = Array.isArray(ix) ? ix : [ix];
      if (!list.length) fail('invalid-argument', `declare(${name}): indice vuoto`);
      // negli indici solo nomi semplici: finiscono nel testo dell'SQL (sqlite.js)
      return list.map(p => {
        if (!checkPath(p, 'index').split('.').every(s => /^[A-Za-z0-9_ -]+$/.test(s))) fail('invalid-argument', `declare(${name}): un indice vuole nomi di campo semplici (lettere, cifre, spazi, "_" e "-"): ${JSON.stringify(p)}`);
        return p;
      });
    });
  }
  if (spec.retention !== undefined && spec.retention !== null) {
    if (!isPlain(spec.retention)) fail('invalid-argument', `declare(${name}): retention deve essere un oggetto`);
    out.retention = clone(spec.retention);
  }
  if (spec.projectField !== undefined) {
    if (spec.projectField !== 'project' && spec.projectField !== '_id') fail('invalid-argument', `declare(${name}): projectField può essere solo 'project' o '_id'`);
    out.projectField = spec.projectField;
  }
  return out;
}

module.exports = {
  StoreError, fail, ulid, ulidTime, checkName, checkId, cleanDoc, cleanValue, clone, isPlain, getPath, checkPath,
  parseFilter, matches, parseSort, parseFindOptions, comparator, cmpStr, cmpValues, project, parseDeclaration,
};
