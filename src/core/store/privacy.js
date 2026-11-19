'use strict';
// La guardia della privacy dello store (S6 di docs/plans/2.13-storage.md): nello storico entrano solo fatti
// derivati, mai testo. Non è una promessa di chi scrive il motore: lo fa rispettare lo store a ogni scrittura.
//
// 1. SOLO I CAMPI DICHIARATI. Ogni collezione dichiara i suoi campi e il loro tipo (store.declare, `fields`).
//    Un campo non dichiarato, o di un tipo diverso, non viene salvato: in sviluppo e nelle prove è un errore
//    (guard: 'reject'), altrimenti si scarta e lo si scrive una volta nel registro (guard: 'drop'), senza il valore.
//    Tipi:
//      'string'   un'etichetta: una riga sola, al massimo 300 caratteri (un testo lungo non è un'etichetta)
//      'id'       un identificativo: lettere, cifre e . _ : @ # + -, al massimo 128 caratteri
//      'number'   'boolean'
//      'path'     un percorso: sempre relativo alla radice del progetto; uno assoluto diventa impronta/nome-file
//      'excerpt'  un estratto di una riga: passa dal filtro dei segreti (scrub) e si ferma a 200 caratteri
//      { a: tipo, … }   un oggetto con quei campi          { '*': tipo }   un oggetto con chiavi qualsiasi
//      [tipo]           un elenco (al massimo 200 voci)
//    `_id`, `project` e `t` ci sono sempre. null è permesso ovunque.
// 2. PERCORSI. relPath(file, radice) li rende relativi; quelli fuori dal progetto diventano
//    "ext:<impronta>/<nome del file>": si capisce che è lo stesso file, non dov'è.
// 3. ESTRATTI. scrub() toglie token, chiavi, password, stringhe di connessione, indirizzi e-mail e IBAN.

const crypto = require('crypto');
const { fail, isPlain } = require('./common');

const TYPES = ['string', 'id', 'number', 'boolean', 'path', 'excerpt'];
const MAX_STRING = 300, MAX_EXCERPT = 200, MAX_PATH = 400, MAX_ID = 128, MAX_LIST = 200, MAX_KEY = 128;
const ID_RE = /^[A-Za-z0-9._:@#+-]+$/;

// ---------------------------------------------------------------- dichiarazione dei campi
function parseFieldSpec(spec, where) {
  if (typeof spec === 'string') {
    if (!TYPES.includes(spec)) fail('invalid-argument', `${where}: tipo sconosciuto ${JSON.stringify(spec)} (ci sono: ${TYPES.join(', ')})`);
    return spec;
  }
  if (Array.isArray(spec)) {
    if (spec.length !== 1) fail('invalid-argument', `${where}: un elenco si dichiara come [tipo]`);
    return [parseFieldSpec(spec[0], `${where}[]`)];
  }
  if (isPlain(spec)) {
    const keys = Object.keys(spec);
    if (!keys.length) fail('invalid-argument', `${where}: un oggetto deve dichiarare i suoi campi`);
    if (keys.includes('*') && keys.length > 1) fail('invalid-argument', `${where}: "*" non si mescola con altri campi`);
    const out = {};
    for (const k of keys) {
      if (!k || k.includes('.') || k.includes('$')) fail('invalid-argument', `${where}: nome di campo non valido ${JSON.stringify(k)}`);
      out[k] = parseFieldSpec(spec[k], `${where}.${k}`);
    }
    return out;
  }
  fail('invalid-argument', `${where}: il tipo deve essere un nome, un oggetto o [tipo]`);
}
function parseFields(name, fields) {
  if (!isPlain(fields)) fail('invalid-argument', `declare(${name}): fields deve essere un oggetto { campo: tipo }`);
  const out = {};
  for (const k of Object.keys(fields)) {
    if (k === '_id' || k === 'project' || k === 't') continue; // ci sono sempre, con il loro tipo
    if (k === '*') fail('invalid-argument', `declare(${name}): al primo livello i campi vanno dichiarati uno per uno`);
    if (!k || k.includes('.') || k.includes('$')) fail('invalid-argument', `declare(${name}): nome di campo non valido ${JSON.stringify(k)}`);
    out[k] = parseFieldSpec(fields[k], `declare(${name}).${k}`);
  }
  return out;
}

// ---------------------------------------------------------------- percorsi
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const slash = p => String(p).replace(/\\/g, '/');
const isAbsolute = p => /^([a-z]:)?\//i.test(p) || /^[a-z]:/i.test(p) || p.startsWith('~') || /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
const fold = p => (/^[a-z]:/i.test(p) || process.platform === 'win32' ? p.toLowerCase() : p);
// un percorso fuori dal progetto: l'impronta del percorso intero e il solo nome del file
function outside(p) {
  const clean = slash(p).replace(/\/+$/, '');
  const name = clean.split('/').pop() || '';
  return `ext:${hash(fold(clean))}/${name}`.slice(0, MAX_PATH);
}
// toglie "." e risolve "..": null se esce dalla radice
function tidy(rel) {
  const out = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
// Il percorso di un file rispetto alla radice del progetto, con le barre dritte. Fuori dal progetto: outside().
function relPath(file, root) {
  const f = slash(file || '').trim();
  if (!f) return '';
  if (f.startsWith('ext:')) return f.slice(0, MAX_PATH);
  if (!isAbsolute(f)) { const t = tidy(f); return t === null ? outside(f) : t; }
  const r = slash(root || '').replace(/\/+$/, '');
  if (r && isAbsolute(r)) {
    const ff = fold(f), rr = fold(r);
    if (ff === rr) return '';
    if (ff.startsWith(rr + '/')) { const t = tidy(f.slice(r.length + 1)); if (t !== null) return t; }
  }
  return outside(f);
}
// quello che la guardia accetta in un campo 'path': mai un percorso assoluto, mai fuori dalla radice
function guardPath(value) { return relPath(value, null); }

// ---------------------------------------------------------------- filtro dei segreti
function ibanOk(s) {
  const c = s.replace(/\s+/g, '').toUpperCase();
  if (c.length < 15 || c.length > 34) return false;
  const moved = c.slice(4) + c.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
const SECRET_NAME = '(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth(?:orization)?|credentials?|private[_-]?key|client[_-]?secret|session[_-]?id|cookie)';
const RULES = [
  // chiavi private in PEM, anche tagliate
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[key]'],
  // indirizzi con le credenziali dentro, comprese le stringhe di connessione (postgres://utente:password@host/db)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, '$1[credentials]@'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]{8,}@/gi, '$1[credentials]@'],
  // intestazioni
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [token]'],
  // token riconoscibili dal prefisso
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|[spr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{40,})/g, '[token]'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[token]'],
  // nome = valore, nome: valore, --nome valore (password=…, DB_PASSWORD=…, API_KEY: …, --token …). Il nome sospetto
  // deve essere una parola intera tra separatori: "author: Mario" e "tokens: 5" non sono segreti
  [new RegExp(`((?:--)?\\b(?:[A-Za-z0-9_.-]*[_.-])?${SECRET_NAME}(?:[_.-][A-Za-z0-9_.-]*)?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s;,&"']+)`, 'gi'), '$1[secret]'],
  [new RegExp(`(--(?:[A-Za-z0-9-]*-)?${SECRET_NAME}(?:-[A-Za-z0-9-]*)?\\s+)("[^"]*"|'[^']*'|[^\\s;,&"'-][^\\s;,&"']*)`, 'gi'), '$1[secret]'],
  // indirizzi e-mail
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  // lunghe sequenze senza senso (maiuscole, minuscole e cifre insieme): quasi sempre una chiave
  [/[A-Za-z0-9+_=-]{40,}/g, m => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? '[token]' : m)],
];
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;

// toglie da un testo quello che non deve restare scritto da nessuna parte
function scrub(text) {
  let s = String(text === undefined || text === null ? '' : text);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s.replace(IBAN_RE, m => (ibanOk(m) ? '[iban]' : m));
}
// un estratto di una riga: spazi compattati, segreti tolti, lunghezza limitata
function excerpt(text, max = MAX_EXCERPT) {
  const s = scrub(String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim());
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------- la guardia sui documenti
// Applica la dichiarazione a un documento già controllato da cleanDoc. Restituisce il documento da salvare;
// i problemi vanno in `problems` come { field, why } (mai il valore).
const DROP = Symbol('drop');
function guardValue(v, spec, where, problems) {
  if (v === null) return null;
  const no = why => { problems.push({ field: where, why }); return DROP; };
  if (typeof spec === 'string') {
    switch (spec) {
      case 'number': return typeof v === 'number' ? v : no('tipo');
      case 'boolean': return typeof v === 'boolean' ? v : no('tipo');
      case 'string': return typeof v !== 'string' ? no('tipo') : (v.length > MAX_STRING || /[\r\n]/.test(v)) ? no('testo') : v;
      case 'id': return typeof v !== 'string' ? no('tipo') : (v.length > MAX_ID || !ID_RE.test(v)) ? no('forma') : v;
      case 'path': return typeof v !== 'string' ? no('tipo') : v.length > 4 * MAX_PATH ? no('testo') : guardPath(v).slice(0, MAX_PATH);
      case 'excerpt': return typeof v !== 'string' ? no('tipo') : excerpt(v);
    }
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(v)) return no('tipo');
    const out = [];
    for (let i = 0; i < v.length && out.length < MAX_LIST; i++) { const x = guardValue(v[i], spec[0], `${where}[]`, problems); if (x !== DROP) out.push(x); }
    if (v.length > MAX_LIST) problems.push({ field: where, why: 'troppe voci' });
    return out;
  }
  if (!isPlain(v)) return no('tipo');
  const out = {}, any = spec['*'];
  for (const k of Object.keys(v)) {
    const sub = any || spec[k], at = `${where}.${any ? '*' : k}`;
    if (!sub) { problems.push({ field: `${where}.${k}`.slice(0, 200), why: 'non dichiarato' }); continue; }
    if (any && k.length > MAX_KEY) { problems.push({ field: at, why: 'chiave troppo lunga' }); continue; }
    const x = guardValue(v[k], sub, at, problems);
    if (x !== DROP) out[k] = x;
  }
  return out;
}
function guardDoc(doc, fields, problems) {
  const out = { _id: doc._id };
  for (const k of Object.keys(doc)) {
    if (k === '_id') continue;
    if (k === 'project' || k === 't') { out[k] = doc[k]; continue; }
    if (!fields[k]) { problems.push({ field: k.slice(0, 80), why: 'non dichiarato' }); continue; }
    const x = guardValue(doc[k], fields[k], k, problems);
    if (x !== DROP) out[k] = x;
  }
  return out;
}

module.exports = { TYPES, parseFields, parseFieldSpec, guardDoc, relPath, guardPath, scrub, excerpt, ibanOk, MAX_STRING, MAX_EXCERPT, MAX_PATH };
