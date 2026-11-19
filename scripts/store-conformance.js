#!/usr/bin/env node
'use strict';
// Prove di conformità dello store (src/core/store): le stesse per ogni backend. Chi le passa si comporta come
// gli altri, e il motore può cambiare backend senza cambiare codice.
//   PLATYPUS_STORE_BACKEND=memory node scripts/store-conformance.js     (sqlite da S3)
// Le richiama anche `npm test` (smoke-test.js). Ogni chiamata allo store ha `await` davanti, anche se i backend
// di questo computer rispondono subito: così le stesse prove girano senza modifiche su un backend di rete
// (MongoDB, 3.0), che il suo pacchetto registra con registerBackend prima di chiamare run().

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { openStore, StoreError, ulidTime } = require(path.join(ROOT, 'src', 'core', 'store'));

// l'errore atteso: uno StoreError con quel codice (per una funzione normale o asincrona)
async function throwsCode(fn, code) {
  try { await fn(); } catch (e) { return e instanceof StoreError && e.code === code; }
  return false;
}
const ids = rows => rows.map(r => r._id).join(',');

async function run(ok, backend = process.env.PLATYPUS_STORE_BACKEND || 'memory') {
  console.log(`store: conformità del backend ${backend}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-store-'));
  let n = 0;
  const open = async extra => openStore({ backend, dir: path.join(tmp, 'db' + (++n)), ...extra });
  const stores = [];
  const fresh = async extra => { const s = await open(extra); stores.push(s); return s; };
  try {
    // ---------------------------------------------------------- collezioni
    const store = await fresh();
    ok(store.backend === backend, 'lo store dice quale backend è');
    ok(await throwsCode(() => store.collection('things'), 'undeclared-collection'), 'una collezione non dichiarata è un errore');
    ok(await throwsCode(() => store.declare('Bad Name', {}), 'invalid-argument') && await throwsCode(() => store.declare('a.b', {}), 'invalid-argument') &&
      await throwsCode(() => store.declare('things', { boh: 1 }), 'invalid-argument'), 'nomi di collezione e dichiarazioni non validi sono rifiutati');
    ok(await throwsCode(() => openStore({ backend: 'non-esiste' }), 'unknown-backend'), 'un backend sconosciuto è un errore');
    await store.declare('things', { indexes: ['kind', ['project', 't']], retention: { days: 90 } });
    await store.declare('things', { indexes: ['kind', ['project', 't']], retention: { days: 90 } }); // due volte: va bene
    const things = await store.collection('things');

    // ---------------------------------------------------------- put, get, copie
    const src = { _id: 'a1', project: 'p1', t: 1000, kind: 'x', n: 1, nested: { deep: { v: 7 } }, list: [1, 'due', { tre: 3 }], flag: true, nothing: null };
    const saved = await things.put(src);
    const got = await things.get('a1');
    ok(JSON.stringify(got) === JSON.stringify(src) && JSON.stringify(saved) === JSON.stringify(src), 'put e get: il documento torna uguale (oggetti, array, booleani, null)');
    src.nested.deep.v = 99; got.list.push('altro'); saved.n = 55;
    const again = await things.get('a1');
    ok(again.nested.deep.v === 7 && again.list.length === 3 && again.n === 1, 'quello che entra e quello che esce sono copie: cambiarle non tocca lo store');
    ok(await things.get('non-esiste') === null, 'get di un _id che non c\'è: null');
    await things.put({ _id: 'a1', project: 'p1', t: 1000, kind: 'y' });
    const replaced = await things.get('a1');
    ok(replaced.kind === 'y' && replaced.n === undefined && replaced.nested === undefined, 'put sostituisce il documento intero');
    const auto = await things.put({ project: 'p1', t: 2000, kind: 'x' });
    ok(typeof auto._id === 'string' && auto._id.length === 26 && Math.abs(ulidTime(auto._id) - Date.now()) < 60000, 'senza _id lo store mette un ULID, con il tempo di adesso');
    const undef = await things.put({ _id: 'u1', kind: 'x', missing: undefined, sub: { gone: undefined, kept: 1 } });
    ok(!('missing' in undef) && JSON.stringify(undef.sub) === '{"kept":1}', 'i campi undefined non vengono salvati (come in JSON)');
    await things.delete('u1');

    // ---------------------------------------------------------- documenti non validi
    const invalid = [
      ['un nome di campo con il punto', { 'a.b': 1 }], ['un nome di campo con $', { $set: 1 }], ['un nome non valido in profondità', { a: [{ 'x.y': 1 }] }],
      ['NaN', { n: NaN }], ['Infinity', { n: Infinity }], ['una Date', { when: new Date() }], ['una funzione', { f() {} }], ['undefined in un array', { a: [undefined] }],
      ['_id non stringa', { _id: 5 }], ['_id vuoto', { _id: '' }], ['t non numerico', { t: '2026-01-01' }], ['project non stringa', { project: 7 }],
    ];
    let allRefused = true;
    for (const [what, doc] of invalid) {
      const r1 = await throwsCode(() => things.put(doc), 'invalid-document'), r2 = await throwsCode(() => things.append(doc), 'invalid-document');
      if (!r1 || !r2) { allRefused = false; ok(false, `documento non valido accettato: ${what}`); }
    }
    ok(allRefused && await throwsCode(() => things.put('testo'), 'invalid-document') && await throwsCode(() => things.put([1]), 'invalid-document'),
      `documenti non validi rifiutati (${invalid.length} casi: nomi con "." o "$", NaN, Date, _id e t sbagliati…)`);
    ok(await things.count({}) === 2, 'un documento rifiutato non lascia niente nello store');

    // ---------------------------------------------------------- patch e delete
    await things.put({ _id: 'p1', project: 'p1', t: 1, a: 1, b: { x: 1, y: 2 } });
    const patched = await things.patch('p1', { a: 2, b: { z: 3 }, c: 'nuovo' });
    ok(patched.a === 2 && JSON.stringify(patched.b) === '{"z":3}' && patched.c === 'nuovo' && patched.t === 1 && JSON.stringify(await things.get('p1')) === JSON.stringify(patched),
      'patch cambia i campi indicati (al primo livello) e lascia gli altri');
    ok(await things.patch('non-esiste', { a: 1 }) === null && await throwsCode(() => things.patch('p1', { _id: 'altro' }), 'invalid-document') &&
      await throwsCode(() => things.patch('p1', { 'x.y': 1 }), 'invalid-document'), 'patch: null se il documento non c\'è; non cambia _id; rifiuta i campi non validi');
    ok(await things.delete('p1') === true && await things.delete('p1') === false && await things.get('p1') === null, 'delete: true se c\'era, false se non c\'era');

    // ---------------------------------------------------------- append
    await store.declare('log', {});
    const log = await store.collection('log');
    const made = [];
    for (let i = 0; i < 300; i++) made.push(await log.append({ project: 'p1', t: 5000 + i, i }));
    await store.flush();
    const back = await log.find({}, { sort: { _id: 1 } });
    ok(made.every(id => typeof id === 'string' && id.length === 26) && new Set(made).size === 300 && back.length === 300 && back.every((d, i) => d._id === made[i] && d.i === i),
      'append: 300 righe, ognuna con il suo ULID; in ordine di _id sono in ordine di scrittura');
    ok(await throwsCode(async () => { await log.append({ _id: made[0], i: -1 }); await store.flush(); }, 'duplicate-id') && (await log.get(made[0])).i === 0, 'append con un _id già usato è un errore e non sovrascrive');

    // ---------------------------------------------------------- filtri
    await store.declare('f', { indexes: ['kind', ['project', 't'], 'm.level'] });
    const f = await store.collection('f');
    const rows = [
      { _id: '01', project: 'p1', t: 100, kind: 'edit', n: 1, ok: true, m: { level: 3, tag: 'a' } },
      { _id: '02', project: 'p1', t: 200, kind: 'run', n: 2, ok: false, m: { level: 1, tag: 'b' } },
      { _id: '03', project: 'p2', t: 300, kind: 'edit', n: 3, ok: 1, m: { level: 2 } },
      { _id: '04', project: 'p2', t: 400, kind: 'read', n: null, name: 'zeta' },
      { _id: '05', project: 'p3', t: 500, kind: 'run', name: 'alfa', tags: ['x', 'y'], m: 'non un oggetto' },
      { _id: '06', project: 'p3', t: 600, kind: 'edit', n: '10', name: '10', 'strano nome': 'q', quote: 'l\'ha "detto"' },
      { _id: '07', t: 700, kind: 'run', n: 0, ok: 0, name: '' },
    ];
    for (const r of rows) await f.put(r);
    const q = async (filter, opts) => ids(await f.find(filter, { sort: { _id: 1 }, ...opts }));
    ok(await q({}) === '01,02,03,04,05,06,07' && await q() === '01,02,03,04,05,06,07' && await q(null) === '01,02,03,04,05,06,07', 'find senza filtro: tutti');
    ok(await q({ kind: 'edit' }) === '01,03,06' && await q({ kind: 'edit', project: 'p1' }) === '01' && await q({ kind: 'nessuno' }) === '', 'uguaglianza, più campi in E');
    ok(await q({ n: 2 }) === '02' && await q({ n: '10' }) === '06' && await q({ n: 10 }) === '' && await q({ name: '' }) === '07', 'uguaglianza: il numero 10 non è la stringa "10"; la stringa vuota si trova');
    ok(await q({ ok: true }) === '01' && await q({ ok: false }) === '02' && await q({ ok: 1 }) === '03' && await q({ ok: 0 }) === '07', 'uguaglianza: true non è 1 e false non è 0');
    ok(await q({ n: null }) === '04,05' && await q({ project: null }) === '07', '{ campo: null } trova il campo a null e il campo che manca');
    ok(await q({ n: { $exists: true } }) === '01,02,03,04,06,07' && await q({ n: { $exists: false } }) === '05' && await q({ 'm.level': { $exists: true } }) === '01,02,03', '$exists: il campo c\'è (anche a null) o non c\'è');
    ok(await q({ kind: { $in: ['run', 'read'] } }) === '02,04,05,07' && await q({ n: { $in: [1, '10', null] } }) === '01,04,05,06' && await q({ kind: { $in: [] } }) === '', '$in, anche con null e con un elenco vuoto');
    ok(await q({ t: { $gt: 300 } }) === '04,05,06,07' && await q({ t: { $gte: 300 } }) === '03,04,05,06,07' && await q({ t: { $lt: 200 } }) === '01' && await q({ t: { $lte: 200 } }) === '01,02',
      '$gt, $gte, $lt, $lte sui numeri');
    ok(await q({ t: { $gte: 200, $lt: 500 } }) === '02,03,04' && await q({ t: { $gte: 200, $lt: 500 }, kind: 'edit' }) === '03', 'un intervallo: due operatori sullo stesso campo, in E con gli altri');
    ok(await q({ n: { $gt: 0 } }) === '01,02,03' && await q({ n: { $gte: 0 } }) === '01,02,03,07' && await q({ n: { $lt: 5 } }) === '01,02,03,07' && await q({ name: { $gte: 'a' } }) === '04,05' && await q({ name: { $lt: 'b' } }) === '05,06,07',
      'i confronti valgono solo tra valori dello stesso tipo: né null, né mancanti, né numeri contro stringhe');
    ok(await q({ 'm.level': 2 }) === '03' && await q({ 'm.level': { $gte: 2 } }) === '01,03' && await q({ 'm.tag': 'a' }) === '01' && await q({ 'm.level': null }) === '04,05,06,07' && await q({ 'm.non.esiste': 1 }) === '',
      'percorsi con il punto dentro gli oggetti; se per strada non c\'è un oggetto, il campo manca');
    ok(await q({ $or: [{ kind: 'read' }, { n: 1 }] }) === '01,04' && await q({ project: 'p1', $or: [{ kind: 'run' }, { n: 1 }] }) === '01,02' &&
      await q({ $or: [{ t: { $lt: 150 } }, { $or: [{ name: 'alfa' }, { project: 'p2', kind: 'read' }] }] }) === '01,04,05', '$or, in E con gli altri campi, anche annidato');
    ok(await q({ tags: 'x' }) === '' && await q({ m: 'non un oggetto' }) === '05', 'un campo che contiene un array non corrisponde a un suo elemento (convenzione dello store)');
    ok(await q({ 'strano nome': 'q' }) === '06' && await q({ quote: 'l\'ha "detto"' }) === '06' && await q({ kind: '\' OR 1=1 --' }) === '' && await q({ 'x\' OR \'1\'=\'1': 1 }) === '' && await q({ 'a"]); DROP TABLE f; --': 1 }) === '' && await f.count({}) === 7,
      'nomi di campo e valori con spazi, apici e SQL dentro: sono solo testo');
    const unsupported = [
      { n: { $ne: 1 } }, { $and: [{ n: 1 }] }, { kind: { $regex: 'e' } }, { kind: { $nin: ['x'] } }, { $where: 'true' }, { $nor: [{ n: 1 }] }, { n: { $not: { $gt: 1 } } },
      { m: { level: 3 } }, { tags: ['x', 'y'] }, { kind: { $in: 'edit' } }, { kind: { $in: [['a']] } }, { n: { $gt: true } }, { n: { $gt: null } }, { n: { $exists: 1 } },
      { $or: [] }, { $or: { n: 1 } }, { n: { $gt: 1, altro: 2 } }, { n: {} }, { 'a..b': 1 }, { 'a.$b': 1 }, { n: undefined }, 'testo', [1],
    ];
    let allThrow = true;
    for (const u of unsupported) {
      for (const call of [() => f.find(u), () => f.count(u), () => f.deleteMany(u)]) {
        if (!await throwsCode(call, 'unsupported-filter')) { allThrow = false; ok(false, `filtro non supportato accettato: ${JSON.stringify(u)}`); }
      }
    }
    ok(allThrow && await f.count({}) === 7, `filtri non supportati: un errore, mai ignorati (${unsupported.length} casi: $ne, $and, $regex, confronto con oggetti…)`);

    // ---------------------------------------------------------- ordinamento, limiti, campi
    ok(ids(await f.find({}, { sort: { t: -1 } })) === '07,06,05,04,03,02,01' && ids(await f.find({}, { sort: { kind: 1, t: -1 } })) === '06,03,01,04,07,05,02' && ids(await f.find({}, { sort: { kind: -1, _id: -1 } })) === '07,05,02,04,06,03,01',
      'sort su uno o più campi, crescente e decrescente');
    ok(ids(await f.find({}, { sort: { n: 1 } })) === '04,05,07,01,02,03,06' && ids(await f.find({}, { sort: { n: -1 } })) === '06,03,02,01,07,04,05' && ids(await f.find({})) === '01,02,03,04,05,06,07' && ids(await f.find({}, { sort: { 'm.level': 1 } })) === '04,05,06,07,02,03,01',
      'sort: prima null e mancanti, poi i numeri, poi le stringhe; a parità (e senza sort) in ordine di _id');
    ok(await q({}, { limit: 3 }) === '01,02,03' && await q({}, { skip: 5 }) === '06,07' && await q({}, { skip: 2, limit: 2 }) === '03,04' && await q({}, { limit: 0 }) === '' && await q({}, { skip: 99 }) === '' && await q({ kind: 'edit' }, { sort: { t: -1 }, limit: 1 }) === '06',
      'limit e skip, dopo il filtro e l\'ordinamento');
    const proj = await f.find({ _id: '01' }, { fields: ['kind', 'm.level', 'non-esiste'] });
    ok(JSON.stringify(proj) === '[{"_id":"01","kind":"edit","m":{"level":3}}]' && JSON.stringify(await f.find({ _id: '04' }, { fields: [] })) === '[{"_id":"04"}]', 'fields: solo i campi chiesti (anche con il punto), più sempre _id');
    ok(await throwsCode(() => f.find({}, { sort: { t: 2 } }), 'invalid-argument') && await throwsCode(() => f.find({}, { limit: -1 }), 'invalid-argument') && await throwsCode(() => f.find({}, { limit: 1.5 }), 'invalid-argument') &&
      await throwsCode(() => f.find({}, { boh: 1 }), 'invalid-argument') && await throwsCode(() => f.find({}, { fields: 'kind' }), 'invalid-argument') && await throwsCode(() => f.find({}, { sort: { 'a.$b': 1 } }), 'invalid-argument'),
      'opzioni di find non valide: un errore');
    await store.declare('u', {});
    const u = await store.collection('u');
    for (const [id, s] of [['1', 'b'], ['2', 'a'], ['3', 'B'], ['4', 'é'], ['5', '\u{1F600}'], ['6', '～'], ['7', 'ab'], ['8', '']]) await u.put({ _id: id, s, big: 2 ** 53 - 1, small: -1.5e-7 });
    ok(ids(await u.find({}, { sort: { s: 1 } })) === '8,3,2,7,1,4,6,5' && ids(await u.find({ s: { $gt: 'a' } }, { sort: { s: 1 } })) === '7,1,4,6,5' && (await u.get('5')).s === '\u{1F600}' && (await u.get('1')).big === 2 ** 53 - 1 && (await u.get('1')).small === -1.5e-7,
      'stringhe in ordine di punti di codice (maiuscole, accenti, emoji); i numeri grandi e piccoli tornano uguali');

    // ---------------------------------------------------------- count e deleteMany
    ok(await f.count({ kind: 'run' }) === 3 && await f.count() === 7 && await f.count({ t: { $gt: 9999 } }) === 0, 'count');
    ok(await f.deleteMany({ kind: 'run', t: { $gte: 500 } }) === 2 && await q({}) === '01,02,03,04,06' && await f.deleteMany({ kind: 'nessuno' }) === 0, 'deleteMany toglie quelli che corrispondono e dice quanti');

    // ---------------------------------------------------------- transazioni
    const before = await q({});
    const r = await store.transaction(async () => { await f.put({ _id: '10', kind: 'tx' }); await f.patch('01', { n: 100 }); return 'fatto'; });
    ok(r === 'fatto' && (await f.get('10')).kind === 'tx' && (await f.get('01')).n === 100, 'transaction: se finisce bene tutto resta, e torna il risultato della funzione');
    let thrown = null;
    try {
      await store.transaction(async () => {
        await f.put({ _id: '11', kind: 'tx' }); await f.patch('01', { n: 200 }); await f.delete('02'); await f.deleteMany({ project: 'p2' });
        await log.append({ i: 9999 }); await f.put({ _id: '10', kind: 'cambiato' });
        throw new Error('annulla');
      });
    } catch (e) { thrown = e; }
    await store.flush();
    ok(thrown && thrown.message === 'annulla' && await f.get('11') === null && (await f.get('01')).n === 100 && (await f.get('02')) !== null && await q({}) === before + ',10' && (await f.get('10')).kind === 'tx' && await log.count({ i: 9999 }) === 0,
      'transaction: se la funzione fallisce niente resta scritto (put, patch, delete, deleteMany, append) e l\'errore arriva a chi chiama');
    let inner = null;
    try { await store.transaction(async () => { await f.put({ _id: '12', kind: 'tx' }); await store.transaction(async () => { await f.put({ _id: '13', kind: 'tx' }); }); throw new Error('fuori'); }); } catch (e) { inner = e; }
    ok(inner && await f.get('12') === null && await f.get('13') === null, 'una transazione dentro un\'altra fa parte di quella di fuori');
    await store.transaction(async () => { await f.put({ _id: '14', kind: 'tx' }); });
    ok((await f.get('14')) !== null && await throwsCode(() => store.transaction('no'), 'invalid-argument'), 'dopo una transazione annullata lo store funziona ancora');

    // ---------------------------------------------------------- dimenticare un progetto
    const s2 = await fresh();
    await s2.declare('projects', { projectField: '_id' });
    await s2.declare('steps', {});
    await s2.declare('lessons', {});
    const pr = await s2.collection('projects'), st = await s2.collection('steps'), le = await s2.collection('lessons');
    for (const k of ['k1', 'k2']) {
      await pr.put({ _id: k, name: 'cartella-' + k });
      for (let i = 0; i < 5; i++) await st.append({ project: k, t: i, action: 'a' });
      await le.put({ _id: 'l-' + k, project: k, weight: 1 });
    }
    await le.put({ _id: 'l-none', weight: 1 });
    await s2.flush();
    ok(await s2.forgetProject('k1') === 7 && await pr.get('k1') === null && await st.count({ project: 'k1' }) === 0 && await le.count({ project: 'k1' }) === 0 &&
      await pr.get('k2') !== null && await st.count({ project: 'k2' }) === 5 && await le.count({}) === 2 && await s2.forgetProject('k1') === 0 && await throwsCode(() => s2.forgetProject(''), 'invalid-argument'),
      'forgetProject toglie il progetto da ogni collezione e lascia stare gli altri');

    // ---------------------------------------------------------- esportare e importare
    const outDir = path.join(tmp, 'export', 'sub');
    const ex = await store.export('f', outDir);
    const text = fs.readFileSync(ex.file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    ok(ex.count === lines.length && ex.count === await f.count({}) && path.basename(ex.file) === 'f.jsonl' && lines.every(l => typeof JSON.parse(l)._id === 'string') && lines.map(l => JSON.parse(l)._id).join(',') === await q({}),
      'export: un file JSONL nella cartella indicata (creata se manca), una riga per documento, in ordine di _id');
    const s3 = await fresh();
    await s3.declare('f', {});
    const f3 = await s3.collection('f');
    await f3.put({ _id: '01', kind: 'vecchio' });
    const im = await s3.import('f', ex.file);
    ok(im.count === ex.count && JSON.stringify(await f3.find({}, { sort: { _id: 1 } })) === JSON.stringify(await f.find({}, { sort: { _id: 1 } })), 'import: gli stessi documenti in un altro store; quelli con lo stesso _id sono sostituiti');
    const badFile = path.join(tmp, 'bad.jsonl');
    fs.writeFileSync(badFile, '{"_id":"z1","kind":"nuovo"}\n\nquesta riga non è JSON\n{"_id":"z2"}\n');
    const noId = path.join(tmp, 'noid.jsonl');
    fs.writeFileSync(noId, '{"_id":"z3"}\n{"kind":"senza id"}\n');
    ok(await throwsCode(() => s3.import('f', badFile), 'invalid-document') && await throwsCode(() => s3.import('f', noId), 'invalid-document') && await f3.get('z1') === null && await f3.get('z3') === null && await f3.count({}) === ex.count,
      'import di un file con una riga sbagliata: un errore, e niente viene importato');
    ok(await throwsCode(() => store.export('non_dichiarata', outDir), 'undeclared-collection') && await throwsCode(() => store.import('non_dichiarata', ex.file), 'undeclared-collection'), 'export e import di una collezione non dichiarata: un errore');

    // ---------------------------------------------------------- solo i campi dichiarati
    const FIELDS = { kind: 'string', n: 'number', flag: 'boolean', who: 'id', file: 'path', line: 'excerpt', tags: ['string'], meta: { phase: 'string', count: 'number' }, counts: { '*': 'number' } };
    const good = { _id: 'g1', project: 'p1', t: 5, kind: 'edit', n: 1, flag: true, who: 'sess-01:main', file: 'src/a.js', line: 'npm test', tags: ['a', 'b'], meta: { phase: 'build', count: 2 }, counts: { ok: 3, error: 1 }, nothing: null };
    const strict = await fresh({ guard: 'reject' });
    await strict.declare('g', { fields: { ...FIELDS, nothing: 'string' } });
    const g = await strict.collection('g');
    ok(JSON.stringify(await g.put(good)) === JSON.stringify(good) && JSON.stringify(await g.get('g1')) === JSON.stringify(good), 'campi dichiarati: un documento in regola passa così com\'è (tipi, oggetti, elenchi, null)');
    const refused = [
      { extra: 1 }, { prompt: 'testo' }, { n: 'uno' }, { flag: 1 }, { kind: 5 }, { kind: 'riga\ndue' }, { kind: 'x'.repeat(301) }, { who: 'con spazi' }, { tags: 'a' }, { tags: [1] },
      { meta: { phase: 'x', altro: 1 } }, { meta: 'x' }, { counts: { ok: 'tre' } }, { file: 7 }, { line: ['x'] },
    ];
    let allRejected = true;
    for (const bad of refused) {
      for (const call of [() => g.put({ ...good, _id: 'g2', ...bad }), () => g.append({ ...good, _id: 'g3', ...bad }), () => g.patch('g1', bad)]) {
        if (!await throwsCode(call, 'undeclared-field')) { allRejected = false; ok(false, `guardia 'reject': accettato ${JSON.stringify(bad).slice(0, 60)}`); }
      }
    }
    await strict.flush();
    ok(allRejected && await g.count({}) === 1 && JSON.stringify(await g.get('g1')) === JSON.stringify(good), `guardia 'reject': un campo non dichiarato o del tipo sbagliato è un errore, in put, append e patch (${refused.length} casi), e non resta scritto niente`);
    const seen = [];
    const loose = await fresh({ guard: 'drop', onGuard: m => seen.push(m) });
    await loose.declare('g', { fields: FIELDS });
    const gl = await loose.collection('g');
    const SECRET = 'S3GRETISSIMO';
    const dropped = await gl.put({ ...good, _id: 'd1', nothing: null, extra: SECRET, prompt: `testo lungo ${SECRET}`, n: SECRET, tags: ['ok', 5, 'due'], meta: { phase: 'build', altro: SECRET }, counts: { a: 1, b: SECRET } });
    await gl.put({ _id: 'd2', extra: SECRET });
    ok(JSON.stringify(dropped) === JSON.stringify({ ...good, _id: 'd1', n: undefined, nothing: undefined, tags: ['ok', 'due'], meta: { phase: 'build' }, counts: { a: 1 } }) && JSON.stringify(await gl.get('d1')) === JSON.stringify(dropped) && JSON.stringify(await gl.get('d2')) === '{"_id":"d2"}',
      'guardia \'drop\': quello che non è dichiarato viene scartato, il resto si salva');
    ok(seen.length === 7 && seen.includes('g.extra: non dichiarato, non salvato') && seen.includes('g.n: tipo, non salvato') && seen.includes('g.meta.altro: non dichiarato, non salvato') && !seen.join(' ').includes(SECRET),
      'guardia \'drop\': ogni campo scartato si segnala una volta sola, con il nome e mai con il valore');
    const paths = await gl.put({ _id: 'd3', file: 'C:\\Users\\mario\\progetto\\src\\a.js', line: `  export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 \n mario.rossi@example.com  ${'x'.repeat(400)}` });
    ok(/^ext:[0-9a-f]{10}\/a\.js$/.test(paths.file) && !paths.line.includes('ghp_') && !paths.line.includes('mario') && paths.line.length <= 200 && !paths.line.includes('\n'),
      'un percorso assoluto diventa impronta e nome del file; un estratto perde i segreti, sta su una riga ed è corto');
    ok(await throwsCode(() => loose.declare('x', { fields: { a: 'testo' } }), 'invalid-argument') && await throwsCode(() => loose.declare('x', { fields: { a: {} } }), 'invalid-argument') && await throwsCode(() => loose.declare('x', { fields: { a: ['string', 'number'] } }), 'invalid-argument') &&
      await throwsCode(() => loose.declare('x', { fields: { 'a.b': 'string' } }), 'invalid-argument') && await throwsCode(() => loose.declare('x', { fields: { '*': 'string' } }), 'invalid-argument') && await throwsCode(() => open({ guard: 'boh' }), 'invalid-argument'),
      'dichiarazioni dei campi non valide: un errore');
    const must = await fresh({ requireFields: true });
    ok(await throwsCode(() => must.declare('x', {}), 'invalid-argument') && (await must.declare('x', { fields: { a: 'number' } })) === undefined && (await must.info()).collections[0].guarded === true, 'con requireFields ogni collezione deve dichiarare i suoi campi');

    // ---------------------------------------------------------- i segni dello store
    await store.setMeta('segno', 'uno');
    let metaErr = null;
    try { await store.transaction(async () => { await store.setMeta('segno', 'due'); await store.setMeta('altro', 'x'); throw new Error('annulla'); }); } catch (e) { metaErr = e; }
    ok(await store.getMeta('segno') === 'uno' && await store.getMeta('altro') === null && await store.getMeta('mai-messo') === null && metaErr && await throwsCode(() => store.setMeta('k', 5), 'invalid-argument') && await throwsCode(() => store.getMeta(''), 'invalid-argument') &&
      (await store.info()).collections.every(c => !c.name.includes('meta')), 'getMeta e setMeta: piccoli segni che seguono le transazioni e non compaiono tra le collezioni');

    // ---------------------------------------------------------- info, store separati, chiusura
    const info = await store.info();
    const fi = info.collections.find(c => c.name === 'things');
    ok(info.backend === backend && typeof info.persistent === 'boolean' && info.collections.length === 4 && fi.count === await things.count({}) && JSON.stringify(fi.indexes) === '[["kind"],["project","t"]]' && fi.retention.days === 90,
      'info: backend, collezioni con quanti documenti, indici e conservazione');
    ok(await f3.count({ kind: 'tx' }) === 2 && await (await s2.collection('steps')).count({}) === 5 && await throwsCode(() => s2.collection('f'), 'undeclared-collection'), 'due store aperti su cartelle diverse non si vedono');
    await s3.close();
    await s3.close();
    ok(await throwsCode(() => f3.get('01'), 'closed') && await throwsCode(() => f3.put({ a: 1 }), 'closed') && await throwsCode(() => s3.collection('f'), 'closed') && await throwsCode(() => s3.info(), 'closed') && await f.count({}) > 0,
      'dopo close lo store rifiuta ogni chiamata (chiuderlo due volte va bene); gli altri store restano aperti');
  } finally {
    for (const s of stores) { try { await s.close(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { run };
if (require.main === module) {
  let failed = 0;
  run((c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failed++; })
    .then(() => { console.log(failed ? `\n${failed} prove fallite.` : '\nTutto a posto.'); process.exit(failed ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
