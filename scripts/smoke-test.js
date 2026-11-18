#!/usr/bin/env node
'use strict';
// Prova veloce che gira uguale su Windows, macOS e Linux (anche nelle GitHub Actions):
// sintassi di tutti i file, traduzioni, motore con la demo, API principali, hook.
// Non tocca la tua configurazione: usa cartelle temporanee.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

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
// il primo stato che la pagina riceve dal flusso degli eventi (quello di /api/state più quello che aggiunge il server)
function sseFirst(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, res => {
      let d = '';
      res.on('data', c => {
        d += c;
        const m = /(?:^|\n)data: (.*)\n\n/.exec(d);
        if (!m) return;
        req.destroy();
        try { resolve(JSON.parse(m[1])); } catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.setTimeout(5000, () => { req.destroy(); resolve({}); });
  });
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
// lo stream delle shell (/api/shell/events): raccoglie gli eventi e aspetta quello che serve
function shellEvents(port, headers = {}) {
  const events = [];
  let status = 0, req = null, buf = '';
  const ready = new Promise(resolve => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/shell/events', headers }, res => {
      status = res.statusCode;
      resolve();
      res.on('data', c => {
        buf += c;
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
          if (ev && data) try { events.push({ event: ev[1], data: JSON.parse(data[1]) }); } catch {}
        }
      });
    });
    req.on('error', () => resolve());
  });
  const wait = async (pred, ms = 3000) => { for (let t = 0; t < ms; t += 50) { const e = events.find(pred); if (e) return e; await sleep(50); } return null; };
  return { events, ready, wait, status: () => status, close: () => { try { req.destroy(); } catch {} } };
}

(async () => {
  console.log(`Platypus smoke test · ${process.platform} ${process.arch} · Node ${process.versions.node}`);

  console.log('sintassi');
  for (const f of walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'renderer')), walk(path.join(ROOT, 'scripts')), walk(path.join(ROOT, 'optional')))) {
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
  await require('./unit-embed').run(ok);
  require('./unit-notify').run(ok);

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
  // il significato resta lessicale, anche se su questo computer gira un Ollama: i numeri delle prove non cambiano
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ embedEngine: 'tfidf' }));
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
  const modelsJs = await get(port, '/models.js');
  ok(modelsJs.status === 200 && modelsJs.body === fs.readFileSync(path.join(ROOT, 'src', 'core', 'models.js'), 'utf8') && mind.models && typeof mind.models.main === 'string', `modelli: /models.js è il modulo del motore, e la bolla sa il modello di ogni mente (${mind.models && mind.models.main})`);
  // E3 · significato con un Ollama finto: la bolla parte lessicale e passa ai vettori neurali quando arrivano
  {
    const fo = await require('./unit-embed').fakeOllama();
    const em0 = JSON.parse((await get(port, '/api/embed')).body);
    ok(mind.src === 'tfidf' && mind.engine === 'lexical' && em0.engine === 'tfidf' && em0.active === 'tfidf', 'significato: con «solo lessicale» la bolla è TF-IDF');
    // E6 · le opzioni guardano le fonti senza caricare modelli (solo /api/tags)
    await get(port, '/api/settings', 'POST', JSON.stringify({ ollamaUrl: fo.url }));
    const pr = JSON.parse((await get(port, '/api/embed', 'POST', JSON.stringify({ action: 'probe' }))).body);
    ok(pr.active === 'tfidf' && pr.sources.ollama.state === 'ready' && pr.sources.ollama.model === 'nomic-embed-text:latest' && ['not-installed', 'ready'].includes(pr.sources.onnx.state) && fo.log.length && fo.log.every(x => x.url === '/api/tags'), `opzioni del significato: Ollama ${pr.sources.ollama.state} (${pr.sources.ollama.model}), ONNX ${pr.sources.onnx.state}, senza caricare il modello`);
    await get(port, '/api/settings', 'POST', JSON.stringify({ embedEngine: 'ollama', ollamaUrl: fo.url }));
    let nm = null, sawRefining = false;
    for (let i = 0; i < 40 && !(nm && nm.src !== 'tfidf' && !nm.pending); i++) { nm = JSON.parse((await get(port, `/api/agentmind?sid=${sid}&aid=main`)).body); if (nm.refining && nm.pieces.length) sawRefining = true; await sleep(50); }
    ok(sawRefining && nm.active === nm.src && nm.refining === false, 'bolla: mentre arrivano i vettori si vede subito il TF-IDF con «affino…», poi la fonte neurale');
    const em1 = JSON.parse((await get(port, '/api/embed')).body);
    ok(nm && nm.src === 'ollama:nomic-embed-text:latest' && nm.engine === 'neural' && nm.pending === 0 && nm.pieces.length === mind.pieces.length && em1.active === nm.src && em1.sources.ollama.state === 'ready' && em1.cache.vectors > 0, `significato: con l'Ollama finto la bolla passa a ${nm && nm.src} (${em1.cache.vectors} vettori in cache)`);
    ok(fo.log.filter(x => x.url === '/api/embed').every(x => x.body.input.length <= 16) && fs.readdirSync(path.join(tmp, 'embed-cache')).some(f => f.endsWith('.bin')), 'significato: lotti di al massimo 16 testi, cache su disco accanto alle opzioni');
    const cl = JSON.parse((await get(port, '/api/embed', 'POST', JSON.stringify({ action: 'clear' }))).body);
    ok(cl.cache.vectors === 0 && cl.cache.diskBytes === 0, 'opzioni del significato: «svuota la cache» toglie vettori in memoria e su disco');
    await fo.close();
    await get(port, '/api/settings', 'POST', JSON.stringify({ embedEngine: 'ollama', ollamaUrl: 'http://192.168.1.5:11434' }));
    const em2 = JSON.parse((await get(port, '/api/embed')).body);
    const sv = JSON.parse((await get(port, '/api/settings')).body);
    ok(sv.ollamaUrl === fo.url, 'significato: le opzioni rifiutano un Ollama fuori dal computer');
    await get(port, '/api/settings', 'POST', JSON.stringify({ ollamaUrl: 'http://127.0.0.1:9' }));
    let em3 = null;
    for (let i = 0; i < 40; i++) { await get(port, `/api/agentmind?sid=${sid}&aid=main`); em3 = JSON.parse((await get(port, '/api/embed')).body); if (em3.sources.ollama.state !== 'unknown') break; await sleep(50); }
    const back = JSON.parse((await get(port, `/api/agentmind?sid=${sid}&aid=main`)).body);
    ok(em2.engine === 'ollama' && em3.active === 'tfidf' && em3.fallback && em3.fallback.source === 'ollama' && em3.sources.ollama.state === 'not-found' && back.src === 'tfidf' && back.engine === 'lexical' && back.pending === 0, `significato: Ollama spento → di nuovo TF-IDF, e lo dice (${em3.fallback && em3.fallback.state})`);
    await get(port, '/api/settings', 'POST', JSON.stringify({ embedEngine: 'tfidf', ollamaUrl: 'http://127.0.0.1:11434' }));
  }
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
  // C3 · feedback agli agenti nella demo: una scena per funzione sul piano 1 (e le lezioni a inizio sessione sul piano 2),
  // passando dalla stessa funzione dell'hook vero; un registro tutto della demo, in memoria
  const p2 = st.sessions.find(s => /mes-clone/.test(s.cwd));
  let dfb = [];
  for (let k = 0; k < 40; k++) { dfb = p1 ? (JSON.parse((await get(port, '/api/feedback/log?sid=' + p1.id)).body).entries || []) : []; if (dfb.length >= 6) break; await sleep(100); }
  const dByF = f => dfb.filter(e => e.feature === f);
  const dNames = dfb.map(e => e.feature + ':' + e.name + ':' + e.mode).join(', ');
  ok(dByF('elder').some(e => e.name === 'CLAUDE' && e.mode === 'on') && dByF('elder').some(e => /TEST-RUNNER/.test(e.name) && e.event === 'PostToolUseFailure') && dByF('claims').some(e => e.name === 'CLAUDE' && e.mode === 'shadow' && e.event === 'Stop'), 'demo, feedback: il Nonno a CLAUDE e al test-runner, l\'affermazione senza prove in ombra → ' + dNames);
  ok(dByF('loop').some(e => e.mode === 'on' && /failed 2 times|fallito 2 volte/.test(e.text + e.sent)) && dByF('stale').some(e => /ARCHITECT/.test(e.name) && e.mode === 'shadow') && dByF('drift').some(e => e.mode === 'shadow'), 'demo, feedback: giro in tondo, file cambiato da un altro e ritorno al compito');
  const dfb2 = p2 ? (JSON.parse((await get(port, '/api/feedback/log?sid=' + p2.id)).body).entries || []) : [];
  ok(dfb2.some(e => e.feature === 'sessionLessons' && e.mode === 'on') && !core.feedbackLog.recent(p1.cwd).length && !core.feedbackLog.recent(p2.cwd).length, 'demo, feedback: le lezioni a inizio sessione sul piano 2, e niente nel registro vero');
  ok(core.feedbackSaid().some(x => x.sid === p1.id && x.feature === 'loop'), 'demo, feedback: i fumetti dell\'ufficio li mostrano');
  core.judgeFeedback(Date.now() + 20 * 60000);
  const dOc = JSON.parse((await get(port, '/api/feedback/log?sid=' + p1.id)).body).entries;
  const oc = f => (dOc.find(e => e.feature === f) || {}).outcome;
  const ocE = dOc.filter(e => e.feature === 'elder').map(e => e.name + '=' + e.outcome).sort().join(' ');
  ok(oc('loop') === 'helped' && oc('stale') === 'helped' && oc('claims') === 'ignored' && oc('drift') === 'unclear' && /CLAUDE=ignored/.test(ocE) && /TEST-RUNNER\S*=helped/.test(ocE), `demo, esiti: giro in tondo ${oc('loop')}, file cambiato ${oc('stale')}, affermazione ${oc('claims')}, deriva ${oc('drift')}, Nonno ${ocE}`);
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
  // T2 (Tauri): le notifiche le decide il motore. Electron le ascolta nel suo processo (core.notify), Tauri dallo stream
  // /api/shell/events: un permesso chiesto mentre la demo gira deve arrivare a tutti e due, una volta sola
  const inProc = [];
  const onNotify = e => inProc.push(e);
  core.notify.on('notify', onNotify);
  const shellSt = shellEvents(port);
  await shellSt.ready;
  const c0 = await shellSt.wait(e => e.event === 'counts');
  ok(shellSt.status() === 200 && c0 && typeof c0.data.waiting === 'number' && c0.data.sessions >= 4, `stream delle shell: contatori subito (${c0 ? JSON.stringify(c0.data) : '-'})`);
  // T4: il menu dell'icona di Tauri, con i testi già tradotti e lo stato delle voci
  const m0 = await shellSt.wait(e => e.event === 'menu');
  const mt = (m0 && m0.data.texts) || {};
  ok(m0 && m0.data.demo === true && m0.data.hooks === false && m0.data.base === base && ['show', 'pin', 'demo', 'notify', 'cowork', 'hooksOn', 'hooksOff', 'report', 'browser', 'folder', 'quit', 'askTitle', 'askYes'].every(k => typeof mt[k] === 'string' && mt[k]) && mt.failed.includes('{error}'), `stream delle shell: il menu (demo accesa, hook no, cartella di Claude Code) → «${mt.show}», «${mt.hooksOn}»`);
  ok(c0 && typeof c0.data.label === 'string' && c0.data.label.includes(String(c0.data.sessions)) && /^Platypus — /.test(c0.data.tooltip), `stream delle shell: la prima voce e il suggerimento dell'icona → «${c0 && c0.data.label}»`);
  const perm = await get(port, '/platypus-hook/permission', 'POST', JSON.stringify({ session_id: 'smoke-1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  ok(perm.status === 204, 'permesso senza finestre aperte: decide il terminale (lo stream delle shell non conta come finestra) → ' + perm.status);
  const nWait = await shellSt.wait(e => e.event === 'notify' && e.data.kind === 'wait' && e.data.sid === 'smoke-1');
  ok(nWait && nWait.data.key === 'wait:smoke-1:main' && /CLAUDE/.test(nWait.data.title) && /ls/.test(nWait.data.body), 'stream delle shell: la notifica del permesso → ' + (nWait ? nWait.data.title + ' | ' + nWait.data.body.replace(/\n/g, ' / ') : '-'));
  ok(inProc.filter(e => e.sid === 'smoke-1').length === 1 && inProc[0].title === (nWait && nWait.data.title), 'Electron: la stessa notifica nel suo processo, una volta sola');
  ok(!!(await shellSt.wait(e => e.event === 'counts' && e.data.waiting >= 1)), 'stream delle shell: i contatori vedono l\'attesa');
  await sleep(700);
  ok(shellSt.events.filter(e => e.event === 'notify' && e.data.sid === 'smoke-1').length === 1, 'nessun doppione della notifica');
  core.notify.off('notify', onNotify);
  shellSt.close();
  const shellBad = shellEvents(port, { Origin: 'http://127.0.0.1:1' });
  await shellBad.ready;
  const shellHost = shellEvents(port, { Host: 'evil.example:' + port });
  await shellHost.ready;
  ok(shellBad.status() === 403 && shellHost.status() === 403, `stream delle shell: un'altra origine → ${shellBad.status()}, un altro Host → ${shellHost.status()}`);
  shellBad.close(); shellHost.close();
  // feedback agli agenti (2.11): l'hook sincrono risponde sempre, e quando non ha niente da dire Claude Code non riceve nulla
  const fbMod = require(path.join(__dirname, '..', 'src', 'core', 'feedback'));
  const fbIn = (ev, extra = {}) => JSON.stringify({ session_id: 'fb-none', hook_event_name: ev, cwd: tmp, tool_name: 'Bash', tool_input: { command: 'npm test' }, ...extra });
  const fb0 = await get(port, '/platypus-hook/feedback', 'POST', fbIn('PostToolUse'));
  ok(fb0.status === 204 && fb0.body === '', 'feedback senza regole: 204 e corpo vuoto → ' + fb0.status);
  ok(!JSON.parse((await get(port, '/api/state')).body).sessions.some(s => s.id === 'fb-none'),'feedback: l\'hook non crea sessioni né tocca lo stato');
  const fbSay = () => ({ text: 'npm test is flaky here: rerun it once before investigating.', lessonId: 'L-smoke' });
  const fbRule = { feature: 'elder', run: fbSay };
  // le prove usano regole loro: quelle vere si mettono da parte e tornano alla fine
  const fbKeep = Object.fromEntries(Object.entries(fbMod.RULES).map(([ev, l]) => [ev, l.slice()]));
  const fbOnly = (ev, ...rs) => fbMod.RULES[ev].splice(0, Infinity, ...rs);
  for (const ev of Object.keys(fbMod.RULES)) fbOnly(ev);
  fbOnly('PostToolUseFailure', fbRule);
  const fbFail = extra => get(port, '/platypus-hook/feedback', 'POST', fbIn('PostToolUseFailure', { error: 'Exit code 1', ...extra }));
  const fbOffR = await fbFail();
  ok(fbOffR.status === 204 && core.feedbackLog.recent(tmp).length === 0, 'feedback, funzione spenta (come di base): niente all\'agente e niente nel registro → ' + fbOffR.status);
  core.state.setSettings({ fbElder: 'shadow' });
  const fbSh = await fbFail();
  let fbLog = core.feedbackLog.recent(tmp);
  ok(fbSh.status === 204 && fbLog.length === 1 && fbLog[0].mode === 'shadow' && fbLog[0].feature === 'elder' && fbLog[0].agent === 'main' && /^Platypus: npm test/.test(fbLog[0].text), 'feedback in ombra: niente all\'agente, ma nel registro c\'è che cosa avrebbe detto → ' + fbSh.status);
  core.state.setSettings({ fbElder: 'on' });
  const fb1 = await fbFail({ session_id: 'fb-on' });
  let fb1j = {}; try { fb1j = JSON.parse(fb1.body); } catch {}
  ok(fb1.status === 200 && fb1j.hookSpecificOutput && fb1j.hookSpecificOutput.hookEventName === 'PostToolUseFailure' && /^Platypus: npm test is flaky/.test(fb1j.hookSpecificOutput.additionalContext), 'feedback acceso: il contesto arriva nella forma di Claude Code → ' + fb1.status);
  const fbRep = await fbFail({ session_id: 'fb-on' });
  const fbSub = await fbFail({ session_id: 'fb-on', agent_id: 'sub-1' });
  ok(fbRep.status === 204 && fbSub.status === 200, `feedback: allo stesso agente non due volte di fila (${fbRep.status}), a un sottoagente sì (${fbSub.status})`);
  const fbMute = JSON.parse((await get(port, '/api/bottega', 'POST', JSON.stringify({ cwd: tmp, action: 'mute' }))).body);
  const fbMuted = await fbFail({ session_id: 'fb-muted' });
  const fbView = JSON.parse((await get(port, '/api/bottega?cwd=' + encodeURIComponent(tmp))).body);
  await get(port, '/api/bottega', 'POST', JSON.stringify({ cwd: tmp, action: 'unmute' }));
  ok(fbMute.ok && fbMute.mute === true && fbView.mute === true && fbMuted.status === 204 && !core.feedbackLog.recent(tmp).some(e => e.sid === 'fb-muted'), 'feedback: un progetto zittito dal Libro non riceve né registra messaggi → ' + fbMuted.status);
  fbOnly('PostToolUseFailure');
  fbOnly('PostToolUse', { feature: 'elder', run: () => { throw new Error('regola rotta'); } });
  const fb2 = await get(port, '/platypus-hook/feedback', 'POST', fbIn('PostToolUse', { session_id: 'fb-broken' }));
  fbOnly('PostToolUse');
  ok(fb2.status === 204, 'feedback, una regola che lancia: 204, mai un errore → ' + fb2.status);
  fbOnly('PostToolUse', { feature: 'elder', run: () => { const t = Date.now(); while (Date.now() - t < 350); return fbSay(); } }); // più lenta del tempo massimo
  const fb3 = await get(port, '/platypus-hook/feedback', 'POST', fbIn('PostToolUse', { session_id: 'fb-slow' }));
  fbOnly('PostToolUse');
  fbLog = core.feedbackLog.recent(tmp);
  ok(fb3.status === 204 && core.feedbackStats.late === 1 && fbLog.some(e => e.sid === 'fb-slow' && e.outcome === 'late'), `feedback oltre i 300 ms: la risposta in ritardo non si manda, e il registro lo dice → ${fb3.status} (in ritardo: ${core.feedbackStats.late})`);
  core.state.setSettings({ fbElder: 'off' });
  for (const [ev, l] of Object.entries(fbKeep)) fbOnly(ev, ...l);
  // B1 · le lezioni del progetto a inizio sessione, con la regola vera e il libro imparato poco sopra
  const fbStart = sid => get(port, '/platypus-hook/feedback', 'POST', JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', source: 'startup', cwd: fakeCwd }));
  ok((await fbStart('fb-start-off')).status === 204, 'lezioni a inizio sessione: spente di base, niente');
  core.state.setSettings({ fbSessionLessons: 'on' });
  const fbI18n = require(path.join(__dirname, '..', 'src', 'i18n')), fbLangWas = fbI18n.getLang();
  fbI18n.setLang('it'); // l'ufficio in italiano: il messaggio all'agente resta in inglese
  // più sopra la prova del CLAUDE.md ha scritto davvero la sezione in questo progetto: la mettiamo da parte e poi torna
  const fbMd = path.join(fakeCwd, 'CLAUDE.md'), fbMdWas = fs.existsSync(fbMd) ? fs.readFileSync(fbMd) : null;
  fs.rmSync(fbMd, { force: true });
  const fbS = await fbStart('fb-start-1');
  let fbSj = {}; try { fbSj = JSON.parse(fbS.body); } catch {}
  const fbCtx = (fbSj.hookSpecificOutput && fbSj.hookSpecificOutput.additionalContext) || '';
  ok(fbS.status === 200 && fbSj.hookSpecificOutput.hookEventName === 'SessionStart' && /^Platypus \(project memory\)/.test(fbCtx) && /\n- .*vecchio\.ts.*doesn't exist/.test(fbCtx), 'lezioni a inizio sessione: arrivano in inglese anche con l\'ufficio in italiano → ' + fbS.status + ' «' + fbCtx.split('\n').slice(1, 2).join('') + '»');
  ok(core.feedbackLog.recent(fakeCwd).some(e => e.sid === 'fb-start-1' && e.feature === 'sessionLessons' && e.mode === 'on' && e.event === 'SessionStart'), 'lezioni a inizio sessione: il messaggio resta nel registro del progetto');
  fs.mkdirSync(fakeCwd, { recursive: true });
  fs.writeFileSync(fbMd, '# Progetto\n\n<!-- platypus:bottega:start -->\n## Lezioni\n<!-- platypus:bottega:end -->\n');
  const fbS2 = await fbStart('fb-start-2');
  ok(fbS2.status === 204, 'lezioni a inizio sessione: se il CLAUDE.md ha già la sezione non si ripetono → ' + fbS2.status);
  if (fbMdWas) fs.writeFileSync(fbMd, fbMdWas); else fs.rmSync(fbMd, { force: true });
  ok(fbI18n.getLang() === 'it', 'e la lingua dell\'ufficio resta quella di prima');
  fbI18n.setLang(fbLangWas);
  core.state.setSettings({ fbSessionLessons: 'off' });
  // B2 · il Nonno parla all'agente: un comando che il libro conosce come instabile fallisce di nuovo, scritto in un altro modo
  const fbFlaky = core.bottega.view(fakeCwd).lessons.find(l => l.kind === 'flaky-command' && l.level === 'lesson');
  const fbElderIn = (sid, extra = {}) => get(port, '/platypus-hook/feedback', 'POST', JSON.stringify({ session_id: sid, hook_event_name: 'PostToolUseFailure', cwd: fakeCwd, tool_name: 'Bash', tool_input: { command: 'cd ' + fakeCwd.replace(/\\/g, '/') + ' && CI=1 ' + (fbFlaky ? fbFlaky.key : 'x') + ' 2>&1 | tail -5' }, error: 'Exit code 1\nFAIL', ...extra }));
  ok(fbFlaky && (await fbElderIn('fb-elder-off')).status === 204, 'il Nonno all\'agente: spento di base, niente');
  core.state.setSettings({ fbElder: 'on' });
  const fbE = await fbElderIn('fb-elder-1');
  let fbEj = {}; try { fbEj = JSON.parse(fbE.body); } catch {}
  const fbEt = (fbEj.hookSpecificOutput && fbEj.hookSpecificOutput.additionalContext) || '';
  ok(fbE.status === 200 && fbEj.hookSpecificOutput.hookEventName === 'PostToolUseFailure' && /^Platypus: /.test(fbEt) && fbEt.includes(fbFlaky.key), 'il Nonno all\'agente, acceso: la lezione arriva dopo il comando fallito → ' + fbE.status + ' «' + fbEt.slice(0, 90) + '…»');
  ok(core.feedbackGate.told('fb-elder-1', 'main', fbFlaky.id) && core.feedbackLog.recent(fakeCwd).some(e => e.sid === 'fb-elder-1' && e.feature === 'elder' && e.lessonId === fbFlaky.id), 'il Nonno all\'agente: l\'ufficio sa che gliel\'ha detto, e resta nel registro');
  const fbE2 = await fbElderIn('fb-elder-2', { tool_input: { command: 'git status' } });
  ok(fbE2.status === 204, 'il Nonno all\'agente: un comando senza lezione fallisce e basta → ' + fbE2.status);
  core.state.setSettings({ fbElder: 'off' });
  // B3 · fuori dal giro in tondo: nella sessione aperta «npm test» è già fallito tre volte allo stesso modo; l'hook porta il quarto
  const fbLoopIn = (extra = {}) => get(port, '/platypus-hook/feedback', 'POST', JSON.stringify({ session_id: 'bottega-smoke-0001', hook_event_name: 'PostToolUseFailure', cwd: fakeCwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't5', error: 'Exit code 1\nFAIL src/a.test.ts\nTests: 1 failed', ...extra }));
  ok((await fbLoopIn()).status === 204, 'giro in tondo: spento di base, niente');
  core.state.setSettings({ fbLoop: 'on' });
  const fbL0 = await fbLoopIn({ tool_input: { command: 'npm run lint' } });
  const fbL1 = await fbLoopIn({ agent_id: 'sub-che-non-esiste' });
  ok(fbL0.status === 204 && fbL1.status === 204, `giro in tondo: un altro comando (${fbL0.status}) o un agente che l'ufficio non conosce (${fbL1.status}) → niente`);
  const fbL = await fbLoopIn();
  let fbLj = {}; try { fbLj = JSON.parse(fbL.body); } catch {}
  const fbLt = (fbLj.hookSpecificOutput && fbLj.hookSpecificOutput.additionalContext) || '';
  ok(fbL.status === 200 && /^Platypus: this command failed 4 times in a row with the same error \(«FAIL src\/a\.test\.ts»\) and no edit in between\./.test(fbLt), 'giro in tondo, acceso: i tentativi di prima vengono dallo stato dell\'ufficio → ' + fbL.status + ' «' + fbLt.slice(0, 80) + '…»');
  ok(core.feedbackLog.recent(fakeCwd).some(e => e.sid === 'bottega-smoke-0001' && e.feature === 'loop' && e.mode === 'on' && e.event === 'PostToolUseFailure'), 'giro in tondo: il messaggio resta nel registro del progetto');
  ok((await fbLoopIn({ tool_use_id: 't6' })).status === 204, 'giro in tondo: lo stesso avviso non torna allo stesso agente');
  core.state.setSettings({ fbLoop: 'off' });
  // B4 · memoria non aggiornata: il principale legge un file, un sottoagente lo modifica, il principale lo riscrive.
  // Nella 2.11 resta in ombra: niente all'agente, la riga nel registro.
  const fbStSid = 'fb-stale-0001', fbStFile = path.join(fakeCwd, 'src', 'carrello.ts'), fbStT0 = Date.now() - 20000;
  const fbStLine = (k, role, content) => ({ type: role, timestamp: new Date(fbStT0 + k * 1000).toISOString(), sessionId: fbStSid, cwd: fakeCwd, message: role === 'assistant' ? { id: 'fbst' + k, role, content, usage: { input_tokens: 10, output_tokens: 10 } } : { role, content } });
  core.state.applyTranscriptLine(fbStSid, null, fbStLine(1, 'assistant', [{ type: 'tool_use', id: 'st1', name: 'Read', input: { file_path: fbStFile } }]));
  core.state.applyTranscriptLine(fbStSid, null, fbStLine(2, 'user', [{ type: 'tool_result', tool_use_id: 'st1', content: 'export const carrello = {}' }]));
  core.state.applyTranscriptLine(fbStSid, 'sub-stale', fbStLine(3, 'assistant', [{ type: 'tool_use', id: 'st2', name: 'Edit', input: { file_path: fbStFile, old_string: 'a', new_string: 'b' } }]), { meta: { agentType: 'Explore' } });
  core.state.applyTranscriptLine(fbStSid, 'sub-stale', fbStLine(4, 'user', [{ type: 'tool_result', tool_use_id: 'st2', content: 'The file has been updated.' }]), { meta: { agentType: 'Explore' } });
  const fbStIn = (extra = {}) => get(port, '/platypus-hook/feedback', 'POST', JSON.stringify({ session_id: fbStSid, hook_event_name: 'PostToolUse', cwd: fakeCwd, tool_name: 'Write', tool_input: { file_path: fbStFile, content: 'x' }, tool_response: {}, tool_use_id: 'st3', ...extra }));
  const fbStOff = await fbStIn();
  ok(fbStOff.status === 204 && !core.feedbackLog.recent(fakeCwd).some(e => e.feature === 'stale'), 'memoria non aggiornata: spenta di base, niente nemmeno nel registro');
  core.state.setSettings({ fbStale: 'on' });
  const fbStOwn = await fbStIn({ agent_id: 'sub-stale' });
  const fbSt = await fbStIn();
  const fbStE = core.feedbackLog.recent(fakeCwd).find(e => e.sid === fbStSid && e.feature === 'stale');
  ok(core.state.settings.fbStale === 'shadow' && fbStOwn.status === 204 && fbSt.status === 204 && fbStE && fbStE.mode === 'shadow' && fbStE.agent === 'main' && /^Platypus: you just rewrote `src\/carrello\.ts`, but EXPLORE changed it at \d\d:\d\d/.test(fbStE.text), 'memoria non aggiornata: chi l\'ha cambiato viene dallo stato dell\'ufficio, e resta in ombra → ' + fbSt.status + ' «' + (fbStE ? fbStE.text.slice(0, 70) : '-') + '…»');
  core.state.setSettings({ fbStale: 'off' });
  // B5 · affermazioni senza prove a fine turno: una modifica, nessun test, e l'agente si ferma dicendo «All tests pass».
  // Nella 2.11 resta in ombra: a Claude Code non arriva niente (nessun blocco), nel registro c'è che cosa avrebbe chiesto.
  const fbClT0 = Date.now() - 20000;
  const fbClTurn = (sid, withTest) => {
    const line = (k, role, content) => ({ type: role, timestamp: new Date(fbClT0 + k * 1000).toISOString(), sessionId: sid, cwd: fakeCwd, message: role === 'assistant' ? { id: sid + k, role, content, usage: { input_tokens: 10, output_tokens: 10 } } : { role, content } });
    core.state.applyTranscriptLine(sid, null, line(0, 'user', 'Sistema gli arrotondamenti del carrello'));
    core.state.applyTranscriptLine(sid, null, line(1, 'assistant', [{ type: 'tool_use', id: sid + '-e', name: 'Edit', input: { file_path: path.join(fakeCwd, 'src', 'carrello.ts'), old_string: 'a', new_string: 'b' } }]));
    core.state.applyTranscriptLine(sid, null, line(2, 'user', [{ type: 'tool_result', tool_use_id: sid + '-e', content: 'The file has been updated.' }]));
    if (!withTest) return;
    core.state.applyTranscriptLine(sid, null, line(3, 'assistant', [{ type: 'tool_use', id: sid + '-t', name: 'Bash', input: { command: 'npm test' } }]));
    core.state.applyTranscriptLine(sid, null, line(4, 'user', [{ type: 'tool_result', tool_use_id: sid + '-t', content: 'PASS src/carrello.test.ts\nTests: 12 passed, 12 total' }]));
  };
  fbClTurn('fb-claims-0001', false);
  fbClTurn('fb-claims-0002', true);
  const fbClIn = (sid, extra = {}) => get(port, '/platypus-hook/feedback', 'POST', JSON.stringify({ session_id: sid, hook_event_name: 'Stop', cwd: fakeCwd, stop_hook_active: false, last_assistant_message: 'Fixed the rounding in the cart. All tests pass.', ...extra }));
  const fbClOff = await fbClIn('fb-claims-0001');
  ok(fbClOff.status === 204 && !core.feedbackLog.recent(fakeCwd).some(e => e.feature === 'claims'), 'affermazioni a fine turno: spente di base, niente nemmeno nel registro');
  core.state.setSettings({ fbClaims: 'on' });
  const fbClAct = await fbClIn('fb-claims-0001', { stop_hook_active: true });
  const fbCl = await fbClIn('fb-claims-0001');
  const fbClOk = await fbClIn('fb-claims-0002');
  const fbClLog = core.feedbackLog.recent(fakeCwd).filter(e => e.feature === 'claims');
  ok(core.state.settings.fbClaims === 'shadow' && fbClAct.status === 204 && fbCl.status === 204 && fbCl.body === '' && fbClOk.status === 204, `affermazioni a fine turno: nella 2.11 nessun blocco arriva a Claude Code → ${fbCl.status}`);
  ok(fbClLog.length === 1 && fbClLog[0].sid === 'fb-claims-0001' && fbClLog[0].mode === 'shadow' && fbClLog[0].event === 'Stop' && fbClLog[0].tag === 'tests/ungrounded' && /^Platypus: you said «All tests pass\.», but no test ran after your last edit/.test(fbClLog[0].text), 'affermazioni a fine turno: nel registro solo il turno senza prove, con che cosa avrebbe chiesto «' + (fbClLog[0] ? fbClLog[0].text.slice(0, 80) : '-') + '…»');
  core.state.setSettings({ fbClaims: 'off' });
  // B6 · ritorno al compito (sperimentale): otto azioni sul compito, poi quattordici su tutt'altro. La stella polare
  // dell'ufficio dice «alla deriva»; nella 2.11 resta in ombra: niente all'agente, la riga nel registro.
  const fbDrSid = 'fb-drift-0001', fbDrT0 = Date.now() - 120000;
  const fbDrLine = (k, role, content) => ({ type: role, timestamp: new Date(fbDrT0 + k * 1000).toISOString(), sessionId: fbDrSid, cwd: fakeCwd, message: role === 'assistant' ? { id: 'fbdr' + k, role, content, usage: { input_tokens: 10, output_tokens: 10 } } : { role, content } });
  core.state.applyTranscriptLine(fbDrSid, null, fbDrLine(0, 'user', 'Fix the login token refresh in the auth module: expired tokens must be renewed'));
  const fbDrOn = ['src/auth/login.ts', 'src/auth/token.ts', 'src/auth/refresh.ts', 'src/auth/login-token.ts'], fbDrOff = ['src/ui/Menu.tsx', 'src/ui/theme/palette.css', 'src/ui/Sidebar.tsx', 'src/ui/Button.tsx', 'src/ui/icons/gradient.css'];
  for (let i = 0; i < 22; i++) {
    const on = i < 8, f = on ? fbDrOn[i % fbDrOn.length] : fbDrOff[i % fbDrOff.length];
    core.state.applyTranscriptLine(fbDrSid, null, fbDrLine(1 + 2 * i, 'assistant', [{ type: 'tool_use', id: 'dr' + i, name: 'Read', input: { file_path: path.join(fakeCwd, f) } }]));
    core.state.applyTranscriptLine(fbDrSid, null, fbDrLine(2 + 2 * i, 'user', [{ type: 'tool_result', tool_use_id: 'dr' + i, content: on ? 'export function refreshToken(login) { /* renew the expired auth token */ }' : 'export const sidebar = { color: palette.dark, hover: gradient }' }]));
  }
  const fbDrIn = () => get(port, '/platypus-hook/feedback', 'POST', JSON.stringify({ session_id: fbDrSid, hook_event_name: 'PostToolUse', cwd: fakeCwd, tool_name: 'Read', tool_input: { file_path: path.join(fakeCwd, 'src/ui/Menu.tsx') }, tool_response: {}, tool_use_id: 'dr21' }));
  const fbDrOffR = await fbDrIn();
  ok(fbDrOffR.status === 204 && !core.feedbackLog.recent(fakeCwd).some(e => e.feature === 'drift'), 'ritorno al compito: spento di base, niente nemmeno nel registro');
  core.state.setSettings({ fbDrift: 'on' });
  const fbDr = await fbDrIn();
  const fbDrE = core.feedbackLog.recent(fakeCwd).find(e => e.sid === fbDrSid && e.feature === 'drift');
  const fbDrMind = JSON.parse((await get(port, `/api/agentmind?sid=${fbDrSid}&aid=main`)).body);
  const fbDrLast = fbDrMind.align && fbDrMind.align[fbDrMind.align.length - 1];
  ok(core.state.settings.fbDrift === 'shadow' && fbDr.status === 204 && fbDrE && fbDrE.mode === 'shadow' && /^Platypus: your last \d+ actions look far from the task you were given: «Fix the login token refresh/.test(fbDrE.text), 'ritorno al compito: la deriva viene dalla stella polare dell\'ufficio, e resta in ombra → ' + fbDr.status + ' «' + (fbDrE ? fbDrE.text.slice(0, 60) : '-') + '…»');
  ok(fbDrLast && fbDrLast[2] / fbDrLast[3] < 0.35, `ritorno al compito: è la stessa serie che la mappa disegna (allineamento ${fbDrLast ? Math.round(100 * fbDrLast[2] / fbDrLast[3]) : '-'}%)`);
  // E5 · la mappa riceve la regola della deriva dal server: è la stessa del motore e dà la stessa risposta
  const ruleJs = await get(port, '/drift-rule.js');
  const ruleBox = { self: {} };
  try { require('vm').runInNewContext(ruleJs.body, ruleBox); } catch {}
  const pageRule = ruleBox.self.PlatypusDrift, fbDrS = core.state.sessions.get(fbDrSid);
  const engineDr = require(path.join(ROOT, 'src', 'core', 'semantic')).drift(fbDrS.main.mind, fbDrS.corpus);
  const pageDr = pageRule && pageRule.judge(fbDrMind.align, fbDrMind.th);
  ok(ruleJs.status === 200 && ruleJs.body === fs.readFileSync(path.join(ROOT, 'src', 'core', 'drift-rule.js'), 'utf8') && pageDr && engineDr && pageDr.drifting === engineDr.drifting && pageDr.run === engineDr.run && pageDr.rel === engineDr.rel, `significato: /drift-rule.js è la regola del motore, e sulla stessa serie la mappa dice lo stesso (deriva da ${pageDr && pageDr.run} azioni)`);
  // E7 · la scena «sinonimi» della demo: il compito dice login, l'agente lavora sull'autenticazione con altre parole.
  // Con il TF-IDF sembra alla deriva; con il provider finto della demo (embedEngine = fake, nascosto) resta sulla rotta.
  {
    const synA = [...core.state.sessions.get(p1.id).subs.values()].find(a => a._demoHold === Infinity);
    const synQ = `/api/agentmind?sid=${p1.id}&aid=${synA && synA.id}`;
    const lex = JSON.parse((await get(port, synQ)).body), lexJ = pageRule.judge(lex.align, lex.th);
    await get(port, '/api/settings', 'POST', JSON.stringify({ embedEngine: 'fake' }));
    let neu = null;
    for (let i = 0; i < 60 && !(neu && neu.src === 'fake:synonyms' && !neu.refining); i++) { neu = JSON.parse((await get(port, synQ)).body); await sleep(30); }
    const neuJ = neu && pageRule.judge(neu.align, neu.th);
    ok(synA && lex.src === 'tfidf' && lexJ.drifting && neu.src === 'fake:synonyms' && neu.th.calibrated && !neuJ.drifting && neuJ.state === 'on', `demo, sinonimi: col TF-IDF «alla deriva» da ${lexJ.run} azioni, col significato finto «sulla rotta» (allineamento ${Math.round(neuJ.rel * 100)}%)`);
    const real = JSON.parse((await get(port, `/api/agentmind?sid=${fbDrSid}&aid=main`)).body);
    ok(real.src === 'tfidf' && real.refining === false && JSON.parse((await get(port, '/api/settings')).body).embedEngine === 'fake', 'demo, sinonimi: il provider finto vale solo per le sessioni della demo, le altre restano lessicali');
    await get(port, '/api/settings', 'POST', JSON.stringify({ embedEngine: 'tfidf' }));
  }
  core.state.setSettings({ fbDrift: 'off' });
  // C1 · quello che l'ufficio e il Libro mostrano: gli ultimi messaggi nello stato, il registro del progetto, i conteggi
  const fbSaid = core.feedbackSaid();
  ok(fbSaid.some(x => x.sid === 'bottega-smoke-0001' && x.agent === 'main' && x.feature === 'loop' && x.mode === 'on' && /^Platypus: /.test(x.text)) && fbSaid.some(x => x.sid === 'fb-claims-0001' && x.mode === 'shadow') && !fbSaid.some(x => x.sid === 'fb-slow'), `ufficio: gli ultimi messaggi (mandati e in ombra, non quelli in ritardo) sono pronti per i fumetti (${fbSaid.length})`);
  const fbSse = await sseFirst(port);
  ok(Array.isArray(fbSse.feedback) && fbSse.feedback.some(x => x.feature === 'loop' && x.sid === 'bottega-smoke-0001'), 'ufficio: arrivano alla pagina con lo stato');
  const fbBook = JSON.parse((await get(port, '/api/feedback/log?cwd=' + encodeURIComponent(fakeCwd))).body);
  const fbRowL = fbBook.entries && fbBook.entries.find(e => e.feature === 'loop');
  ok(fbBook.ok && fbRowL && fbRowL.mode === 'on' && fbRowL.name === 'CLAUDE' && fbRowL.event === 'PostToolUseFailure' && /this command failed 4 times/.test(fbRowL.sent || fbRowL.text) && fbBook.entries.every((e, i, l) => !i || l[i - 1].t >= e.t), `Libro, scheda FEEDBACK: ${fbBook.entries ? fbBook.entries.length : '-'} righe del progetto, dalla più recente, con a chi e che cosa`);
  ok(['stale', 'claims', 'drift', 'elder', 'sessionLessons'].every(f => fbBook.entries.some(e => e.feature === f)) && fbBook.entries.find(e => e.feature === 'claims').tag === 'tests/ungrounded' && (await get(port, '/api/feedback/log')).status === 404, 'Libro, scheda FEEDBACK: tutte le funzioni provate qui sopra, e niente senza un progetto');
  const fbCnt = JSON.parse((await get(port, '/api/feedback/counts')).body);
  ok(fbCnt.ok && fbCnt.days === 7 && fbCnt.counts.loop.on === 1 && fbCnt.counts.claims.shadow === 1 && fbCnt.counts.claims.on === 0 && fbCnt.counts.elder.on >= 2, 'opzioni: i conteggi degli ultimi 7 giorni per funzione → ' + JSON.stringify(fbCnt.counts));
  // C2 · esiti: dopo il giro in tondo l'agente modifica un file e i test passano; dopo l'affermazione senza prove
  // (in ombra) arriva una nuova richiesta senza che niente sia stato lanciato
  const fbOcT = Date.now() + 1000;
  const fbOcLine = (sid, k, role, content) => ({ type: role, timestamp: new Date(fbOcT + k * 1000).toISOString(), sessionId: sid, cwd: fakeCwd, message: role === 'assistant' ? { id: sid + 'oc' + k, role, content, usage: { input_tokens: 10, output_tokens: 10 } } : { role, content } });
  core.state.applyTranscriptLine('bottega-smoke-0001', null, fbOcLine('bottega-smoke-0001', 0, 'assistant', [{ type: 'tool_use', id: 'oc1', name: 'Edit', input: { file_path: path.join(fakeCwd, 'src', 'a.ts'), old_string: 'a', new_string: 'b' } }]));
  core.state.applyTranscriptLine('bottega-smoke-0001', null, fbOcLine('bottega-smoke-0001', 1, 'user', [{ type: 'tool_result', tool_use_id: 'oc1', content: 'The file has been updated.' }]));
  core.state.applyTranscriptLine('fb-claims-0001', null, fbOcLine('fb-claims-0001', 2, 'user', 'Ora aggiungi lo sconto'));
  const fbPend0 = core.feedbackPending.size;
  const fbJudged = core.judgeFeedback(fbOcT + 5000);
  const fbOc = JSON.parse((await get(port, '/api/feedback/log?cwd=' + encodeURIComponent(fakeCwd))).body).entries;
  const fbOcL = fbOc.find(e => e.feature === 'loop'), fbOcC = fbOc.find(e => e.feature === 'claims'), fbOcS = fbOc.find(e => e.feature === 'sessionLessons' && e.mode === 'on');
  ok(fbJudged >= 3 && core.feedbackPending.size === fbPend0 - fbJudged && fbOcL.outcome === 'helped' && fbOcL.why && fbOcC.outcome === 'ignored' && fbOcC.mode === 'shadow' && fbOcS.outcome === 'unclear', `esiti dai passi veri: giro in tondo → ${fbOcL.outcome} («${fbOcL.why}»), affermazione in ombra → ${fbOcC.outcome}, lezioni a inizio sessione → ${fbOcS.outcome} (${fbJudged} giudicati, ${core.feedbackPending.size} in attesa)`);
  ok(!fbOc.some(e => e.sid === 'fb-slow' && e.outcome !== 'late') && [...core.feedbackPending.values()].every(p => p.entry.sid !== 'bottega-smoke-0001' || p.entry.feature !== 'loop'), 'esiti: la risposta arrivata tardi resta «in ritardo», e un messaggio giudicato non torna in attesa');
  const fb4 = await get(port, '/platypus-hook/feedback', 'POST', 'non è json {');
  ok(fb4.status === 204, 'feedback con un corpo che non è JSON: 204 → ' + fb4.status);
  // gli hook di feedback dal pannello delle opzioni: prima le righe da vedere, poi si scrive solo con la conferma
  const fbSet = path.join(base, 'settings.json');
  const fbPrev = JSON.parse((await get(port, '/api/feedback/hooks')).body);
  ok(fbPrev.ok && fbPrev.installed === false && fbPrev.path === fbSet && /"type": "http"/.test(fbPrev.text) && fbPrev.text.includes(`http://127.0.0.1:${port}/platypus-hook/feedback`), 'hook di feedback: anteprima delle righe, con la porta del server');
  const fbNo = await get(port, '/api/feedback/hooks', 'POST', JSON.stringify({ action: 'install' }));
  ok(fbNo.status === 400 && !fs.existsSync(fbSet), 'hook di feedback: senza conferma non si scrive niente → ' + fbNo.status);
  const fbYes = JSON.parse((await get(port, '/api/feedback/hooks', 'POST', JSON.stringify({ action: 'install', confirm: true }))).body);
  ok(fbYes.ok && fbYes.installed && fs.readFileSync(fbSet, 'utf8').includes('/platypus-hook/feedback'), 'hook di feedback: con la conferma finiscono in settings.json');
  const fbOff = JSON.parse((await get(port, '/api/feedback/hooks', 'POST', JSON.stringify({ action: 'uninstall', confirm: true }))).body);
  ok(fbOff.ok && !fbOff.installed && fbOff.removed && !fs.readFileSync(fbSet, 'utf8').includes('platypus-hook'), 'hook di feedback: rimossi dal pannello');
  fs.rmSync(fbSet, { force: true });
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
  // C3 · la demo finisce: il suo registro di feedback si svuota e i suoi messaggi non aspettano più un esito
  const p1Cwd = p1 && p1.cwd;
  core.demo.stop();
  const dAfter = p1Cwd ? JSON.parse((await get(port, '/api/feedback/log?cwd=' + encodeURIComponent(p1Cwd))).body) : {};
  ok(dAfter.ok && dAfter.demo === false && dAfter.entries.length === 0 && ![...core.feedbackPending.values()].some(p => /^demo-/.test(p.entry.sid)) && !core.feedbackSaid().some(x => /^demo-/.test(x.sid)), 'demo spenta: niente più righe di feedback della demo, né in attesa né nei fumetti');

  // Cowork su un albero finto di Windows (docs/plans/cowork-structure.md): percorso noto, titolo e stato dai metadati
  console.log('Cowork (albero finto di Windows)');
  {
    const copyTree = (from, to) => { // `_claude` è la cartella `.claude` (git ignora `.claude/`)
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const dst = path.join(to, e.name === '_claude' ? '.claude' : e.name);
        if (e.isDirectory()) copyTree(path.join(from, e.name), dst); else fs.copyFileSync(path.join(from, e.name), dst);
      }
    };
    const cwRoot = path.join(tmp, 'cowork-win');
    copyTree(path.join(__dirname, 'fixtures', 'cowork-win'), cwRoot);
    const fresh = new Date(); // i file di prova sembrano scritti adesso (il motore segue solo le cartelle usate nelle ultime 36 ore)
    const touchAll = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) touchAll(p); else fs.utimesSync(p, fresh, fresh); } };
    touchAll(cwRoot);
    const { findCoworkBases, readCoworkMeta } = require(path.join(ROOT, 'src', 'core', 'sources'));
    const r = findCoworkBases(cwRoot).bases.filter(b => b.path.startsWith(cwRoot));
    const act = r.find(b => b.meta && b.meta.title === 'Prova Cowork dal metadato'), arc = r.find(b => b.meta && b.meta.isArchived === true);
    ok(r.length === 2 && act && arc && act.files === 1 && act.path.endsWith(path.join('local_1', '.claude')), `Cowork: il percorso noto trova le due sessioni e non il decoy delle abilità (${r.map(b => path.basename(path.dirname(b.path))).join(', ')})`);
    ok(act && act.meta.cliSessionId === 'c1' && act.meta.model === 'claude-opus-4-8' && act.meta.isArchived === false, 'Cowork: dai metadati titolo, id del transcript, modello e stato');
    const meta = readCoworkMeta(path.join(cwRoot, 'local-agent-mode-sessions', 'a', 'b', 'local_1.json'));
    ok(meta && !('emailAddress' in meta) && !('accountName' in meta) && !('systemPrompt' in meta) && !('initialMessage' in meta) && !JSON.stringify(meta).includes('example.invalid'), 'Cowork: dei metadati si tengono solo i campi che servono (niente e-mail, nome, prompt)');
    // una radice senza il percorso noto (cartella indicata a mano, struttura cambiata): resta la ricerca larga
    const odd = path.join(tmp, 'cowork-odd');
    fs.mkdirSync(path.join(odd, 'chissa', 'dove', 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(odd, 'chissa', 'dove', 'projects', 'p', 'x.jsonl'), '{}\n');
    const r2 = findCoworkBases(odd).bases.filter(b => b.path.startsWith(odd));
    ok(r2.length === 1 && r2[0].meta === undefined, 'Cowork: struttura sconosciuta → la ricerca larga trova lo stesso la cartella');
    // nel motore: il titolo dell'app vince su quello del transcript, e la sessione archiviata non si segue
    await get(port, '/api/settings', 'POST', JSON.stringify({ coworkDirs: cwRoot }));
    let cw = null;
    for (let k = 0; k < 40 && !cw; k++) { await sleep(150); const st = JSON.parse((await get(port, '/api/state')).body); cw = st.sessions.find(s => s.wing === 'cowork' && /Prova Cowork|Titolo dal transcript/.test(s.title || '')); }
    ok(cw && cw.title === 'Prova Cowork dal metadato', `Cowork: la scheda mostra il titolo dei metadati (${cw && cw.title})`);
    const st2 = JSON.parse((await get(port, '/api/state')).body);
    ok(!st2.sessions.some(s => s.title === 'Sessione archiviata'), 'Cowork: la sessione archiviata nell\'app non compare');
    await get(port, '/api/settings', 'POST', JSON.stringify({ coworkDirs: '' }));
  }
  core.stop();

  console.log('hook di Claude Code');
  const hooks = require(path.join(ROOT, 'src', 'core', 'hooks'));
  hooks.install({ port: 47800, base });
  ok(hooks.status({ base }) && !hooks.outdated({ base }), 'installati in una configurazione di prova');
  hooks.uninstall({ base });
  ok(!hooks.status({ base }), 'rimossi');
  // gli hook di feedback (2.11) si installano e si tolgono a parte: gli altri, e quelli dell'utente, restano come sono
  const sp = path.join(base, 'settings.json');
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mio' }] };
  fs.writeFileSync(sp, JSON.stringify({ model: 'opus', hooks: { PostToolUse: [mine] } }, null, 2));
  hooks.install({ port: 47800, base });
  const readS = () => JSON.parse(fs.readFileSync(sp, 'utf8'));
  const isFb = h => [h.url, h.command].some(x => typeof x === 'string' && x.includes('/platypus-hook/feedback'));
  const others = s => JSON.stringify(Object.fromEntries(Object.entries(s.hooks).map(([ev, gs]) => [ev, gs.map(g => ({ ...g, hooks: g.hooks.filter(h => !isFb(h)) })).filter(g => g.hooks.length)]).filter(([, gs]) => gs.length).sort((a, b) => a[0].localeCompare(b[0])))); // l'ordine degli eventi nel file non conta
  const countFb = s => Object.values(s.hooks).flat().flatMap(g => g.hooks).filter(isFb).length;
  const before = others(readS());
  ok(!hooks.feedbackStatus({ base }), 'hook di feedback: non installati insieme a quelli che osservano');
  const fi = hooks.installFeedback({ port: 47800, base });
  let cur = readS();
  ok(hooks.feedbackStatus({ base }) && hooks.status({ base }) && fi.events === 5 && countFb(cur) === 5 && cur.model === 'opus', `hook di feedback installati a parte: ${countFb(cur)} eventi`);
  ok(others(cur) === before, 'gli hook che osservano e quelli dell\'utente restano identici');
  ok(cur.hooks.Stop.some(g => g.hooks.some(h => h.type === 'http' && h.timeout === 3 && !h.async)) && cur.hooks.PostToolUseFailure.some(g => g.matcher === hooks.FEEDBACK_TOOLS && g.hooks.some(isFb)) && !cur.hooks.PreToolUse.some(g => g.hooks.some(isFb)), 'hook di feedback: http, sincroni, sui soli eventi previsti (mai PreToolUse)');
  hooks.installFeedback({ port: 47800, base });
  ok(countFb(readS()) === 5, 'installarli due volte non li raddoppia');
  hooks.installFeedback({ port: 47800, base, curl: true });
  cur = readS();
  ok(countFb(cur) === 5 && cur.hooks.Stop.some(g => g.hooks.some(h => h.type === 'command' && /curl/.test(h.command) && isFb(h))), 'con curl: comandi al posto degli hook http, sempre cinque');
  hooks.install({ port: 47800, base }); // reinstallare (o aggiornare) quelli che osservano non tocca quelli di feedback, nemmeno se sono comandi curl
  ok(countFb(readS()) === 5 && !hooks.outdated({ base }), 'reinstallare gli hook che osservano lascia quelli di feedback');
  hooks.uninstall({ base });
  ok(!hooks.status({ base }) && hooks.feedbackStatus({ base }) && countFb(readS()) === 5, 'togliere gli hook che osservano lascia quelli di feedback');
  hooks.install({ port: 47800, base });
  const ru = hooks.uninstallFeedback({ base });
  cur = readS();
  ok(ru.removed && !hooks.feedbackStatus({ base }) && hooks.status({ base }) && others(cur) === before && cur.hooks.PostToolUse.some(g => g.hooks.some(h => h.command === 'echo mio')), 'tolti gli hook di feedback: il resto è com\'era');
  ok(hooks.uninstallFeedback({ base }).removed === false, 'toglierli due volte: niente da fare');
  hooks.uninstall({ base });

  // il guscio Tauri avvia il motore come processo figlio e ne tiene aperto lo stdin: quando il guscio si chiude
  // (anche in modo brusco) il motore deve salvare e uscire da solo. Home e dati finti: mai le sessioni vere
  console.log('motore avviato da un guscio (--parent-stdin)');
  {
    const home = path.join(tmp, 'home-guscio');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const sp = 47990 + Math.floor(Math.random() * 9);
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PLATYPUS_DATA_DIR: path.join(home, '.platypus'), PLATYPUS_PORT: String(sp) };
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'standalone.js'), '--no-open', '--parent-stdin'], { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const exited = new Promise(r => child.on('exit', code => r(code)));
    let up = false;
    for (let k = 0; k < 75 && !up; k++) { up = (await get(sp, '/api/state')).status === 200; if (!up) await sleep(200); }
    child.stdin.end();
    const code = await Promise.race([exited, sleep(5000).then(() => 'ancora acceso')]);
    if (code !== 0) try { child.kill(); } catch {}
    ok(up && code === 0, `il motore risponde, e quando il guscio chiude lo stdin esce da solo → ${up ? 'acceso' : 'non risponde'}, uscita ${code}`);
  }

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

  // Windows: cambiando «Avvia all'accesso» sparisce anche la voce di avvio che si chiamava come Agent Office
  {
    const autostart = require(path.join(ROOT, 'src', 'autostart'));
    const calls = [];
    const fakeApp = { isPackaged: false, commandLine: { hasSwitch: () => false }, setLoginItemSettings: o => calls.push(o), getLoginItemSettings: () => ({ openAtLogin: false }) };
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { autostart.setEnabled(fakeApp, false); } finally { Object.defineProperty(process, 'platform', realPlatform); }
    ok(calls.some(c => c.openAtLogin === false && c.name === 'com.agentoffice.desktop'), 'Windows: la vecchia voce di avvio «com.agentoffice.desktop» viene tolta');
  }

  // il controllo del log della modalità mini (lo usano le Actions su macOS)
  {
    const { check } = require('./check-mini-log');
    ok(check('x\n[snapshot] bounds {"x":1,"y":2,"width":382,"height":151} onTop true\n').ok, 'modalità mini: striscia piccola e in primo piano → bene');
    ok(!check('[snapshot] bounds {"x":1,"y":2,"width":980,"height":620} onTop true').ok && !check('[snapshot] bounds {"x":1,"y":2,"width":380,"height":150} onTop false').ok && !check('niente').ok, 'modalità mini: finestra grande, non in primo piano o senza riga → errore');
  }

  // Windows rifiuta i percorsi sopra i 260 caratteri: un file del repository troppo "lungo" fa fallire il checkout nelle Actions
  {
    const ls = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    if (ls.status === 0) {
      const longest = ls.stdout.split('\n').filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
      ok(longest.length <= 150, `repository: il percorso più lungo di un file ha ${longest.length} caratteri (max 150, per stare sotto i 260 di Windows con una cartella di lavoro lunga): ${longest.slice(0, 60)}`);
    } else ok(true, 'git non disponibile: lunghezza dei percorsi non controllata');
  }

  // Node 24 stampa l'avviso DEP0190 se si passano argomenti a un processo con shell: l'avvio non deve farlo
  const launchSrc = fs.readFileSync(path.join(__dirname, 'launch.js'), 'utf8');
  ok(!/spawnSync\([^;]*\[[^\]]*\][^;]*shell:\s*(IS_WIN|true)/.test(launchSrc), 'avvio: nessun argomento separato con shell (avviso DEP0190 di Node 24)');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
