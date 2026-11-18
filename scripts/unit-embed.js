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
  for (const k of Object.keys(want)) ok(JSON.stringify(got[k]) === JSON.stringify(want[k]), `embedding E1: con il solo TF-IDF i numeri di /api/agentmind (${k}) restano identici`);
  ok(got.drift.plan1 && got.drift.plan1.drifting && got.main.align.length === 10, `embedding E1: scenario della demo (Plan alla deriva dopo ${got.drift.plan1 && got.drift.plan1.run} azioni, ${got.main.align.length} azioni di CLAUDE)`);
  st.stop && st.stop();
}

// uno spazio finto di lunghezza qualsiasi: parole del testo sparse con un hash in dim posizioni, poi normalizzate.
// has(x) decide quali vettori sono "già arrivati".
function fakeSpace(src, dim, has = () => true) {
  const vec = text => {
    const v = new Float32Array(dim);
    for (const w of String(text || '').toLowerCase().split(/[^a-z0-9àèéìòù]+/).filter(x => x.length > 2)) { let h = 7; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % dim] += 1; }
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < dim; i++) v[i] /= n;
    return v;
  };
  return { src, version: 1, goal: g => (has(g) ? vec(g.text) : null), piece: p => (has(p) ? vec(p.text) : null) };
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

function run(ok) {
  console.log('significato (embedding)');
  pinnedTests(ok);
  anyLengthTests(ok);
}

module.exports = { run, demoScenario };

if (require.main === module) {
  let failed = 0;
  run((cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; });
  process.exit(failed ? 1 : 0);
}
