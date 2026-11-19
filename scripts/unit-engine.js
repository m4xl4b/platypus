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
    // riscritto mentre il decodificatore tiene mezzo carattere: quel byte non deve sporcare la prima riga nuova
    const b2 = L('Una riga lunga quanto basta, lasciata a metà proprio sulla è');
    fs.writeFileSync(f, b2.subarray(0, b2.lastIndexOf(Buffer.from('è')) + 1));
    w.pollTracked();
    fs.writeFileSync(f, L('Sì'));
    w.pollTracked();
    const last = got[got.length - 1];
    ok(got.length === 3 && last.message.content === 'Sì', `file riscritto a metà di un carattere: «${last && last.message.content}» (${got.length} righe)`);
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
    // la prima riga enorme non porta né data né cartella (es. un'istantanea): si leggono dalle righe dopo, e il titolo dalla richiesta
    let body2 = JSON.stringify({ type: 'file-history-snapshot', snapshot: 'B'.repeat(80 * 1024) }) + '\n';
    const m2 = (i, type, text) => JSON.stringify({ type, timestamp: iso(t0 + i * 60000), sessionId: 'sess-big-0002', cwd: '/p/shop', message: { role: type, content: text } }) + '\n';
    body2 += m2(0, 'user', 'Sistema il carrello');
    for (let i = 1; i <= 12; i++) body2 += m2(i, i % 2 ? 'assistant' : 'user', 'ok');
    fs.writeFileSync(path.join(pdir, 'sess-big-0002.jsonl'), body2);
    const y = listArchive({ base: tmp }).find(r => r.id === 'sess-big-0002');
    ok(y && y.start === t0 && y.cwd === '/p/shop' && /carrello/.test(y.title || ''), `archivio, prima riga enorme senza data: inizio ${y && y.start === t0}, cartella ${y && y.cwd}, titolo «${y && y.title}»`);
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

// 2.12.1 · il registro del lanciatore si ruota (launch.log.1), non si svuota; le prove partono solo con una cartella
// dei dati temporanea
function launchLogTests(ok) {
  const { openLaunchLog, readSince } = require(path.join(ROOT, 'scripts', 'launch-log'));
  const guard = require(path.join(ROOT, 'scripts', 'test-guard'));
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-launchlog-'));
  try {
    const log = path.join(tmp, 'launch.log');
    fs.writeFileSync(log, 'avvio di prima: errore importante\n');
    let l = openLaunchLog(tmp);
    fs.writeSync(l.fd, 'secondo avvio\n'); fs.closeSync(l.fd);
    ok(fs.readFileSync(log + '.1', 'utf8') === 'avvio di prima: errore importante\n' && fs.readFileSync(log, 'utf8') === 'secondo avvio\n' && l.start === 0, 'launch.log: il registro di prima diventa launch.log.1, non si svuota');
    l = openLaunchLog(tmp); fs.closeSync(l.fd);
    ok(fs.readFileSync(log + '.1', 'utf8') === 'secondo avvio\n' && fs.readFileSync(log, 'utf8') === '', 'launch.log: a ogni avvio si ruota di uno (se ne tengono due)');
    l = openLaunchLog(tmp); fs.closeSync(l.fd);
    ok(fs.readFileSync(log + '.1', 'utf8') === 'secondo avvio\n', 'launch.log: un registro vuoto non prende il posto di launch.log.1');
    // se il file non si può rinominare (qui: launch.log.1 è una cartella), si scrive in coda e il vecchio resta
    fs.writeFileSync(log, 'ancora aperto da un altro Platypus\n'); fs.rmSync(log + '.1'); fs.mkdirSync(log + '.1');
    l = openLaunchLog(tmp);
    fs.writeSync(l.fd, 'terzo avvio\n'); fs.closeSync(l.fd);
    const all = fs.readFileSync(log, 'utf8');
    ok(all.startsWith('ancora aperto da un altro Platypus\n') && /\n--- \d{4}-.*---\nterzo avvio\n$/.test(all) && readSince(log, l.start) === 'terzo avvio\n', 'launch.log: se non si può ruotare si scrive in coda, e del nuovo avvio si legge solo la sua parte');
    // le prove: mai senza PLATYPUS_DATA_DIR, mai in una cartella che non sia temporanea
    const inTmp = path.join(os.tmpdir(), 'platypus-guard', 'data');
    // (le prove girano con una home temporanea: per una cartella "vera" si usa un percorso fisso fuori da quella temporanea)
    const real = path.join(path.parse(os.tmpdir()).root, 'Users', 'max', '.platypus');
    ok(guard.whyNot({}) !== '' && guard.whyNot({ PLATYPUS_DATA_DIR: '  ' }) !== '' && guard.whyNot({ PLATYPUS_DATA_DIR: real }) !== '' && guard.whyNot({ PLATYPUS_DATA_DIR: path.dirname(real) }) !== '' && guard.whyNot({ PLATYPUS_DATA_DIR: os.tmpdir() }) !== '' && guard.whyNot({ PLATYPUS_DATA_DIR: path.join(os.tmpdir(), '..', 'Documents') }) !== '', 'prove: si rifiutano senza PLATYPUS_DATA_DIR, con una cartella vera (~/.platypus, la home), con la cartella temporanea intera o con una che ne esce con ..');
    ok(guard.whyNot({ PLATYPUS_DATA_DIR: inTmp }) === '' && guard.whyNot({ PLATYPUS_DATA_DIR: path.join(tmp, 'ci', 'data'), RUNNER_TEMP: path.join(tmp, 'ci') }) === '', 'prove: partono con una cartella dentro quella temporanea del sistema, o dentro RUNNER_TEMP nelle GitHub Actions');
    const env = { ...process.env }; delete env.PLATYPUS_DATA_DIR;
    const run = f => spawnSync(process.execPath, [path.join(ROOT, 'scripts', f)], { env, encoding: 'utf8', timeout: 30000 });
    const r1 = run('smoke-test.js'), r2 = run('unit-notify.js');
    ok(r1.status === 2 && /Mi rifiuto di partire/.test(r1.stderr) && !/sintassi/.test(r1.stdout) && r2.status === 2, `prove: npm test e una prova lanciata da sola, senza PLATYPUS_DATA_DIR, escono subito con il codice ${r1.status} senza fare niente`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 2.12.1 · i metadati di una sessione Cowork: solo i campi della lista ammessa, mai messaggi, prompt, nome o e-mail
function coworkMetaTests(ok) {
  const { readCoworkMeta, COWORK_META_FIELDS } = require(path.join(ROOT, 'src', 'core', 'sources'));
  const ALLOWED = ['title', 'sessionId', 'cliSessionId', 'processName', 'model', 'effortOverride', 'createdAt', 'lastActivityAt', 'isArchived', 'isAgentCompleted'];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-cwmeta-'));
  try {
    // ogni campo vietato (e ogni campo sconosciuto) porta un valore riconoscibile: non deve uscire da nessuna parte
    const SECRET = 'SEGRETO-NON-DEVE-USCIRE';
    const full = {
      title: 'Report trimestrale', sessionId: 'local_1', cliSessionId: 'c1', processName: 'quiet-brave-otter', model: 'claude-opus-4-8[1m]',
      effortOverride: 'high', createdAt: 1700000000000, lastActivityAt: 1700000100000, isArchived: false, isAgentCompleted: true,
      initialMessage: SECRET + ' messaggio', systemPrompt: SECRET + ' prompt', accountName: SECRET + ' nome', emailAddress: SECRET + '@example.invalid',
      vmProcessName: SECRET, cwd: '/sessions/' + SECRET, userSelectedFolders: ['C:/' + SECRET], mcqAnswers: { a: SECRET }, futureField: SECRET,
    };
    const f = path.join(tmp, 'local_1.json');
    fs.writeFileSync(f, JSON.stringify(full));
    const m = readCoworkMeta(f);
    const keys = Object.keys(m).sort();
    ok(JSON.stringify(Object.keys(COWORK_META_FIELDS).sort()) === JSON.stringify(ALLOWED.slice().sort()) && JSON.stringify(keys) === JSON.stringify(ALLOWED.slice().sort()), `Cowork: dai metadati escono esattamente i ${keys.length} campi ammessi (${keys.join(', ')})`);
    ok(!JSON.stringify(m).includes(SECRET) && !('initialMessage' in m) && !('systemPrompt' in m) && !('accountName' in m) && !('emailAddress' in m), 'Cowork: mai initialMessage, systemPrompt, accountName, emailAddress, né campi sconosciuti (nemmeno un pezzo del loro valore)');
    ok(m.processName === 'quiet-brave-otter' && m.effortOverride === 'high' && m.model === 'claude-opus-4-8[1m]' && m.isAgentCompleted === true && m.createdAt === 1700000000000, 'Cowork: i campi ammessi arrivano con il loro valore');
    // tipi sbagliati e testi lunghissimi: scartati o accorciati; un file che non è un oggetto non dà niente
    fs.writeFileSync(f, JSON.stringify({ title: 'x'.repeat(5000), model: 42, isArchived: 'true', createdAt: 'ieri', effortOverride: { a: 1 }, emailAddress: SECRET }));
    const w = readCoworkMeta(f);
    ok(w.title.length === 200 && !('model' in w) && !('isArchived' in w) && !('createdAt' in w) && !('effortOverride' in w) && !JSON.stringify(w).includes(SECRET), 'Cowork: tipi sbagliati scartati, testi accorciati');
    fs.writeFileSync(f, JSON.stringify([SECRET]));
    ok(readCoworkMeta(f) === null && readCoworkMeta(path.join(tmp, 'manca.json')) === null, 'Cowork: un file che non è un oggetto, o che manca, non dà metadati');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 2.12.1 · nomi dei modelli (src/core/models.js): il contesto da 1M con [1m], e l'età dei modelli nuovi o sconosciuti
function modelTests(ok) {
  const M = require(path.join(ROOT, 'src', 'core', 'models'));
  const { AgentWorld } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
  // [1m]: contesto da 1M, nell'etichetta, nella finestra e nella stima del contesto del motore
  const big = M.info('claude-opus-4-8[1m]'), plain = M.info('claude-opus-4-8');
  ok(big.ctx1m && big.fam === 'opus' && big.ver === 4.8 && big.label === 'Opus 4.8 · 1M' && !plain.ctx1m && plain.label === 'Opus 4.8', 'modelli: [1m] vuol dire contesto da 1M, e la versione resta quella (Opus 4.8 · 1M)');
  ok(M.contextLimit('claude-opus-4-8[1m]', 5000) === 1e6 && M.contextLimit('claude-opus-4-8', 5000) === 2e5 && M.contextLimit('claude-opus-4-8', 250000) === 1e6 && M.contextLimit('', 0) === 2e5 && M.contextLimit('claude-sonnet-4-5[1M]', 0) === 1e6, 'modelli: finestra di contesto 1M con [1m] (anche maiuscolo), altrimenti 200k finché il contesto visto non li supera');
  const ctxDim = model => { const w = new AgentWorld(); w.model = model; w.start('t1', 'Read', { file_path: '/p/a.ts' }, 1000, '/p', 150000); return w.steps[0].vec[6]; };
  ok(ctxDim('claude-opus-4-8[1m]') === 0.15 && ctxDim('claude-opus-4-8') === 0.75, `modelli: la stima del contesto del motore (150k token) è ${ctxDim('claude-opus-4-8[1m]')} su 1M con [1m] e ${ctxDim('claude-opus-4-8')} su 200k senza`);
  // età: un modello nuovo è un personaggio giovane, anche di una famiglia nuova o sconosciuta
  const age = (id, seen) => M.ageTier(id, seen && M.newest(seen));
  ok(age('claude-fable-5') === 0 && age('claude-fable-5-2') === 0 && age('claude-opus-5-5') === 0 && age('claude-mythos-5-2') === 0 && age('claude-zeta-7') === 0 && age('gpt-4o') === 0, 'modelli: Fable 5, Fable 5.2, Opus 5.5 e le famiglie sconosciute recenti (Mythos 5.2, Zeta 7) sono giovani; un nome senza versione anche');
  ok(age('claude-opus-4-8') === 1 && age('claude-opus-4-1') === 2 && age('claude-3-5-haiku-20241022') === 3 && age('claude-instant-1-2', ['claude-instant-1-2']) === 3 && age('claude-2-1', ['claude-2-1']) === 3, 'modelli: i vecchi invecchiano, anche di una famiglia sconosciuta vista da sola (Instant 1.2, Claude 2.1)');
  ok(age('claude-fable-5', ['claude-fable-6-1']) === 2 && age('claude-opus-5-5', ['claude-fable-6-1']) === 0 && age('claude-mythos-5-2', ['claude-mythos-6-2']) === 2, "modelli: l'età si misura nella stessa famiglia (un Fable 6.1 invecchia Fable 5, non Opus 5.5); una famiglia sconosciuta contro la versione più recente di tutte");
  ok(M.info('claude-sonnet-4-5-20250929').ver === 4.5 && M.info('claude-3-opus-20240229').ver === 3 && M.info('claude-2-1').label === 'Claude 2.1' && M.info('gpt-4o').label === 'gpt-4o' && M.info(null) === null, 'modelli: nomi con la data, con la versione prima della famiglia, e nomi che non sono di Claude');
  // la pagina usa lo stesso modulo (niente regole scritte due volte), caricato prima di game.js
  const game = fs.readFileSync(path.join(ROOT, 'renderer', 'game.js'), 'utf8'), wm = fs.readFileSync(path.join(ROOT, 'renderer', 'worldmap.js'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  ok(/PlatypusModels/.test(game) && !/NEWEST_KNOWN|opus|sonnet|haiku/.test(game) && /PlatypusModels.contextLimit/.test(wm) && !/mx > 200000 ? 1000000/.test(wm.replace(/: mx > 200000 ? 1000000 : 200000; }/, '')) && html.indexOf('models.js') > 0 && html.indexOf('models.js') < html.indexOf('game.js'), 'modelli: età e bolla della pagina usano models.js, caricato prima di game.js');
}

// PLATYPUS_DATA_DIR: un'altra cartella al posto di ~/.platypus (prove e loop in parallelo), creata se manca,
// senza copiare il vecchio Agent Office e senza toccare ~/.platypus
function dataDirOverrideTests(ok) {
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-dd-'));
  try {
    fs.mkdirSync(path.join(tmp, '.agent-office'));
    fs.writeFileSync(path.join(tmp, '.agent-office', 'settings.json'), '{}');
    const want = path.join(tmp, 'loop', '.platypus-dev');
    const run = env => execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(ROOT, 'src', 'paths'))}).dataDir())`], { env: { ...process.env, HOME: tmp, USERPROFILE: tmp, PLATYPUS_DATA_DIR: '', ...env } }).toString();
    const got = run({ PLATYPUS_DATA_DIR: want });
    ok(got === path.resolve(want) && fs.existsSync(want) && fs.readdirSync(want).length === 0 && !fs.existsSync(path.join(tmp, '.platypus')), `cartella dati con PLATYPUS_DATA_DIR: ${path.relative(tmp, got)}, creata vuota, ~/.platypus non toccata`);
    const rel = run({ PLATYPUS_DATA_DIR: '  ' });
    ok(rel === path.join(tmp, '.platypus') && fs.existsSync(path.join(tmp, '.platypus', 'settings.json')), 'PLATYPUS_DATA_DIR vuota: si usa ~/.platypus, come sempre (con la copia dal vecchio Agent Office)');  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
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
    // senza PLATYPUS_DATA_DIR (le prove la impostano): qui si controlla proprio ~/.platypus, nella home temporanea
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'src', 'paths'))}).dataDir()`], { env: { ...process.env, HOME: tmp, PLATYPUS_DATA_DIR: '' } });
    const mode = fs.statSync(path.join(tmp, '.platypus')).mode & 0o777;
    ok(mode === 0o700, `~/.platypus solo per il proprietario (permessi ${mode.toString(8)})`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Node.js minimo (22.13, per node:sqlite): lo stesso per lanciatore, modalità browser, finestra e guscio Tauri
function nodeVersionTests(ok) {
  const { spawnSync } = require('child_process');
  const req = require(path.join(ROOT, 'src', 'requirements'));
  ok(['22.13.0', 'v22.23.4', '23.4.0', '24.13.0', '25.0.0'].every(req.nodeOk), 'Node.js 22.13, 22.23, 23.4, 24 e 25: vanno bene');
  ok(!['20.20.2', '22.12.0', '22.5.1', '23.3.0', '18.20.0', 'v20.0.0', '', 'boh'].some(req.nodeOk), 'Node.js 18, 20, 22.12 e 23.3: rifiutati');
  const cmd = (p, env) => req.updateCommand(p, env || {});
  ok(cmd('win32') === 'winget install OpenJS.NodeJS.LTS' && cmd('darwin') === 'brew install node' && cmd('linux') === 'nvm install --lts' &&
    cmd('darwin', { NVM_DIR: '/x' }) === 'nvm install --lts' && cmd('win32', { NVM_HOME: 'C:\\nvm' }) === 'nvm install lts', 'Node.js vecchio: il comando per aggiornare secondo il sistema (winget, brew, nvm)');
  const msg = req.nodeMessages('v20.20.2', 'win32', {});
  ok(msg.length === 2 && msg.every(l => l.includes('22.13') && l.includes('20.20.2') && l.includes('winget install OpenJS.NodeJS.LTS')), 'Node.js vecchio: messaggio in italiano e in inglese, con la versione che hai e il comando');
  // il guscio Tauri controlla il Node.js del sistema con lo stesso minimo
  const rs = fs.readFileSync(path.join(ROOT, 'shells', 'tauri', 'src-tauri', 'src', 'engine.rs'), 'utf8');
  const m = /pub const MIN_NODE: \(u32, u32\) = \((\d+), (\d+)\);/.exec(rs);
  ok(m && `${m[1]}.${m[2]}.0` === req.MIN_NODE && require(path.join(ROOT, 'package.json')).engines.node === `>=${m[1]}.${m[2]}`, 'Node.js minimo: uguale in src/requirements.js, package.json e nel guscio Tauri');
  // lanciatore e modalità browser si fermano prima di caricare altro: provati con un Node.js finto (versione riscritta)
  const pre = path.join(os.tmpdir(), `pl-oldnode-${process.pid}.js`);
  fs.writeFileSync(pre, `Object.defineProperty(process.versions, 'node', { value: '22.12.0' });`);
  try {
    for (const [name, file] of [['lanciatore', path.join(ROOT, 'scripts', 'launch.js')], ['modalità browser', path.join(ROOT, 'src', 'standalone.js')]]) {
      const r = spawnSync(process.execPath, ['-r', pre, file, '--web', '--no-open'], { encoding: 'utf8', timeout: 20000 });
      ok(r.status === 1 && /Serve Node\.js 22\.13/.test(r.stderr) && /Node\.js 22\.13 or newer is required: you have 22\.12\.0/.test(r.stderr) && !/in ascolto|listening/.test(r.stdout),
        `${name} con Node.js 22.12: non parte e dice come aggiornare`);
    }
  } finally { fs.rmSync(pre, { force: true }); }
  // node:sqlite: si toglie solo il suo avviso sperimentale, gli altri restano
  const code = `const { loadSqlite } = require(${JSON.stringify(path.join(ROOT, 'src', 'core', 'store', 'sqlite-load'))});
    const s = loadSqlite(); new s.DatabaseSync(':memory:').exec('create table t(x)');
    process.emitWarning('altro avviso sperimentale', 'ExperimentalWarning'); process.emitWarning('avviso normale'); console.log(s === loadSqlite() ? 'ok' : 'no');`;
  const w = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 });
  ok(w.status === 0 && w.stdout.trim() === 'ok' && !/SQLite/.test(w.stderr) && /altro avviso sperimentale/.test(w.stderr) && /avviso normale/.test(w.stderr),
    'node:sqlite si carica senza il suo avviso sperimentale; gli altri avvisi si vedono ancora');
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

// il registro dei messaggi su uno store di prova: in memoria, con le collezioni vere e la guardia che rifiuta;
// le chiavi dei progetti non chiamano git (ogni cartella è il suo progetto)
function testFeedbackLog(backend = 'memory', dir) {
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { declareCollections } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
  const { ProjectKeys } = require(path.join(ROOT, 'src', 'core', 'store', 'project-key'));
  const { FeedbackLog } = require(path.join(ROOT, 'src', 'core', 'feedbacklog'));
  const store = declareCollections(openStore({ backend, dir, guard: 'reject', requireFields: true }));
  const keys = new ProjectKeys({ store, exec: async () => null });
  const log = new FeedbackLog({ store, keys });
  log.close = () => store.close();
  return log;
}

function run(ok) {
  console.log('motore: casi del giro di debug');
  workflowTests(ok);
  planBoardTests(ok);
  nodeVersionTests(ok);
  dataDirTests(ok);
  dataDirOverrideTests(ok);
  modelTests(ok);
  coworkMetaTests(ok);
  launchLogTests(ok);
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
  feedbackTests(ok);
}

// feedback agli agenti (2.11, A1): dall'evento di un hook alla risposta per Claude Code, senza mai lanciare
function feedbackTests(ok) {
  const fb = require(path.join(ROOT, 'src', 'core', 'feedback'));
  const inp = (ev, extra = {}) => ({ hook_event_name: ev, session_id: 'sess-fb-0001', cwd: '/p', ...extra });
  const one = (ev, rule) => ({ [ev]: [rule] });
  const lesson = () => ({ feature: 'elder', text: 'npm test is flaky here (12 and 18 October): rerun it once before investigating.', lessonId: 'L1' });
  // con qualcosa da dire: la forma giusta per ogni evento
  let r = fb.decide(inp('PostToolUse', { tool_name: 'Bash' }), {}, one('PostToolUse', lesson));
  let a = r && fb.answer('PostToolUse', r.message);
  ok(a && a.hookSpecificOutput.hookEventName === 'PostToolUse' && /^Platypus: npm test is flaky/.test(a.hookSpecificOutput.additionalContext) && r.message.lessonId === 'L1', 'feedback: dopo uno strumento, contesto in più firmato «Platypus»');
  ok(!('decision' in a) && !('permissionDecision' in a.hookSpecificOutput) && !('updatedInput' in a.hookSpecificOutput), 'feedback: mai una decisione sui permessi né un input riscritto');
  r = fb.decide(inp('SessionStart', { source: 'startup' }), {}, one('SessionStart', lesson));
  ok(r && fb.answer('SessionStart', r.message).hookSpecificOutput.hookEventName === 'SessionStart', 'feedback: a inizio sessione');
  r = fb.decide(inp('PostToolUseFailure', { tool_name: 'Bash' }), {}, one('PostToolUseFailure', lesson));
  ok(r && fb.answer('PostToolUseFailure', r.message).hookSpecificOutput.additionalContext, 'feedback: dopo uno strumento fallito');
  // a fine turno si può solo chiedere di continuare, e mai due volte di fila
  const claim = () => ({ feature: 'claims', text: 'you said the tests pass, but none ran in this turn.', block: true });
  r = fb.decide(inp('Stop'), {}, one('Stop', claim));
  a = r && fb.answer('Stop', r.message);
  ok(a && a.decision === 'block' && /^Platypus: you said/.test(a.reason), 'feedback: a fine turno chiede di continuare con il motivo');
  ok(fb.decide(inp('Stop', { stop_hook_active: true }), {}, one('Stop', claim)) === null, 'feedback: mai un secondo blocco mentre Claude Code sta già continuando');
  ok(fb.decide(inp('Stop'), {}, one('Stop', lesson)) === null, 'feedback: a fine turno un messaggio senza «block» non si manda');
  ok(fb.decide(inp('PostToolUse'), {}, one('PostToolUse', claim)).message.block === false, 'feedback: «block» fuori da Stop non conta');
  // niente da dire
  ok(fb.decide(inp('PostToolUse'), {}) === null && fb.decide(inp('PostToolUse'), {}, one('PostToolUse', () => null)) === null, 'feedback: senza regole o senza messaggio, niente');
  ok(fb.answer('PostToolUse', null) === null && fb.answer('PreToolUse', { text: 'x' }) === null, 'feedback: nessuna risposta per gli eventi che non usiamo');
  // input rotti: mai un errore
  const bad = [null, undefined, 'x', 42, [], {}, { hook_event_name: 'PostToolUse' }, { hook_event_name: 7, session_id: 's' }, { hook_event_name: 'Boh', session_id: 's' }, { hook_event_name: 'PostToolUse', session_id: '' }];
  ok(bad.every(x => fb.decide(x, {}, one('PostToolUse', lesson)) === null), 'feedback: input malformati → niente, senza errori');
  // una regola che lancia non ferma le altre
  r = fb.decide(inp('PostToolUse'), {}, { PostToolUse: [() => { throw new Error('rotta'); }, lesson] });
  ok(r && r.message.feature === 'elder', 'feedback: una regola rotta non ferma la successiva');
  ok(fb.decide(inp('PostToolUse'), {}, one('PostToolUse', () => { throw new Error('rotta'); })) === null, 'feedback: solo regole rotte → niente');
  // tempo scaduto: le regole dopo non partono
  let clock = 1000, ran = 0;
  const slow = () => { clock += 500; return null; }, late = () => { ran++; return lesson(); };
  ok(fb.decide(inp('PostToolUse'), { now: () => clock, deadline: 1300 }, { PostToolUse: [slow, late] }) === null && ran === 0, 'feedback: oltre il tempo massimo non si risponde');
  // testo: una riga, firmata una volta sola, entro il limite
  ok(fb.say('Platypus: già firmato') === 'Platypus: già firmato' && fb.say('  due\n righe ') === 'Platypus: due righe' && fb.say('') === '', 'feedback: firma e spazi');
  const long = fb.say('x'.repeat(2000));
  ok(long.length === fb.MAX_TEXT && long.endsWith('…'), `feedback: testo lungo tagliato a ${fb.MAX_TEXT} caratteri (${long.length})`);
  ok(['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop'].every(ev => Array.isArray(fb.RULES[ev])) && !fb.RULES.PreToolUse, 'feedback: regole solo per gli eventi a cui sappiamo rispondere');
  feedbackModeTests(ok, fb, inp);
  // la prova su una sessione vera: un marcatore per evento, e un solo blocco a fine turno
  const ck = ev => fb.checkAnswer(inp(ev));
  ok(/PLATY-PRE/.test(ck('PreToolUse').hookSpecificOutput.additionalContext) && /PLATY-FAIL/.test(ck('PostToolUseFailure').hookSpecificOutput.additionalContext) && ck('Notification') === null && fb.checkAnswer(null) === null, 'feedback, prova reale: un marcatore per evento');
  ok(ck('Stop').decision === 'block' && fb.checkAnswer(inp('Stop', { stop_hook_active: true })) === null, 'feedback, prova reale: a fine turno un solo blocco');
  feedbackRuleTests(ok, fb, inp);
}

// feedback (2.11, parte B): le regole vere, una per funzione
function feedbackRuleTests(ok, fb, inp) {
  const rules = require(path.join(ROOT, 'src', 'core', 'feedback-rules'));
  const i18n = require(path.join(ROOT, 'src', 'i18n'));
  const claudemd = require(path.join(ROOT, 'src', 'core', 'claudemd'));
  ok(Object.values(fb.RULES).flat().every(r => typeof r.run === 'function' && fb.FEATURES[r.feature]) && fb.RULES.SessionStart.some(r => r.run === rules.sessionLessons), 'regole: ognuna dichiara la sua funzione, e sono registrate una volta sola');
  rules.register();
  ok(fb.RULES.SessionStart.filter(r => r.run === rules.sessionLessons).length === 1, 'regole: registrarle di nuovo non le raddoppia');
  // B1 · le lezioni del progetto a inizio sessione
  const L = (kind, key, extra = {}) => ({ id: kind + key, kind, key, count: 3, sessions: ['a', 'b'], pinned: false, ignored: false, weight: 3, level: 'lesson', title: 'titolo', ...extra });
  const book = [
    L('flaky-command', 'npm run test:e2e'), L('ghost-path', 'src/auth/oldToken.ts', { weight: 5 }), L('fragile-file', 'src/db/pool.ts', { pinned: true, weight: 1 }),
    L('slow-step', 'npm run build', { level: 'observation' }), L('loop-trap', 'npm test', { ignored: true }),
  ];
  const lang = i18n.getLang();
  i18n.setLang('it'); // l'ufficio in italiano: il messaggio all'agente resta in inglese
  const start = (lessons, extra = {}) => rules.sessionLessons(inp('SessionStart', { source: 'startup' }), { cwd: '/p', lessons: () => lessons, ...extra });
  let m = start(book);
  const lines = m ? m.text.split('\n') : [];
  ok(m && /^Platypus \(project memory\)/.test(lines[0]) && /clues/.test(lines[0]) && lines.length === 4, `inizio sessione: intestazione che dice da dove vengono, e ${lines.length - 1} lezioni (attese 3)`);
  ok(/src\/db\/pool\.ts.*fragile/.test(lines[1]) && /oldToken\.ts.*doesn't exist/.test(lines[2]) && /test:e2e.*flaky/.test(lines[3]), 'inizio sessione: in inglese, la fissata per prima, poi per peso');
  ok(!/npm run build|npm test`/.test(m.text), 'inizio sessione: niente osservazioni né lezioni ignorate');
  ok(i18n.getLang() === 'it', 'inizio sessione: la lingua dell\'ufficio torna quella di prima');
  i18n.setLang(lang);
  ok(start([L('slow-step', 'x', { level: 'observation' })]) === null && start([]) === null, 'inizio sessione: un progetto senza lezioni non dice niente');
  ok(start(book, { hasSection: () => true }) === null, 'inizio sessione: se il CLAUDE.md ha già la sezione di Platypus non si ripetono');
  ok(rules.sessionLessons(inp('SessionStart', { cwd: '' }), { cwd: '', lessons: () => book }) === null, 'inizio sessione: senza cartella del progetto, niente');
  const many = Array.from({ length: 12 }, (_, i) => L('ghost-path', 'src/file' + i + '.ts', { weight: 12 - i }));
  m = start(many);
  ok(m.text.split('\n').length === 1 + rules.MAX_START && /file0\.ts/.test(m.text) && !/file6\.ts/.test(m.text), `inizio sessione: al massimo ${rules.MAX_START} lezioni, le più forti`);
  // attraverso tutto il giro: più righe conservate, entro il limite dei messaggi lunghi, nella forma di SessionStart
  const r = fb.respond(inp('SessionStart', { source: 'compact' }), { cwd: '/p', lessons: () => many, settings: { fbSessionLessons: 'on' } }, new fb.Gate(), { SessionStart: [{ feature: 'sessionLessons', run: rules.sessionLessons }] });
  const ctxText = r.out && r.out.hookSpecificOutput.additionalContext;
  ok(r.out && r.out.hookSpecificOutput.hookEventName === 'SessionStart' && ctxText.split('\n- ').length === 1 + rules.MAX_START && ctxText.length <= fb.MAX_LONG && r.entry.feature === 'sessionLessons', `inizio sessione, acceso: l'elenco arriva su più righe (${ctxText ? ctxText.length : 0} caratteri)`);
  ok(fb.say('a\n\n  b  \n', { lines: true }) === 'Platypus: a\nb' && fb.say('x'.repeat(5000), { max: 99999 }).length === fb.MAX_LONG && fb.say('a\nb') === 'Platypus: a b', 'testo: più righe solo se la regola lo chiede, e mai oltre il tetto');
  let threw = false;
  try { i18n.withLang('en', () => { throw new Error('x'); }); } catch { threw = true; }
  ok(threw && i18n.getLang() === lang && i18n.withLang('en', () => i18n.getLang()) === 'en', 'i18n: una lingua solo per un pezzo di codice, anche se quel pezzo lancia');
  // il CLAUDE.md ha già la sezione? Una lettura, tenuta finché il file non cambia
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-md-'));
  try {
    const f = path.join(tmp, 'CLAUDE.md');
    ok(claudemd.hasSection(tmp) === false, 'CLAUDE.md che non c\'è: nessuna sezione');
    fs.writeFileSync(f, '# Progetto\n\nRegole mie.\n');
    ok(claudemd.hasSection(tmp) === false, 'CLAUDE.md senza la sezione di Platypus');
    fs.writeFileSync(f, '# Progetto\n\n' + claudemd.MARKERS.start + '\n## Lezioni\n' + claudemd.MARKERS.end + '\nAltre regole, più lunghe di prima.\n');
    ok(claudemd.hasSection(tmp) === true && claudemd.hasSection(path.join(tmp, 'non-esiste')) === false, 'CLAUDE.md con la sezione: riconosciuta appena il file cambia');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  elderRuleTests(ok, fb, inp, rules, i18n);
}

// B2 · il Nonno parla all'agente dopo una trappola nota
function elderRuleTests(ok, fb, inp, rules, i18n) {
  const bt = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const now = Date.parse('2026-11-18T10:00:00Z');
  const ev = i => ({ sid: 's' + i, t: Date.parse('2026-10-1' + (1 + i) + 'T09:00:00Z'), agent: 'EXPLORE', excerpt: '' });
  const L = (kind, key, extra = {}) => ({ id: 'id-' + kind + '-' + key.length, kind, key, count: 3, sessions: ['s1', 's2'], first: now - 30 * 86400000, last: now - 86400000, evidence: [ev(1), ev(2)], pinned: false, ignored: false, weight: 3, level: 'lesson', ...extra });
  const errText = "Exit code 1\nFAIL src/auth/refresh.test.ts\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at renew (src/auth/refresh.ts:42:18)";
  const surprise = require(path.join(ROOT, 'src', 'core', 'surprise'));
  const pat = bt.errorPattern((surprise.classifyFailure(errText, 'npm test') || {}).excerpt || surprise.errorExcerpt(errText));
  const book = [
    L('flaky-command', 'npm test'), L('loop-trap', 'npm run lint', { weight: 2 }), L('known-fix', pat + ' → src/auth/refresh.ts', { weight: 4 }),
    L('ghost-path', 'src/auth/oldToken.ts'), L('fragile-file', 'src/db/pool.ts'), L('slow-step', 'npm run build'),
    L('flaky-command', 'npm run test:e2e', { level: 'observation' }), L('fragile-file', 'src/ui/Menu.tsx', { ignored: true }),
  ];
  const ctx = { cwd: '/p', lessons: () => book };
  const fail = (tool, tool_input, error = 'Exit code 1\nFAIL') => rules.elder(inp('PostToolUseFailure', { tool_name: tool, tool_input, error }), ctx);
  const done = (tool, tool_input, tool_response) => rules.elder(inp('PostToolUse', { tool_name: tool, tool_input, tool_response }), ctx);
  const lang = i18n.getLang();
  i18n.setLang('it');
  // un comando instabile appena fallito, scritto in un altro modo
  let m = fail('Bash', { command: 'cd /p && CI=1 npm test 2>&1 | tail -5' });
  ok(m && /^Last time npm test got stuck 3 times \(12 October and 13 October\)/.test(m.text) && m.lessonId === book[0].id, 'Nonno all\'agente, comando instabile fallito: «' + (m && m.text) + '»');
  ok(i18n.getLang() === 'it', 'Nonno all\'agente: in inglese, e la lingua dell\'ufficio non cambia');
  i18n.setLang(lang);
  ok(done('Bash', { command: 'npm test' }, { stdout: 'ok' }) === null, 'Nonno all\'agente: lo stesso comando riuscito non dice niente');
  m = fail('PowerShell', { command: 'npm run lint' });
  ok(m && /go round in circles/.test(m.text), 'Nonno all\'agente, giro in tondo: anche da PowerShell');
  // un errore già sistemato viene prima del comando instabile
  m = fail('Bash', { command: 'npm test' }, errText);
  ok(m && /EXPLORE already fixed that error in src\/auth\/refresh\.ts/.test(m.text) && m.lessonId === book[2].id, 'Nonno all\'agente, errore già visto: dice dove è stato sistemato, prima di tutto il resto');
  // un file che non c'è: Read fallito, Glob e Grep che non trovano niente
  m = fail('Read', { file_path: '/p/src/auth/oldToken.ts' }, 'File does not exist.');
  ok(m && /oldToken\.ts isn't there/.test(m.text), 'Nonno all\'agente, percorso inventato dopo un Read fallito');
  ok(rules.elder(inp('PostToolUseFailure', { tool_name: 'Read', tool_input: { file_path: 'C:\\p\\src\\auth\\oldToken.ts' }, error: 'File does not exist.' }), { cwd: 'C:\\p', lessons: () => book }), 'Nonno all\'agente: anche con i percorsi di Windows');
  ok(done('Glob', { pattern: '**/oldToken.ts' }, { filenames: [], numFiles: 0 }) && done('Grep', { pattern: 'renew', path: '/p/src/auth/oldToken.ts' }, { numFiles: 0 }), 'Nonno all\'agente: Glob e Grep che non trovano niente su quel percorso');
  ok(done('Glob', { pattern: '**/oldToken.ts' }, { filenames: ['src/x/oldToken.ts'], numFiles: 1 }) === null && done('Glob', { pattern: 'src/**/*.ts' }, { filenames: [], numFiles: 0 }) === null && done('Glob', { pattern: '**/oldToken.ts' }, 'boh') === null, 'Nonno all\'agente: Glob che trova qualcosa, con i jolly o con un risultato che non conosciamo → niente');
  ok(fail('Read', { file_path: '/p/src/altro.ts' }, 'File does not exist.') === null, 'Nonno all\'agente: un altro file che non c\'è non è una lezione');
  // un file fragile appena modificato
  m = done('Edit', { file_path: '/p/src/db/pool.ts', old_string: 'a', new_string: 'b' }, {});
  ok(m && /Careful with src\/db\/pool\.ts/.test(m.text) && / Run the tests now\.$/.test(m.text), 'Nonno all\'agente, file fragile modificato: «' + (m && m.text) + '»');
  ok(done('Write', { file_path: '/p/src/db/pool.ts', content: 'x' }, {}) && done('Read', { file_path: '/p/src/db/pool.ts' }, {}) === null, 'Nonno all\'agente: vale per Write, non per una lettura');
  // un comando lento
  m = done('Bash', { command: 'npm run build' }, { stdout: 'done' });
  ok(m && /takes forever/.test(m.text), 'Nonno all\'agente, comando lento: la prossima volta in background');
  // osservazioni e lezioni ignorate non partono, e nemmeno un comando diverso
  ok(fail('Bash', { command: 'npm run test:e2e' }) === null && done('Edit', { file_path: '/p/src/ui/Menu.tsx' }, {}) === null && fail('Bash', { command: 'git status' }) === null, 'Nonno all\'agente: niente per osservazioni, lezioni ignorate e comandi senza lezione');
  ok(rules.elder(inp('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'x' }), { cwd: '/p', lessons: () => [] }) === null && rules.elder(inp('PostToolUseFailure', {}), ctx) === null, 'Nonno all\'agente: libro vuoto o hook senza strumento → niente');
  // nel giro completo: una volta per agente, i sottoagenti a parte, e l'ufficio sa a chi è arrivata davvero
  let clock = now;
  const gate = new fb.Gate({ now: () => clock });
  const real = { PostToolUseFailure: [{ feature: 'elder', run: rules.elder }] };
  const go = (settings, extra = {}) => fb.respond(inp('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1', ...extra }), { ...ctx, now: () => clock, settings }, gate, real);
  const r1 = go({ fbElder: 'on' });
  clock += fb.AGENT_GAP_MS + 1000;
  const r2 = go({ fbElder: 'on' });
  const r3 = go({ fbElder: 'shadow' }, { agent_id: 'sub-1' });
  ok(r1.out && /^Platypus: Last time npm test/.test(r1.out.hookSpecificOutput.additionalContext) && r1.out.hookSpecificOutput.hookEventName === 'PostToolUseFailure' && !r2.out && !r2.entry, 'Nonno all\'agente, acceso: firmato «Platypus», e la stessa lezione non torna allo stesso agente');
  ok(gate.told('sess-fb-0001', 'main', book[0].id) && !gate.told('sess-fb-0001', 'sub-1', book[0].id) && r3.entry && r3.entry.mode === 'shadow' && !gate.told('sess-fb-0001', 'main', 'altra'), 'Nonno all\'agente: «detto anche a lui» solo se il messaggio è partito davvero, non in ombra');
  gate.untell(inp('PostToolUseFailure'), book[0].id);
  ok(!gate.told('sess-fb-0001', 'main', book[0].id), 'Nonno all\'agente: una risposta arrivata tardi non risulta detta');
  loopRuleTests(ok, fb, inp, rules, book[0]);
}

// B3 · fuori dal giro in tondo: lo stesso comando fallisce di nuovo con lo stesso errore, senza modifiche in mezzo
function loopRuleTests(ok, fb, inp, rules, flaky) {
  const { AgentWorld } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
  const now = Date.parse('2026-11-18T10:00:00Z');
  const ERR = "FAIL src/cart.test.ts\n  ● rate › rounds the cents\n    TypeError: Cannot read properties of undefined (reading 'total')\n      at sum (src/cart.ts:42:18)";
  const ERR2 = ERR.replace(':42:18', ':57:9');   // lo stesso errore, a un'altra riga
  const OTHER = 'FAIL src/cart.test.ts\n  ● rate › rounds the cents\n    ReferenceError: discount is not defined\n      at sum (src/cart.ts:42:18)';
  // i passi di un agente come li vede l'ufficio: una storia è una lista di [strumento, input, esito, errore?]
  const story = (list, { goals = [], start = now - 60000 } = {}) => {
    const w = new AgentWorld();
    let t = start, k = 0;
    for (const [name, input, out, isErr] of list) {
      const id = 'tu' + (++k);
      w.start(id, name, input, t += 1000, '/p', 0);
      if (out !== null) w.end(id, !!isErr, { content: out }, null, t += 1000, '/p');
    }
    return { steps: w.steps, goals, last: 'tu' + k };
  };
  const test = (out = ERR, cmd = 'npm test') => ['Bash', { command: cmd }, 'Exit code 1\n' + out, true];
  const ask = (st, extra = {}) => rules.loop(inp('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\n' + ERR, tool_use_id: 'tu-now', ...extra }), { now: () => now, agent: () => st });
  // due fallimenti uguali di fila: il secondo è quello dell'hook
  let m = ask(story([test()]));
  ok(m && /^this command failed 2 times in a row with the same error \(«TypeError: Cannot read properties of undefined \(reading 'total'\)»\) and no edit in between\. Change something/.test(m.text) && m.once && !m.lessonId, 'giro in tondo, secondo fallimento uguale: «' + (m && m.text) + '»');
  ok(fb.say(m.text).length < fb.MAX_TEXT && /say what is blocking you\.$/.test(fb.say(m.text)), 'giro in tondo: il messaggio sta nel limite, intero');
  // il transcript è arrivato prima dell'hook: il fallimento di adesso è già tra i passi, e non si conta due volte
  let st = story([test(), test()]);
  m = ask(st, { tool_use_id: st.last });
  ok(m && /failed 2 times/.test(m.text), 'giro in tondo: il fallimento già nello stato non si conta due volte');
  ok(/failed 3 times/.test(ask(st).text) && ask(story([test()]), { error: 'Exit code 1\n' + ERR2 }), 'giro in tondo: tre di fila, e lo stesso errore a un\'altra riga è lo stesso errore');
  // in mezzo: letture, ricerche, uno sguardo e una modifica rifiutata non cambiano niente
  st = story([test(), ['Read', { file_path: '/p/src/cart.ts' }, 'x'], ['Grep', { pattern: 'total', path: '/p/src' }, 'src/cart.ts'], ['Bash', { command: 'git status' }, 'clean'], ['Edit', { file_path: '/p/src/cart.ts', old_string: 'a', new_string: 'b' }, 'String to replace not found in file.', true]]);
  ok(ask(st), 'giro in tondo: letture, ricerche e una modifica rifiutata in mezzo non contano come cambiamento');
  // una modifica riuscita, un altro comando, un sottoagente, lo stesso comando riuscito: qualcosa è cambiato
  ok(ask(story([test(), ['Edit', { file_path: '/p/src/cart.ts', old_string: 'a', new_string: 'b' }, 'ok']])) === null, 'giro in tondo: un fallimento, una modifica, un fallimento → niente');
  ok(ask(story([test(), ['Write', { file_path: '/p/src/new.ts', content: 'x' }, 'ok']])) === null && ask(story([test(), ['Bash', { command: 'npm install' }, 'added 3 packages']])) === null && ask(story([test(), ['Task', { subagent_type: 'general-purpose', prompt: 'fix it' }, 'done']])) === null, 'giro in tondo: nemmeno dopo un file nuovo, un altro comando o un sottoagente');
  ok(ask(story([test(), ['Bash', { command: 'npm test' }, 'PASS src/cart.test.ts\nTests: 12 passed']])) === null, 'giro in tondo: se in mezzo è riuscito, non è di fila');
  // errori diversi
  ok(ask(story([test(OTHER)])) === null && ask(story([test(OTHER), test()])).text.includes('2 times'), 'giro in tondo: errori diversi → niente, e il conto riparte dall\'errore nuovo');
  ok(ask(story([test()]), { tool_input: { command: 'npm run lint' } }) === null, 'giro in tondo: un altro comando che fallisce non è un giro');
  // una nuova richiesta dell'utente in mezzo: riprovare è una sua scelta
  st = story([test()]);
  ok(ask({ ...st, goals: [{ t: now - 120000 }, { t: now - 5000 }] }) === null && ask({ ...st, goals: [{ t: now - 120000 }] }), 'giro in tondo: conta solo il turno in corso');
  ok(ask(story([test()], { start: now - 45 * 60000 })) === null, 'giro in tondo: un fallimento di tre quarti d\'ora fa non conta');
  // senza l'identificativo dello strumento si conta per difetto
  ok(ask(story([test()]), { tool_use_id: undefined }) === null && /failed 2 times/.test(ask(story([test(), test()]), { tool_use_id: undefined }).text), 'giro in tondo: senza identificativo, solo quando i fallimenti nello stato sono già due');
  // un comando ancora in corso (in parallelo) non interrompe il conto
  ok(ask(story([test(), ['Bash', { command: 'npm run build' }, null]])), 'giro in tondo: uno strumento ancora in corso non conta');
  // niente da dire
  ok(ask(story([test()]), { is_interrupt: true }) === null && ask(story([test()]), { tool_name: 'Read' }) === null && ask(null) === null && ask(story([])) === null, 'giro in tondo: interruzione dell\'utente, altro strumento, agente sconosciuto o primo fallimento → niente');
  ok(rules.loop(inp('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1', tool_use_id: 'x' }), { now: () => now, agent: () => story([['Bash', { command: 'npm test' }, 'Exit code 1', true]]) }) === null, 'giro in tondo: senza una riga d\'errore non si dice che è lo stesso');
  ok(ask(story([['PowerShell', { command: 'npm test' }, 'Exit code 1\n' + ERR, true]]), { tool_name: 'PowerShell' }), 'giro in tondo: anche da PowerShell');
  // nel giro completo: firmato, una volta sola per lo stesso giro, e dopo il Nonno
  let clock = now;
  const gate = new fb.Gate({ now: () => clock });
  st = story([test()]);
  const real = { PostToolUseFailure: fb.RULES.PostToolUseFailure.filter(r => r.run === rules.elder || r.run === rules.loop) };
  ok(real.PostToolUseFailure.length === 2 && real.PostToolUseFailure[0].run === rules.elder && real.PostToolUseFailure[1].feature === 'loop', 'giro in tondo: registrato dopo il Nonno');
  const go = (settings, extra = {}, lessons = []) => fb.respond(inp('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\n' + ERR, tool_use_id: 'tu-now', ...extra }), { cwd: '/p', now: () => clock, settings, lessons: () => lessons, agent: () => st }, gate, real);
  ok(go({ fbLoop: 'off' }).entry === null, 'giro in tondo: spento di base, niente');
  const s1 = go({ fbLoop: 'shadow' }, { agent_id: 'sub-9' });
  ok(!s1.out && s1.entry && s1.entry.mode === 'shadow' && s1.entry.feature === 'loop' && /^Platypus: this command failed 2 times/.test(s1.entry.text), 'giro in tondo in ombra: niente all\'agente, la riga nel registro');
  const r1 = go({ fbLoop: 'on' });
  ok(r1.out && r1.out.hookSpecificOutput.hookEventName === 'PostToolUseFailure' && /^Platypus: this command failed 2 times/.test(r1.out.hookSpecificOutput.additionalContext) && r1.entry.lessonId === null, 'giro in tondo, acceso: arriva firmato dopo il secondo fallimento');
  clock += fb.AGENT_GAP_MS + 1000;
  ok(go({ fbLoop: 'on' }).entry === null, 'giro in tondo: lo stesso avviso non torna allo stesso agente');
  ok(go({ fbLoop: 'on' }, { error: 'Exit code 1\n' + OTHER }).entry === null, 'giro in tondo: e un errore nuovo riparte da uno');
  // con il Nonno acceso: prima la lezione del progetto, poi (se insiste) il giro in tondo
  const g2 = new fb.Gate({ now: () => clock });
  const both = (extra = {}) => fb.respond(inp('PostToolUseFailure', { session_id: 'sess-fb-0002', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\n' + ERR, tool_use_id: 'tu-now', ...extra }), { cwd: '/p', now: () => clock, settings: { fbLoop: 'on', fbElder: 'on' }, lessons: () => [flaky], agent: () => st }, g2, real);
  const b1 = both();
  clock += fb.AGENT_GAP_MS + 1000;
  const b2 = both();
  ok(b1.entry && b1.entry.feature === 'elder' && b2.entry && b2.entry.feature === 'loop', `giro in tondo e Nonno insieme: prima la lezione (${b1.entry && b1.entry.feature}), al fallimento dopo l'avviso (${b2.entry && b2.entry.feature})`);
  staleRuleTests(ok, fb, inp, rules, AgentWorld);
}

// B4 · memoria non aggiornata: una modifica riuscita su un file che un altro agente aveva cambiato dopo l'ultima lettura
function staleRuleTests(ok, fb, inp, rules, AgentWorld) {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const FILE = '/p/src/cart.ts';
  // due agenti della stessa sessione; ogni mossa è [chi, strumento, input, esito (null = ancora in corso), errore?]
  const scene = (moves, cwd = '/p') => {
    const w = { main: new AgentWorld(), sub: new AgentWorld() };
    let t = now - 60000, k = 0;
    for (const [who, name, input, out, isErr] of moves) {
      const id = who + (++k);
      w[who].start(id, name, input, t += 1000, cwd, 0);
      if (out !== null) w[who].end(id, !!isErr, { content: out }, null, t += 1000, cwd);
    }
    const team = [{ id: 'main', name: 'CLAUDE', nodes: w.main.nodes }, { id: 'sub-1', name: 'EXPLORE', nodes: w.sub.nodes }];
    return { w, ctx: who => ({ cwd, now: () => now, team: () => team, agent: () => ({ id: who === 'sub' ? 'sub-1' : 'main', steps: w[who].steps, nodes: w[who].nodes, goals: [] }) }) };
  };
  const read = (who, f = FILE) => [who, 'Read', { file_path: f }, 'export const cart = {}'];
  const edit = (who, out = 'ok', isErr = false, f = FILE) => [who, 'Edit', { file_path: f, old_string: 'a', new_string: 'b' }, out, isErr];
  const hook = (sc, tool = 'Write', extra = {}, who = 'main') => rules.stale(inp('PostToolUse', { tool_name: tool, tool_input: { file_path: FILE }, tool_response: {}, tool_use_id: 'tu-now', ...extra }), sc.ctx(who));
  // letto da me, cambiato da un altro, riscritto da me
  let sc = scene([read('main'), edit('sub')]);
  let m = hook(sc);
  ok(m && /^you just rewrote `src\/cart\.ts`, but EXPLORE changed it at \d\d:\d\d, after you last read it\. Check that you did not undo that change\.$/.test(m.text) && m.once && !m.lessonId, 'memoria non aggiornata, Write sopra la modifica di un altro: «' + (m && m.text) + '»');
  m = hook(sc, 'Edit');
  ok(m && /^EXPLORE changed `src\/cart\.ts` at \d\d:\d\d, after you last read it, and you just edited it without reading it again\. Read it again/.test(m.text), 'memoria non aggiornata, Edit: chiede di rileggere');
  ok(hook(sc, 'MultiEdit') && hook(sc, 'Read') === null && hook(sc, 'Bash') === null, 'memoria non aggiornata: vale per le modifiche, non per letture e comandi');
  // cambiato dallo stesso agente, o da un altro ma prima dell'ultima lettura: niente
  ok(hook(scene([read('main'), edit('main')])) === null, 'memoria non aggiornata: se l\'ha cambiato lo stesso agente, niente');
  ok(hook(scene([edit('sub'), read('main')])) === null && hook(scene([read('main'), edit('sub'), read('main')])) === null, 'memoria non aggiornata: se l\'ha riletto dopo la modifica dell\'altro, niente');
  ok(hook(scene([read('main'), edit('sub', 'String to replace not found in file.', true)])) === null, 'memoria non aggiornata: una modifica rifiutata dell\'altro non conta');
  ok(hook(scene([edit('sub')])) === null && hook(scene([read('main'), edit('sub', 'ok', false, '/p/src/other.ts')])) === null, 'memoria non aggiornata: un file mai letto da lui, o un altro file → niente');
  // la mia modifica può essere già tra i passi dell'ufficio: con l'identificativo si riconosce, senza si tace
  sc = scene([read('main'), edit('sub'), ['main', 'Write', { file_path: FILE, content: 'x' }, 'ok']]);
  const mine = sc.w.main.steps[sc.w.main.steps.length - 1].id;
  ok(hook(sc, 'Write', { tool_use_id: mine }) && hook(sc, 'Write', { tool_use_id: undefined }) === null, 'memoria non aggiornata: la modifica già registrata si riconosce dall\'identificativo; senza, si tace');
  sc = scene([read('main'), edit('sub'), ['main', 'Write', { file_path: FILE, content: 'x' }, null]]);
  ok(hook(sc, 'Write', { tool_use_id: sc.w.main.steps[sc.w.main.steps.length - 1].id }), 'memoria non aggiornata: anche se l\'ufficio l\'ha vista partire ma non finire');
  // anche al contrario (il sottoagente sopra il principale), con i percorsi di Windows, e mai fuori dal progetto
  m = hook(scene([read('sub'), edit('main')]), 'Write', {}, 'sub');
  ok(m && /but CLAUDE changed it/.test(m.text), 'memoria non aggiornata: vale anche per un sottoagente sopra il principale');
  sc = scene([['main', 'Read', { file_path: 'C:\\p\\src\\cart.ts' }, 'x'], ['sub', 'Edit', { file_path: 'C:\\p\\src\\cart.ts', old_string: 'a', new_string: 'b' }, 'ok']], 'C:\\p');
  ok(hook(sc, 'Write', { tool_input: { file_path: 'C:\\p\\src\\cart.ts' } }), 'memoria non aggiornata: anche con i percorsi di Windows');
  sc = scene([read('main'), edit('sub')]);
  ok(hook(sc, 'Write', { tool_input: { file_path: '/altrove/x.ts' } }) === null && hook(sc, 'Write', { tool_input: {} }) === null && rules.stale(inp('PostToolUse', { tool_name: 'Write', tool_input: { file_path: FILE } }), { cwd: '/p' }) === null && rules.stale(inp('PostToolUse', { tool_name: 'Write', tool_input: { file_path: FILE } }), { cwd: '/p', team: () => [], agent: () => null }) === null, 'memoria non aggiornata: file fuori dal progetto, hook senza file o agente sconosciuto → niente');
  // nel giro completo: nella 2.11 al massimo in ombra, prima del Nonno, una volta sola per quel cambiamento
  ok(fb.modeOf({ fbStale: 'on' }, 'stale') === 'shadow' && fb.modeOf({}, 'stale') === 'off' && fb.SHADOW_ONLY.has('stale'), 'memoria non aggiornata: spenta di base, e nella 2.11 mai oltre l\'ombra');
  const post = fb.RULES.PostToolUse.filter(r => r.run === rules.stale || r.run === rules.elder);
  ok(post.length === 2 && post[0].run === rules.stale && post[0].feature === 'stale', 'memoria non aggiornata: registrata prima del Nonno, per le modifiche riuscite');
  let clock = now;
  const gate = new fb.Gate({ now: () => clock });
  const go = settings => fb.respond(inp('PostToolUse', { tool_name: 'Write', tool_input: { file_path: FILE }, tool_response: {}, tool_use_id: 'tu-now' }), { ...sc.ctx('main'), now: () => clock, settings, lessons: () => [] }, gate, { PostToolUse: post });
  ok(go({ fbStale: 'off' }).entry === null, 'memoria non aggiornata: spenta, niente');
  const r1 = go({ fbStale: 'on' });
  ok(!r1.out && r1.entry && r1.entry.mode === 'shadow' && r1.entry.feature === 'stale' && /^Platypus: you just rewrote/.test(r1.entry.text), 'memoria non aggiornata: anche «accesa» resta in ombra, con la riga nel registro');
  clock += fb.AGENT_GAP_MS + 1000;
  ok(go({ fbStale: 'shadow' }).entry === null, 'memoria non aggiornata: lo stesso cambiamento non torna allo stesso agente');
  claimsRuleTests(ok, fb, inp, rules, AgentWorld);
}

// B5 · affermazioni senza prove a fine turno: «i test passano» senza averli lanciati dopo l'ultima modifica
function claimsRuleTests(ok, fb, inp, rules, AgentWorld) {
  const now = Date.parse('2026-11-18T10:00:00Z'), T0 = now - 60000;
  // un turno: la richiesta dell'utente a T0, poi i passi [strumento, input, esito (null = in corso), errore?]
  const turn = (list, { goals = [{ t: T0 }], start = T0 } = {}) => {
    const w = new AgentWorld();
    let t = start, k = 0;
    for (const [name, input, out, isErr] of list) {
      const id = 'tu' + (++k);
      w.start(id, name, input, t += 1000, '/p', 0);
      if (out !== null) w.end(id, !!isErr, { content: out }, null, t += 1000, '/p');
    }
    return { id: 'main', steps: w.steps, nodes: w.nodes, goals, w };
  };
  const edit = ['Edit', { file_path: '/p/src/cart.ts', old_string: 'a', new_string: 'b' }, 'ok'];
  const pass = ['Bash', { command: 'npm test' }, 'PASS src/cart.test.ts\nTests: 12 passed, 12 total'];
  const fail = ['Bash', { command: 'npm test' }, 'Exit code 1\nFAIL src/cart.test.ts\nTests: 1 failed', true];
  const stop = (me, said, extra = {}, ctx = {}) => rules.claims(inp('Stop', { last_assistant_message: said, ...extra }), { now: () => now, agent: () => me, ...ctx });
  const SAID = 'Fixed the rounding in the cart. All tests pass.';
  // senza prove: ha modificato e non ha lanciato i test
  let m = stop(turn([edit]), SAID);
  ok(m && m.block === true && m.tag === 'tests/ungrounded' && m.text === 'you said «All tests pass.», but no test ran after your last edit. Run them, or say that it is not verified.', 'affermazioni, senza prove: «' + (m && m.text) + '»');
  m = stop(turn([fail, edit]), SAID);
  ok(m && /but no test ran after your last edit \(last run: failed at \d\d:\d\d\)\. Run them/.test(m.text), 'affermazioni, senza prove: dice com\'era finito l\'ultimo lancio, prima della modifica');
  ok(stop(turn([edit, pass, edit]), SAID).tag === 'tests/ungrounded', 'affermazioni: un test passato prima dell\'ultima modifica non è una prova');
  // con le prove: niente
  ok(stop(turn([edit, pass]), SAID) === null && stop(turn([fail, edit, pass]), SAID) === null, 'affermazioni con le prove (test lanciati e passati dopo l\'ultima modifica): niente');
  // smentita: l'ultimo lancio è fallito
  m = stop(turn([edit, pass, fail]), SAID);
  ok(m && m.block && m.tag === 'tests/contradicted' && /^you said «All tests pass\.», but the last test run failed \(at \d\d:\d\d\)\. Fix it and run the tests again, or say that they fail\.$/.test(m.text), 'affermazioni, smentita: «' + (m && m.text) + '»');
  ok(stop(turn([fail]), 'The tests pass now.').tag === 'tests/contradicted', 'affermazioni: la smentita vale anche senza modifiche nel turno');
  // un turno senza affermazioni, o con affermazioni che non si giudicano qui
  ok(stop(turn([edit]), 'I changed the rounding in src/cart.ts.') === null && stop(turn([edit]), 'I fixed the bug. Done.') === null, 'affermazioni: un turno senza «test» o «verificato» non si giudica (nemmeno «sistemato» e «fatto»)');
  ok(stop(turn([edit]), 'I\'ll run the tests next.') === null && stop(turn([edit]), 'Do the tests pass on your machine?') === null && stop(turn([edit]), 'The tests do not pass yet.') === null, 'affermazioni: intenzioni, domande e negazioni non sono affermazioni');
  ok(stop(turn([edit]), '') === null && stop(turn([edit]), undefined) === null && stop(null, SAID) === null, 'affermazioni: senza ultimo messaggio o senza agente, niente');
  // chi risponde a una domanda, o ha solo letto, non deve prove
  ok(stop(turn([]), 'Yes, all tests pass.') === null && stop(turn([['Read', { file_path: '/p/src/cart.ts' }, 'x']]), 'I verified that the function is used in two places.') === null, 'affermazioni: senza modifiche nel turno non si chiedono prove');
  // «verificato»
  m = stop(turn([edit]), 'I verified that the fix works.');
  ok(m && m.tag === 'verified/ungrounded' && /but nothing was run after your last edit to check it\. Run a check, or say that it is not verified\.$/.test(m.text), 'affermazioni, «verificato» senza aver lanciato niente: «' + (m && m.text) + '»');
  ok(stop(turn([edit, ['Bash', { command: 'node scripts/try.js' }, 'ok']]), 'I verified that the fix works.') === null, 'affermazioni, «verificato»: un comando riuscito dopo la modifica è una prova');
  m = stop(turn([edit, ['Bash', { command: 'npm run lint' }, 'Exit code 1\nerror: unused variable', true]]), 'I verified that the fix works.');
  ok(m && m.tag === 'verified/contradicted' && /the last check you ran failed \(`npm run lint` at \d\d:\d\d\)/.test(m.text), 'affermazioni, «verificato» con l\'ultimo controllo fallito: «' + (m && m.text) + '»');
  ok(stop(turn([edit, pass, ['Bash', { command: 'git push' }, 'Exit code 1\nfatal: no upstream', true]]), 'I verified that the fix works.') === null, 'affermazioni, «verificato»: un comando qualunque fallito dopo (git push) non è una smentita');
  // conta solo il turno in corso
  const two = list => turn(list, { goals: [{ t: T0 - 600000 }, { t: T0 + 4500 }], start: T0 });
  ok(stop(two([edit, pass, edit]), SAID).tag === 'tests/ungrounded' && /last run: passed/.test(stop(two([edit, pass, edit]), SAID).text) && stop(two([edit, edit, pass]), SAID) === null, 'affermazioni: le prove sono quelle del turno in corso');
  ok(stop(two([edit, pass]), SAID) === null, 'affermazioni: se in questo turno non ha modificato niente, il test del turno prima basta');
  // mai su una domanda all'utente
  ok(stop(turn([edit, ['AskUserQuestion', { questions: [] }, null]]), SAID) === null && stop(turn([edit, ['ExitPlanMode', { plan: 'x' }, null]]), SAID) === null && stop(turn([edit]), SAID, {}, { waiting: () => true }) === null, 'affermazioni: un turno che finisce con una domanda o un piano da approvare non si giudica');
  // i sottoagenti: dall'inizio del compito
  m = rules.claims(inp('SubagentStop', { agent_id: 'sub-1', last_assistant_message: 'Tutti i test passano.' }), { now: () => now, agent: () => turn([edit], { goals: [] }) });
  ok(m && m.tag === 'tests/ungrounded' && /«Tutti i test passano\.»/.test(m.text) && /\|sub-1\|/.test(m.once), 'affermazioni: vale per i sottoagenti, e in italiano');
  // la risposta che bloccherebbe, come funzione pura; e mai due volte di fila
  const real = { Stop: fb.RULES.Stop.filter(r => r.run === rules.claims), SubagentStop: fb.RULES.SubagentStop.filter(r => r.run === rules.claims) };
  ok(real.Stop.length === 1 && real.SubagentStop.length === 1 && real.Stop[0].feature === 'claims', 'affermazioni: registrata per Stop e SubagentStop');
  const me = turn([edit]);
  const d = fb.decide(inp('Stop', { last_assistant_message: SAID }), { now: () => now, agent: () => me }, real);
  const a = d && fb.answer('Stop', d.message);
  ok(a && a.decision === 'block' && /^Platypus: you said «All tests pass\.», but no test ran/.test(a.reason) && a.reason.length <= fb.MAX_TEXT, 'affermazioni: la risposta che chiederebbe di continuare (decision: block, con il motivo)');
  ok(fb.decide(inp('Stop', { last_assistant_message: SAID, stop_hook_active: true }), { now: () => now, agent: () => me }, real) === null, 'affermazioni: mai mentre Claude Code sta già continuando per un blocco');
  // nel giro completo: nella 2.11 al massimo in ombra (niente a Claude Code), una volta per turno
  const gate = new fb.Gate({ now: () => now });
  const go = settings => fb.respond(inp('Stop', { last_assistant_message: SAID }), { cwd: '/p', now: () => now, settings, agent: () => me }, gate, real);
  ok(go({ fbClaims: 'off' }).entry === null, 'affermazioni: spenta di base, niente');
  const r1 = go({ fbClaims: 'on' });
  ok(r1.out === null && r1.entry && r1.entry.mode === 'shadow' && r1.entry.feature === 'claims' && r1.entry.event === 'Stop' && r1.entry.tag === 'tests/ungrounded', 'affermazioni: anche «accesa» resta in ombra: niente a Claude Code, nel registro con che cosa ha trovato');
  ok(go({ fbClaims: 'shadow' }).entry === null, 'affermazioni: una volta sola per turno');
  driftRuleTests(ok, fb, inp, rules);
}

// B6 · ritorno al compito (sperimentale): la stella polare dice «alla deriva», con la stessa regola della mappa
function driftRuleTests(ok, fb, inp, rules) {
  const sem = require(path.join(ROOT, 'src', 'core', 'semantic'));
  const now = Date.parse('2026-11-18T10:00:00Z'), T0 = now - 600000;
  const TASK = 'Fix the login token refresh in the auth module: expired tokens must be renewed';
  const ON = ['Read src/auth/login.ts token refresh', 'Grep refresh token expired in src/auth', 'Read src/auth/token.ts renew expired token', 'Edit src/auth/refresh.ts renew the login token', 'Bash npm test auth login refresh'];
  const OFF = ['Read src/ui/Menu.tsx sidebar colors', 'Edit src/ui/theme.css palette dark mode', 'Read src/ui/Button.tsx hover animation', 'Grep gradient shadow in src/ui/styles', 'Edit src/ui/Sidebar.tsx icon spacing layout'];
  // una mente vera: il compito, n azioni sul compito e poi m azioni su tutt'altro
  const mind = (on, off, { goal = TASK, again = null } = {}) => {
    const corpus = new sem.Corpus(), m = new sem.AgentMind(corpus);
    let t = T0, k = 0;
    const act = text => m.action('tu' + (++k), t += 1000, text.slice(0, 40), text + ' step ' + k);
    m.setGoal(T0, goal);
    for (let i = 0; i < on; i++) act(ON[i % ON.length]);
    for (let i = 0; i < off; i++) act(OFF[i % OFF.length]);
    if (again) m.setGoal(t += 1000, again);
    return { id: 'main', steps: [], nodes: new Map(), goals: m.goals, mind: m, corpus };
  };
  const hook = (me, extra = {}) => rules.driftBack(inp('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/src/ui/theme.css' }, tool_response: {}, ...extra }), { now: () => now, agent: () => me });
  // sul compito: niente; poi abbastanza azioni lontane di fila
  ok(hook(mind(12, 0)) === null && hook(mind(8, 3)) === null, 'ritorno al compito: finché lavora sul compito, o per poche azioni lontane, niente');
  const far = mind(8, 14), d = sem.drift(far.mind, far.corpus);
  let m = hook(far);
  ok(d && d.drifting && d.run >= sem.DRIFT_RUN && d.rel < sem.DRIFT_REL && !d.weak, `stella polare: alla deriva dopo ${d ? d.run : '-'} azioni di fila sotto la soglia (allineamento ${d ? Math.round(d.rel * 100) : '-'}%)`);
  ok(m && m.text === `your last ${d.run} actions look far from the task you were given: «${TASK}». If this detour is needed, carry on; otherwise go back to the task.` && m.tag === 'run=' + d.run && /^drift\|main\|/.test(m.once) && !m.block, 'ritorno al compito, alla deriva: «' + (m && m.text) + '»');
  ok(fb.say(m.text).length <= fb.MAX_TEXT, 'ritorno al compito: il messaggio sta nel limite');
  // la soglia è quella della mappa: una azione prima della sesta di fila non basta
  let first = 0;
  for (let n = 1; n <= 14 && !first; n++) { const x = mind(8, n), dx = sem.drift(x.mind, x.corpus); if (dx.drifting) first = n; }
  const before = mind(8, first - 1), db = sem.drift(before.mind, before.corpus);
  ok(first > 0 && db.run === sem.DRIFT_RUN - 1 && hook(before) === null && hook(mind(8, first)), `ritorno al compito: scatta alla sesta azione di fila sotto la soglia (dopo ${first} azioni lontane), non prima`);
  // la stessa serie che disegna la mappa
  const snap = sem.snapshotMinds([{ id: 'main', name: 'CLAUDE', mind: far.mind }], far.corpus, 'unit-drift');
  ok(JSON.stringify(snap.align) === JSON.stringify(sem.alignment(far.mind, far.corpus)) && snap.align.length === 22, 'stella polare: la regola usa la stessa serie della mappa');
  // un compito che non si può misurare, una nuova richiesta, un agente senza mente
  const weak = mind(0, 14, { goal: 'Zzyzx quux frobnicate' }), dw = sem.drift(weak.mind, weak.corpus);
  ok(dw && dw.weak && !dw.drifting && hook(weak) === null, 'ritorno al compito: se le parole del compito non compaiono mai nel lavoro non si giudica');
  ok(hook(mind(8, 14, { again: 'Now restyle the sidebar menu colors' })) === null, 'ritorno al compito: una nuova richiesta dell\'utente sposta la stella, e si riparte');
  ok(hook(null) === null && hook({ id: 'main', steps: [] }) === null && sem.drift(null, null) === null && sem.drift(mind(0, 0).mind, mind(0, 0).corpus) === null, 'ritorno al compito: senza agente, senza mente o senza azioni → niente');
  m = rules.driftBack(inp('PostToolUse', { agent_id: 'sub-1', tool_name: 'Read' }), { agent: () => far });
  ok(m && /^drift\|sub-1\|/.test(m.once), 'ritorno al compito: vale per i sottoagenti, sul compito che hanno ricevuto');
  // abbastanza veloce per stare nell'hook anche con una mente piena
  const big = mind(450, 450), t0 = Date.now();
  sem.drift(big.mind, big.corpus);
  const ms = Date.now() - t0;
  ok(ms < 150, `stella polare: ${big.mind.pieces.length} pezzi giudicati in ${ms} ms`);
  // nel giro completo: nella 2.11 al massimo in ombra, dopo le altre regole, una volta per compito
  const post = fb.RULES.PostToolUse.map(r => r.run);
  ok(post.indexOf(rules.driftBack) > post.indexOf(rules.elder) && post.indexOf(rules.elder) > post.indexOf(rules.stale) && fb.RULES.PostToolUse.find(r => r.run === rules.driftBack).feature === 'drift', 'ritorno al compito: registrato per ultimo dopo uno strumento riuscito');
  const gate = new fb.Gate({ now: () => now });
  const real = { PostToolUse: [{ feature: 'drift', run: rules.driftBack }] };
  const go = settings => fb.respond(inp('PostToolUse', { tool_name: 'Edit', tool_input: {}, tool_response: {} }), { cwd: '/p', now: () => now, settings, agent: () => far }, gate, real);
  ok(go({ fbDrift: 'off' }).entry === null, 'ritorno al compito: spento di base, niente');
  const r1 = go({ fbDrift: 'on' });
  ok(r1.out === null && r1.entry && r1.entry.mode === 'shadow' && r1.entry.feature === 'drift' && /^Platypus: your last \d+ actions look far/.test(r1.entry.text) && /^run=\d+$/.test(r1.entry.tag), 'ritorno al compito: anche «acceso» resta in ombra, con la riga nel registro');
  ok(go({ fbDrift: 'shadow' }).entry === null, 'ritorno al compito: una volta sola per compito');
  feedbackShownTests(ok, fb, inp, rules);
}

// C1 · quello che si vede in ufficio e nel Libro: lo stesso messaggio nella lingua dell'ufficio, e i conteggi del registro
function feedbackShownTests(ok, fb, inp, rules) {
  const i18n = require(path.join(ROOT, 'src', 'i18n'));
  const { AgentWorld } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
  const { FeedbackLog } = require(path.join(ROOT, 'src', 'core', 'feedbacklog'));
  const now = Date.parse('2026-11-18T10:00:00Z');
  const w = new AgentWorld();
  w.start('t1', 'Bash', { command: 'npm test' }, now - 5000, '/p', 0);
  w.end('t1', true, { content: 'Exit code 1\nTypeError: boom is not a function' }, null, now - 4000, '/p');
  const ctx = { now: () => now, agent: () => ({ id: 'main', steps: w.steps, nodes: w.nodes, goals: [] }) };
  const hook = inp('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nTypeError: boom is not a function', tool_use_id: 't2' });
  const lesson = { id: 'L-flaky', kind: 'flaky-command', key: 'npm test', count: 3, evidence: [{ sid: 's1', t: Date.parse('2026-10-12T09:00:00Z'), agent: 'EXPLORE' }], ignored: false, weight: 3, level: 'lesson' };
  const lang = i18n.getLang();
  try {
    i18n.setLang('it');
    let m = rules.loop(hook, ctx);
    ok(/^this command failed 2 times in a row/.test(m.text) && /^questo comando è fallito 2 volte di fila con lo stesso errore \(«TypeError: boom is not a function»\) e senza modifiche in mezzo\./.test(m.local), 'messaggi in due lingue: all\'agente in inglese, in ufficio in italiano «' + m.local + '»');
    const e = rules.elder(hook, { cwd: '/p', lessons: () => [lesson] });
    ok(/^Last time npm test got stuck 3 times/.test(e.text) && /^L'ultima volta npm test si è piantato 3 volte/.test(e.local), 'messaggi in due lingue: anche la lezione del Nonno');
    const s = rules.sessionLessons(inp('SessionStart', { source: 'startup' }), { cwd: '/p', lessons: () => [lesson] });
    ok(/^Platypus \(project memory\)/.test(s.text) && /^Platypus \(memoria del progetto\)/.test(s.local) && /\n- .*instabile/.test(s.local), 'messaggi in due lingue: l\'elenco di inizio sessione');
    // nel registro: il testo mandato e quello da mostrare, con il nome che l'agente ha in ufficio
    const r = fb.respond(hook, { ...ctx, cwd: '/p', settings: { fbLoop: 'on' }, agentName: () => 'CLAUDE', log: { append: (cwd, x) => ({ id: 'x1', ...x }) } }, new fb.Gate({ now: () => now }), { PostToolUseFailure: [{ feature: 'loop', run: rules.loop }] });
    ok(r.out && /^Platypus: this command failed/.test(r.out.hookSpecificOutput.additionalContext) && /^Platypus: this command failed/.test(r.entry.text) && /^Platypus: questo comando è fallito/.test(r.entry.local) && r.entry.name === 'CLAUDE', 'registro: il testo arrivato all\'agente, quello nella lingua dell\'ufficio e il nome dell\'agente');
    i18n.setLang('en');
    m = rules.loop(hook, ctx);
    const r2 = fb.respond(hook, { ...ctx, cwd: '/p', settings: { fbLoop: 'on' } }, new fb.Gate({ now: () => now }), { PostToolUseFailure: [{ feature: 'loop', run: rules.loop }] });
    ok(m.text && !('local' in m) && !('local' in r2.entry) && !('name' in r2.entry), 'messaggi in due lingue: con l\'ufficio in inglese basta un testo');
  } finally { i18n.setLang(lang); }
  // i conteggi accanto agli interruttori: per funzione, mandati e in ombra, da un certo giorno in poi, in tutti i progetti
  const fl = testFeedbackLog();
  try {
    ok(JSON.stringify(fl.counts(0)) === '{}', 'conteggi: registro vuoto');
    const row = (cwd, t, feature, mode) => fl.append(cwd, { t, sid: 's', agent: 'main', feature, mode, event: 'PostToolUse', text: 'Platypus: x' });
    row('/p/app', now - 10 * 86400000, 'elder', 'on');   // troppo vecchio
    row('/p/app', now - 2 * 86400000, 'elder', 'on');
    row('/p/app', now - 86400000, 'elder', 'shadow');
    row('/p/altro', now - 3600000, 'elder', 'on');
    row('/p/altro', now - 3600000, 'claims', 'shadow');
    const late = row('/p/app', now - 1000, 'loop', 'on');
    fl.setOutcome('/p/app', late.id, 'late');
    fl.setOutcome('/p/app', fl.recent('/p/app')[1].id, 'helped');
    const c = fl.counts(now - 7 * 86400000);
    ok(c.elder.on === 2 && c.elder.shadow === 1 && c.claims.shadow === 1 && c.claims.on === 0 && !c.loop, `conteggi degli ultimi 7 giorni: ${JSON.stringify(c)} (non contano i vecchi né le risposte in ritardo)`);
    fl.setOutcome('/p/app', late.id, 'helped', 'ha lanciato i test');
    ok(fl.recent('/p/app').find(r => r.id === late.id).why === 'ha lanciato i test', 'registro: l\'esito porta con sé il perché');
  } finally { fl.close(); }
  // il registro della demo: la stessa interfaccia, in memoria, svuotabile, e fuori dai conteggi
  const { MemoryFeedbackLog } = require(path.join(ROOT, 'src', 'core', 'feedbacklog'));
  const ml = new MemoryFeedbackLog(3);
  const m1 = ml.append('C:\\Progetti\\App', { t: now - 3000, feature: 'loop', mode: 'on', text: 'a' });
  ml.append('c:/progetti/app/', { t: now - 1000, feature: 'elder', mode: 'shadow', text: 'b' });
  ok(ml.recent('C:/Progetti/App').map(e => e.text).join() === 'b,a' && ml.setOutcome('C:/Progetti/App', m1.id, 'helped', 'perché') && ml.recent('C:/Progetti/App')[1].why === 'perché' && !ml.setOutcome('C:/Progetti/App', 'nessuno', 'x'), 'registro della demo: righe e esiti in memoria, stessa cartella scritta in modi diversi');
  for (let i = 0; i < 4; i++) ml.append('/d', { t: now + i, feature: 'loop', mode: 'on', text: 'x' + i });
  ok(ml.recent('/d').length === 3 && JSON.stringify(ml.counts()) === '{}' && ml.has('/d'), 'registro della demo: non cresce senza fine e non entra nei conteggi delle opzioni');
  ml.clear();
  ok(!ml.has('/d') && ml.recent('C:/Progetti/App').length === 0, 'registro della demo: si svuota quando la demo finisce');
  outcomeTests(ok, fb, inp, rules);
}

// C2 · esiti: dopo un messaggio, che cosa ha fatto l'agente nei passi successivi (sessioni finte, passi veri di AgentWorld)
function outcomeTests(ok, fb, inp, rules) {
  const { judge, WINDOW_MS, GIVE_UP_MS } = require(path.join(ROOT, 'src', 'core', 'outcomes'));
  const { AgentWorld } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
  const i18n = require(path.join(ROOT, 'src', 'i18n'));
  const lang = i18n.getLang();
  i18n.setLang('en'); // i perché si leggono in inglese nei test
  try {
    const T = Date.parse('2026-11-18T10:00:00Z');
    const FAIL = 'Exit code 1\nFAIL src/cart.test.ts\n    TypeError: Cannot read properties of undefined (reading \'total\')';
    const pat = 'TypeError: Cannot read properties of undefined (reading <…>)';
    // l'hook è arrivato a T, sul passo «tu0»; dopo, i passi della lista [strumento, input, esito (null = in corso), errore?]
    const after = (list, { goals = [], replies = [] } = {}) => {
      const w = new AgentWorld();
      w.start('tu0', 'Bash', { command: 'npm test' }, T - 2000, '/p', 0);
      w.end('tu0', true, { content: FAIL }, null, T - 1000, '/p');
      let t = T, k = 0;
      for (const [name, input, out, isErr] of list) {
        const id = 'tu' + (++k);
        w.start(id, name, input, t += 1000, '/p', 0);
        if (out !== null) w.end(id, !!isErr, { content: out }, null, t += 1000, '/p');
      }
      return { steps: w.steps, goals, replies };
    };
    const run = (cmd, out = 'PASS', err = false) => ['Bash', { command: cmd }, out, err];
    const edit = (f = '/p/src/cart.ts') => ['Edit', { file_path: f, old_string: 'a', new_string: 'b' }, 'ok'];
    const read = (f = '/p/src/cart.ts') => ['Read', { file_path: f }, 'x'];
    const E = (feature, about, extra = {}) => ({ id: 'e1', t: T, agent: 'main', feature, mode: 'on', about, toolUseId: 'tu0', ...extra });
    const loopE = E('loop', { kind: 'loop', cmd: 'npm test', pat });
    const j = (e, ag, now = T + 60000) => judge(e, ag, now);
    // B3 e il Nonno su un comando fallito
    let r = j(loopE, after([edit(), run('npm test')]));
    ok(r.outcome === 'helped' && r.why === 'changed something before running it again', 'esito, giro in tondo: una modifica prima di riprovare → probabilmente utile');
    ok(j(loopE, after([run('cd /p && npm test 2>&1 | tail', 'Tests: 12 passed')])).why === 'the next run succeeded', 'esito, giro in tondo: la volta dopo è andata (anche scritto in un altro modo)');
    r = j(loopE, after([run('npm test', FAIL, true)]));
    ok(r.outcome === 'ignored' && /same error/.test(r.why), 'esito, giro in tondo: rilanciato senza cambiare niente, lo stesso errore → ignorato');
    ok(j(loopE, after([run('npm test', 'Exit code 1\nReferenceError: x is not defined', true)])).outcome === 'unclear', 'esito: rilanciato con un altro errore → non si può dire');
    ok(j(E('elder', { kind: 'flaky-command', cmd: 'npm test', pat }), after([run('npm test', FAIL, true)])).outcome === 'unclear', 'esito, comando instabile: il consiglio era rilanciarlo, se fallisce uguale non si può dire');
    ok(j(loopE, after([read(), ['Grep', { pattern: 'total', path: '/p/src' }, 'x']])) === null, 'esito: finché la finestra è aperta e non ha riprovato, si aspetta');
    ok(j(loopE, after([run('npm test', null)])) === null, 'esito: il comando di nuovo in corso → si aspetta il suo esito');
    ok(j(loopE, after([read()], { goals: [{ t: T + 30000 }] })).why === 'stopped instead of trying again' && j(E('elder', { kind: 'loop-trap', cmd: 'npm test', pat }), after([], { goals: [{ t: T + 30000 }] })).outcome === 'unclear', 'esito: si è fermato (nuova richiesta) → per il giro in tondo probabilmente utile, per il Nonno non si può dire');
    ok(j(loopE, after([read()]), T + WINDOW_MS + 1).why === 'did not run it again', 'esito: passata la finestra senza riprovarlo → non si può dire');
    ok(j(loopE, after([read(), read(), read(), read(), read(), read(), read(), read()])).outcome === 'unclear', 'esito: otto passi senza riprovarlo chiudono la finestra');
    // il passo dopo la nuova richiesta non conta
    ok(j(loopE, after([run('npm test', FAIL, true)], { goals: [{ t: T + 500 }] })).why === 'stopped instead of trying again', 'esito: conta solo il turno in corso');
    // senza l'identificativo dello strumento: i passi partiti dopo il messaggio
    ok(j({ ...loopE, toolUseId: undefined }, after([edit()])).outcome === 'helped', 'esito: senza identificativo, i passi partiti dopo il messaggio');
    // il Nonno sui file
    ok(j(E('elder', { kind: 'known-fix', file: 'src/auth/refresh.ts' }), after([edit('/p/src/auth/refresh.ts')])).why === 'edited src/auth/refresh.ts' && j(E('elder', { kind: 'known-fix', file: 'src/auth/refresh.ts' }), after([edit('/p/src/other.ts')]), T + WINDOW_MS + 1).outcome === 'ignored', 'esito, errore già sistemato: ha modificato quel file → utile; non l\'ha toccato → ignorato');
    ok(j(E('elder', { kind: 'fragile-file', file: 'src/db/pool.ts' }), after([run('npm test')])).why === 'ran the tests' && j(E('elder', { kind: 'fragile-file', file: 'src/db/pool.ts' }), after([read()]), T + WINDOW_MS + 1).outcome === 'ignored', 'esito, file fragile: «lancia i test» seguito o no');
    ok(j(E('elder', { kind: 'ghost-path', file: 'src/old.ts' }), after([read('/p/src/old.ts')])).outcome === 'ignored' && j(E('elder', { kind: 'ghost-path', file: 'src/old.ts' }), after([read()]), T + WINDOW_MS + 1).outcome === 'helped', 'esito, percorso inventato: cercato di nuovo → ignorato; non più → utile');
    ok(j(E('elder', { kind: 'slow-step', cmd: 'npm run build' }), after([])).outcome === 'unclear', 'esito, comando lento: i passi non dicono come l\'ha lanciato');
    // B4
    ok(j(E('stale', { file: 'src/cart.ts' }), after([read()])).why === 'read it again' && j(E('stale', { file: 'src/cart.ts' }), after([edit()])).outcome === 'ignored', 'esito, memoria non aggiornata: riletto → utile; modificato di nuovo alla cieca → ignorato');
    // B5: prima della richiesta successiva, un controllo o l'affermazione ritirata
    const cl = E('claims', { kind: 'tests' }, { toolUseId: undefined });
    ok(j(cl, after([run('npm test')])).why === 'ran the tests' && j(cl, after([run('git status')]), T + WINDOW_MS + 1).outcome === 'ignored', 'esito, affermazioni: i test lanciati dopo → utile; un altro comando non basta');
    ok(j(cl, after([], { replies: [{ t: T + 2000, text: 'Correction: I have not run the tests yet.' }] })).why === 'said it was not verified', 'esito, affermazioni: ritirata → utile');
    ok(j(cl, after([run('npm test')], { goals: [{ t: T + 500 }] })).why === 'nothing before the next request' && j(cl, after([])) === null, 'esito, affermazioni: niente prima della richiesta successiva → ignorato; prima, si aspetta');
    ok(j(E('claims', { kind: 'verified' }, { toolUseId: undefined }), after([run('node try.js')])).why === 'ran a check', 'esito, «verificato»: un comando lanciato dopo conta come controllo');
    // B1, B6 e i casi di contorno
    ok(j(E('sessionLessons', null), null).outcome === 'unclear' && j(E('drift', null), null).outcome === 'unclear', 'esito: lezioni a inizio sessione e ritorno al compito → non si può dire, subito');
    ok(j(loopE, null) === null && j(loopE, null, T + GIVE_UP_MS + 1).why === 'the session is no longer visible' && judge(null, null) === null, 'esito: una sessione che non si vede più → si aspetta, poi «non si può dire»');
    // la riga del registro porta con sé di che cosa parlava il messaggio e il passo da cui partire
    const st = after([]);
    const rr = fb.respond(inp('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: FAIL, tool_use_id: 'tu-now' }), { cwd: '/p', now: () => T, settings: { fbLoop: 'shadow' }, agent: () => st }, new fb.Gate({ now: () => T }), { PostToolUseFailure: [{ feature: 'loop', run: rules.loop }] });
    ok(rr.entry && rr.entry.about && rr.entry.about.kind === 'loop' && rr.entry.about.cmd === 'npm test' && rr.entry.about.pat === pat && rr.entry.toolUseId === 'tu-now', 'registro: di che cosa parlava il messaggio, per giudicarlo dopo');
    const m = fb.decide(inp('PostToolUse'), {}, { PostToolUse: [() => ({ text: 'x', about: { kind: 'k', cmd: 'c'.repeat(500), evil: { a: 1 }, file: 7 } })] });
    ok(m.message.about.kind === 'k' && m.message.about.cmd.length === 200 && !('evil' in m.message.about) && !('file' in m.message.about), 'registro: di «about» solo i campi noti, solo testo corto');
  } finally { i18n.setLang(lang); }
}

// feedback (2.11, A3): i tre modi di ogni funzione, i limiti di frequenza, il progetto zittito e il registro
function feedbackModeTests(ok, fb, inp) {
  const { OfficeState, DEFAULT_SETTINGS } = require(path.join(ROOT, 'src', 'core', 'state'));
  // opzioni: tutto spento di base, solo modi validi, e due funzioni mai oltre l'ombra
  ok(Object.values(fb.FEATURES).every(k => DEFAULT_SETTINGS[k] === 'off'), 'feedback: ogni funzione è spenta di base');
  const st = new OfficeState({});
  st.setSettings({ fbElder: 'on', fbLoop: 'boh', fbClaims: 'on', fbDrift: 'shadow', fbSessionLessons: 'shadow' });
  ok(st.settings.fbElder === 'on' && st.settings.fbLoop === 'off' && st.settings.fbClaims === 'shadow' && st.settings.fbDrift === 'shadow', `feedback, opzioni: modi ripuliti (elder ${st.settings.fbElder}, loop ${st.settings.fbLoop}, claims ${st.settings.fbClaims})`);
  st.stop && st.stop();
  ok(fb.modeOf({ fbElder: 'on' }, 'elder') === 'on' && fb.modeOf({}, 'elder') === 'off' && fb.modeOf({ fbClaims: 'on' }, 'claims') === 'shadow' && fb.modeOf({ x: 'on' }, 'boh') === 'off', 'feedback: il modo di una funzione, spenta se manca o non esiste');
  // spenta, ombra, accesa
  let clock = Date.parse('2026-11-18T10:00:00Z'), ran = 0;
  const logged = [], log = { append: (cwd, e) => { const x = { id: 'e' + logged.length, cwd, ...e }; logged.push(x); return x; } };
  const elder = { feature: 'elder', run: () => { ran++; return { text: 'npm test is flaky here.', lessonId: 'L1' }; } };
  const rules = { PostToolUseFailure: [elder] };
  const ctx = (settings, extra = {}) => ({ now: () => clock, settings, cwd: '/p', log, ...extra });
  const go = (settings, extra, gate, input = {}, rs = rules) => fb.respond(inp('PostToolUseFailure', input), ctx(settings, extra), gate, rs);
  let r = go({ fbElder: 'off' });
  ok(r.out === null && r.entry === null && ran === 0 && logged.length === 0, 'feedback spento: la regola non parte nemmeno');
  r = go({ fbElder: 'shadow' });
  ok(r.out === null && r.entry && r.entry.mode === 'shadow' && logged.length === 1 && logged[0].text === 'Platypus: npm test is flaky here.' && logged[0].cwd === '/p', 'feedback in ombra: niente all\'agente, una riga nel registro');
  r = go({ fbElder: 'on' });
  ok(r.out && r.out.hookSpecificOutput.additionalContext && r.entry.mode === 'on' && r.entry.agent === 'main' && r.entry.event === 'PostToolUseFailure' && r.entry.lessonId === 'L1', 'feedback acceso: il messaggio parte e resta nel registro');
  // il progetto zittito viene prima di tutto
  ran = 0;
  r = go({ fbElder: 'on' }, { muted: () => true });
  ok(r.out === null && r.entry === null && ran === 0, 'feedback: progetto zittito, niente messaggi e niente registro');
  // limiti: uno ogni 2 minuti per agente, mai la stessa lezione due volte, 6 all'ora per sessione; i sottoagenti contano a parte
  const on = { fbElder: 'on' };
  let n = 0;
  const fresh = { PostToolUseFailure: [{ feature: 'elder', run: () => ({ text: 'lesson ' + n, lessonId: 'N' + (n++) }) }] };
  let gate = new fb.Gate({ now: () => clock });
  ok(go(on, {}, gate, {}, fresh).out && !go(on, {}, gate, {}, fresh).out, 'limiti: allo stesso agente non due messaggi in 2 minuti');
  ok(!!go(on, {}, gate, { agent_id: 'sub-1' }, fresh).out, 'limiti: un sottoagente ha il suo conto');
  clock += fb.AGENT_GAP_MS + 1000;
  ok(!!go(on, {}, gate, {}, fresh).out, 'limiti: passati 2 minuti si può di nuovo');
  gate = new fb.Gate({ now: () => clock });
  ok(go(on, {}, gate).out && (clock += fb.AGENT_GAP_MS + 1000) && !go(on, {}, gate).out, 'limiti: la stessa lezione non si ripete allo stesso agente, nemmeno più tardi');
  ok(!!go(on, {}, gate, {}, { PostToolUseFailure: [elder, fresh.PostToolUseFailure[0]] }).out, 'limiti: se la prima regola ripeterebbe, parla la successiva');
  gate = new fb.Gate({ now: () => clock });
  const sent = [];
  for (let i = 0; i < 8; i++) sent.push(!!go(on, {}, gate, { agent_id: 'a' + i }, fresh).out);
  ok(sent.filter(Boolean).length === fb.SESSION_MAX && !sent[6] && !sent[7], `limiti: al massimo ${fb.SESSION_MAX} messaggi all'ora per sessione (${sent.filter(Boolean).length} su 8)`);
  ok(!!go(on, {}, gate, { session_id: 'sess-fb-altra', agent_id: 'a0' }, fresh).out, 'limiti: un\'altra sessione non ne risente');
  clock += 3600000 + 1000;
  ok(!!go(on, {}, gate, { agent_id: 'a9' }, fresh).out, 'limiti: dopo un\'ora la sessione può di nuovo');
  // la fine del turno ha la sua regola (una volta per turno) e non consuma gli altri limiti; il controllo resta in ombra anche se «acceso»
  const stopRules = { Stop: [{ feature: 'claims', run: () => ({ text: 'you said the tests pass, but none ran.', block: true }) }] };
  gate = new fb.Gate({ now: () => clock });
  go(on, {}, gate, {}, fresh);
  r = fb.respond(inp('Stop'), ctx({ fbClaims: 'on' }), gate, stopRules);
  ok(r.out === null && r.entry && r.entry.mode === 'shadow' && r.entry.feature === 'claims', 'feedback: il controllo a fine turno nella 2.11 registra soltanto, anche subito dopo un altro messaggio');
  // registro: nello storico (collezione feedback), un progetto per cartella, esiti aggiunti dopo; lo stesso su disco
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-fblog-'));
  try {
    for (const backend of ['memory', 'sqlite']) {
      let fl = testFeedbackLog(backend, path.join(tmp, backend));
      const e1 = fl.append('/p/app', { t: 1000, sid: 's', agent: 'main', feature: 'elder', mode: 'shadow', event: 'PostToolUseFailure', lessonId: 'L1', text: 'Platypus: uno', about: { kind: 'flaky-command', cmd: 'npm test' }, name: 'Claude', toolUseId: 'toolu_1' });
      const e2 = fl.append('/p/app', { t: 2000, sid: 's', agent: 'sub-1', feature: 'loop', mode: 'on', event: 'PostToolUseFailure', lessonId: null, text: 'Platypus: due', local: 'Platypus: due (it)', tag: 'x/y' });
      fl.append('/p/altro', { t: 3000, sid: 'x', agent: 'main', feature: 'elder', mode: 'on', event: 'PostToolUse', text: 'Platypus: altrove' });
      ok(e1.id && e1.text === 'Platypus: uno' && e1.lessonId === 'L1' && fl.setOutcome('/p/app', e1.id, 'helped') && !fl.setOutcome('/p/app', '', 'x') && !fl.setOutcome('/p/app', 'non-esiste', 'helped'), `registro (${backend}): append restituisce il messaggio con il suo id; l'esito si aggiunge dopo, solo a un messaggio che c'è`);
      let rec = fl.recent('/p/app');
      ok(rec.length === 2 && rec[0].id === e2.id && rec[1].id === e1.id && rec[1].outcome === 'helped' && rec[1].at > 0 && !rec[0].outcome && e1.id !== e2.id && rec[1].about.cmd === 'npm test' && rec[1].name === 'Claude' && rec[1].toolUseId === 'toolu_1' &&
        rec[0].local === 'Platypus: due (it)' && rec[0].tag === 'x/y' && !('lessonId' in rec[0]) && !('project' in rec[0]) && !('_id' in rec[0]), `registro (${backend}): gli ultimi messaggi del progetto, dal più recente, con il loro esito e i loro campi`);
      ok(fl.recent('/p/altro').length === 1 && fl.recent('/p/nessuno').length === 0 && fl.recent('/P/APP/').length === (process.platform === 'win32' ? 2 : 0), `registro (${backend}): ogni cartella vede solo i suoi messaggi`);
      for (let i = 0; i < 12; i++) fl.append('/p/app', { t: 4000 + i, sid: 's', agent: 'main', feature: 'elder', mode: 'on', event: 'PostToolUse', text: 'Platypus: riga ' + i + ' ' + 'x'.repeat(60) });
      rec = fl.recent('/p/app', 5);
      ok(rec.length === 5 && /riga 11/.test(rec[0].text) && /riga 7/.test(rec[4].text) && fl.recent('/p/app').length === 14, `registro (${backend}): recent si ferma al numero chiesto`);
      const secret = fl.append('/p/app', { t: 9000, sid: 's', agent: 'main', feature: 'loop', mode: 'on', event: 'PostToolUse', text: 'Platypus: the last error said password=hunter2' });
      ok(secret.text.includes('hunter2') && fl.recent('/p/app', 1)[0].text === 'Platypus: the last error said password=[secret]', `registro (${backend}): all'agente va il testo intero, nello storico resta senza segreti`);
      if (backend === 'sqlite') {
        fl.close();
        fl = testFeedbackLog(backend, path.join(tmp, backend));
        ok(fl.recent('/p/app').length === 15 && fl.recent('/p/app').find(r => r.id === e1.id).outcome === 'helped' && fl.counts(0).elder.on === 13 && !fs.existsSync(path.join(tmp, backend, 'feedback')), 'registro (sqlite): dopo un riavvio c\'è tutto, nel database e non in file a parte');
      }
      fl.close();
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  // il Libro ricorda il progetto zittito
  const bt = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-mute-'));
  try {
    const b1 = new bt.Bottega(bdir);
    ok(b1.muted('/p/app') === false && b1.setMute('/p/app', true) === true && b1.view('/p/app').mute === true, 'Libro: «non parlare agli agenti di questo progetto»');
    b1.stop();
    const b2 = new bt.Bottega(bdir);
    ok(b2.muted('/p/app') === true && b2.muted('/p/altro') === false && b2.setMute('/p/app', false) === false, 'Libro: la scelta resta salvata, progetto per progetto');
    b2.stop();
  } finally { fs.rmSync(bdir, { recursive: true, force: true }); }
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
  require('./test-guard').requireTempDataDir('unit-engine'); // mai nei dati veri: solo con PLATYPUS_DATA_DIR in una cartella temporanea
  let failed = 0;
  run((cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
}
