#!/usr/bin/env node
'use strict';
// Prove del significato con gli embedding (piano docs/plans/neural-embeddings.md).
// Niente rete vera, niente modelli: server Ollama finto e modulo ONNX finto. Le richiama smoke-test.js.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'agentmind-tfidf.json');
const iso = t => new Date(t).toISOString();

// Uno scenario della demo (piano 1, portale-clienti) scritto come transcript, con un orologio fisso:
// CLAUDE rifà il login, un sottoagente Plan si perde tra i componenti grafici, una compattazione a metà.
function demoScenario() {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const T0 = Date.parse('2026-11-18T09:00:00Z');
  let now = T0;
  const st = new OfficeState({ clock: () => now, settings: {} });
  const S = 'sess-embed-demo-0001';
  let k = 0;
  const line = (type, content, extra = {}) => ({ type, timestamp: iso(now += 1000), cwd: 'C:/Progetti/portale-clienti', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + (++k), usage: { input_tokens: 10, output_tokens: 10 } } : {}) }, ...extra });
  const say = (agent, type, content, extra) => st.applyTranscriptLine(S, agent, line(type, content, extra), agent ? { meta: { agentType: 'Plan' } } : undefined);
  const tool = (agent, id, name, input, out, isErr) => {
    say(agent, 'assistant', [{ type: 'tool_use', id, name, input }]);
    say(agent, 'user', [{ type: 'tool_result', tool_use_id: id, content: out, ...(isErr ? { is_error: true } : {}) }]);
  };
  say(null, 'user', 'Refactoring del login e delle sessioni: i token scaduti devono essere rinnovati in automatico');
  tool(null, 'a1', 'Read', { file_path: 'C:/Progetti/portale-clienti/src/auth/login.ts' }, 'export async function login(user, password) { const token = await issueToken(user); return token }');
  tool(null, 'a2', 'Grep', { pattern: 'refreshToken', path: 'src/auth' }, 'src/auth/token.ts:12: export function refreshToken(t) {}\nsrc/auth/session.ts:40: refreshToken(session.token)');
  say(null, 'assistant', [{ type: 'text', text: 'Il rinnovo del token avviene in session.ts: lo sposto nel modulo auth e aggiungo la scadenza.' }]);
  tool(null, 'a3', 'Read', { file_path: 'C:/Progetti/portale-clienti/src/auth/token.ts' }, 'export function refreshToken(t) { if (expired(t)) return renew(t) }');
  tool(null, 'a4', 'Edit', { file_path: 'C:/Progetti/portale-clienti/src/auth/token.ts', old_string: 'renew(t)', new_string: 'renewWithExpiry(t)' }, 'The file has been updated.');
  tool(null, 'a5', 'Bash', { command: 'npm test -- auth' }, 'FAIL src/auth/token.test.ts expired token not renewed', true);
  tool(null, 'a6', 'Edit', { file_path: 'C:/Progetti/portale-clienti/src/auth/session.ts', old_string: 'refreshToken(session.token)', new_string: 'await refreshToken(session.token)' }, 'The file has been updated.');
  tool(null, 'a7', 'Bash', { command: 'npm test -- auth' }, 'PASS src/auth/token.test.ts\nTests: 9 passed, 9 total');
  // il sottoagente Plan: parte dal compito, poi finisce tra i componenti grafici
  tool(null, 'sp', 'Agent', { subagent_type: 'Plan', description: 'Piano di migrazione al nuovo DB', prompt: 'Prepara il piano di migrazione delle sessioni al nuovo database' }, 'ok');
  say('plan1', 'user', 'Prepara il piano di migrazione delle sessioni al nuovo database');
  tool('plan1', 'p1', 'Read', { file_path: 'C:/Progetti/portale-clienti/db/schema.sql' }, 'CREATE TABLE sessions (id uuid primary key, user_id int, token text, expires_at timestamp)');
  tool('plan1', 'p2', 'Grep', { pattern: 'sessions', path: 'db/migrations' }, 'db/migrations/004_sessions.sql: ALTER TABLE sessions ADD COLUMN expires_at');
  for (const [i, f] of ['005_sessions_token.sql', '006_sessions_index.sql', '007_sessions_users.sql', '008_sessions_expiry.sql', '009_sessions_cleanup.sql', '010_sessions_audit.sql'].entries()) {
    tool('plan1', 'q' + i, 'Read', { file_path: 'C:/Progetti/portale-clienti/db/migrations/' + f }, 'ALTER TABLE sessions ADD COLUMN ' + f.split('_')[2].replace('.sql', '') + '; migrate the sessions database table');
  }
  for (const [i, f] of ['Menu.tsx', 'Button.tsx', 'Sidebar.tsx', 'theme.css', 'Card.tsx', 'Modal.tsx', 'Header.tsx', 'Footer.tsx', 'Tabs.tsx', 'Toast.tsx', 'Avatar.tsx', 'Badge.tsx'].entries()) {
    tool('plan1', 'p' + (3 + i), i % 2 ? 'Edit' : 'Read', i % 2 ? { file_path: 'C:/Progetti/portale-clienti/src/ui/components/' + f, old_string: 'color: red', new_string: 'color: var(--accent)' } : { file_path: 'C:/Progetti/portale-clienti/src/ui/components/' + f }, 'export const ' + f.split('.')[0] + ' = styled.div`padding: 8px; border-radius: 4px; color: var(--accent)`');
  }
  // compattazione e un nuovo compito per CLAUDE
  say(null, 'system', undefined, { subtype: 'compact_boundary', compactMetadata: { preTokens: 120000, postTokens: 9000 } });
  st.applyTranscriptLine(S, null, { type: 'user', isCompactSummary: true, timestamp: iso(now += 1000), cwd: 'C:/Progetti/portale-clienti', message: { role: 'user', content: 'Summary: the login token refresh was moved into the auth module and the tests pass.' } });
  say(null, 'user', 'Now add a logout from every device');
  tool(null, 'a8', 'Grep', { pattern: 'logout', path: 'src' }, 'src/auth/logout.ts:3: export function logout(session) {}');
  tool(null, 'a9', 'Edit', { file_path: 'C:/Progetti/portale-clienti/src/auth/logout.ts', old_string: 'logout(session)', new_string: 'logoutEverywhere(user)' }, 'The file has been updated.');
  return { st, s: st.sessions.get(S) };
}

// tutti i numeri che la mappa riceve da /api/agentmind, più la regola della deriva
function numbersOf(sem, s, keyPrefix) {
  const minds = (aid) => (aid === 'all' ? [s.main, ...s.subs.values()] : [aid === 'main' ? s.main : s.subs.get(aid)]).filter(a => a && a.mind && a.mind.pieces.length).map(a => ({ id: a.id, name: a.id, mind: a.mind }));
  const out = {};
  for (const aid of ['main', 'plan1', 'all']) {
    const v = sem.snapshotMinds(minds(aid), s.corpus, keyPrefix + aid);
    out[aid] = { engine: v.engine, pieces: v.pieces, goals: v.goals, clusters: v.clusters, align: v.align, ctx: v.ctx };
  }
  out.drift = { main: sem.drift(s.main.mind, s.corpus), plan1: sem.drift(s.subs.get('plan1').mind, s.corpus) };
  return out;
}

function pinnedTests(ok) {
  const sem = require(path.join(ROOT, 'src', 'core', 'semantic'));
  const i18n = require(path.join(ROOT, 'src', 'i18n'));
  // l'ufficio in italiano, qualunque sia la lingua del computer: le etichette fanno parte dei numeri fissati
  const { st, s, got } = i18n.withLang('it', () => { const x = demoScenario(); return { ...x, got: numbersOf(sem, x.s, 'unit-embed-pin:') }; });
  if (process.env.PLATYPUS_WRITE_FIXTURE) { fs.mkdirSync(path.dirname(FIXTURE), { recursive: true }); fs.writeFileSync(FIXTURE, JSON.stringify(got, null, 1) + '\n'); }
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // i numeri fissati devono restare identici; i campi aggiunti dopo (es. src, th) non contano
  const pick = (g, w) => (w && typeof w === 'object' && !Array.isArray(w) && g && typeof g === 'object' ? Object.fromEntries(Object.keys(w).map(k => [k, pick(g[k], w[k])])) : g);
  for (const k of Object.keys(want)) ok(JSON.stringify(pick(got[k], want[k])) === JSON.stringify(want[k]), `embedding E1: con il solo TF-IDF i numeri di /api/agentmind (${k}) restano identici`);
  ok(got.drift.plan1 && got.drift.plan1.drifting && got.main.align.length === 10, `embedding E1: scenario della demo (Plan alla deriva dopo ${got.drift.plan1 && got.drift.plan1.run} azioni, ${got.main.align.length} azioni di CLAUDE)`);
  st.stop && st.stop();
}

// uno spazio finto di lunghezza qualsiasi: parole del testo sparse con un hash in dim posizioni, poi normalizzate.
// has(x) decide quali vettori sono "già arrivati".
function wordVec(text, dim) {
  const v = new Float32Array(dim);
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9àèéìòù]+/).filter(x => x.length > 2)) { let h = 7; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % dim] += 1; }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}
function fakeSpace(src, dim, has = () => true) {
  return { src, version: 1, goal: g => (has(g) ? wordVec(g.text, dim) : null), piece: p => (has(p) ? wordVec(p.text, dim) : null) };
}

function anyLengthTests(ok) {
  const sem = require(path.join(ROOT, 'src', 'core', 'semantic'));
  const i18n = require(path.join(ROOT, 'src', 'i18n'));
  const { st, s } = i18n.withLang('it', demoScenario);
  const plan = s.subs.get('plan1').mind, all = [s.main.mind, plan];
  // i pezzi tengono un estratto corto del testo, in memoria
  const longest = Math.max(...all.flatMap(m => m.pieces.map(p => p.text.length)));
  const act = plan.pieces.find(p => p.kind === 'action');
  ok(longest <= 480 && plan.pieces.every(p => typeof p.text === 'string') && /schema\.sql/.test(act.text) && /→ CREATE TABLE sessions/.test(act.text), `embedding E1: ogni pezzo porta un estratto del testo (al massimo ${longest} caratteri), l'azione anche il suo risultato`);
  // vettori di 8 e di 384 dimensioni: PCA, gruppi, stella polare e deriva funzionano lo stesso
  for (const dim of [8, 384]) {
    const sp = sem.pickSpace([plan], s.corpus, [fakeSpace('onnx:fake-' + dim, dim)]);
    const v = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-dim:' + dim, 0, sp);
    const d = sem.drift(plan, s.corpus, sp);
    const finite = v.pieces.every(p => [5, 6, 7].every(i => Number.isFinite(p[i]))) && v.align.every(r => Number.isFinite(r[1]));
    ok(sp.src === 'onnx:fake-' + dim && v.src === sp.src && v.engine === 'neural' && v.pending === 0 && v.pieces.length === plan.pieces.length && v.clusters.length >= 1 && v.align.length === plan.pieces.filter(p => p.kind === 'action').length && finite && d && typeof d.rel === 'number', `embedding E1: vettori di ${dim} dimensioni (${v.pieces.length} pezzi, ${v.clusters.length} gruppi, deriva ${d && d.rel})`);
  }
  // fonti miste: se lo spazio neurale non copre ogni compito e ogni azione, si resta tutti sul TF-IDF
  const noGoal = fakeSpace('ollama:fake', 16, x => !('label' in x && !('kind' in x)));
  const halfActs = fakeSpace('ollama:fake', 16, x => !(x.kind === 'action' && x.id % 2));
  const onlyActs = fakeSpace('ollama:fake', 16, x => !x.kind || x.kind === 'action');
  ok(sem.pickSpace(all, s.corpus, [noGoal]).src === 'tfidf' && sem.pickSpace(all, s.corpus, [halfActs]).src === 'tfidf' && sem.pickSpace(all, s.corpus, []).src === 'tfidf' && sem.pickSpace(all, s.corpus, null).src === 'tfidf', 'embedding E1: un compito o un\'azione senza vettore neurale → tutto sul TF-IDF, mai un misto');
  const sp = sem.pickSpace(all, s.corpus, [onlyActs]);
  const v = sem.snapshotMinds([{ id: 'main', name: 'CLAUDE', mind: s.main.mind }], s.corpus, 'unit-embed-pending', 0, sp);
  const kinds = new Set(v.pieces.map(p => p[1]));
  ok(sp.src === 'ollama:fake' && v.pending > 0 && v.pieces.length + v.pending === s.main.mind.pieces.length && [...kinds].every(k => k === 'action' || k === 'prompt'), `embedding E1: i pezzi ancora senza vettore restano fuori dalla nuvola (${v.pending} in arrivo), le azioni ci sono tutte`);
  // cambia la fonte con la stessa chiave: si riparte, niente assi presi dall'altra
  const a = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-switch');
  const b = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-switch', 0, fakeSpace('onnx:fake-8', 8));
  const c = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-switch');
  ok(a.src === 'tfidf' && b.src === 'onnx:fake-8' && c.src === 'tfidf' && a !== c && JSON.stringify(a.pieces) === JSON.stringify(c.pieces), 'embedding E1: cambiare fonte e tornare indietro dà gli stessi numeri, senza mischiare');
  st.stop && st.stop();
}

// ---------------------------------------------------------------- E2 · provider, catena, cache, coda
// un provider finto: up dice se risponde, hang non risponde mai, fail sbaglia sempre
function fakeProvider(kind, { dim = 8, model = 'fake', up = true, hang = false, fail = false } = {}) {
  const p = {
    id: kind + ':' + model, dim, model, state: 'unknown', calls: [],
    ready: async () => { p.state = up ? 'ready' : 'not-found'; return up; },
    embed: async (texts, k) => { p.calls.push({ n: texts.length, kind: k, texts }); if (hang) return new Promise(() => {}); if (fail) throw new Error('boom'); return texts.map(t => wordVec(k + ' ' + t, dim)); },
  };
  return p;
}
const facts = map => Object.fromEntries(Object.entries(map).map(([k, f]) => [k, () => f]));
// aspetta che la coda si svuoti
async function settle(emb, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await new Promise(r => setImmediate(r)); if (!emb.queue.size && !emb.busy && !emb.kicked && !emb.resolving) return true; }
  return false;
}

async function providerTests(ok) {
  const embed = require(path.join(ROOT, 'src', 'core', 'embed'));
  const os = require('os');
  // la catena
  const chain = async (engine, o, x) => (await embed.resolveChain(engine, { ollama: o, onnx: x }, { timeoutMs: 200 }));
  const up = () => fakeProvider('ollama'), down = () => fakeProvider('ollama', { up: false }), onnx = () => fakeProvider('onnx'), gone = { id: 'onnx', dim: 0, state: 'not-installed', ready: async () => false };
  const hangReady = { id: 'ollama', dim: 8, ready: () => new Promise(() => {}) };
  let r = await chain('auto', up(), onnx());
  const r2 = await chain('auto', down(), onnx()), r3 = await chain('auto', down(), gone), r4 = await chain('auto', hangReady, onnx());
  ok(r.provider.id === 'ollama:fake' && r2.provider.id === 'onnx:fake' && r3.provider.id === 'tfidf' && !r3.fallback && r4.provider.id === 'onnx:fake', 'embedding E2: in automatico Ollama se risponde, poi ONNX se c\'è, altrimenti TF-IDF (anche se Ollama non risponde in tempo)');
  const f1 = await chain('ollama', down(), onnx()), f2 = await chain('onnx', up(), gone), f3 = await chain('tfidf', up(), onnx()), f4 = await chain('qualcosa', up(), onnx());
  ok(f1.provider.id === 'tfidf' && f1.fallback && f1.fallback.source === 'ollama' && f1.fallback.state === 'not-found' && f2.provider.id === 'tfidf' && f2.fallback.state === 'not-installed' && f3.provider.id === 'tfidf' && !f3.fallback && f4.provider.id === 'tfidf', 'embedding E2: con una fonte scelta che non va si torna al TF-IDF e si dice perché; «tfidf» resta lessicale');
  const gp = embed.getProvider({ embedEngine: 'auto' }, { factories: facts({ ollama: down(), onnx: onnx() }) });
  const gpOk = await gp.ready();
  const v = await gp.embed(['ciao'], 'query');
  ok(gpOk && gp.id === 'onnx:fake' && gp.dim === 8 && v.length === 1 && v[0].length === 8 && typeof gp.ready === 'function', 'embedding E2: getProvider(settings) → {id, dim, embed, ready} con la catena dentro');

  // la coda: lotti di 16, priorità, una fonte alla volta
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-embed-'));
  try {
    const p1 = up();
    let emb = new embed.Embedder({ settings: { embedEngine: 'auto' }, dir, factories: facts({ ollama: p1, onnx: gone }), timeoutMs: 300 });
    ok(emb.space(0) === null, 'embedding E2: finché la catena non ha scelto si usa il TF-IDF (nessuno spazio neurale)');
    await settle(emb);
    let sp = emb.space(1);
    const docs = Array.from({ length: 40 }, (_, i) => ({ text: 'pezzo numero ' + i + ' del contesto' }));
    const first = docs.map(d => sp.piece(d));
    const goal = { text: 'rifai il login' };
    ok(first.every(x => x === null) && sp.goal(goal) === null && sp.src === 'ollama:fake', 'embedding E2: un vettore che non c\'è ancora → null, e va in coda');
    await settle(emb);
    const sizes = p1.calls.map(c => c.n + c.kind[0]).join(',');
    ok(p1.calls.length >= 3 && p1.calls.every(c => c.n <= 16) && p1.calls[0].kind === 'document' && p1.calls.some(c => c.kind === 'query'), `embedding E2: lotti di al massimo 16 testi, compito e pezzi a parte (${sizes})`);
    sp = emb.space(1);
    ok(docs.every(d => sp.piece(d) && sp.piece(d).length === 8) && sp.goal(goal) && sp.version > 1, 'embedding E2: quando arrivano i vettori lo spazio li ha (e la versione cresce)');
    // priorità: chi si sta guardando passa davanti
    p1.calls.length = 0;
    const low = Array.from({ length: 20 }, (_, i) => ({ text: 'sottofondo ' + i }));
    const hi = Array.from({ length: 3 }, (_, i) => ({ text: 'visibile ' + i }));
    const spl = emb.space(1), sph = emb.space(0);
    low.forEach(x => spl.piece(x)); hi.forEach(x => sph.piece(x));
    await settle(emb);
    ok(p1.calls[0] && hi.every(x => p1.calls[0].texts.includes(x.text)), 'embedding E2: la priorità va agli agenti visibili');
    // la cache su disco: solo vettori e hash, mai il testo; una nuova istanza non richiede di nuovo
    await emb.disks.get('ollama:fake').chain;
    const file = path.join(dir, embed.fileOf('ollama:fake'));
    const raw = fs.readFileSync(file);
    ok(raw.length > 16 && !raw.includes(Buffer.from('pezzo numero')) && !raw.includes(Buffer.from('visibile')) && raw.subarray(0, 8).toString() === 'PLEMB001', `embedding E2: cache su disco in embed-cache/${path.basename(file)} (${raw.length} byte), niente testo dentro`);
    const p2 = up();
    emb = new embed.Embedder({ settings: { embedEngine: 'auto' }, dir, factories: facts({ ollama: p2, onnx: gone }) });
    emb.space(1); await settle(emb); // la catena sceglie al primo uso
    sp = emb.space(1);
    docs.forEach(d => sp.piece(d));
    await settle(emb);
    sp = emb.space(1);
    ok(p2.calls.length === 0 && docs.every(d => sp.piece(d)), 'embedding E2: alla ripartenza i vettori vengono dal disco, senza chiedere di nuovo');
    // un altro modello con lo stesso nome (altra dimensione): la cache si butta, non si mischia
    const p3 = fakeProvider('ollama', { dim: 12 });
    emb = new embed.Embedder({ settings: { embedEngine: 'auto' }, dir, factories: facts({ ollama: p3, onnx: gone }) });
    emb.space(1); await settle(emb); // la catena sceglie al primo uso
    sp = emb.space(1); sp.piece(docs[0]); await settle(emb);
    ok(p3.calls.length === 1 && emb.space(1).piece(docs[0]).length === 12, 'embedding E2: vettori su disco di un\'altra dimensione → si ricalcolano');
    // tetti: memoria (LRU) e disco
    const p4 = up();
    emb = new embed.Embedder({ settings: { embedEngine: 'auto' }, dir: path.join(dir, 'small'), factories: facts({ ollama: p4, onnx: gone }), memCap: 10, diskCap: 2000 });
    emb.space(1); await settle(emb); // la catena sceglie al primo uso
    sp = emb.space(1);
    const many = Array.from({ length: 60 }, (_, i) => ({ text: 'riga ' + i }));
    many.forEach(x => sp.piece(x));
    await settle(emb);
    await emb.disks.get('ollama:fake').chain;
    const st1 = emb.status();
    ok(st1.cache.vectors === 10 && st1.cache.diskBytes > 0 && st1.cache.diskBytes <= 2000, `embedding E2: tetti rispettati (memoria ${st1.cache.vectors} vettori, disco ${st1.cache.diskBytes} byte)`);
    await emb.clearCache();
    const st2 = emb.status();
    ok(st2.cache.vectors === 0 && st2.cache.diskBytes === 0 && !fs.readdirSync(path.join(dir, 'small')).some(f => f.endsWith('.bin')), 'embedding E2: «svuota la cache» toglie memoria e file');
    // tempo scaduto e tre fallimenti di fila: sospesa per 5 minuti, si torna al TF-IDF
    let now = Date.parse('2026-11-18T10:00:00Z');
    const slow = fakeProvider('ollama', { hang: true });
    emb = new embed.Embedder({ settings: { embedEngine: 'ollama' }, factories: facts({ ollama: slow, onnx: gone }), timeoutMs: 40, now: () => now });
    emb.space(1); await settle(emb); // la catena sceglie al primo uso
    for (let i = 0; i < 3; i++) { const s3 = emb.space(1); if (s3) s3.piece({ text: 'lento ' + i }); await settle(emb); }
    const st3 = emb.status();
    ok(slow.calls.length === 3 && st3.active === 'tfidf' && st3.sources.ollama.state === 'error' && /timeout/.test(st3.sources.ollama.detail) && st3.fallback && st3.fallback.source === 'ollama' && emb.space(1) === null, `embedding E2: 3 richieste oltre il tempo → sospesa, TF-IDF e il motivo (${st3.sources.ollama.detail})`);
    now += embed.SUSPEND_MS + 1000;
    slow.embed = async texts => texts.map(t => wordVec(t, 8));
    emb.space(1); await settle(emb);
    ok(emb.status().active === 'ollama:fake' && emb.space(1) !== null, 'embedding E2: dopo 5 minuti ci si riprova');
    // in automatico una fonte sospesa lascia il posto alla successiva
    const bad = fakeProvider('ollama', { fail: true }), alt = onnx();
    emb = new embed.Embedder({ settings: { embedEngine: 'auto' }, factories: facts({ ollama: bad, onnx: alt }), timeoutMs: 100 });
    emb.space(1); await settle(emb); // la catena sceglie al primo uso
    for (let i = 0; i < 3; i++) { const s4 = emb.space(1); if (s4) s4.piece({ text: 'errore ' + i }); await settle(emb); }
    ok(emb.status().active === 'onnx:fake' && !emb.status().fallback && bad.calls.length === 3, 'embedding E2: in automatico, dopo 3 errori di Ollama si passa all\'ONNX');
    // con semantic.js: prima il TF-IDF subito, poi lo spazio neurale quando ha tutti i compiti e tutte le azioni
    const sem = require(path.join(ROOT, 'src', 'core', 'semantic'));
    const { st, s } = require(path.join(ROOT, 'src', 'i18n')).withLang('it', demoScenario);
    const plan = s.subs.get('plan1').mind;
    const before = sem.pickSpace([plan], s.corpus, [emb.space(0)]);
    await settle(emb);
    const after = sem.pickSpace([plan], s.corpus, [emb.space(0)]);
    const snap0 = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-e2', 0, after);
    await settle(emb);
    const snap = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-e2', 0, emb.space(0));
    ok(before.src === 'tfidf' && after.src === 'onnx:fake' && snap0.pending > 0 && snap.src === 'onnx:fake' && snap.pending === 0 && snap.align.length === plan.pieces.filter(p => p.kind === 'action').length, `embedding E2: la bolla parte col TF-IDF e passa a ${after.src} quando i vettori ci sono tutti`);
    st.stop && st.stop();
    // un provider che dice di essere "freddo" ha più tempo, sia per ready() sia per la prima richiesta
    const slowCold = { ...fakeProvider('ollama'), readyTimeoutMs: 1000, timeoutFor: () => 1000 };
    slowCold.ready = async () => { await new Promise(r => setTimeout(r, 150)); slowCold.state = 'ready'; return true; };
    slowCold.embed = async texts => { await new Promise(r => setTimeout(r, 150)); return texts.map(t => wordVec(t, 8)); };
    const embCold = new embed.Embedder({ settings: { embedEngine: 'ollama' }, factories: facts({ ollama: slowCold, onnx: gone }), timeoutMs: 50 });
    embCold.space(1); await settle(embCold);
    const sc = embCold.space(1); sc && sc.piece({ text: 'a freddo' }); await settle(embCold);
    ok(embCold.status().active === 'ollama:fake' && embCold.space(1).piece({ text: 'a freddo' }) && !embCold.status().fallback, 'embedding E2: la coda dà al modello "freddo" il tempo di caricarsi (readyTimeoutMs, timeoutFor) invece di sospenderlo');
    // cambiare le opzioni rifà la catena e riparte da zero
    ok(emb.configure({ embedEngine: 'tfidf' }) === true && emb.configure({ embedEngine: 'tfidf' }) === false && emb.space(1) === null, 'embedding E2: cambiare motore rifà la catena (e lo stesso valore non fa niente)');
    await settle(emb);
    ok(emb.status().active === 'tfidf' && embed.cleanEngine('xyz') === 'tfidf', 'embedding E2: «solo lessicale» resta TF-IDF');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- E3 · Ollama finto
// Un server che risponde come Ollama, con vettori deterministici (parole sparse in 16 posizioni).
// o.models: i modelli di /api/tags; o.legacy: niente /api/embed (Ollama vecchio); o.delayMs: risposte lente.
function fakeOllama(o = {}) {
  const http = require('http');
  const opts = { models: [{ name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } }, { name: 'llama3.2:latest', details: { family: 'llama' } }], legacy: false, delayMs: 0, coldMs: 0, dim: 16, ...o };
  let warm = false; // coldMs: il primo /api/embed carica il modello e ci mette di più, come un Ollama vero
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
      log.push({ method: req.method, url: req.url, body: j });
      const send = (code, obj) => setTimeout(() => { if (!res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } }, opts.delayMs);
      const known = name => opts.models.some(m => m.name === name);
      if (req.method === 'GET' && req.url === '/api/tags') return send(200, { models: opts.models });
      if (req.method === 'POST' && req.url === '/api/embed' && !warm && opts.coldMs) { warm = true; return setTimeout(() => res.end(JSON.stringify({ model: j.model, embeddings: (j.input || []).map(t => Array.from(wordVec(t, opts.dim))) })), opts.coldMs); }
      if (req.method === 'POST' && req.url === '/api/embed') {
        if (opts.legacy) return send(404, '404 page not found');
        if (!known(j.model)) return send(404, { error: `model "${j.model}" not found, try pulling it first` });
        return send(200, { model: j.model, embeddings: (j.input || []).map(t => Array.from(wordVec(t, opts.dim))) });
      }
      if (req.method === 'POST' && req.url === '/api/embeddings') {
        if (!known(j.model)) return send(404, { error: `model "${j.model}" not found, try pulling it first` });
        return send(200, { embedding: Array.from(wordVec(j.prompt, opts.dim)) });
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + server.address().port, opts, log, close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) })));
}

async function ollamaTests(ok) {
  const ollama = require(path.join(ROOT, 'src', 'core', 'embed', 'ollama'));
  const srv = await fakeOllama();
  try {
    // il caso normale: sceglie il modello di embedding, impara la dimensione, mette i prefissi del modello
    let p = ollama.create({ ollamaUrl: srv.url }, { timeoutMs: 1000 });
    const r = await p.ready();
    const v = await p.embed(['aggiusta il login', 'correggi l\'autenticazione'], 'document');
    const last = srv.log[srv.log.length - 1];
    ok(r && p.state === 'ready' && p.id === 'ollama:nomic-embed-text:latest' && p.dim === 16 && v.length === 2 && v[0].length === 16 && last.url === '/api/embed' && Array.isArray(last.body.input) && last.body.input[0] === 'search_document: aggiusta il login', `embedding E3: Ollama finto → ${p.id}, ${p.dim} dimensioni, una richiesta per lotto con i prefissi del modello`);
    ok(srv.log[0].url === '/api/tags' && !srv.log.some(x => /pull/.test(x.url)), 'embedding E3: guarda /api/tags e non scarica niente');
    // la scelta del modello
    const M = n => ({ name: n });
    ok(ollama.pickModel([M('llama3.2:latest'), M('nomic-embed-text:latest'), M('bge-m3:latest')]) === 'bge-m3:latest' && ollama.pickModel([M('snowflake-arctic-embed2:latest'), M('qwen3-embedding:4b'), M('qwen3-embedding:0.6b'), M('nomic-embed-text:latest')]) === 'qwen3-embedding:0.6b' && ollama.pickModel([M('llama3.2:latest'), M('mxbai-embed-large:latest')]) === 'mxbai-embed-large:latest' && ollama.pickModel([M('llama3.2:latest')]) === null && ollama.pickModel([M('bge-m3:latest')], 'bge-m3') === 'bge-m3:latest' && ollama.pickModel([M('bge-m3:latest')], 'e5') === null, 'embedding E3: il modello: quello scelto, altrimenti il primo di embedding, prima i multilingue');
    ok(ollama.prefix('jeffh/intfloat-multilingual-e5-small:f16', 'query') === 'query: ' && ollama.prefix('multilingual-e5-small', 'document') === 'passage: ' && ollama.prefix('bge-m3:latest', 'query') === '', 'embedding E3: prefissi e5 (query:/passage:), nessuno per bge-m3');
    // un modello che non c'è: si dice, con il comando da lanciare (non lo lancia)
    p = ollama.create({ ollamaUrl: srv.url, embedModel: 'bge-m3' }, { timeoutMs: 1000 });
    ok(!(await p.ready()) && p.state === 'not-found' && p.hint === 'ollama pull bge-m3' && /bge-m3/.test(p.detail), `embedding E3: modello mancante → «${p.detail}», suggerisce «${p.hint}»`);
    srv.opts.models = [{ name: 'llama3.2:latest', details: { family: 'llama' } }];
    p = ollama.create({ ollamaUrl: srv.url }, { timeoutMs: 1000 });
    ok(!(await p.ready()) && p.state === 'not-found' && p.hint === 'ollama pull ' + ollama.SUGGESTED, `embedding E3: nessun modello di embedding → «${p.hint}»`);
    // Ollama vecchio: /api/embeddings un testo alla volta
    srv.opts.models = [{ name: 'all-minilm:latest', details: { family: 'bert' } }]; srv.opts.legacy = true;
    p = ollama.create({ ollamaUrl: srv.url }, { timeoutMs: 1000 });
    const rl = await p.ready(), vl = await p.embed(['uno', 'due', 'tre'], 'document');
    ok(rl && p.legacy && vl.length === 3 && srv.log.filter(x => x.url === '/api/embeddings').length === 4, 'embedding E3: Ollama vecchio (senza /api/embed) → /api/embeddings, un testo alla volta');
    srv.opts.legacy = false;
    // tempo scaduto
    srv.opts.delayMs = 400;
    p = ollama.create({ ollamaUrl: srv.url }, { timeoutMs: 100 });
    const t0 = Date.now(), rt = await p.ready();
    ok(!rt && p.state === 'not-found' && /timeout/.test(p.detail) && Date.now() - t0 < 350, `embedding E3: Ollama troppo lento → non pronto in ${Date.now() - t0} ms («${p.detail}»)`);
    srv.opts.delayMs = 0;
    p = ollama.create({ ollamaUrl: srv.url }, { timeoutMs: 100 });
    await p.ready(); srv.opts.delayMs = 400;
    let err = ''; try { await p.embed(['lento'], 'document'); } catch (e) { err = e.message; }
    ok(/timeout/.test(err), 'embedding E3: una richiesta di vettori oltre il tempo è un errore (la coda conta i fallimenti)');
    // a freddo: il primo uso carica il modello e può durare più di 5 s; interromperlo farebbe annullare il caricamento
    srv.opts.delayMs = 0; srv.opts.coldMs = 300;
    let clock = Date.parse('2026-11-18T10:00:00Z');
    const pw = ollama.create({ ollamaUrl: srv.url }, { timeoutMs: 100, loadMs: 1000, now: () => clock });
    const cold = pw.timeoutFor(), rw = await pw.ready(), warmMs = pw.timeoutFor();
    const lastEmbed = srv.log.filter(x => x.url === '/api/embed').pop();
    clock += 10 * 60 * 1000;
    ok(cold === 1000 && rw && pw.dim === 16 && warmMs === 100 && pw.timeoutFor() === 1000 && pw.readyTimeoutMs === 1100 && lastEmbed.body.keep_alive === ollama.KEEP_ALIVE, `embedding E3: a freddo il modello ha tempo per caricarsi (300 ms con 100 ms di limite a caldo), poi resta caricato ${ollama.KEEP_ALIVE} e valgono di nuovo i tempi brevi`);
    srv.opts.delayMs = 0;
  } finally { await srv.close(); }
  // Ollama spento: la porta non risponde
  const off = ollama.create({ ollamaUrl: srv.url }, { timeoutMs: 1000 });
  ok(!(await off.ready()) && off.state === 'not-found' && /not answering/.test(off.detail), `embedding E3: Ollama spento → «${off.detail}»`);
  // solo loopback
  const hosts = ['http://192.168.1.5:11434', 'http://example.com:11434', 'http://127.0.0.1.evil.example:11434', 'http://user:pw@127.0.0.1:11434', 'ftp://127.0.0.1', 'http://10.0.0.1'];
  const goodHosts = ['http://127.0.0.1:11434', 'localhost:11434', 'http://[::1]:11434', 'https://localhost:8443', ''];
  ok(hosts.every(h => ollama.loopbackUrl(h) === null) && goodHosts.every(h => ollama.loopbackUrl(h)), 'embedding E3: accetta solo 127.0.0.1, ::1 e localhost');
  const far = ollama.create({ ollamaUrl: 'http://192.168.1.5:11434' });
  ok(!(await far.ready()) && far.state === 'error' && /loopback/.test(far.detail), 'embedding E3: un host che non è di loopback si rifiuta senza chiamarlo');
  const { OfficeState, DEFAULT_SETTINGS } = require(path.join(ROOT, 'src', 'core', 'state'));
  const st = new OfficeState({ settings: {} });
  ok(DEFAULT_SETTINGS.embedEngine === 'auto' && st.settings.embedEngine === 'auto' && DEFAULT_SETTINGS.ollamaUrl === 'http://127.0.0.1:11434', 'embedding: di base il significato è automatico (Ollama locale se risponde, altrimenti lessicale)');
  st.setSettings({ ollamaUrl: 'http://localhost:11500' });
  st.setSettings({ ollamaUrl: 'http://example.com:11434', embedEngine: 'boh', embedModel: 'bge-m3 ; rm -rf' });
  // per le opzioni: check() guarda solo /api/tags, senza caricare il modello
  const srv2 = await fakeOllama();
  const pc = ollama.create({ ollamaUrl: srv2.url });
  const rc = await pc.check();
  ok(rc && pc.state === 'ready' && pc.model === 'nomic-embed-text:latest' && pc.dim === 0 && srv2.log.every(x => x.url === '/api/tags'), 'embedding E6: il controllo per le opzioni legge solo /api/tags (nessun modello caricato)');
  await srv2.close();
  ok(st.settings.ollamaUrl === 'http://localhost:11500' && st.settings.embedEngine === 'tfidf' && st.settings.embedModel === 'bge-m3rm-rf', `embedding E3: le opzioni rifiutano un host esterno (resta ${st.settings.ollamaUrl}) e ripuliscono motore e modello`);
  st.stop && st.stop();
}

// ---------------------------------------------------------------- E4 · ONNX con un modulo finto
// Un transformers.js finto (CommonJS): vettori deterministici di 12 dimensioni, rifiuta di girare se i modelli remoti
// non sono spenti, e sbaglia apposta con il testo «BOOM».
const FAKE_TRANSFORMERS = `'use strict';
const env = {};
${wordVec.toString()}
async function pipeline(task, model, opts) {
  if (env.allowRemoteModels !== false) throw new Error('remote models must be off');
  if (task !== 'feature-extraction') throw new Error('task ' + task);
  return async (texts, o) => {
    if (!o || o.pooling !== 'mean' || !o.normalize) throw new Error('pooling');
    if (texts.some(t => /BOOM/.test(t))) throw new Error('fake failure');
    const dim = 12, data = new Float32Array(texts.length * dim);
    texts.forEach((t, i) => data.set(wordVec(t, dim), i * dim));
    return { dims: [texts.length, dim], data };
  };
}
module.exports = { env, pipeline };
`;

async function onnxTests(ok) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const onnxLoader = require(path.join(ROOT, 'src', 'core', 'embed', 'onnx'));
  const mod = require(path.join(ROOT, 'optional', 'embed-onnx'));
  const embed = require(path.join(ROOT, 'src', 'core', 'embed'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-onnx-'));
  const fake = path.join(dir, 'fake-transformers.js'), models = path.join(dir, 'models');
  fs.writeFileSync(fake, FAKE_TRANSFORMERS);
  const stops = [];
  try {
    // il modulo che manca, i pacchetti che mancano, il modello che manca: «non installato», con il comando
    const a = onnxLoader.create({}, { onnxModule: path.join(dir, 'non-esiste') });
    const b = onnxLoader.create({}, { modelsDir: models, transformers: path.join(dir, 'non-esiste.js') });
    const c = onnxLoader.create({}, { modelsDir: models, transformers: fake });
    const ra = await a.ready(), rb = await b.ready(), rc = await c.ready();
    ok(!ra && !rb && !rc && [a, b, c].every(p => p.state === 'not-installed' && p.hint === 'npm run embed:onnx:install') && /missing/.test(a.detail) && /packages/.test(b.detail) && /model not downloaded/.test(c.detail), 'embedding E4: modulo, pacchetti o modello mancanti → «non installato», con «npm run embed:onnx:install»');
    // con il modello "scaricato" (il segno lasciato dall'installazione): gira in un worker_thread
    fs.mkdirSync(path.dirname(mod.markerOf(models)), { recursive: true });
    fs.writeFileSync(mod.markerOf(models), '{}');
    const p = onnxLoader.create({}, { modelsDir: models, transformers: fake });
    stops.push(p);
    const r = await p.ready();
    const [q, d] = [await p.embed(['rifai il login'], 'query'), await p.embed(['correggi l\'autenticazione'], 'document')];
    const same = (x, y) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
    ok(r && p.state === 'ready' && p.id === 'onnx:Xenova/multilingual-e5-small' && p.dim === 12 && p.worker && p.worker.threadId > 0 && same(q[0], wordVec('query: rifai il login', 12)) && same(d[0], wordVec('passage: correggi l\'autenticazione', 12)), `embedding E4: modulo finto → ${p.id}, ${p.dim} dimensioni, in un worker_thread (n. ${p.worker && p.worker.threadId}), prefissi e5 query:/passage:`);
    let err = ''; try { await p.embed(['BOOM'], 'document'); } catch (e) { err = e.message; }
    const after = await p.embed(['ancora'], 'document');
    ok(/fake failure/.test(err) && after.length === 1, 'embedding E4: un errore del modello arriva come errore, e il worker resta in piedi');
    // nella catena: Ollama spento, ONNX installato → ONNX
    const emb = new embed.Embedder({ settings: { embedEngine: 'auto' }, factories: { ollama: () => fakeProvider('ollama', { up: false }), onnx: (s, deps) => onnxLoader.create(s, deps) }, deps: { modelsDir: models, transformers: fake } });
    stops.push(emb);
    emb.space(1); await settle(emb, 10000);
    const st = emb.status();
    ok(st.active === 'onnx:Xenova/multilingual-e5-small' && st.sources.onnx.state === 'ready' && st.sources.ollama.state === 'not-found', 'embedding E4: in automatico, con Ollama spento, la catena prende l\'ONNX installato');
    // nel motore vero di questa cartella, senza installazione: non installato
    if (!mod.installed()) {
      const real = onnxLoader.create({}, { modelsDir: models });
      ok(!(await real.ready()) && real.state === 'not-installed', 'embedding E4: qui il provider ONNX non è installato, e lo dice');
    }
    // l'installazione chiede conferma, dice quanto pesa e, se la risposta è no, non scarica niente
    const env = { ...process.env, PLATYPUS_DATA_DIR: path.join(dir, 'data') };
    const before = fs.existsSync(path.join(ROOT, 'optional', 'embed-onnx', 'node_modules'));
    const ins = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'embed-onnx-install.js')], { input: 'n\n', encoding: 'utf8', env, timeout: 20000 });
    ok(ins.status === 1 && /118 MB/.test(ins.stdout) && /Annullato/.test(ins.stdout) && fs.existsSync(path.join(ROOT, 'optional', 'embed-onnx', 'node_modules')) === before && !fs.existsSync(path.join(dir, 'data', 'models')), 'embedding E4: «npm run embed:onnx:install» chiede conferma con le dimensioni; con «no» non scarica niente');
  } finally {
    for (const x of stops) x.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- E5 · calibrazione, una regola in tre posti
// la regola come la vede la pagina: drift-rule.js caricato come script in un contesto senza module
function ruleAsInPage() {
  const vm = require('vm');
  const sandbox = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'core', 'drift-rule.js'), 'utf8'), sandbox);
  return sandbox.self.PlatypusDrift;
}

function calibrationTests(ok) {
  const sem = require(path.join(ROOT, 'src', 'core', 'semantic'));
  const rule = require(path.join(ROOT, 'src', 'core', 'drift-rule'));
  const ev = require('./embed-eval');
  // la calibrazione gira sul TF-IDF e dice quello che sappiamo: buono sulle parole, cieco sui sinonimi
  const r = ev.evaluate('tfidf', x => sem.tfidfSpace(x.corpus));
  ok(r.tasks >= 30 && r.auc > 0.7 && r.aucSyn < r.auc && r.current.rel === 0.35 && r.current.tpr >= 0.75 && r.current.fpr <= 0.05 && r.weak.current === 0.031, `embedding E5: calibrazione TF-IDF su ${r.tasks} compiti → AUC ${r.auc} (sinonimi ${r.aucSyn}), deriva con 0,35: veri ${r.current.tpr}, falsi ${r.current.fpr}`);
  // una fonte di prova (parole sparse in 64 dimensioni): la stessa misura funziona con vettori di altra lunghezza e con il fondo
  const word = ev.evaluate('test:word64', x => fakeSpace('test:word64', 64), { base: { ...rule.TFIDF, zero: 0.05 } });
  ok(Number.isFinite(word.auc) && Number.isFinite(word.relAuc) && word.best.rel > 0 && word.zero >= 0, `embedding E5: la misura funziona con qualsiasi fonte (prova a 64 dimensioni: AUC ${word.auc}, soglia migliore ${word.best.rel})`);
  // E7 · il provider finto della demo: la riga della tabella è quella che la misura propone, e batte il TF-IDF
  const fake = require(path.join(ROOT, 'src', 'core', 'embed', 'fake'));
  const fr = ev.evaluate(fake.ID, () => ({ src: fake.ID, goal: g => fake.vector(g.text), piece: p => fake.vector(p.text) }), { base: { ...rule.TFIDF }, calibrate: true });
  const row = rule.TABLE[fake.ID];
  ok(row && row.rel === fr.chosen.rel && row.weak === fr.weak.suggested && row.zero === fr.used.zero && row.widen === fr.used.widen && row.warn === +Math.min(0.95, fr.chosen.rel + 0.25).toFixed(2), `embedding E7: la riga «${fake.ID}» di drift-rule.js è quella misurata (rel ${fr.chosen.rel}, weak ${fr.weak.suggested}, zero ${fr.used.zero}, widen ${fr.used.widen})`);
  ok(fr.auc > r.auc && fr.aucSyn > r.aucSyn + 0.2 && fr.chosen.tpr >= r.current.tpr && fr.chosen.fpr === 0 && fr.weak.unmeasurableMax < fr.weak.suggested, `embedding E7: sull'insieme il provider finto batte il TF-IDF (AUC ${fr.auc} contro ${r.auc}, sinonimi ${fr.aucSyn} contro ${r.aucSyn})`);
  // la tabella: il TF-IDF con i numeri di sempre; una fonte neurale senza misure non giudica
  const un = rule.thresholdsFor('ollama:nomic-embed-text:v1.5');
  ok(rule.thresholdsFor('tfidf') === rule.TFIDF && rule.TFIDF.rel === 0.35 && rule.TFIDF.run === 6 && rule.TFIDF.weak === 0.031 && rule.TFIDF.floor === 0.03 && un.calibrated === false, 'embedding E5: soglie per fonte: TF-IDF 0,35 · 6 · 0,031 · 0,03; una fonte neurale non misurata (o che non batte il TF-IDF) è «non calibrata»');
  // i modelli di Ollama misurati: una riga ciascuno, trovata anche con ":latest", con valori sensati
  const measured = Object.keys(rule.TABLE).filter(k => k.startsWith('ollama:'));
  const sane = t => t.calibrated && t.run === 6 && t.rel > 0 && t.rel < 1 && t.warn > t.rel && t.weak > t.floor && t.zero >= 0 && t.zero < 1 && t.widen >= 0 && t.widen < 1;
  ok(measured.length === 6 && measured.every(k => sane(rule.TABLE[k])) && rule.thresholdsFor('ollama:bge-m3:latest') === rule.TABLE['ollama:bge-m3'] && rule.thresholdsFor('ollama:qwen3-embedding:0.6b') === rule.TABLE['ollama:qwen3-embedding:0.6b'], `embedding E5: ${measured.length} modelli di Ollama misurati nella tabella (${measured.map(k => k.slice(7)).join(', ')})`);
  const ollamaMod = require(path.join(ROOT, 'src', 'core', 'embed', 'ollama'));
  ok(ollamaMod.SUGGESTED === 'qwen3-embedding:0.6b' && rule.thresholdsFor('ollama:' + ollamaMod.SUGGESTED).calibrated, 'embedding E5: il modello proposto è quello misurato meglio, e ha la sua riga');
  // una regola in tre posti: motore, feedback e mappa danno la stessa risposta sulle stesse righe
  const { st, s } = require(path.join(ROOT, 'src', 'i18n')).withLang('it', demoScenario);
  const plan = s.subs.get('plan1').mind, page = ruleAsInPage();
  const al = sem.alignment(plan, s.corpus), d = sem.drift(plan, s.corpus), pj = page.judge(al, page.thresholdsFor('tfidf'));
  ok(d.drifting && pj.drifting && pj.run === d.run && pj.rel === d.rel && pj.weak === d.weak && pj.state === 'drifting', `embedding E5: motore e mappa (drift-rule.js come script della pagina) danno la stessa risposta: alla deriva da ${pj.run} azioni`);
  const snap = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-e5');
  ok(JSON.stringify(snap.th) === JSON.stringify(rule.TFIDF) && JSON.stringify(page.judge(snap.align, snap.th)) === JSON.stringify(rule.judge(al, rule.TFIDF)), 'embedding E5: /api/agentmind dice alla mappa con quali soglie sono calcolate le righe (th)');
  // la mappa non ha più i numeri scritti dentro, e carica la regola prima di sé
  const wm = fs.readFileSync(path.join(ROOT, 'renderer', 'worldmap.js'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const star = wm.slice(wm.indexOf('function drawStar'), wm.indexOf('function drawComposition'));
  ok(!/0\.35|0\.031|run >= 6/.test(star) && /RULE\.judge\(al, th\)/.test(star) && html.indexOf('drift-rule.js') > 0 && html.indexOf('drift-rule.js') < html.indexOf('worldmap.js'), 'embedding E5: la mappa usa drift-rule.js e le soglie della fonte, non 0,35 / 6 / 0,031 scritti a mano');
  // fonte neurale non calibrata: righe e nuvola sì, giudizio no (né la mappa né il feedback)
  const neural = fakeSpace('ollama:fake', 16);
  const dn = sem.drift(plan, s.corpus, neural), sn = sem.snapshotMinds([{ id: 'plan1', name: 'PLAN', mind: plan }], s.corpus, 'unit-embed-e5n', 0, neural);
  const pn = page.judge(sn.align, sn.th);
  ok(dn && dn.weak && dn.uncalibrated && !dn.drifting && dn.src === 'ollama:fake' && pn.weak && pn.uncalibrated && sn.th.calibrated === false, 'embedding E5: con una fonte non calibrata motore e mappa dicono «non misurabile», mai una deriva inventata');
  const rules = require(path.join(ROOT, 'src', 'core', 'feedback-rules'));
  const inp = { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: {}, tool_response: {} };
  const me = sp => ({ id: 'plan1', steps: [], nodes: new Map(), goals: plan.goals, mind: plan, corpus: s.corpus, space: sp });
  ok(rules.driftBack(inp, { agent: () => me(null) }) && rules.driftBack(inp, { agent: () => me(sem.tfidfSpace(s.corpus)) }) && rules.driftBack(inp, { agent: () => me(neural) }) === null, 'embedding E5: il feedback «ritorno al compito» passa da drift(): TF-IDF come prima, fonte non calibrata → niente');
  // il fondo (zero) e il minimo della base vengono dalla tabella della fonte
  const th = { ...rule.TFIDF, zero: 0.5, floor: 0.2 };
  const raw = sem.alignment(plan, s.corpus, neural), resc = sem.alignment(plan, s.corpus, { ...neural, th });
  ok(resc.every((row, i) => Math.abs(row[1] - Math.max(0, (raw[i][1] - 0.5) / 0.5)) < 0.002 && row[3] >= 0.2), 'embedding E5: i punteggi si riscalano dal fondo della fonte, e la base non scende sotto il suo minimo');
  st.stop && st.stop();
}

async function run(ok) {
  console.log('significato (embedding)');
  pinnedTests(ok);
  anyLengthTests(ok);
  await providerTests(ok);
  await ollamaTests(ok);
  await onnxTests(ok);
  calibrationTests(ok);
}

module.exports = { run, demoScenario, fakeOllama, wordVec };

if (require.main === module) {
  let failed = 0;
  run((cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; }).then(() => process.exit(failed ? 1 : 0));
}
