#!/usr/bin/env node
'use strict';
// Prove del motore per i casi trovati dal giro di debug: stato dei sottoagenti, lettura dei transcript,
// archivio, mappa, libro. Tutto in memoria o in cartelle temporanee, mai sessioni vere.
// Le richiama smoke-test.js (quindi anche npm test e le GitHub Actions); si possono lanciare anche da sole.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const iso = t => new Date(t).toISOString();

// un sottoagente che scrive una frase e poi pensa più di 25 s (es. il contenuto di un Write lungo)
// non va dato per finito e poi contato di nuovo come agente nuovo
function quietSubTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  let now = Date.parse('2026-10-23T10:00:00Z');
  const st = new OfficeState({ clock: () => now, settings: {} });
  const S = 'sess-quiet-0001';
  const line = (t, type, content, extra = {}) => ({ type, timestamp: iso(t), cwd: '/p', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + t, usage: { input_tokens: 1, output_tokens: 1 } } : {}) }, ...extra });
  const t0 = now;
  st.applyTranscriptLine(S, null, line(t0, 'assistant', [{ type: 'tool_use', id: 'spawn1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Scrive il modulo' } }]));
  st.applyTranscriptLine(S, 'ag1', line(t0 + 1000, 'user', 'Scrivi il modulo'));
  st.applyTranscriptLine(S, 'ag1', line(t0 + 2000, 'assistant', [{ type: 'text', text: 'Ora creo il file del modulo.' }]));
  const s = st.sessions.get(S);
  const a1 = s.subs.get('ag1');
  for (let k = 1; k <= 8; k++) { now = t0 + 2000 + k * 5000; st.tick(); } // 40 s senza righe
  now = t0 + 42000;
  st.applyTranscriptLine(S, 'ag1', line(now, 'assistant', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/p/src/mod.ts', content: '…' } }]));
  const a2 = s.subs.get('ag1');
  ok(a2 === a1 && !a2.finished && a2.status === 'working', 'sottoagente zitto per 40 s che riscrive: è lo stesso agente, di nuovo al lavoro');
  st.applyTranscriptLine(S, 'ag1', line(now + 1000, 'user', [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }]));
  st.applyTranscriptLine(S, null, line(now + 2000, 'user', [{ type: 'tool_result', tool_use_id: 'spawn1', content: 'fatto' }], { toolUseResult: { status: 'completed', agentId: 'ag1' } }));
  ok(s.completed === 1 && Object.values(s.completedByType).reduce((x, y) => x + y, 0) === 1, `quando finisce davvero il compito si conta una volta sola (fatti: ${s.completed}, per tipo: ${JSON.stringify(s.completedByType)})`);
  st.stop && st.stop();
}

// un sottoagente vecchio (o già concluso all'avvio) che viene ripreso, es. con SendMessage:
// le righe nuove nello stesso file vanno lette, non ignorate per sempre
function resumedSubTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const { TranscriptWatcher } = require(path.join(ROOT, 'src', 'core', 'sources'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  try {
    const pdir = path.join(tmp, 'projects', 'proj');
    const now = Date.now();
    const L = (sid, t, type, content) => JSON.stringify({ type, timestamp: iso(t), sessionId: sid, cwd: '/p', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + t + Math.random(), usage: { input_tokens: 1, output_tokens: 1 } } : {}) } }) + '\n';
    const setup = (sid, { finished = false } = {}) => {
      fs.mkdirSync(path.join(pdir, sid, 'subagents'), { recursive: true });
      const main = path.join(pdir, sid + '.jsonl');
      fs.writeFileSync(main, L(sid, now - 60000, 'user', 'ciao'));
      const sub = path.join(pdir, sid, 'subagents', 'agent-ag1.jsonl');
      fs.writeFileSync(sub, L(sid, now - 3600000, 'user', 'Analizza i moduli') + L(sid, now - 3599000, 'assistant', [{ type: 'text', text: 'Fatto.' }]));
      fs.writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Analizza i moduli', finished }));
      if (!finished) { const old = new Date(now - 3600000); fs.utimesSync(sub, old, old); }
      return { main, sub, resume: () => fs.appendFileSync(sub, L(sid, now + 1000, 'user', 'Riprendi: controlla anche api/') + L(sid, now + 2000, 'assistant', [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/api/a.ts' } }])) };
    };
    // 1) la sessione è già seguita quando si trova il file vecchio del sottoagente (l'ordine dipende dal sistema)
    {
      const st = new OfficeState({});
      const w = new TranscriptWatcher(st, { base: tmp });
      const f = setup('sess-old-0001');
      w.maybeTrack(f.main, true);
      w.scan(true);
      const tokBefore = st.sessions.get('sess-old-0001').tok.out;
      f.resume();
      w.pollTracked();
      const s = st.sessions.get('sess-old-0001'), a = s && s.subs.get('ag1');
      ok(a && !a.finished && a.status === 'working' && !w.files.get(f.sub).ignored, 'sottoagente vecchio ripreso: torna nel piano e lo seguiamo dal vivo');
      ok(s.tok.out === tokBefore + 1, `i suoi token vecchi non si contano due volte (${tokBefore} → ${s.tok.out})`);
      w.stop();
    }
    // 2) sottoagente già concluso quando si apre l'ufficio, poi ripreso
    {
      const st = new OfficeState({});
      const w = new TranscriptWatcher(st, { base: tmp });
      const f = setup('sess-fin-0001', { finished: true });
      w.maybeTrack(f.main, true);
      w.maybeTrack(f.sub, true);
      f.resume();
      w.pollTracked();
      w.refreshMeta(); // il meta.json dice ancora "finished" (scritto prima della ripresa)
      const a = st.sessions.get('sess-fin-0001').subs.get('ag1');
      ok(a && !a.finished && a.status === 'working', 'sottoagente concluso all\'avvio e poi ripreso: di nuovo al lavoro, nonostante il vecchio «finished»');
      w.stop();
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// lettura: un carattere accentato spezzato fra due letture del file non deve diventare «�»
function splitCharTests(ok) {
  const { TranscriptWatcher } = require(path.join(ROOT, 'src', 'core', 'sources'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  try {
    const pdir = path.join(tmp, 'projects', 'proj');
    fs.mkdirSync(pdir, { recursive: true });
    const f = path.join(pdir, 'sess-utf8-0001.jsonl');
    const got = [];
    const st = { sessions: new Map(), accountLine() {}, applyTranscriptLine(_s, _a, o) { got.push(o); } };
    const L = text => Buffer.from(JSON.stringify({ type: 'user', timestamp: iso(Date.now()), sessionId: 'sess-utf8-0001', message: { role: 'user', content: text } }) + '\n');
    const b = L('Perché non funziona più?');
    const cut = b.indexOf(Buffer.from('é')) + 1; // a metà dei due byte di «é»
    fs.writeFileSync(f, b.subarray(0, cut));
    const w = new TranscriptWatcher(st, { base: tmp });
    w.maybeTrack(f, false);
    fs.appendFileSync(f, b.subarray(cut));
    w.pollTracked();
    const t = got[0] && got[0].message.content;
    ok(t === 'Perché non funziona più?', `carattere UTF-8 spezzato fra due letture: «${t}»`);
    // file riscritto più corto: il decodificatore riparte da zero
    fs.writeFileSync(f, L('Già fatto'));
    w.pollTracked();
    ok(got[1] && got[1].message.content === 'Già fatto', 'file riscritto: si rilegge da capo');
    w.stop();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// archivio: durata e titolo di una sessione il cui file sta fra 64 e 256 KB
function archiveTests(ok) {
  const { listArchive } = require(path.join(ROOT, 'src', 'core', 'archive'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  try {
    const pdir = path.join(tmp, 'projects', 'proj');
    fs.mkdirSync(pdir, { recursive: true });
    const t0 = Date.parse('2026-10-20T09:00:00Z'), pad = 'x'.repeat(900);
    let body = '';
    for (let i = 0; i < 200; i++) body += JSON.stringify({ type: i % 2 ? 'assistant' : 'user', timestamp: iso(t0 + i * 60000), sessionId: 'sess-arch-0001', cwd: '/p/app', message: { role: i % 2 ? 'assistant' : 'user', content: i === 0 ? 'Rifai la pagina di login' : [{ type: 'text', text: pad }] } }) + '\n';
    body += JSON.stringify({ type: 'ai-title', aiTitle: 'Nuova pagina di login', sessionId: 'sess-arch-0001' }) + '\n';
    fs.writeFileSync(path.join(pdir, 'sess-arch-0001.jsonl'), body);
    const x = listArchive({ base: tmp }).find(r => r.id === 'sess-arch-0001');
    const kb = Math.round(body.length / 1024), min = x ? Math.round((x.end - x.start) / 60000) : -1;
    ok(x && min === 199 && x.title === 'Nuova pagina di login' && x.start === t0, `archivio, file da ${kb} KB: durata ${min} min (vera 199) e titolo «${x && x.title}»`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// archivio: la prima riga (più di 64 KB, es. un'immagine incollata) non deve far perdere inizio, titolo e cartella
function archiveBigFirstLineTests(ok) {
  const { listArchive } = require(path.join(ROOT, 'src', 'core', 'archive'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  try {
    const pdir = path.join(tmp, 'projects', 'proj');
    fs.mkdirSync(pdir, { recursive: true });
    const t0 = Date.parse('2026-10-20T09:00:00Z');
    const m = (i, type, content) => JSON.stringify({ type, timestamp: iso(t0 + i * 60000), sessionId: 'sess-big-0001', cwd: '/p/app', message: { role: type, content } }) + '\n';
    let body = m(0, 'user', [{ type: 'text', text: 'Guarda questa schermata' }, { type: 'image', source: { data: 'A'.repeat(80 * 1024) } }]);
    for (let i = 1; i <= 29; i++) body += m(i, i % 2 ? 'assistant' : 'user', [{ type: 'text', text: 'ok' }]);
    body += JSON.stringify({ type: 'ai-title', aiTitle: 'Schermata da sistemare', sessionId: 'sess-big-0001' }) + '\n';
    fs.writeFileSync(path.join(pdir, 'sess-big-0001.jsonl'), body);
    const x = listArchive({ base: tmp }).find(r => r.id === 'sess-big-0001');
    ok(x && x.start === t0 && Math.round((x.end - x.start) / 60000) === 29 && x.cwd === '/p/app' && x.title === 'Schermata da sistemare', `archivio, prima riga da 80 KB: inizio ${x && x.start === t0}, durata ${x && Math.round((x.end - x.start) / 60000)} min, cartella «${x && x.cwd}»`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// statistiche: il titolo di una sessione Cowork arriva a lavoro iniziato, ma è sempre la stessa sessione
function statsRenameTests(ok) {
  const { Stats } = require(path.join(ROOT, 'src', 'core', 'stats'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  try {
    let cost = 0.8, label = 'Report';
    const s = { id: 'sess-cw-0001', kind: 'cowork', project: 'cowork', createdAt: Date.now(), tok: { in: 1, out: 1, cr: 0, cw: 0 }, completed: 0, completedByType: {}, errByType: {}, toolsByType: {}, wByType: {}, releases: [], alerts: [] };
    const st = { sessions: new Map([[s.id, s]]), label: () => label, costOf: () => cost, rateOf: () => 0 };
    const stats = new Stats(st, path.join(tmp, 'stats.json'));
    stats.collect();
    label = 'Report trimestrale per il cliente'; cost = 1.6;
    stats.collect();
    const r = stats.report(Object.keys(stats.data.days)[0]);
    const names = r.projects.map(p => p.name + ':' + p.cost.toFixed(2));
    ok(r.projects.length === 1 && r.projects[0].name === label && Math.abs(r.projects[0].cost - 1.6) < 1e-6 && r.totals.sessions === 1, `sessione Cowork con titolo arrivato dopo: un solo progetto (${names.join(', ')}; sessioni ${r.totals.sessions})`);
    stats.stop();
    // due sessioni Cowork senza titolo sotto lo stesso nome, poi una riceve il titolo: restano due sessioni in tutto, non tre
    const mk = id => ({ ...s, id });
    const a = mk('sess-cw-000a'), b = mk('sess-cw-000b'), labels = { [a.id]: 'outputs', [b.id]: 'outputs' };
    const st2 = { sessions: new Map([[a.id, a], [b.id, b]]), label: x => labels[x.id], costOf: () => 0.5, rateOf: () => 0 };
    const stats2 = new Stats(st2, path.join(tmp, 'stats2.json'));
    stats2.collect();
    labels[b.id] = 'Report Q3';
    stats2.collect();
    const r2 = stats2.report(Object.keys(stats2.data.days)[0]);
    ok(r2.totals.sessions === 2, `nome condiviso da due sessioni, una cambia titolo: ${r2.totals.sessions} sessioni in tutto (${r2.projects.map(p => p.name + ':' + p.sessions).join(', ')})`);
    stats2.stop();
    const again = new Stats(st, path.join(tmp, 'stats.json')); // il vecchio stats.json (senza «name») resta leggibile
    ok(Object.keys(again.data.days).length === 1, 'stats.json riletto');
    again.stop();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// una domanda di Claude all'utente (AskUserQuestion) senza risposta: l'agente aspetta, e dopo un po' scatta l'avviso
function askUserTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  let now = Date.parse('2026-10-23T10:00:00Z');
  const st = new OfficeState({ clock: () => now, settings: {} });
  const S = 'sess-ask-0001', t0 = now;
  const line = (t, type, content) => ({ type, timestamp: iso(t), cwd: '/p', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + t, usage: { input_tokens: 1, output_tokens: 1 } } : {}) } });
  st.applyTranscriptLine(S, null, line(t0, 'assistant', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Quale?' }] } }]));
  const s = st.sessions.get(S);
  ok(s.main.status === 'waiting', `domanda in sospeso: lo stato è «${s.main.status}» (atteso waiting)`);
  st.applyRegistry([{ sessionId: S, alive: true, status: 'busy', cwd: '/p' }]); // il registro dice «busy»: non la cancella
  ok(s.main.status === 'waiting', 'il registro «busy» non toglie l\'attesa della risposta');
  now = t0 + 4 * 60000; st.tick();
  ok(s.alerts.some(a => a.kind === 'wait' && /risposta|answer/.test(a.text)), 'dopo qualche minuto scatta l\'avviso «aspetta una tua risposta»');
  st.applyTranscriptLine(S, null, line(now, 'user', [{ type: 'tool_result', tool_use_id: 'q1', content: 'A' }]));
  ok(s.main.status === 'thinking' && !s.main.userWait, 'arrivata la risposta, l\'agente torna a pensare');
  st.tick();
  ok(!s.alerts.some(a => a.kind === 'wait'), 'e l\'avviso sparisce');
  // la domanda insieme ad altri strumenti nello stesso messaggio: resta in attesa finché non rispondi, in qualunque ordine
  const use = (id, name) => ({ type: 'tool_use', id, name, input: name === 'Read' ? { file_path: '/p/a.js' } : { questions: [{ question: 'Quale?' }] } });
  const res = id => line(now += 1000, 'user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);
  st.applyTranscriptLine(S, null, line(now += 1000, 'assistant', [use('r2', 'Read'), use('q2', 'AskUserQuestion')]));
  st.applyTranscriptLine(S, null, res('r2'));
  ok(s.main.status === 'waiting', `Read + domanda, finisce il Read: resta in attesa (${s.main.status})`);
  st.applyTranscriptLine(S, null, res('q2'));
  ok(s.main.status === 'thinking' && !s.main.userWait, 'poi rispondi: torna a pensare');
  st.applyTranscriptLine(S, null, line(now += 1000, 'assistant', [use('q3', 'AskUserQuestion'), use('r3', 'Read')]));
  ok(s.main.status === 'waiting', `domanda + Read: il Read non copre l'attesa (${s.main.status})`);
  st.applyTranscriptLine(S, null, res('q3')); st.applyTranscriptLine(S, null, res('r3'));
  ok(s.main.status === 'thinking' && !s.main.userWait, 'risposte arrivate: nessuna attesa rimasta');
  // con gli hook: il PostToolUse di un altro strumento non chiude la domanda, quello della domanda sì
  const hook = (ev, tool) => st.applyHook({ hook_event_name: ev, session_id: S, cwd: '/p', tool_name: tool, tool_input: {} });
  hook('PreToolUse', 'AskUserQuestion'); hook('PreToolUse', 'Read'); hook('PostToolUse', 'Read');
  ok(s.main.status === 'waiting', `hook: finisce un altro strumento, la domanda resta aperta (${s.main.status})`);
  hook('PostToolUse', 'AskUserQuestion');
  ok(s.main.status === 'thinking' && !s.main.userWait, 'hook: risposta arrivata');
  // interrotta: la domanda non vale più, e il lavoro dopo non torna «in attesa»
  st.applyTranscriptLine(S, null, line(now += 1000, 'assistant', [use('q4', 'AskUserQuestion')]));
  st.applyTranscriptLine(S, null, line(now += 1000, 'user', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]));
  st.applyTranscriptLine(S, null, line(now += 1000, 'assistant', [use('r4', 'Read')]));
  ok(s.main.status === 'working' && !s.main.userWait, `dopo un'interruzione la vecchia domanda non conta (${s.main.status})`);
  st.stop && st.stop();
}

// mappa: percorsi dei comandi Git Bash su Windows (/d/dev/... è D:\dev\...)
function gitBashPathTests(ok) {
  const { AgentWorld, relKey } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
  const cwd = 'D:\\dev\\shop';
  const w = new AgentWorld();
  w.start('a', 'Bash', { command: 'cd /d/dev/shop && cat src/cart.ts' }, 1000, cwd);
  w.end('a', false, { content: 'ok' }, null, 1100, cwd);
  w.start('b', 'Read', { file_path: 'D:\\dev\\shop\\src\\cart.ts' }, 1200, cwd);
  w.end('b', false, { content: 'export const cart = 1' }, null, 1300, cwd);
  const keys = [...w.nodes.keys()].filter(k => !/^cmd:/.test(k) && k !== '.'); // "." è la cartella del cd
  ok(keys.length === 1 && keys[0] === 'src/cart.ts', 'Git Bash «cd /d/dev/shop && cat src/cart.ts»: lo stesso luogo del Read, nel progetto (' + keys.join(', ') + ')');
  ok(relKey('/d/dev/other/x.ts', cwd) === 'abs:D:/dev/other/x.ts' && relKey('/cygdrive/d/dev/shop/a.ts', cwd) === 'a.ts', 'Git Bash: fuori dal progetto resta assoluto, /cygdrive/d vale come /d');
  ok(relKey('/d/dev/shop/a.ts', '/home/u/shop') === 'abs:/d/dev/shop/a.ts', 'su Linux e macOS /d/... resta un percorso normale');
}

// mappa: dopo un cd fuori dal progetto Claude Code riporta la shell indietro, anche in una cartella con spazi
function shellResetTests(ok) {
  const { AgentWorld } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
  const cwd = 'C:\\Users\\Mario Rossi\\shop';
  const w = new AgentWorld();
  w.start('c', 'Bash', { command: 'cd .. && ls' }, 1000, cwd);
  w.end('c', false, { content: 'shop\nShell cwd was reset to C:\\Users\\Mario Rossi\\shop' }, null, 1100, cwd);
  w.start('d', 'Bash', { command: 'cat src/cart.ts' }, 1200, cwd);
  w.end('d', false, { content: 'cat: src/cart.ts: No such file or directory' }, null, 1300, cwd);
  const ghosts = [...w.nodes].filter(([, n]) => n.ghost).map(([k]) => k);
  ok(w.shellCwd === 'C:/Users/Mario Rossi/shop' && ghosts.length === 1 && ghosts[0] === 'src/cart.ts', `cartella con spazi dopo «Shell cwd was reset»: ${w.shellCwd} · fantasma ${ghosts.join(', ')}`);
}

// libro: «Dimentica» deve reggere anche se la sessione che ha prodotto la lezione è ancora aperta
// (l'apprendimento dal vivo ripresenta gli stessi casi ogni minuto)
function forgetTests(ok) {
  const { Bottega } = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  try {
    const cwd = path.join(tmp, 'shop'), now = Date.now();
    const old = [{ kind: 'ghost-path', key: 'src/old-cart.ts', sid: 's1', t: now - 20000, agent: 'Claude', excerpt: 'File does not exist.' }];
    const b = new Bottega(path.join(tmp, 'bottega'));
    const ghosts = bk => bk.view(cwd).lessons.filter(l => l.kind === 'ghost-path');
    b.learn(cwd, old);
    const id = ghosts(b)[0].id;
    b.act(cwd, 'forget', id);
    b.learn(cwd, old); // il giro successivo dell'apprendimento dal vivo
    ok(!ghosts(b).length, 'lezione dimenticata: gli stessi casi non la riportano indietro');
    b.stop();
    const b2 = new Bottega(path.join(tmp, 'bottega')); // anche dopo un riavvio
    b2.learn(cwd, old);
    ok(!ghosts(b2).length, 'dimenticata anche dopo il riavvio dell\'app');
    b2.learn(cwd, [{ ...old[0], sid: 's2', t: Date.now() + 60000 }]);
    const g = ghosts(b2);
    ok(g.length === 1 && g[0].count === 1, 'un caso nuovo, dopo «Dimentica», ricomincia la lezione da capo');
    b2.stop();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// finestra: la posizione salvata su un monitor che non c'è più non deve aprirla fuori dallo schermo
function boundsTests(ok) {
  const { fitBounds } = require(path.join(ROOT, 'src', 'bounds'));
  const one = [{ x: 0, y: 0, width: 1920, height: 1160 }];
  const two = [...one, { x: 1920, y: 0, width: 2560, height: 1400 }];
  const saved = { x: 2400, y: 100, width: 980, height: 620 };
  const gone = fitBounds(saved, one);
  ok(gone.x === undefined && gone.y === undefined && gone.width === 980, 'monitor staccato: la finestra si riapre al centro dello schermo che c\'è');
  ok(JSON.stringify(fitBounds(saved, two)) === JSON.stringify(saved), 'monitor ancora collegato: stessa posizione di prima');
  ok(fitBounds({ x: 1900, y: 100, width: 980, height: 620 }, one).x === undefined, 'finestra quasi tutta fuori (meno di 120 px visibili): al centro');
  ok(fitBounds({ x: 1700, y: 100, width: 980, height: 620 }, one).x === 1700, 'finestra in parte fuori ma con la barra in alto visibile: resta dov\'è');
  ok(fitBounds({ x: 100, y: -500, width: 980, height: 620 }, one).y === undefined, 'barra in alto sopra lo schermo: al centro');
  const big = fitBounds({ width: 3000, height: 2000 }, one);
  ok(big.width === 1920 && big.height === 1160, 'dimensioni più grandi dello schermo principale: ridotte');
}

// finestra: cosa resta dentro l'ufficio e cosa si apre nel browser
function urlTests(ok) {
  const { isOwnUrl, isExternalUrl } = require(path.join(ROOT, 'src', 'urls'));
  ok(isOwnUrl('http://127.0.0.1:47800/report', 47800) && isOwnUrl('http://localhost:47800/', 47800), 'le pagine dell\'ufficio restano nella finestra');
  ok(!isOwnUrl('http://127.0.0.1:3000/', 47800) && !isOwnUrl('https://127.0.0.1:47800/', 47800) && !isOwnUrl('http://evil.example/', 47800), 'altre porte, https e altri siti: non sono l\'ufficio');
  ok(isExternalUrl('https://github.com/m4xl4b/platypus/pull/9') && isExternalUrl('http://127.0.0.1:47800/report'), 'http e https si aprono nel browser');
  const bad = ['file:///C:/Windows/System32/calc.exe', 'smb://host/share', 'ms-msdt:/id', 'vscode://x', 'javascript:alert(1)', 'https://user:pw@example.com/', 'not a url'];
  ok(bad.every(u => !isExternalUrl(u)), 'file:, smb:, protocolli di altre app, javascript: e credenziali nell\'indirizzo: mai a openExternal');
}

// ~/.platypus contiene progetti, comandi ed estratti degli errori: su Linux e macOS solo il proprietario la legge
function dataDirTests(ok) {
  if (process.platform === 'win32') { console.log('  --   permessi di ~/.platypus: solo Linux e macOS, controllo saltato'); return; }
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  try {
    // in un processo a parte: la home è quella temporanea, la cartella esiste già con i permessi di prima
    fs.mkdirSync(path.join(tmp, '.platypus'), { mode: 0o755 });
    fs.chmodSync(path.join(tmp, '.platypus'), 0o755);
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'src', 'paths'))}).dataDir()`], { env: { ...process.env, HOME: tmp } });
    const mode = fs.statSync(path.join(tmp, '.platypus')).mode & 0o777;
    ok(mode === 0o700, `~/.platypus solo per il proprietario (permessi ${mode.toString(8)})`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// lanciatore: con quali versioni di Node.js si apre la finestra (Electron 44 vuole la 22.12)
function nodeVersionTests(ok) {
  const { windowNodeOk } = require(path.join(ROOT, 'scripts', 'requirements'));
  ok(['22.12.0', 'v22.23.4', '24.13.0', '25.0.0'].every(windowNodeOk), 'Node.js 22.12, 22.23, 24 e 25: finestra desktop');
  ok(!['20.20.2', '22.11.0', '18.20.0', 'v20.0.0'].some(windowNodeOk), 'Node.js 20, 22.11 e 18: solo modalità browser');
}

// lavagna B: il piano arriva dal file che Claude Code scrive (ExitPlanMode non lo passa più nell'input)
function planBoardTests(ok) {
  const { OfficeState, parsePlan, isPlanFile } = require(path.join(ROOT, 'src', 'core', 'state'));
  let now = Date.parse('2026-10-25T10:00:00Z');
  const st = new OfficeState({ clock: () => now, settings: {} });
  const S = 'sess-plan-0001';
  let k = 0;
  const use = (name, input) => { const id = 'p' + (++k); now += 1000; st.applyTranscriptLine(S, null, { type: 'assistant', timestamp: iso(now), cwd: '/p', message: { id: 'm' + k, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } }); return id; };
  const result = (id, content, extra = {}) => { now += 500; st.applyTranscriptLine(S, null, { type: 'user', timestamp: iso(now), cwd: '/p', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra }); };
  const file = 'C:\\Users\\me\\.claude\\plans\\shiny-plan.md';
  const plan = '# Rifare il login\n\n## Contesto\nIl login usa ancora le sessioni.\n\n## Passi\n1. Togliere **session.ts**\n2. Aggiungere i token\n3. Test e2e\n\n## Verifica\n- npm test';
  result(use('Write', { file_path: file, content: plan }), 'File created');
  result(use('Edit', { file_path: file, old_string: '2. Aggiungere i token', new_string: '2. Aggiungere i token JWT' }), 'ok');
  const s = st.sessions.get(S);
  ok(!s.plan, 'mentre Claude scrive il piano la lavagna non cambia ancora');
  use('ExitPlanMode', {});
  ok(s.plan && s.plan.title === 'Rifare il login' && JSON.stringify(s.plan.steps) === JSON.stringify(['Togliere session.ts', 'Aggiungere i token JWT', 'Test e2e']), `ExitPlanMode senza contenuto: piano dal file, con la Edit (${s.plan && s.plan.steps.join(' · ')})`);
  // il risultato con il piano approvato (modificato dall'utente) vince
  const id2 = use('ExitPlanMode', {});
  result(id2, 'User has approved your plan.\n\n## Approved Plan:\n# Rifare il login\n1. Token\n2. Test');
  ok(s.plan.steps.join('|') === 'Token|Test', 'piano approvato nel risultato: la lavagna mostra quello');
  // le versioni vecchie: il piano nell'input
  use('ExitPlanMode', { plan: '# Vecchio stile\n## Uno\n## Due' });
  ok(s.plan.title === 'Vecchio stile' && s.plan.steps.join('|') === 'Uno|Due', 'versioni vecchie: piano nell\'input');
  ok(isPlanFile('/home/u/.claude/plans/a.md') && isPlanFile(file) && !isPlanFile('/home/u/proj/docs/plans/2.9.md'), 'solo i piani di Claude Code, non i docs/plans del progetto');
  // app desktop: il piano sta in una cartella di lavoro della sessione, non in .claude/plans
  const S2 = 'sess-plan-0002';
  const use2 = (name, input) => { const id = 'q' + (++k); now += 1000; st.applyTranscriptLine(S2, null, { type: 'assistant', timestamp: iso(now), cwd: '/p', message: { id: 'n' + k, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } }); return id; };
  use2('Write', { file_path: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--work-app\\abc123\\plan\\plan.md', content: '# Nuovo export\n1. Query\n2. CSV' });
  use2('ExitPlanMode', {});
  const s2 = st.sessions.get(S2);
  ok(s2.plan && s2.plan.title === 'Nuovo export' && s2.plan.steps.join('|') === 'Query|CSV', 'piano in una cartella di lavoro dell\'app desktop: arriva sulla lavagna');
  // solo una Edit nel transcript: il testo si legge dal file
  const tmpPlan = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-')), 'plan.md');
  fs.writeFileSync(tmpPlan, '# Dal disco\n1. Uno\n2. Due');
  use2('Edit', { file_path: tmpPlan, old_string: 'x', new_string: 'y' });
  use2('ExitPlanMode', {});
  ok(s2.plan.title === 'Dal disco' && s2.plan.steps.join('|') === 'Uno|Due', 'senza il testo nel transcript il piano si legge dal file');
  fs.rmSync(path.dirname(tmpPlan), { recursive: true, force: true });
  // un .md scritto molto prima non è il piano
  const S3 = 'sess-plan-0003';
  now += 1000; st.applyTranscriptLine(S3, null, { type: 'assistant', timestamp: iso(now), cwd: '/p', message: { id: 'o1', role: 'assistant', content: [{ type: 'tool_use', id: 'o1', name: 'Write', input: { file_path: '/p/README.md', content: '# Leggimi\n- a\n- b' } }], usage: { input_tokens: 1, output_tokens: 1 } } });
  now += 60 * 60000; st.applyTranscriptLine(S3, null, { type: 'assistant', timestamp: iso(now), cwd: '/p', message: { id: 'o2', role: 'assistant', content: [{ type: 'tool_use', id: 'o2', name: 'ExitPlanMode', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } });
  ok(!st.sessions.get(S3).plan, 'un .md toccato un\'ora prima non viene preso per il piano');
  // app desktop: la lista dei compiti arriva da mcp__ccd_turn__update_plan (items, advance, done/start) e wrap_up la chiude
  const S4 = 'sess-plan-0004';
  const use4 = (name, input) => { now += 1000; st.applyTranscriptLine(S4, null, { type: 'assistant', timestamp: iso(now), cwd: '/p', message: { id: 'd' + (++k), role: 'assistant', content: [{ type: 'tool_use', id: 'd' + k, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } }); };
  const todo = () => st.sessions.get(S4).todos.map(t => t.text + ':' + t.status).join(' | ');
  use4('mcp__ccd_turn__update_plan', { items: [{ content: 'Leggi il codice', status: 'in_progress' }, { content: 'Correggi', status: 'pending' }, { content: 'Test', status: 'pending' }], scope: 'first_task' });
  ok(todo() === 'Leggi il codice:doing | Correggi:todo | Test:todo', 'app desktop: la lista dei compiti arriva sulla lavagna');
  use4('mcp__ccd_turn__update_plan', { advance: true });
  ok(todo() === 'Leggi il codice:done | Correggi:doing | Test:todo', 'advance: chiude il passo in corso e apre il successivo');
  use4('mcp__ccd_turn__update_plan', { done: [2], start: 3 });
  ok(todo() === 'Leggi il codice:done | Correggi:done | Test:doing', 'done e start per numero');
  use4('Write', { file_path: '/p/build.cmd', content: 'echo' });
  use4('mcp__ccd_turn__wrap_up', { recap: 'fatto' });
  ok(todo() === 'Leggi il codice:done | Correggi:done | Test:done', 'wrap_up: la lista è tutta spuntata');
  ok(!st.sessions.get(S4).mdDraft, 'un file .cmd non è un .md');
  const p = parsePlan('# Titolo\n## Contesto\n## Modifiche\n### 1. Primo [link](http://x)\n### 2. Secondo `codice`\n## Verifica');
  ok(p.steps.join('|') === 'Primo link|Secondo codice', 'passi numerati anche nei titoli, senza markdown: ' + p.steps.join(' · '));
  ok(parsePlan('# T\n## Analisi\n## Refresh\n## Test').steps.join('|') === 'Analisi|Refresh|Test', 'senza numeri: i titoli ##');
  st.stop && st.stop();
}

// Workflow: gli agenti stanno in subagents/workflows/<runId>/, con il giornale; il riepilogo in workflows/<runId>.json
// (struttura come quella di Claude Code, contenuti inventati)
function workflowTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const { TranscriptWatcher } = require(path.join(ROOT, 'src', 'core', 'sources'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-test-'));
  const st = new OfficeState({});
  const w = new TranscriptWatcher(st, { base: tmp });
  try {
    const S = 'aaaa1111-0000-4000-8000-00000000wf01', RUN = 'wf_test_0001';
    const sdir = path.join(tmp, 'projects', 'proj', S), rdir = path.join(sdir, 'subagents', 'workflows', RUN);
    fs.mkdirSync(rdir, { recursive: true });
    const now = Date.now();
    let k = 0;
    const L = (o, t) => JSON.stringify({ timestamp: iso(now - 60000 + t * 1000), sessionId: S, cwd: '/p', ...o }) + '\n';
    const asst = (t, content, agentId) => L({ type: 'assistant', ...(agentId ? { agentId, isSidechain: true } : {}), message: { id: 'm' + (++k), role: 'assistant', content, usage: { input_tokens: 1000, output_tokens: 100 } } }, t);
    const res = (t, id, content, extra = {}) => L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra }, t);
    fs.writeFileSync(path.join(sdir + '.jsonl'),
      L({ type: 'user', message: { role: 'user', content: 'Rivedi il modulo ordini' } }, 0) +
      asst(1, [{ type: 'tool_use', id: 'wf1', name: 'Workflow', input: { script: '…', description: 'Revisione del modulo ordini' } }]) +
      res(2, 'wf1', 'Workflow launched', { toolUseResult: { status: 'async_launched', taskId: 'task-1', taskType: 'workflow', workflowName: 'review-orders', runId: RUN, transcriptDir: rdir } }) +
      asst(30, [{ type: 'tool_use', id: 'sm1', name: 'SendMessage', input: { to: 'reviewer', summary: 'Controlla anche i resi', message: '…' } }]) +
      res(31, 'sm1', 'ok', { toolUseResult: { success: true, resumedAgentId: 'a2' } }));
    const agents = [['a1', 'review:bugs', 'Review'], ['a2', 'review:perf', 'Review'], ['a3', 'verify:bugs', 'Verify']];
    fs.writeFileSync(path.join(rdir, 'journal.jsonl'), JSON.stringify({ type: 'launched' }) + '\n' +
      agents.map(([id, label, phase]) => JSON.stringify({ type: 'started', agentId: id, key: label, label, phase })).join('\n') + '\n' +
      JSON.stringify({ type: 'result', agentId: 'a1', key: 'review:bugs', result: {} }) + '\n' + JSON.stringify({ type: 'failed', agentId: 'a2', key: 'review:perf' }) + '\n');
    agents.forEach(([id, , phase], i) => {
      fs.writeFileSync(path.join(rdir, `agent-${id}.jsonl`), L({ type: 'user', agentId: id, isSidechain: true, message: { role: 'user', content: 'Rivedi' } }, 3 + i) + asst(5 + i * 3, [{ type: 'text', text: 'Fatto.' }], id));
      fs.writeFileSync(path.join(rdir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', spawnDepth: 1, description: id, workflowPhase: phase }));
    });
    w.scan(true); w.scan(false);
    const s = st.sessions.get(S);
    const a3 = s && s.subs.get('a3');
    ok(a3 && a3.name === 'verify:bugs' && a3.phase === 'Verify' && a3.workflow === RUN, 'agente di un Workflow in ufficio, con etichetta e fase del giornale');
    let snap = st.sessionSnapshot(s).workflows.find(x => x.id === RUN);
    const rev = snap && snap.phases.find(p => p.title === 'Review');
    ok(snap && snap.name === 'review-orders' && snap.description === 'Revisione del modulo ordini' && snap.status === 'running', `esecuzione dal transcript principale: ${snap && snap.name}, ${snap && snap.status}`);
    ok(rev && rev.total === 2 && rev.done === 1 && rev.failed === 1 && rev.cost > 0, `fase Review: 2 agenti, 1 fatto, 1 fallito, costo ${rev && rev.cost.toFixed(4)}`);
    ok(snap.cost > 0 && st.costOf(s) >= snap.cost, 'i token degli agenti del Workflow entrano nel costo della sessione');
    // il riepilogo finale: nome, stato, fasi nell'ordine dello script (anche quelle senza agenti)
    fs.mkdirSync(path.join(sdir, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(sdir, 'workflows', RUN + '.json'), JSON.stringify({ runId: RUN, workflowName: 'review-orders', status: 'completed', startTime: now - 59000, durationMs: 40000,
      phases: [{ title: 'Review', detail: 'trova i difetti' }, { title: 'Verify' }, { title: 'Report' }], agentCount: 3, totalTokens: 3300, totalToolCalls: 12, summary: 'Tre agenti, un difetto confermato' }));
    w.scan(false);
    snap = st.sessionSnapshot(s).workflows.find(x => x.id === RUN);
    ok(snap.status === 'completed' && snap.durationMs === 40000 && snap.phases.map(p => p.title).join('|') === 'Review|Verify|Report' && snap.phases[0].detail === 'trova i difetti', 'riepilogo letto: stato, durata, fasi nell\'ordine dello script');
    ok(snap.agents.find(a => a.id === 'a3').state === 'stopped', 'a esecuzione chiusa, un agente senza esito risulta fermato');
    const m = st.sessionSnapshot(s).messages[0];
    ok(m && m.to === 'reviewer' && m.toId === 'a2' && m.summary === 'Controlla anche i resi', 'SendMessage: chi scrive a chi, con l\'agente ripreso');
    // dall'archivio (replay): la stessa esecuzione, con etichette, esiti e riepilogo
    const { Replay } = require(path.join(ROOT, 'src', 'core', 'archive'));
    const rp = new Replay({ file: sdir + '.jsonl', base: tmp, settings: {} });
    rp.control('pause'); rp.seek(1);
    const fr = rp.frame(), rs = fr.session && fr.session.workflows.find(x => x.id === RUN);
    const ok3 = rs && rs.agents.find(a => a.id === 'a3');
    rp.stop();
    ok(rs && rs.status === 'completed' && rs.name === 'review-orders' && rs.phases.find(p => p.title === 'Review').failed === 1 && ok3 && ok3.label === 'verify:bugs', 'replay dall\'archivio: esecuzione, fasi ed esiti ricostruiti');
  } finally { w.stop(); st.stop && st.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

function run(ok) {
  console.log('motore: casi del giro di debug');
  workflowTests(ok);
  planBoardTests(ok);
  nodeVersionTests(ok);
  dataDirTests(ok);
  urlTests(ok);
  boundsTests(ok);
  forgetTests(ok);
  quietSubTests(ok);
  resumedSubTests(ok);
  archiveTests(ok);
  splitCharTests(ok);
  archiveBigFirstLineTests(ok);
  statsRenameTests(ok);
  askUserTests(ok);
  gitBashPathTests(ok);
  shellResetTests(ok);
  bashLabelTests(ok);
}

// il fumetto di un comando senza descrizione mostra il comando vero, non il "cd" davanti
function bashLabelTests(ok) {
  const { describeTool } = require(path.join(ROOT, 'src', 'core', 'describe'));
  const d = c => describeTool('Bash', { command: c });
  ok(/npm test/.test(d('cd C:/Users/me/work/app && npm test 2>&1 | tail -30')) && !/cd /.test(d('cd "C:/My Work" && cd sub && npm test')), 'fumetto di Bash: «' + d('cd C:/Users/me/work/app && npm test') + '»');
  ok(/cd sub/.test(d('cd sub')) && /^Dice/.test(describeTool('Bash', { command: 'x', description: 'Dice ciao' })), 'fumetto di Bash: un cd da solo resta, la descrizione vince');
}

module.exports = { run };

if (require.main === module) {
  let failed = 0;
  run((cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
}
