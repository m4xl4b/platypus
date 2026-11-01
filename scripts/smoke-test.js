#!/usr/bin/env node
'use strict';
// Prova veloce che gira uguale su Windows, macOS e Linux (anche nelle GitHub Actions):
// sintassi di tutti i file, traduzioni, motore con la demo, API principali, hook.
// Non tocca la tua configurazione: usa cartelle temporanee.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|dist|\.git|locales)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
function get(port, p, method = 'GET', body) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`Platypus smoke test · ${process.platform} ${process.arch} · Node ${process.versions.node}`);

  console.log('sintassi');
  for (const f of walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'renderer')), walk(path.join(ROOT, 'scripts')))) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) ok(false, path.relative(ROOT, f) + '\n' + r.stderr);
  }
  ok(true, 'node --check su tutti i file');

  console.log('traduzioni');
  const i = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'i18n-check.js')], { encoding: 'utf8' });
  ok(i.status === 0, i.stdout.trim());

  require('./unit-test').run(ok);
  require('./unit-claudemd').run(ok);
  require('./unit-surprise').run(ok);
  require('./unit-engine').run(ok);

  console.log('motore');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  const base = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  // una sessione finta di Claude Code nella cartella di prova: il libro della bottega deve impararci qualcosa
  const fakeCwd = path.join(tmp, 'progetto');
  const fakeDir = path.join(base, 'projects', 'progetto-finto');
  fs.mkdirSync(fakeDir, { recursive: true });
  const T0 = Date.now() - 60000, at = k => new Date(T0 + k * 1000).toISOString();
  const asst = (k, id, name, input) => ({ type: 'assistant', timestamp: at(k), sessionId: 'bottega-smoke-0001', cwd: fakeCwd, message: { id: 'm' + k, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 10 } } });
  const res = (k, id, err, content) => ({ type: 'user', timestamp: at(k), sessionId: 'bottega-smoke-0001', cwd: fakeCwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content }] } });
  fs.writeFileSync(path.join(fakeDir, 'bottega-smoke-0001.jsonl'), [
    { type: 'user', timestamp: at(0), sessionId: 'bottega-smoke-0001', cwd: fakeCwd, message: { role: 'user', content: 'Sistema il login' } },
    asst(1, 't1', 'Read', { file_path: path.join(fakeCwd, 'src', 'vecchio.ts') }), res(2, 't1', true, 'File does not exist.'),
    asst(3, 't2', 'Bash', { command: 'npm test' }), res(4, 't2', true, 'FAIL src/a.test.ts\nTests: 1 failed'),
    asst(5, 't3', 'Bash', { command: 'npm test' }), res(6, 't3', true, 'FAIL src/a.test.ts\nTests: 1 failed'),
    asst(7, 't4', 'Bash', { command: 'npm test' }), res(8, 't4', true, 'FAIL src/a.test.ts\nTests: 1 failed'),
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  // una sessione passata dello stesso progetto (file di tre giorni fa: è in archivio, non aperta)
  const oldFile = path.join(fakeDir, 'bottega-smoke-0000.jsonl');
  const T1 = Date.now() - 3 * 86400000, at1 = k => new Date(T1 + k * 1000).toISOString();
  fs.writeFileSync(oldFile, [
    { type: 'user', timestamp: at1(0), sessionId: 'bottega-smoke-0000', cwd: fakeCwd, message: { role: 'user', content: 'Aggiorna i test' } },
    { type: 'assistant', timestamp: at1(1), sessionId: 'bottega-smoke-0000', cwd: fakeCwd, message: { id: 'o1', role: 'assistant', content: [{ type: 'tool_use', id: 'o1', name: 'Read', input: { file_path: path.join(fakeCwd, 'src', 'vecchio.ts') } }], usage: { input_tokens: 10, output_tokens: 10 } } },
    { type: 'user', timestamp: at1(2), sessionId: 'bottega-smoke-0000', cwd: fakeCwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'o1', is_error: true, content: 'File does not exist.' }] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  fs.utimesSync(oldFile, new Date(T1), new Date(T1));
  const { startCore } = require(path.join(ROOT, 'src', 'core'));
  const port = 47900 + Math.floor(Math.random() * 90);
  const core = startCore({ port, base, settingsPath: path.join(tmp, 'settings.json'), statsPath: path.join(tmp, 'stats.json'), fetch: async () => { throw new Error('offline'); } });
  await core.ready;
  core.demo.start({ scale: 0.02 }); // gli scenari costruiti apposta, in velocità
  await sleep(2500);
  const st = JSON.parse((await get(port, '/api/state')).body);
  ok(st.sessions.length >= 4, `demo: ${st.sessions.length} piani, ${st.sessions.reduce((a, s) => a + s.subs.length, 0)} sottoagenti`);
  const sid = st.sessions[0].id;
  const wfs = st.sessions.flatMap(s => s.workflows || []);
  const live = wfs.find(r => r.name === 'policy-review'), past = wfs.find(r => r.name === 'gap-analysis');
  ok(live && live.status === 'running' && live.phases.length === 4 && past && past.status === 'completed' && past.phases.some(p => p.failed), `demo: workflow in corso (${live && live.phases.map(p => p.done + '/' + p.total).join(' ')}) e uno finito con un fallimento`);
  ok(st.sessions.some(s => (s.messages || []).length), 'demo: un messaggio tra agenti (SendMessage)');
  for (const p of ['/', '/i18n.js', '/i18n-runtime.js', '/game.js', '/worldmap.js', '/bottega.js', '/report', '/api/settings', '/api/stats/costs', '/api/report']) {
    const r = await get(port, p);
    ok(r.status === 200, `GET ${p} → ${r.status}`);
  }
  const map = JSON.parse((await get(port, `/api/agentmap?sid=${sid}&aid=all`)).body);
  ok(map.ok && map.nodes.length > 0 && map.trajectories.length > 0, `mappa della realtà: ${map.nodes.length} luoghi, ${map.trajectories.length} traiettorie`);
  const mind = JSON.parse((await get(port, `/api/agentmind?sid=${sid}&aid=main`)).body);
  ok(mind.ok && mind.pieces && mind.pieces.length > 0, `bolla del contesto: ${mind.pieces ? mind.pieces.length : 0} pezzi`);
  const gr = JSON.parse((await get(port, `/api/grounding?sid=${sid}&aid=all`)).body);
  ok(gr.ok && Array.isArray(gr.stale) && Array.isArray(gr.blindEdits) && Array.isArray(gr.ghosts) && Array.isArray(gr.claims) && gr.disk, `mappa contro territorio: ${gr.stale ? gr.stale.length : 0} ricordi scaduti, ${gr.blindEdits ? gr.blindEdits.length : 0} modifiche alla cieca, ${gr.ghosts ? gr.ghosts.length : 0} percorsi inventati, ${gr.claims ? gr.claims.length : 0} affermazioni`);
  // lo scenario della demo sul piano 1 (portale-clienti)
  const p1 = st.sessions.find(s => /portale-clienti/.test(s.cwd));
  const sc = p1 ? JSON.parse((await get(port, `/api/grounding?sid=${p1.id}&aid=all`)).body) : {};
  ok(sc.ok && sc.disk && sc.disk.checked, 'scenario: disco finto della demo');
  ok(sc.ok && sc.stale.some(x => x.key === 'src/auth/session.ts' && /EXPLORE/.test(x.agentName) && /ARCHITECT/.test(x.changedBy || '')), 'scenario: ricordo scaduto di EXPLORE, cambiato da ARCHITECT');
  ok(sc.ok && sc.ghosts.some(x => x.key === 'src/auth/oldToken.ts' && x.source === 'tool'), 'scenario: percorso inventato src/auth/oldToken.ts');
  const tc = sc.ok ? sc.claims.filter(c => c.agent === 'main' && c.kind === 'tests').sort((a, b) => a.t - b.t) : [];
  ok(tc.length >= 2 && tc[0].status === 'ungrounded' && tc[tc.length - 1].status === 'grounded', `scenario: «i test passano» prima senza prove, poi ancorata (${tc.map(c => c.status).join(' → ')})`);
  ok(sc.ok && sc.claims.some(c => c.agent === 'main' && c.kind === 'fixed' && c.status === 'grounded'), 'scenario: «ho corretto il refresh» ancorata dalla modifica');
  ok(sc.ok && !sc.blindEdits.some(b => b.agent === 'main' && b.key === 'src/auth/refresh.ts'), 'scenario: CLAUDE rilegge refresh.ts prima di modificarlo (niente modifica alla cieca)');
  ok(sc.ok && Array.isArray(sc.surprises) && sc.surprises.some(x => x.value >= 0.5 && x.kind === 'test'), `sorprese sul piano 1: ${sc.surprises ? sc.surprises.length : 0} (anche il test e2e che si incastra)`);
  ok(sc.ok && sc.surprises.some(x => x.kind === 'test' && x.reaction === 'insists') && Array.isArray(sc.reactions), 'il test-runner bloccato insiste sullo stesso comando');
  const bk = p1 ? JSON.parse((await get(port, `/api/bottega?sid=${p1.id}`)).body) : {};
  const strongDemo = bk.lessons ? bk.lessons.filter(l => l.level === 'lesson').length : 0;
  ok(bk.ok && /^[0-9a-f]{16}$/.test(bk.key) && bk.lessons.length >= 5 && bk.lessons.length <= 6 && strongDemo >= 4, `libro finto della demo (piano 1): ${bk.lessons ? bk.lessons.length : '-'} lezioni, ${strongDemo} forti`);
  const demoKinds = new Set((bk.lessons || []).map(l => l.kind));
  ok(['stale-trap', 'ghost-path', 'flaky-command', 'known-fix', 'fragile-file'].every(k => demoKinds.has(k)), 'libro della demo coerente con gli scenari (file conteso, percorso inventato, test instabile, correzione nota, file fragile)');
  const hd = JSON.parse((await get(port, '/api/bottega/hints?sid=' + p1.id)).body);
  ok(hd.ok && hd.hints.length >= 1, `il Nonno ha qualcosa da dire sul piano 1: «${hd.hints && hd.hints[0] ? hd.hints[0].text : '-'}»`);
  const bk404 = p1 ? await get(port, '/api/bottega', 'POST', JSON.stringify({ sid: p1.id, action: 'pin', id: 'nessuna' })) : { status: 0 };
  ok(bk404.status === 404, 'azione su una lezione che non c\'è → ' + bk404.status);
  const learned = core.learnLive();
  const fk = JSON.parse((await get(port, '/api/bottega?cwd=' + encodeURIComponent(fakeCwd))).body);
  const kindsFk = new Set((fk.lessons || []).map(l => l.kind));
  ok(learned > 0 && kindsFk.has('ghost-path') && kindsFk.has('loop-trap') && kindsFk.has('flaky-command'), `il libro impara da una sessione aperta: ${learned} casi, ${[...kindsFk].join(', ')}`);
  ok(core.learnLive() === 0, 'imparare di nuovo dalla stessa sessione non aggiunge nulla');
  // dall'archivio, da sé e in background (senza il bottone): la sessione aperta si salta, quella passata si legge una volta sola
  let fk2 = {};
  for (let k = 0; k < 40; k++) { await sleep(100); fk2 = JSON.parse((await get(port, '/api/bottega?cwd=' + encodeURIComponent(fakeCwd))).body); if (fk2.learning && !fk2.learning.running) break; }
  const gl = (fk2.lessons || []).find(l => l.kind === 'ghost-path');
  ok(fk2.learning && fk2.learning.total === 1 && fk2.learnedSessions === 1 && gl && gl.sessions.length === 2 && gl.level === 'lesson', `imparare dall'archivio da sé: ${fk2.learnedSessions} sessione letta, il percorso inventato ora è una lezione (${gl ? gl.sessions.length : 0} sessioni)`);
  const lr2 = JSON.parse((await get(port, '/api/bottega/learn', 'POST', JSON.stringify({ cwd: fakeCwd }))).body);
  ok(lr2.ok && lr2.learning.total === 0, 'una sessione già letta e non cambiata non si rilegge');
  core.bottega.save();
  const books = JSON.parse((await get(port, '/api/bottega/list')).body);
  const fb = (books.books || []).find(b => b.cwd === fakeCwd);
  ok(fb && fb.strong >= 1 && fb.name === 'progetto', `scheda BOTTEGA: ${books.books ? books.books.length : 0} libri, «${fb && fb.name}» con ${fb && fb.strong} lezioni`);
  const byKey = fb ? JSON.parse((await get(port, '/api/bottega?key=' + fb.key)).body) : {};
  ok(byKey.ok && byKey.lessons.length === fk2.lessons.length, 'il libro si apre anche dalla sua chiave');
  const ev = gl && gl.evidence.find(e => e.sid === 'bottega-smoke-0000');
  const rp = ev ? JSON.parse((await get(port, '/api/replay', 'POST', JSON.stringify({ action: 'start', key: ev.sid, at: ev.t }))).body) : {};
  ok(rp.ok, 'dalla prova al replay della sessione, da quel momento');
  await get(port, '/api/replay', 'POST', JSON.stringify({ action: 'stop' }));
  // CLAUDE.md, solo nella cartella di prova: anteprima, niente senza conferma, poi aggiunta e sostituzione
  fs.mkdirSync(fakeCwd, { recursive: true });
  const cmdFile = path.join(fakeCwd, 'CLAUDE.md'), orig = Buffer.from('# Progetto\r\n\r\nRegole mie, da non toccare.\r\n');
  fs.writeFileSync(cmdFile, orig);
  const pv = JSON.parse((await get(port, '/api/bottega/claudemd?cwd=' + encodeURIComponent(fakeCwd))).body);
  ok(pv.ok && pv.writable && /^## /.test(pv.markdown) && pv.path === cmdFile, 'CLAUDE.md: anteprima della sezione e percorso');
  const nc = await get(port, '/api/bottega/claudemd', 'POST', JSON.stringify({ cwd: fakeCwd }));
  ok(nc.status === 400 && fs.readFileSync(cmdFile).equals(orig), 'CLAUDE.md: senza conferma non si scrive nulla');
  const w1 = JSON.parse((await get(port, '/api/bottega/claudemd', 'POST', JSON.stringify({ cwd: fakeCwd, confirm: true }))).body);
  const after = fs.readFileSync(cmdFile);
  ok(w1.ok && w1.mode === 'append' && after.slice(0, orig.length).equals(orig) && after.includes('<!-- platypus:bottega:start -->') && after.includes('\r\n- '), 'CLAUDE.md: sezione aggiunta in fondo, il resto identico byte per byte (anche i CRLF)');
  const w2 = JSON.parse((await get(port, '/api/bottega/claudemd', 'POST', JSON.stringify({ cwd: fakeCwd, confirm: true }))).body);
  ok(w2.ok && w2.mode === 'replace' && fs.existsSync(cmdFile + '.platypus-backup') && fs.readFileSync(cmdFile).equals(after), 'CLAUDE.md: la seconda volta sostituisce la sezione, con la copia di sicurezza');
  const pd = JSON.parse((await get(port, `/api/bottega/claudemd?sid=${p1.id}`)).body);
  const wd = await get(port, '/api/bottega/claudemd', 'POST', JSON.stringify({ sid: p1.id, confirm: true }));
  ok(pd.ok && !pd.writable && pd.reason === 'demo' && wd.status === 409, 'CLAUDE.md: sulla demo solo «Copia»');
  const hn = JSON.parse((await get(port, '/api/bottega/hints?sid=bottega-smoke-0001')).body);
  ok(hn.ok && Array.isArray(hn.hints), `il Nonno risponde: ${hn.hints ? hn.hints.length : '-'} cose da dire`);
  core.state.setSettings({ bottegaLearn: false });
  const off = await get(port, '/api/bottega/learn', 'POST', JSON.stringify({ cwd: fakeCwd }));
  ok(off.status === 409 && core.learnLive() === 0, 'apprendimento spento: niente dal vivo né dall\'archivio → ' + off.status);
  core.state.setSettings({ bottegaLearn: true });
  const bkDemo = JSON.parse((await get(port, `/api/bottega?sid=${p1.id}`)).body);
  ok(bkDemo.ok && bkDemo.lessons.length === bk.lessons.length && bkDemo.lessons.every(l => l.count === bk.lessons.find(x => x.id === l.id).count), 'la demo non impara dal vivo: il suo libro resta quello finto');
  core.bottega.save();
  ok(!fs.existsSync(path.join(tmp, 'bottega', bk.key + '.json')), 'il libro della demo non finisce sul disco');
  // scenario della sorpresa: catena completa e un agente che cerca altrove
  const chain = sc.ok ? sc.surprises.find(x => x.refs && x.refs.some(r => r.file === 'src/auth/refresh.ts' && r.line === 42)) : null;
  ok(chain && chain.value === 1 && chain.reasons.includes('usedToWork') && !chain.reasons.includes('tdd'), `scenario: il test che prima passava fallisce, sorpresa forte (${chain ? Math.round(chain.value * 100) + '%' : '-'})`);
  ok(chain && chain.cause === 'follows' && chain.reaction === 'corrects' && chain.chain.complete, 'scenario: segue la traccia fino a refresh.ts e la catena si chiude con i test di nuovo verdi');
  const away = sc.ok ? sc.surprises.find(x => x.refs && x.refs.some(r => r.file === 'src/db/migrate.ts')) : null;
  ok(away && away.cause === 'elsewhere' && away.chain.fix && /Menu\.tsx$/.test(away.chain.fix.target), 'scenario: l\'errore cita migrate.ts, il PLAN modifica Menu.tsx (cerca altrove)');
  const hook = await get(port, '/platypus-hook', 'POST', JSON.stringify({ session_id: 'smoke-1', hook_event_name: 'PreToolUse', cwd: tmp, tool_name: 'Read', tool_input: { file_path: 'a.txt' } }));
  ok(hook.status === 204, 'hook ricevuto → ' + hook.status);
  const perm = await get(port, '/platypus-hook/permission', 'POST', JSON.stringify({ session_id: 'smoke-1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  ok(perm.status === 204, 'permesso senza finestre aperte: decide il terminale → ' + perm.status);
  const bad = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } }, res => resolve(res.statusCode));
    req.on('error', () => resolve(0)); req.end();
  });
  ok(bad === 403, 'richieste da altri host rifiutate → ' + bad);
  // una pagina su un'altra porta di localhost (dev server, notebook) non deve poter usare le API dell'ufficio
  const fromOrigin = (origin, p, body) => new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.end(body);
  });
  const dirsBefore = core.state.settings.claudeDirs;
  const foreign = await fromOrigin('http://localhost:3000', '/api/settings', JSON.stringify({ claudeDirs: '\\\\attacker.example\\share' }));
  const foreign2 = await fromOrigin('http://127.0.0.1:5173', '/api/demo', '{"on":false}');
  ok(foreign === 403 && foreign2 === 403 && core.state.settings.claudeDirs === dirsBefore, `POST da un'altra porta di localhost rifiutato → ${foreign}, ${foreign2}`);
  const own = await fromOrigin(`http://127.0.0.1:${port}`, '/api/settings', '{}');
  const ownLocal = await fromOrigin(`http://localhost:${port}`, '/api/settings', '{}');
  ok(own === 200 && ownLocal === 200, `POST dalla pagina dell'ufficio (127.0.0.1 e localhost, stessa porta) → ${own}, ${ownLocal}`);
  // indirizzo in forma assoluta non valido, scritto a mano sul socket (un browser non lo manda, un programma sì)
  const absForm = await new Promise(resolve => {
    const s = require('net').connect(port, '127.0.0.1', () => s.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let d = ''; s.on('data', c => { d += c; }); s.on('end', () => resolve(d.split('\r\n')[0])); s.on('error', e => resolve(e.code));
  });
  ok(/ 400 /.test(absForm) && (await get(port, '/api/settings')).status === 200, `GET http://[ → ${absForm}, il server risponde ancora`);
  // pagine con la CSP (niente script esterni o in linea) e mai dentro un iframe di un'altra pagina
  const head = await new Promise(resolve => { http.get({ host: '127.0.0.1', port, path: '/' }, res => { res.resume(); resolve(res.headers); }).on('error', () => resolve({})); });
  const csp = head['content-security-policy'] || '';
  ok(/script-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp) && head['x-frame-options'] === 'DENY' && head['x-content-type-options'] === 'nosniff', 'pagina dell\'ufficio: CSP con script solo dal server, niente iframe, nosniff');
  const inline = fs.readdirSync(path.join(ROOT, 'renderer')).filter(f => f.endsWith('.html')).filter(f => /<script(?![^>]*\ssrc=)[^>]*>/i.test(fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8')) || / on[a-z]+=["']/i.test(fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8')));
  ok(!inline.length, 'nessuno script in linea nelle pagine (la CSP li bloccherebbe)' + (inline.length ? ': ' + inline.join(', ') : ''));
  // una cartella accanto a renderer/ con lo stesso inizio del nome non si serve
  const sibling = path.join(ROOT, 'renderer-smoke-' + process.pid);
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'segreto');
  const sib = await get(port, `/..%2F${path.basename(sibling)}%2Fsecret.txt`);
  fs.rmSync(sibling, { recursive: true, force: true });
  ok(sib.status === 403 && !sib.body.includes('segreto'), `cartella sorella di renderer/ (${path.basename(sibling)}) → ${sib.status}`);
  const nul = await get(port, '/%00');
  const nul2 = await get(port, '/index.html%00.js');
  ok(nul.status === 400 && nul2.status === 400 && (await get(port, '/api/settings')).status === 200, `byte nullo nel percorso (GET /%00) → ${nul.status}, ${nul2.status}, il server risponde ancora`);
  const malformed = await get(port, '/%');
  const stillUp = await get(port, '/api/settings');
  ok(malformed.status === 400 && stillUp.status === 200, `URL malformato (GET /%) → ${malformed.status}, il server risponde ancora → ${stillUp.status}`);
  core.stop();

  console.log('hook di Claude Code');
  const hooks = require(path.join(ROOT, 'src', 'core', 'hooks'));
  hooks.install({ port: 47800, base });
  ok(hooks.status({ base }) && !hooks.outdated({ base }), 'installati in una configurazione di prova');
  hooks.uninstall({ base });
  ok(!hooks.status({ base }), 'rimossi');

  console.log('finestra della sessione (Windows)');
  const osint = require(path.join(ROOT, 'src', 'core', 'osint'));
  const script = osint.focusScriptWin(1234, ['idea64'], { name: 'dsg', path: 'c:\\users\\x\\dsg' });
  ok(script.includes("$PROJ = 'dsg'") && script.includes("$PROJPATH = 'c:\\users\\x\\dsg'"), 'il progetto della sessione finisce nello script');
  ok(/\[AOW\]::Windows/.test(script), 'sceglie tra tutte le finestre del processo, non solo la principale');
  // un apice nel nome della cartella non deve poter chiudere la stringa PowerShell
  const quoted = osint.focusScriptWin(1, ['x'], { name: "o'brien", path: "c:\\o'brien" });
  const projLine = quoted.split('\n').find(l => l.startsWith('$PROJ '));
  ok(projLine === "$PROJ = 'o''brien'", 'apici raddoppiati: ' + projLine);
  // senza cartella valida si torna al comportamento di sempre
  ok(osint.focusScriptWin(1, ['x'], null).includes("$PROJ = ''"), 'senza progetto non si filtra per titolo');
  // la cartella passata a cmd.exe (per riaprire l'IDE): "&" e "," nel nome non devono diventare comandi
  for (const name of ['R&D', 'x&md,pl-proof']) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const args = osint.cmdArgs('echo', dir);
    ok(args && args[3] === `"echo "${dir}""`, `cartella «${name}»: tra virgolette per cmd.exe`);
    if (args && process.platform === 'win32') {
      const r = spawnSync('cmd.exe', args, { cwd: tmp, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8' });
      ok(r.stdout.trim() === `"${dir}"` && !fs.existsSync(path.join(tmp, 'pl-proof')), `cartella «${name}»: cmd.exe riceve il percorso intero e non esegue altro`);
    }
  }
  // «Riprendi»: Windows Terminal separa i sottocomandi con ";" (anche dentro -d), quindi una cartella con ";" passa da cmd
  const semi = path.join(tmp, 'x;calc');
  ok(osint.resumeWin(path.join(tmp, 'R&D'), 'abcd-1234', true).how === 'wt' && osint.resumeWin(semi, 'abcd-1234', true).how === 'cmd', 'Riprendi: cartella con «;» non va a Windows Terminal');
  if (process.platform === 'win32') {
    // la riga per cmd con "echo" al posto di "start": & e ; nel nome restano lettere
    for (const name of ['R&D', 'x;calc', 'y&md,pl-proof']) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      const line = osint.resumeWin(dir, 'abcd-1234', false).args[1].replace(/^start "Claude Code" \/D/, 'echo');
      const r = spawnSync('cmd.exe', ['/c', line], { cwd: tmp, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8' });
      ok(r.stdout.trim() === `"${dir}" cmd /k claude --resume abcd-1234` && !fs.existsSync(path.join(tmp, 'pl-proof')), `Riprendi con cmd, cartella «${name}»: arriva intera, nessun altro comando`);
    }
  }
  fs.mkdirSync(path.join(tmp, 'a%PATH%b'), { recursive: true });
  ok(osint.cmdArgs('code', path.join(tmp, 'a%PATH%b')) === null, 'cartella con «%»: cmd.exe la espanderebbe, quindi non si usa');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
