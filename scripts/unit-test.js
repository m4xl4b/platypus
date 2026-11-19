#!/usr/bin/env node
'use strict';
// Prove dei pezzi del motore che non hanno bisogno del server: mappa contro territorio, parser.
// Le richiama smoke-test.js (quindi anche npm test e le GitHub Actions); si possono lanciare anche da sole.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { AgentWorld } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
const grounding = require(path.join(ROOT, 'src', 'core', 'grounding'));

// un agente finto: read/edit con esito, agli istanti indicati (ms)
let seq = 0;
function act(w, tool, file, t, { err = false, out = '', cwd = '' } = {}) {
  const id = 'u' + (++seq);
  w.start(id, tool, { file_path: file }, t, cwd, 0);
  w.end(id, err, { content: out }, {}, t + 100, cwd);
}
const agent = (id, name) => ({ id, name, world: new AgentWorld() });

function groundingTests(ok) {
  const sess = (extra) => ({ id: 's' + (++seq), cwd: '', kind: 'code', ...extra });

  // EXPLORE legge, ARCHITECT modifica dopo: ricordo scaduto di EXPLORE, "cambiato da ARCHITECT"
  {
    const ex = agent('a1', 'EXPLORE'), ar = agent('a2', 'ARCHITECT');
    act(ex.world, 'Read', 'src/auth/session.ts', 1000);
    act(ar.world, 'Edit', 'src/auth/session.ts', 5000);
    const r = grounding.checkStale(sess({ kind: 'cowork' }), [ex, ar], '');
    const s = r.stale.find(x => x.agent === 'a1');
    ok(s && s.changedBy === 'ARCHITECT' && !s.outside && s.readAt === 1100, 'ricordo scaduto: letto da EXPLORE, cambiato da ARCHITECT');
    ok(!r.stale.some(x => x.agent === 'a2'), 'chi ha modificato il file non ha un ricordo scaduto');
    ok(!r.disk.checked && /Cowork/.test(r.disk.reason), 'Cowork: niente disco, con il motivo');
    // rilegge: non è più scaduto
    act(ex.world, 'Read', 'src/auth/session.ts', 7000);
    ok(!grounding.checkStale(sess({ kind: 'cowork' }), [ex, ar], '').stale.length, 'dopo una nuova lettura il ricordo non è più scaduto');
  }

  // una lettura fallita non allinea la mappa; una modifica fallita nemmeno
  {
    const w = new AgentWorld();
    act(w, 'Read', 'a.js', 1000, { err: true, out: 'File does not exist.' });
    act(w, 'Edit', 'b.js', 1000, { err: true, out: 'String to replace not found' });
    ok(!w.nodes.get('a.js').lastSync && !w.nodes.get('b.js').lastSync, 'esiti falliti: nessun ultimo contatto');
  }

  // modifica alla cieca: B cambia il file, A lo modifica senza rileggerlo
  {
    const a = agent('a', 'CLAUDE'), b = agent('b', 'REFACTOR');
    act(a.world, 'Read', 'src/x.ts', 1000);
    act(b.world, 'Edit', 'src/x.ts', 2000);
    act(a.world, 'Edit', 'src/x.ts', 3000);
    const r = grounding.checkStale(sess({ kind: 'cowork' }), [a, b], '');
    const be = r.blindEdits.find(x => x.agent === 'a');
    ok(be && be.changedBy === 'REFACTOR' && !be.caught, 'modifica alla cieca su un file cambiato da un altro agente');
    // se invece rilegge prima di modificare, niente modifica alla cieca
    const c = agent('c', 'CLAUDE'), d = agent('d', 'REFACTOR');
    act(c.world, 'Read', 'src/x.ts', 1000);
    act(d.world, 'Edit', 'src/x.ts', 2000);
    act(c.world, 'Read', 'src/x.ts', 2500);
    act(c.world, 'Edit', 'src/x.ts', 3000);
    ok(!grounding.checkStale(sess({ kind: 'cowork' }), [c, d], '').blindEdits.length, 'rilegge prima di modificare: nessuna modifica alla cieca');
  }

  // Claude Code rifiuta la modifica: presa in tempo
  {
    const a = agent('a', 'CLAUDE');
    act(a.world, 'Read', 'src/y.ts', 1000);
    act(a.world, 'Edit', 'src/y.ts', 4000, { err: true, out: 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.' });
    const r = grounding.checkStale(sess({ kind: 'cowork' }), [a], '');
    ok(r.blindEdits.length === 1 && r.blindEdits[0].caught, 'modifica rifiutata da Claude Code: presa in tempo');
  }

  // disco vero: cartella temporanea con mtime controllati
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-ground-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      const f = path.join(dir, 'src', 'a.js'), g = path.join(dir, 'src', 'b.js'), h = path.join(dir, 'src', 'c.js');
      for (const p of [f, g, h]) fs.writeFileSync(p, 'x');
      const T = Date.now();
      fs.utimesSync(f, new Date(T), new Date(T));
      fs.utimesSync(g, new Date(T), new Date(T));
      const a = agent('a', 'CLAUDE');
      act(a.world, 'Read', path.join(dir, 'src', 'a.js'), T - 60000, { cwd: dir }); // letto un minuto prima dell'ultima modifica
      act(a.world, 'Read', 'src/b.js', T - 1000, { cwd: dir });                      // dentro la tolleranza
      act(a.world, 'Read', 'src/c.js', T, { cwd: dir });
      fs.rmSync(h);                                                                  // poi cancellato
      const s = sess({ cwd: dir });
      const r = grounding.checkStale(s, [a], dir);
      const by = k => r.stale.find(x => x.key === k);
      ok(r.disk.checked, 'disco controllato');
      ok(by('src/a.js') && by('src/a.js').outside && by('src/a.js').changedBy === null, 'cambiato fuori dalla sessione (percorso assoluto ricondotto alla cartella)');
      ok(!by('src/b.js'), `entro ${grounding.SLACK} ms non è scaduto`);
      ok(by('src/c.js') && by('src/c.js').gone, 'file cancellato dopo la lettura');
      // la cache: per 10 s il disco non si riguarda
      fs.utimesSync(g, new Date(T + 60000), new Date(T + 60000));
      ok(!grounding.checkStale(s, [a], dir).stale.some(x => x.key === 'src/b.js'), `il disco si riguarda al massimo ogni ${grounding.DISK_TTL / 1000} s`);
      ok(grounding.checkStale(sess({ cwd: dir }), [a], dir).stale.some(x => x.key === 'src/b.js'), 'con la cache scaduta il cambiamento si vede');
      // in replay il disco non si usa
      ok(!grounding.checkStale(sess({ cwd: dir }), [a], dir, { replay: true }).disk.checked, 'replay: niente disco');
      // cartella che non si legge (es. WSL non montato)
      ok(!grounding.checkStale(sess({ cwd: path.join(dir, 'non-esiste') }), [a], path.join(dir, 'non-esiste')).disk.checked, 'cartella non leggibile: niente disco');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // demo: disco finto
  {
    const a = agent('a', 'EXPLORE');
    act(a.world, 'Read', 'src/auth/session.ts', 1000);
    act(a.world, 'Read', 'src/auth/token.ts', 1000);
    const demoDisk = new Map([['src/auth/session.ts', { mtime: 9000 }], ['src/auth/token.ts', { mtime: 500 }]]);
    const r = grounding.checkStale(sess({ demo: true, demoDisk }), [a], '/demo');
    ok(r.disk.checked && r.stale.length === 1 && r.stale[0].key === 'src/auth/session.ts', 'demo: disco finto (s.demoDisk)');
    ok(!grounding.checkStale(sess({ demo: true }), [a], '/demo').disk.checked, 'demo senza disco finto: niente disco');
  }
}

function ghostTests(ok) {
  const { missingPathsInOutput } = require(path.join(ROOT, 'src', 'core', 'worldmap'));
  const sess = (extra) => ({ id: 'g' + (++seq), cwd: '', kind: 'code', ...extra });

  // fonte 2: output dei comandi (inglese e italiano, POSIX e Windows)
  const outputs = [
    ['cat: src/missing.ts: No such file or directory', 'src/missing.ts'],
    ["ls: cannot access 'docs/old.md': No such file or directory", 'docs/old.md'],
    ["FileNotFoundError: [Errno 2] No such file or directory: 'data/input.csv'", 'data/input.csv'],
    ["Error: ENOENT: no such file or directory, open 'config/app.json'", 'config/app.json'],
    ["Error: Cannot find module './lib/helper'", './lib/helper'],
    ["src/a.ts(3,20): error TS2307: Cannot find module './session' or its corresponding type declarations.", './session'],
    ["Get-Content : Cannot find path 'C:\\proj\\src\\nope.ps1' because it does not exist.", 'C:\\proj\\src\\nope.ps1'],
    ["Get-Content : Impossibile trovare il percorso 'C:\\proj\\docs\\vecchio.md' perché non esiste.", 'C:\\proj\\docs\\vecchio.md'],
    ['cat: appunti/note.txt: File o directory non esistente', 'appunti/note.txt'],
    ["python: can't open file 'C:\\\\proj\\\\run.py': [Errno 2] No such file or directory", 'C:\\proj\\run.py'],
    ["error: pathspec 'src/x.js' did not match any file(s) known to git", 'src/x.js'],
    ["ls: cannot access '/home/max/My Docs/a.md': No such file or directory", '/home/max/My Docs/a.md'],
  ];
  for (const [out, want] of outputs) {
    const got = missingPathsInOutput(out).map(g => g.path);
    ok(got.length === 1 && got[0] === want, `output: ${want}` + (got[0] === want ? '' : ` (trovato: ${JSON.stringify(got)})`));
  }
  const none = ['The system cannot find the path specified.', 'Il sistema non riesce a trovare il percorso specificato.', "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.", '3 passing (12ms)'];
  ok(none.every(o => !missingPathsInOutput(o).length), 'output senza percorsi: nessun fantasma');

  // fonte 3: risposte
  const replies = [
    ['Ho aggiornato `src/auth/session.ts` e il file docs/guida.md.', ['src/auth/session.ts', 'docs/guida.md']],
    ['I read `package.json` and src/app.ts.', ['package.json', 'src/app.ts']],
    ['Ho modificato src\\ui\\Menu.tsx come richiesto', ['src\\ui\\Menu.tsx']],
    ['Usa `Node.js` 20, vedi https://example.com/a/b.js, versione 3.5 o v1.2.3, cioè e.g. i.e.', []],
    ["Esempio:\n```js\nimport x from './foo.ts'\n```\nfine", []],
  ];
  for (const [text, want] of replies) {
    const got = grounding.pathsInReply(text).map(p => p.path);
    ok(JSON.stringify(got) === JSON.stringify(want), `risposta: ${JSON.stringify(want)}` + (JSON.stringify(got) === JSON.stringify(want) ? '' : ` (trovato: ${JSON.stringify(got)})`));
  }

  // fonte 1 e 2 dentro la mappa, e "poi creato"
  {
    const a = agent('a', 'TEST-RUNNER'), b = agent('b', 'CLAUDE');
    act(a.world, 'Read', 'src/auth/oldToken.ts', 1000, { err: true, out: 'File does not exist. Note: your current working directory is /proj.' });
    act(a.world, 'Read', 'src/later.ts', 1000, { err: true, out: '<tool_use_error>File does not exist.</tool_use_error>' });
    act(b.world, 'Write', 'src/later.ts', 2000);
    a.world.start('r1', 'Bash', { command: 'cd tools && cat conf/x.yml' }, 3000, '/proj', 0);
    a.world.end('r1', true, { content: 'cat: conf/x.yml: No such file or directory' }, {}, 3100, '/proj');
    const r = grounding.findGhosts(sess({ kind: 'cowork' }), [a, b], '/proj');
    const by = k => r.ghosts.find(g => g.key === k);
    ok(by('src/auth/oldToken.ts') && by('src/auth/oldToken.ts').source === 'tool' && !by('src/auth/oldToken.ts').createdLater, 'Read fallito: fantasma');
    ok(by('src/later.ts') && by('src/later.ts').createdLater, 'creato dopo da un altro agente: era un\'intenzione');
    ok(by('tools/conf/x.yml') && by('tools/conf/x.yml').source === 'output', 'output del comando, relativo alla cartella della shell');
  }

  // fonte 3 sul disco vero
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-ghost-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'auth', 'real.ts'), 'x');
      const a = agent('a', 'CLAUDE'), b = agent('b', 'BUILDER');
      a.world.reply(5000, 'Ho corretto `src/auth/real.ts` (in `auth/real.ts`, cioè `real.ts`), poi src/auth/fake.ts e `src/new.ts`.');
      act(b.world, 'Write', 'src/new.ts', 6000);
      const r = grounding.findGhosts(sess({ cwd: dir }), [a, b], dir);
      ok(r.ghosts.length === 1 && r.ghosts[0].key === 'src/auth/fake.ts' && r.ghosts[0].source === 'reply', 'risposta: solo il file che non c\'è e che nessuno ha creato');
      ok(!grounding.findGhosts(sess({ cwd: dir }), [a, b], dir, { replay: true }).ghosts.length, 'replay: le risposte non si controllano sul disco');
      // agenti che lavorano in un worktree di Claude Code: i percorsi sono relativi al worktree
      fs.mkdirSync(path.join(dir, '.claude', 'worktrees', 'wt1', 'frontend', 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'worktrees', 'wt1', 'frontend', 'src', 'app.css'), 'x');
      const w = agent('w', 'WORKER');
      w.world.reply(7000, 'Ho aggiornato frontend/src/app.css e frontend/src/manca.css.');
      const rw = grounding.findGhosts(sess({ cwd: dir }), [w], dir).ghosts.map(g => g.key);
      ok(!rw.includes('frontend/src/app.css') && rw.includes('frontend/src/manca.css'), 'percorsi di un worktree di Claude Code: esistono, non sono fantasmi');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}

function claimTests(ok) {
  // estrazione: frase → tipi attesi (in ordine)
  const cases = [
    ['Ho corretto il refresh e i test passano.', ['tests', 'fixed']],
    ['All tests pass.', ['tests']],
    ['Tutti i test sono verdi.', ['tests']],
    ['La suite è verde, tutto a posto.', ['tests']],
    ["Ho verificato che l'endpoint risponde 200.", ['verified']],
    ['I verified the fix in the browser.', ['verified']],
    ['Now it works.', ['verified']],
    ['Fixed the bug in `src/auth/refresh.ts`.', ['fixed']],
    ['Ho creato `docs/guida.md` con i passaggi.', ['created']],
    ['Added `src/utils/date.ts` with the helpers.', ['created']],
    ['Completato.', ['done']],
    ['Done!', ['done']],
    ['Confermato: il problema era nel parser.', ['verified']],
    // falsi positivi da evitare
    ['Ora devo verificare che i test passino.', []],
    ['Se i test passano, faccio il commit.', []],
    ["I'll run the tests to verify.", []],
    ['I test non passano ancora.', []],
    ['Do the tests pass?', []],
    ['Make sure all tests pass before merging.', []],
    ['Il fatto è che il token scade.', []],
    ['Once tests pass, we can ship.', []],
    ['It should work now.', []],
    ["Non funziona ancora.", []],
    // tipi di frase trovati nella prova sulle sessioni vere (D2), riscritti con esempi inventati
    ['La soluzione proposta in `src/utils/date.ts` è corretta.', []],
    ['Riepilogo: come funziona la cache delle sessioni', []],
    ['The request that failed created nothing.', []],
    ['Now check the flag already confirmed in Settings.java.', []],
    ['Va bene come idea, ma «confermato» è una parola forte.', []],
    ['Il bug del login è stato risolto.', ['fixed']],
    ['Ho già sistemato `src/a.ts`.', ['fixed']],
    ['```\n// tests pass, done\n```', []],
  ];
  for (const [text, want] of cases) {
    const got = grounding.extractClaims(text).map(c => c.kind);
    ok(JSON.stringify(got) === JSON.stringify(want), `affermazioni: «${text.replace(/\n/g, ' ')}» → ${want.join(', ') || 'nessuna'}` + (JSON.stringify(got) === JSON.stringify(want) ? '' : ` (trovato: ${got.join(', ') || 'nessuna'})`));
  }
  const f = grounding.extractClaims('Fixed the bug in `src/auth/refresh.ts`.')[0];
  ok(f && f.file === 'src/auth/refresh.ts', 'affermazioni: il file corretto è quello citato');

  // prove nel turno: la mappa dell'agente come la costruisce state.js
  const run = (w, cmd, t, err = false) => { const id = 'c' + (++seq); w.start(id, 'Bash', { command: cmd }, t, '/p', 0); w.end(id, err, { content: err ? 'FAIL' : 'ok' }, {}, t + 100, '/p'); };
  const claimsAt = (a, text, t) => { a.world.reply(t, text); return grounding.checkClaims({}, [a], '/p').claims.filter(c => c.t === t); };
  const a = { id: 'main', name: 'CLAUDE', world: new AgentWorld(), mind: { goals: [{ t: 500 }] } };
  act(a.world, 'Read', 'src/auth/refresh.ts', 1000);
  act(a.world, 'Edit', 'src/auth/refresh.ts', 2000);
  let c = claimsAt(a, 'Ho corretto il refresh in `src/auth/refresh.ts` e i test passano.', 3000);
  const by = k => c.find(x => x.kind === k);
  ok(by('fixed') && by('fixed').status === 'grounded' && by('fixed').evidence.target === 'src/auth/refresh.ts', 'ho corretto X: ancorata dalla modifica a X');
  ok(by('tests') && by('tests').status === 'ungrounded', 'i test passano senza averli lanciati dopo la modifica: non ancorata');
  run(a.world, 'npm test', 4000);
  c = claimsAt(a, 'Tests pass now.', 5000);
  ok(c[0] && c[0].status === 'grounded' && c[0].evidence.act === 'verify', 'dopo npm test riuscito: ancorata');
  act(a.world, 'Edit', 'src/auth/refresh.ts', 5500);
  run(a.world, 'npm test', 6000, true);
  c = claimsAt(a, 'All tests pass.', 7000);
  ok(c[0] && c[0].status === 'contradicted', 'test fallito dopo l\'ultima modifica: smentita');
  c = claimsAt(a, 'Fatto.', 7100);
  ok(c[0] && c[0].kind === 'done' && c[0].status === 'ungrounded', 'fatto con un test rosso nel turno: non ancorata');
  // nuovo turno (nuova richiesta dell'utente): le prove del turno prima non valgono
  a.mind.goals.push({ t: 8000 });
  c = claimsAt(a, 'Ho verificato, funziona.', 9000);
  ok(c[0] && c[0].kind === 'verified' && c[0].status === 'ungrounded', 'nuovo turno: le prove del turno precedente non contano');
  // "creati" senza file: vale uno strumento esterno riuscito nel turno (ticket via MCP)
  const mc = { id: 'main', name: 'CLAUDE', world: new AgentWorld(), mind: { goals: [{ t: 100 }] } };
  mc.world.start('m1', 'mcp__jira__create_issue', { summary: 'x' }, 1000, '/p', 0); mc.world.end('m1', false, { content: 'ok' }, {}, 1100, '/p');
  mc.world.reply(2000, 'All 12 are created.');
  const mcc = grounding.checkClaims({}, [mc], '/p').claims[0];
  ok(mcc && mcc.kind === 'created' && mcc.status === 'grounded', 'creati senza file: ancorata da uno strumento esterno riuscito');
  const sc = grounding.checkClaims({}, [a], '/p').score;
  ok(sc && sc.total >= 5 && sc.pct === Math.round(100 * sc.grounded / sc.total), `indice di ancoraggio: ${sc ? sc.pct + '% su ' + sc.total : '-'}`);
}

// avvisi di ancoraggio (facoltativi) costruiti da OfficeState
function alertTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const st = new OfficeState({});
  const s = st.ensureSession('al-1', '/p', Date.now());
  const t0 = Date.now() - 60000;
  const sub = st.ensureSub(s, 'sub-1', { agentType: 'REFACTOR' }, true, t0);
  st.worldStart(s, s.main, 'x1', 'Read', { file_path: '/p/src/a.ts' }, t0);
  st.worldEnd(s, s.main, 'x1', false, { content: 'x' }, {}, t0 + 100);
  st.worldStart(s, sub, 'x2', 'Edit', { file_path: '/p/src/a.ts' }, t0 + 1000);
  st.worldEnd(s, sub, 'x2', false, { content: 'ok' }, {}, t0 + 1100);
  st.worldStart(s, s.main, 'x3', 'Edit', { file_path: '/p/src/a.ts' }, t0 + 2000);
  st.worldEnd(s, s.main, 'x3', false, { content: 'ok' }, {}, t0 + 2100);
  st.updateAlerts(s);
  ok(!s.alerts.some(x => x.kind === 'grounding'), 'avvisi di ancoraggio spenti di base');
  st.setSettings({ groundingAlerts: true });
  st.updateAlerts(s);
  ok(s.alerts.some(x => x.kind === 'grounding' && /src\/a\.ts/.test(x.text)), 'acceso: avviso per la modifica alla cieca');
}

// sorpresa dei fallimenti (B1): tipo deciso quando arriva l'esito, punteggio calcolato su richiesta
function surpriseTests(ok) {
  const sp = require(path.join(ROOT, 'src', 'core', 'surprise'));
  const sh = (w, cmd, t, err, out) => { const id = 's' + (++seq); w.start(id, 'Bash', { command: cmd }, t, '/p', 0); w.end(id, err, { content: out }, {}, t + 100, '/p'); };
  const val = (w) => sp.surpriseAt(w.world.steps, w.world.steps.length - 1);
  // prima funzionava: npm test riusciva, ora fallisce
  const a = agent('a', 'TEST-RUNNER');
  sh(a.world, 'npm test', 1000, false, 'Tests: 12 passed, 12 total');
  sh(a.world, 'npm test', 2000, true, 'FAIL src/auth/refresh.test.ts\n  ● refresh › renews the token\n    at Object.<anonymous> (src/auth/refresh.ts:42:7)\nTests: 1 failed, 11 passed, 12 total');
  let x = val(a);
  ok(x && x.kind === 'test' && x.value === 1 && x.reasons.includes('usedToWork'), `test che prima passava: sorpresa ${x && x.value} (${x && x.reasons.join(', ')})`);
  ok(x && /refresh/.test(x.excerpt), 'estratto dell\'errore: ' + (x && x.excerpt));
  const last = a.world.steps[a.world.steps.length - 1];
  ok(last.refs && last.refs.refs.some(r => r.file === 'src/auth/refresh.ts' && r.line === 42), 'i file citati dall\'errore restano sul passo (per B3)');
  // primo tentativo di un comando nuovo
  const b = agent('b', 'CLAUDE');
  sh(b.world, 'pnpm lint', 1000, true, 'bash: pnpm: command not found');
  x = val(b);
  ok(x && x.kind === 'command' && x.value === 0.3 && x.reasons.includes('firstTry'), `comando nuovo che fallisce al primo colpo: ${x && x.value}`);
  // TDD: ha appena scritto un test che deve fallire
  const c = agent('c', 'CLAUDE');
  act(c.world, 'Write', 'tests/auth.test.ts', 1000);
  sh(c.world, 'npx jest tests/auth.test.ts', 2000, true, 'FAIL tests/auth.test.ts\n  ● login › rejects a wrong password\nTests: 1 failed, 1 total');
  x = val(c);
  ok(x && x.kind === 'test' && x.reasons.includes('tdd') && x.value === 0.3, `TDD (test appena scritto che fallisce): ${x && x.value} (${x && x.reasons.join(', ')})`);
  // Edit senza la stringa, permessi
  const d = agent('d', 'CLAUDE');
  act(d.world, 'Edit', 'src/a.ts', 1000, { err: true, out: 'String to replace not found in file.\nString: foo()' });
  x = val(d);
  ok(x && x.kind === 'edit' && x.value === 0.5, `Edit senza la stringa da sostituire: ${x && x.value}`);
  act(d.world, 'Read', 'src/secret.key', 2000, { err: true, out: "EACCES: permission denied, open 'src/secret.key'" });
  x = val(d);
  ok(x && x.kind === 'permission' && x.value === 0.4, `permesso negato: ${x && x.value}`);
  // un errore senza testo riconoscibile: comando generico
  sh(d.world, 'make deploy', 3000, true, '');
  x = val(d);
  ok(x && x.kind === 'command' && x.value >= 0 && x.value <= 1, 'fallimento senza testo: comando generico');
  const all = sp.surprises([a, b, c, d]).surprises;
  ok(all.length === 6 && all.every((y, i) => !i || all[i - 1].t <= y.t), `elenco della sessione: ${all.length} sorprese in ordine di tempo`);

  // B2: dopo la sorpresa si corregge, insiste o si ferma?
  const reactionOf = (w, i, ctx) => sp.reactionAt(w.world.steps, i, ctx);
  const ins = agent('i', 'TEST-RUNNER');
  sh(ins.world, 'npm run test:e2e', 1000, true, 'FAIL tests/e2e/login.spec.ts');
  sh(ins.world, 'npm run test:e2e', 2000, true, 'FAIL tests/e2e/login.spec.ts');
  ok(reactionOf(ins, 0).reaction === 'insists', 'rilancia lo stesso comando senza cambiare nulla: insiste');
  const cor = agent('k', 'CLAUDE');
  sh(cor.world, 'npm test', 1000, true, 'FAIL src/a.test.ts\nTests: 1 failed');
  act(cor.world, 'Read', 'src/a.ts', 2000);
  act(cor.world, 'Edit', 'src/a.ts', 3000);
  sh(cor.world, 'npm test', 4000, false, 'Tests: 3 passed');
  let r = reactionOf(cor, 0);
  ok(r.reaction === 'corrects' && r.recovery && r.recovery.steps === 3 && r.recovery.ms === 3000, `legge, modifica e rilancia: si corregge, recupero in ${r.recovery && r.recovery.steps} passi e ${r.recovery && r.recovery.ms / 1000} s`);
  const arg = agent('g', 'CLAUDE');
  sh(arg.world, 'npm test', 1000, true, 'FAIL src/a.test.ts');
  sh(arg.world, 'npm test -- --runInBand', 2000, false, 'Tests: 3 passed');
  ok(reactionOf(arg, 0).reaction === 'corrects', 'cambia gli argomenti del comando: si corregge');
  const edm = agent('e', 'CLAUDE');
  sh(edm.world, 'npm test', 1000, true, 'FAIL');
  act(edm.world, 'Edit', 'src/a.ts', 2000);
  sh(edm.world, 'npm test', 3000, true, 'FAIL');
  ok(reactionOf(edm, 0).reaction === 'corrects', 'rilancia lo stesso comando ma dopo una modifica: non è insistere');
  // si ferma: risponde e poi arriva una nuova richiesta dell'utente
  const stp = agent('p', 'CLAUDE');
  sh(stp.world, 'npm test', 1000, true, 'FAIL');
  sh(stp.world, 'git status', 9000, false, 'clean');
  r = reactionOf(stp, 0, { replies: [{ t: 2000, text: 'I test falliscono, come procedo?' }], goals: [{ t: 5000 }], now: 10000 });
  ok(r.reaction === 'stops', 'fine del turno dopo la sorpresa: si ferma');
  const ask = agent('q', 'CLAUDE');
  sh(ask.world, 'npm test', 1000, true, 'FAIL');
  ask.world.start('aq', 'AskUserQuestion', { questions: [] }, 2000, '/p', 0);
  ok(reactionOf(ask, 0).reaction === 'stops', 'chiede all\'utente: si ferma');
  const lst = agent('l', 'CLAUDE');
  sh(lst.world, 'npm test', 1000, true, 'FAIL');
  ok(reactionOf(lst, 0, { now: 1000 + 30000 }).reaction === 'undecided' && reactionOf(lst, 0, { now: 1000 + 120000 }).reaction === 'stops', 'ultimo passo: "in corso" per un minuto, poi si ferma');
  const sum = sp.surprises([ins, cor, arg, edm], { now: 1e13 }).reactions;
  const kk = sum.find(x => x.id === 'k'), ii = sum.find(x => x.id === 'i');
  ok(kk && kk.corrects === 1 && kk.total === 1 && ii && ii.corrects === 0 && ii.total === 2, `indicatore per agente: si corregge ${kk && kk.corrects} volte su ${kk && kk.total}`);

  // B3: ha capito la causa? catena sorpresa → file citati → modifica → conferma
  const causeOf = (w, i, now = 1e13) => sp.causeAt(w.world.steps, i, { now });
  const fol = agent('f', 'TEST-RUNNER');
  sh(fol.world, 'npm test', 1000, true, "FAIL src/auth/refresh.test.ts\n  ● refresh › renews\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at renew (src/auth/refresh.ts:42:18)\n      at Object.<anonymous> (node_modules/jest-circus/build/utils.js:298:28)");
  act(fol.world, 'Read', 'src/auth/refresh.ts', 2000);
  act(fol.world, 'Edit', 'src/auth/refresh.ts', 3000);
  sh(fol.world, 'npm test', 4000, false, 'Tests: 12 passed');
  let cz = causeOf(fol, 0);
  ok(cz.cause === 'follows' && cz.readCited && cz.refs[0].file === 'src/auth/refresh.ts' && cz.refs[0].line === 42 && cz.discarded === 1, 'segue la traccia: modifica il file citato (e il frame di node_modules è scartato ma contato)');
  ok(cz.chain.fix && cz.chain.fix.cited && cz.chain.confirm && cz.chain.complete, 'catena completa: errore → refresh.ts → modifica → npm test di nuovo verde');
  const els = agent('el', 'PLAN');
  sh(els.world, 'npx tsc --noEmit', 1000, true, "src/db/migrate.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.");
  act(els.world, 'Edit', 'src/ui/components/Menu.tsx', 2000);
  cz = causeOf(els, 0);
  ok(cz.cause === 'elsewhere' && cz.chain.fix && !cz.chain.fix.cited && !cz.chain.complete, 'cerca altrove: l\'errore cita migrate.ts, modifica Menu.tsx');
  const thk = agent('th', 'CLAUDE');
  sh(thk.world, 'npx tsc --noEmit', 1000, true, 'src/a.ts(3,1): error TS1005: \';\' expected.');
  for (let k = 0; k < 6; k++) act(thk.world, 'Read', 'src/other' + k + '.ts', 2000 + k * 1000);
  ok(causeOf(thk, 0).cause === 'thinking', 'nessuna modifica nei 6 passi dopo: ci pensa ancora');
  ok(sp.causeAt(thk.world.steps, 0, { now: 1500 }).cause === 'thinking', 'con sei passi già fatti non è più "in corso"');
  const ntr = agent('nt', 'CLAUDE');
  sh(ntr.world, 'pnpm build', 1000, true, 'bash: pnpm: command not found');
  sh(ntr.world, 'node x.js', 2000, true, 'Error: boom\n    at f (node_modules/lib/index.js:1:1)\n    at node:internal/main:5:3');
  ok(causeOf(ntr, 0).cause === 'notrail' && causeOf(ntr, 1).cause === 'notrail' && causeOf(ntr, 1).discarded >= 1, 'l\'errore non cita file del progetto: nessuna traccia (ma sa di aver scartato le librerie)');
  const und = agent('un', 'CLAUDE');
  sh(und.world, 'npx tsc --noEmit', 1000, true, 'src/a.ts(3,1): error TS1005: \';\' expected.');
  ok(sp.causeAt(und.world.steps, 0, { now: 20000 }).cause === 'undecided', 'appena successo, senza passi dopo: in corso');
  const ind = sp.surprises([fol, els], { now: 1e13 }).reactions;
  const fi = ind.find(x => x.id === 'f'), ei = ind.find(x => x.id === 'el');
  ok(fi && fi.follows === 1 && fi.judged === 1 && fi.complete === 1 && fi.chains === 1 && ei && ei.follows === 0 && ei.judged === 1 && ei.complete === 0, 'indicatori: segue la traccia X/Y, catene complete X/Y');
}

// Libro della bottega (C1): chiave del progetto, casi dedotti dai fatti, peso, azioni, salvataggio
// un Libro come lo crea il motore: nello storico (sqlite nella cartella di prova), chiavi senza git.
// stop() chiude anche lo store, così un Libro nuovo sulla stessa cartella rilegge quello che è stato salvato
function storeBook(dir, cwdOf) {
  const { openStore } = require(path.join(__dirname, '..', 'src', 'core', 'store'));
  const { declareCollections } = require(path.join(__dirname, '..', 'src', 'core', 'store', 'collections'));
  const { ProjectKeys } = require(path.join(__dirname, '..', 'src', 'core', 'store', 'project-key'));
  const { Bottega } = require(path.join(__dirname, '..', 'src', 'core', 'bottega'));
  const store = declareCollections(openStore({ backend: 'sqlite', dir: path.join(dir, 'db'), requireFields: true }));
  const book = new Bottega({ store, keys: new ProjectKeys({ store, exec: async () => null }), cwdOf, log() {} });
  const stop = book.stop.bind(book);
  book.stop = () => { stop(); store.close(); };
  return book;
}

function bottegaTests(ok) {
  const bt = require(path.join(ROOT, 'src', 'core', 'bottega'));
  ok(bt.projectKey('C:\\Progetti\\Portale\\') === bt.projectKey('c:/progetti/portale'), 'chiave del progetto: stessa cartella scritta in modi diversi');
  const pat = bt.errorPattern("TypeError: Cannot read properties of undefined (reading 'exp') at src/a.ts:42:7");
  ok(pat === 'TypeError: Cannot read properties of undefined (reading <…>) at <path>:N:N', 'schema d\'errore senza percorsi, numeri e contenuti: ' + pat);
  const sh = (w, cmd, t, err, out) => { const id = 'b' + (++seq); w.start(id, 'Bash', { command: cmd }, t, '/p', 0); w.end(id, err, { content: out }, {}, t + 100, '/p'); };
  const a = agent('a', 'TEST-RUNNER'), b = agent('b', 'CLAUDE');
  // instabile: passa, fallisce, ripassa senza modifiche in mezzo
  sh(a.world, 'npm run test:e2e', 1000, false, 'ok');
  sh(a.world, 'npm run test:e2e', 2000, true, 'FAIL tests/e2e/login.spec.ts');
  sh(a.world, 'npm run test:e2e', 3000, false, 'ok');
  // catena completa: errore che cita refresh.ts, modifica, di nuovo verde
  sh(a.world, 'npm test', 4000, false, 'Tests: 3 passed');
  sh(a.world, 'npm test', 5000, true, "FAIL\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at renew (src/auth/refresh.ts:42:18)");
  act(a.world, 'Edit', 'src/auth/refresh.ts', 6000);
  sh(a.world, 'npm test', 7000, false, 'Tests: 3 passed');
  // trappola: lo stesso comando che fallisce due volte di fila
  sh(b.world, 'npx tsc --noEmit', 1000, true, "src/x.ts(1,1): error TS1005: ';' expected.");
  sh(b.world, 'npx tsc --noEmit', 2000, true, "src/x.ts(1,1): error TS1005: ';' expected.");
  sh(b.world, 'npx tsc --noEmit', 3000, true, "src/x.ts(1,1): error TS1005: ';' expected.");
  // percorso inventato, file conteso (letto da uno, cambiato dall'altro), passo lento
  act(b.world, 'Read', 'src/auth/oldToken.ts', 4000, { err: true, out: 'File does not exist.' });
  act(b.world, 'Read', 'src/auth/refresh.ts', 4500);
  const slowId = 'b' + (++seq);
  b.world.start(slowId, 'Bash', { command: 'npm run build' }, 10000, '/p', 0);
  b.world.end(slowId, false, { content: 'done' }, {}, 10000 + 7 * 60000, '/p');
  const sess = { id: 's1', cwd: '/p', kind: 'code' };
  const recent = Date.now() - 3 * 86400000; // i passi finti partono dal 1970: li spostiamo a tre giorni fa
  const cases = bt.digest(sess, [a, b]).map(c => ({ ...c, t: recent + c.t }));
  const kinds = new Set(cases.map(c => c.kind));
  for (const k of bt.KINDS) ok(kinds.has(k), `dai fatti della sessione: ${k}`);
  ok(cases.some(c => c.kind === 'known-fix' && /→ src\/auth\/refresh\.ts$/.test(c.key)), 'correzione nota: schema d\'errore → file corretto');
  ok(cases.some(c => c.kind === 'loop-trap' && c.key === 'npx tsc --noEmit'), 'trappola: il comando intero, non la sua etichetta');
  // il libro, in una cartella temporanea
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-bottega-'));
  try {
    const book = storeBook(dir);
    const n1 = book.learn('/p', cases);
    ok(n1 === cases.length && book.learn('/p', cases) === 0, 'gli stessi casi non contano due volte');
    const cases2 = bt.digest({ id: 's2', cwd: '/p', kind: 'code' }, [a, b]).map(c => ({ ...c, sid: 's2', t: recent + c.t + 86400000 }));
    book.learn('/p', cases2);
    let v = book.view('/p');
    const flaky = v.lessons.find(l => l.kind === 'flaky-command');
    ok(flaky && flaky.sessions.length === 2 && flaky.level === 'lesson' && /npm run test:e2e/.test(flaky.title), `lezione da due sessioni: «${flaky && flaky.title}» (peso ${flaky && flaky.weight})`);
    const once = storeBook(dir);
    once.learn('/q', [{ kind: 'ghost-path', key: 'src/old.ts', sid: 'x', t: Date.now(), agent: 'A', excerpt: '' }]);
    ok(once.view('/q').lessons[0].level === 'observation', 'un caso solo resta un\'osservazione');
    const l0 = { count: 4, sessions: ['a', 'b'], last: Date.now() - 60 * 86400000, pinned: false };
    ok(Math.abs(bt.weightOf(l0) - bt.weightOf({ ...l0, last: Date.now() }) / 4) < 0.01, 'il peso si dimezza ogni 30 giorni');
    ok(bt.weightOf({ ...l0, pinned: true }) === bt.weightOf({ ...l0, last: Date.now() }), 'una lezione fissata non sbiadisce');
    ok(book.act('/p', 'pin', flaky.id) && book.view('/p').lessons[0].id === flaky.id, 'fissata: va in cima');
    ok(book.act('/p', 'ignore', flaky.id) && book.view('/p').lessons.find(l => l.id === flaky.id).ignored, 'ignorata');
    const ghost = v.lessons.find(l => l.kind === 'ghost-path');
    ok(book.act('/p', 'forget', ghost.id) && !book.view('/p').lessons.some(l => l.id === ghost.id), 'dimenticata');
    ok(!book.act('/p', 'boh', flaky.id), 'azione sconosciuta: rifiutata');
    book.stop(); once.stop();
    const again = storeBook(dir);
    v = again.view('/p');
    ok(v.lessons.length > 0 && v.lessons.length === book.view('/p').lessons.length, `salvato su disco e riletto (${v.lessons.length} lezioni)`);
    ok(v.lessons.find(l => l.id === flaky.id).ignored && !v.lessons.some(l => l.id === ghost.id), 'riletto con fissate, ignorate e dimenticate');
    ok(again.store.collection('lessons').count({ project: bt.projectKey('/p') }) === v.lessons.length && !fs.readdirSync(dir).some(f => f.endsWith('.json')), 'nello storico: una lezione per documento, sotto la chiave del progetto; nessun file per progetto');
    again.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// il Nonno (C2): l'azione in corso di un agente contro le lezioni forti del libro
function elderTests(ok) {
  const bt = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const now = Date.now();
  const ev = (k, i) => ({ sid: 's' + i, t: now - (3 - i) * 86400000, agent: 'EXPLORE', excerpt: '' });
  const lesson = (kind, key, extra = {}) => ({ id: kind, kind, key, count: 3, sessions: ['s1', 's2'], first: now - 3 * 86400000, last: now - 86400000, evidence: [ev(kind, 1), ev(kind, 2)], pinned: false, ignored: false, weight: 3, level: 'lesson', ...extra });
  const lessons = [
    lesson('flaky-command', 'npm run test:e2e'),
    lesson('ghost-path', 'src/auth/oldToken.ts'),
    lesson('known-fix', "TypeError: Cannot read properties of undefined (reading <…>) → src/auth/refresh.ts"),
    lesson('slow-step', 'npm run build', { level: 'observation' }),
    lesson('fragile-file', 'src/db/pool.ts', { ignored: true }),
  ];
  const a = agent('a', 'TEST-RUNNER'), b = agent('b', 'EXPLORE'), c = agent('c', 'CLAUDE'), d = agent('d', 'BUILDER'), e = agent('e', 'DB');
  a.world.start('h1', 'Bash', { command: 'npm run test:e2e' }, now - 2000, '/p', 0);                     // in corso
  act(b.world, 'Read', 'src/auth/oldToken.ts', now - 5000, { err: true, out: 'File does not exist.' }); // appena finita
  c.world.start('h3', 'Bash', { command: 'npm test' }, now - 4000, '/p', 0);
  c.world.end('h3', true, { content: "FAIL\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at renew (src/auth/refresh.ts:42:18)" }, {}, now - 3000, '/p');
  d.world.start('h4', 'Bash', { command: 'npm run build' }, now - 1000, '/p', 0);                        // solo un'osservazione
  act(e.world, 'Edit', 'src/db/pool.ts', now - 1000);                                                     // lezione ignorata
  const h = bt.hints({ id: 's' }, [a, b, c, d, e], lessons, now);
  const by = id => h.find(x => x.agent === id);
  ok(by('a') && by('a').kind === 'flaky-command' && /npm run test:e2e/.test(by('a').text) && /3/.test(by('a').text), 'Nonno: sta per lanciare un comando instabile — «' + (by('a') && by('a').text) + '»');
  ok(by('b') && by('b').kind === 'ghost-path', 'Nonno: cerca un percorso che non esiste');
  ok(by('c') && by('c').kind === 'known-fix' && /EXPLORE/.test(by('c').text) && /refresh\.ts/.test(by('c').text), 'Nonno: errore già sistemato — «' + (by('c') && by('c').text) + '»');
  ok(!by('d') && !by('e'), 'Nonno: niente per le osservazioni e per le lezioni ignorate');
  const old = agent('o', 'OLD');
  act(old.world, 'Read', 'src/auth/oldToken.ts', now - 120000, { err: true, out: 'File does not exist.' });
  ok(!bt.hints({ id: 's' }, [old], lessons, now).length, 'Nonno: un\'azione finita da più di 30 s non conta');
  // lo stesso comando scritto in un altro modo: cartella, variabili, redirezioni e pipe non contano
  const flaky = [lesson('flaky-command', 'cd /d/app && CI=1 npm test 2>&1 | tail -20')];
  const run = (cmd, i) => { const x = agent('r' + i, 'R' + i); x.world.start('hr' + i, 'Bash', { command: cmd }, now - 1000, '/p', 0); return x; };
  const same = ['npm test', 'cd /x && npm test > out.txt 2>&1', 'NODE_ENV=test npm test | head -5', 'npm test -- --grep auth'].map(run);
  const other = ['npm testing', 'npm run test:e2e', 'npm', 'git status'].map((c, i) => run(c, i + 10));
  const hs = bt.hints({ id: 's' }, [...same, ...other], flaky, now);
  ok(hs.length === same.length && same.every(x => hs.some(y => y.agent === x.id)), 'Nonno: riconosce «npm test» scritto in quattro modi diversi (' + hs.map(y => y.agent).join(',') + ')');
  // l'interruttore dell'apprendimento
  const { OfficeState, DEFAULT_SETTINGS } = require(path.join(ROOT, 'src', 'core', 'state'));
  ok(DEFAULT_SETTINGS.elderEnabled === true && DEFAULT_SETTINGS.bottegaLearn === true, 'opzioni: Nonno e apprendimento accesi di base');
  const st = new OfficeState({});
  st.setSettings({ bottegaLearn: false, elderEnabled: false });
  ok(st.settings.bottegaLearn === false && st.settings.elderEnabled === false, 'opzioni: si spengono');
  // C4: la sezione per il CLAUDE.md
  const md = bt.renderSection([
    { ...lessons[0], weight: 2 }, { ...lessons[1], weight: 5 }, { ...lessons[2], weight: 1, pinned: true },
    lessons[3], lessons[4],
  ], 'portale-clienti');
  const rows = md.split('\n').filter(l => l.startsWith('- '));
  ok(/^## .*portale-clienti/.test(md) && rows.length === 3, `CLAUDE.md: titolo e tre lezioni (niente osservazioni né ignorate)\n${md}`);
  ok(/refresh\.ts/.test(rows[0]) && /oldToken\.ts/.test(rows[1]) && /test:e2e/.test(rows[2]), 'CLAUDE.md: prima le fissate, poi per peso');
  ok(bt.renderSection([lessons[3]], 'x') === '', 'CLAUDE.md: senza lezioni forti non c\'è niente da proporre');
  const many = Array.from({ length: 12 }, (_, i) => ({ ...lessons[1], id: 'g' + i, key: 'src/x' + i + '.ts' }));
  ok(bt.renderSection(many, 'x').split('\n').filter(l => l.startsWith('- ')).length === 8, 'CLAUDE.md: al massimo 8 lezioni');
}

// i comandi di shell che scrivono: sed -i, cp, mv (solo la destinazione è modificata)
function shellWriteTests(ok) {
  const sh = (cmd) => { const w = new AgentWorld(); const id = 'c' + (++seq); w.start(id, 'Bash', { command: cmd }, 1000, '', 0); w.end(id, false, { content: '' }, {}, 1100, ''); return w; };
  const ed = (w, k) => !!(w.nodes.get(k) && w.nodes.get(k).edit), seen = (w, k) => !!(w.nodes.get(k) && w.nodes.get(k).seen);
  let w = sh("sed -i 's/getUser/fetchUser/g' src/api.ts");
  ok(ed(w, 'src/api.ts'), 'sed -i: il file risulta modificato');
  w = sh("sed -n 's/a/b/p' src/api.ts");
  ok(seen(w, 'src/api.ts') && !ed(w, 'src/api.ts'), 'sed senza -i: solo visto');
  w = sh("sed -n '1,20p' src/api.ts | grep -i foo");
  ok(seen(w, 'src/api.ts') && !ed(w, 'src/api.ts'), 'sed in sola lettura seguito da grep -i: il -i non è suo, solo visto');
  w = sh("sed -i 's/a/b/' src/api.ts && cat src/other.ts");
  ok(ed(w, 'src/api.ts') && seen(w, 'src/other.ts') && !ed(w, 'src/other.ts'), 'sed -i in una catena: modificato solo il suo file');
  w = sh('cp src/a.ts src/b.ts');
  ok(ed(w, 'src/b.ts') && seen(w, 'src/a.ts') && !ed(w, 'src/a.ts'), 'cp: modificata la destinazione, la sorgente solo vista');
  w = sh('mv src/a.ts src/b.ts');
  ok(ed(w, 'src/b.ts') && seen(w, 'src/a.ts') && !ed(w, 'src/a.ts'), 'mv: modificata la destinazione, la sorgente solo vista');
  w = sh('cd src && cp a.ts b.ts && cat c.ts');
  ok(ed(w, 'src/b.ts') && !ed(w, 'src/a.ts') && !ed(w, 'src/c.ts'), 'cp in una catena: conta solo il suo segmento');
  w = sh('rm src/a.ts src/b.ts');
  ok(ed(w, 'src/a.ts') && ed(w, 'src/b.ts'), 'rm: tutti i percorsi modificati come prima');
  w = sh('node gen.js > out.txt');
  ok(ed(w, 'out.txt'), 'redirezione: come prima');
}

// le espressioni di sed/perl/awk non sono cartelle del progetto
function sedExpressionTests(ok) {
  const placesOf = (cmd) => { const w = new AgentWorld(); const id = 'c' + (++seq); w.start(id, 'Bash', { command: cmd }, 1000, '', 0); w.end(id, false, { content: '' }, {}, 1100, ''); return [...w.nodes.keys()].filter(k => !k.startsWith('cmd:')).join(','); };
  ok(placesOf('sed -i "s/old/new/" src/api.ts') === 'src/api.ts', 'sed "s/old/new/": non è un luogo: ' + placesOf('sed -i "s/old/new/" src/api.ts'));
  ok(placesOf("sed -i 's/old value/new value/g' src/api.ts") === 'src/api.ts', 'sed con spazi nell\'espressione: nessun luogo inventato: ' + placesOf("sed -i 's/old value/new value/g' src/api.ts"));
  ok(placesOf("sed -e 'y/abc/xyz/' -e '/^#/d' src/api.ts") === 'src/api.ts', 'sed y/// e /x/d: nessun luogo');
  ok(placesOf("perl -pe 's/a b/c d/' src/api.ts") === 'src/api.ts', 'perl -pe: nessun luogo');
  ok(placesOf("awk '/foo/' src/api.ts") === 'src/api.ts', 'awk /x/: nessun luogo');
  ok(placesOf('sed -i s/getUser/fetchUser/g src/api.ts') === 'src/api.ts', 'sed senza virgolette: nessun luogo inventato: ' + placesOf('sed -i s/getUser/fetchUser/g src/api.ts'));
  ok(placesOf('cat s/old/new/ src/api.ts').includes('s/old/new'), 'fuori da sed, s/old/new/ resta un percorso');
  ok(placesOf('ls "src/mydir/"') === 'src/mydir', 'una cartella tra virgolette resta una cartella: ' + placesOf('ls "src/mydir/"'));
  ok(placesOf('sed -i "s/a/b/" "src/mydir/"') === 'src/mydir', 'cartella vera accanto a un\'espressione sed');
}

// il nome del progetto nel libro e nel CLAUDE.md conserva le maiuscole (la chiave no)
function bottegaNameTests(ok) {
  const bt = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-bname-'));
  try {
    const b1 = storeBook(dir);
    const win = 'C:\\Users\\me\\MyShop';
    const les = { kind: 'ghost-path', key: 'src/old.ts', sid: 'x', t: Date.now(), agent: 'A', excerpt: '' };
    b1.learn(win, [les]);
    ok(b1.view(win).name === 'MyShop', 'nome del libro: ' + b1.view(win).name);
    ok(b1.view('C:\\Users\\me\\MyShop\\').name === 'MyShop' && b1.view('C:/Users/me/MyShop/').name === 'MyShop', 'nome: barre finali e / o \\ uguali');
    ok(bt.renderSection([{ level: 'lesson', pinned: true, weight: 1, kind: 'ghost-path', key: 'a.ts' }], b1.view(win).name).includes('(MyShop)'), 'titolo del CLAUDE.md con le maiuscole');
    b1.stop();
    // un libro già salvato col nome in minuscolo: alla prossima apertura prende quello giusto
    const K = bt.projectKey(win);
    const b2 = storeBook(dir, key => (key === K ? win : ''));
    b2.store.collection('projects').patch(K, { name: 'myshop' });
    ok(b2.list()[0].name === 'myshop', 'elenco: il nome vecchio finché non si apre con la cartella');
    const v = b2.view(win);
    ok(v.name === 'MyShop' && v.lessons.length === 1 && v.key === bt.projectKey(win), 'libro vecchio: nome corretto, stessa chiave, lezioni intatte');
    b2.stop();
    const b3 = storeBook(dir);
    ok(b3.store.collection('projects').get(K).name === 'MyShop', 'il nome corretto viene salvato');
    b3.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// 2.14, R1: il classificatore del rischio contro la tabella di scripts/risk-cases.js
function riskCase([level, cmd, rule, o = {}]) {
  const risk = require(path.join(ROOT, 'src', 'core', 'risk'));
  const root = o.win ? 'D:/dev/app' : '/home/u/proj', home = o.win ? 'C:/Users/u' : '/home/u';
  return risk.classify({
    tool: o.tool || (o.ps ? 'PowerShell' : 'Bash'), input: o.input || { command: cmd },
    cwd: o.cwd || root, root, home, branch: o.branch,
    fileState: o.state ? () => o.state : undefined, ...(o.turn || {}),
  });
}
function riskTests(ok) {
  const risk = require(path.join(ROOT, 'src', 'core', 'risk'));
  const { CASES } = require('./risk-cases');
  let wrong = 0;
  for (const c of CASES) {
    const r = riskCase(c), [level, cmd, rule, o = {}] = c;
    const good = r.level === level && (!rule || r.ruleIds.includes(rule)) && (level > 0 || r.ruleIds.length === 0);
    if (!good) { wrong++; ok(false, `rischio: «${cmd || o.tool}» atteso ${level}${rule ? ' ' + rule : ''}, trovato ${r.level} ${r.ruleIds.join(',')}`); }
  }
  ok(CASES.length >= 150 && wrong === 0, `rischio: ${CASES.length} comandi della tabella, ognuno al suo livello e con la sua regola (${wrong} sbagliati)`);
  const levels = [0, 1, 2, 3].map(l => CASES.filter(c => c[0] === l).length);
  ok(levels.every(n => n >= 15), 'rischio: la tabella copre tutti i livelli (0–3: ' + levels.join(', ') + ')');

  // il risultato: forma senza argomenti, bersaglio relativo al progetto, prudenze, come si torna indietro
  const r = riskCase([2, 'git reset --hard origin/feature-secret-name']);
  ok(r.shape === 'git reset --hard <ref>' && !JSON.stringify(r).includes('secret-name'), 'rischio: del comando resta la forma, mai gli argomenti');
  ok(r.category === 'git' && r.reach === 'project' && r.prudence.includes('backup') && r.prudence.includes('looked') && /reflog/.test(r.undo) && r.reasons.length === 1, 'rischio: categoria, portata, prudenze che contano e come tornare indietro');
  const rm = riskCase([2, 'rm -rf /home/u/proj/data/export']);
  ok(rm.targets.join() === 'data/export' && rm.undo === '', 'rischio: il bersaglio è relativo al progetto; senza rimedio, undo è vuoto');
  const out = riskCase([3, 'rm -rf /home/u/Documents/private-folder']);
  ok(out.level === 3 && out.targets.length === 0 && !JSON.stringify(out).includes('private-folder'), 'rischio: un percorso fuori dal progetto non viene riportato');
  const two = riskCase([3, 'git reset --hard && git push --force origin main']);
  ok(two.level === 3 && two.ruleIds.slice(0, 2).sort().join() === 'git-push-force-shared,git-push-main' && two.ruleIds[2] === 'git-reset-hard' && two.reach === 'remote', 'rischio: più regole insieme, le più gravi per prime');
  const en = require(path.join(ROOT, 'src', 'i18n')).withLang('en', () => riskCase([2, 'git clean -fd']));
  ok(/deletes the files git does not know/.test(en.reasons[0]), 'rischio: i testi sono tradotti in inglese');
  ok(Object.values(risk.RULES).every(x => x.level >= 1 && x.level <= 3 && typeof x.text() === 'string' && Array.isArray(x.prudence) && x.prudence.length), 'rischio: ogni regola ha livello, testo e prudenze');
  // segni per chi chiama: ha letto segreti, ha chiamato la rete
  ok(riskCase([0, 'cat ~/.aws/credentials']).marks.readsSecret && riskCase([0, 'curl https://example.com']).marks.network && !riskCase([0, 'ls']).marks.network, 'rischio: segna la lettura di segreti e le chiamate di rete');
  ok(riskCase([0, '', '', { tool: 'Read', input: { file_path: '/home/u/.ssh/id_ed25519' } }]).marks.readsSecret, 'rischio: anche lo strumento Read segna la lettura di segreti');
  // non lancia mai eccezioni, nemmeno con input rotti
  let threw = 0;
  for (const bad of [undefined, null, {}, { tool: 'Bash' }, { tool: 'Bash', input: { command: 42 } }, { tool: 'Bash', input: { command: 'rm -rf "unclosed' } }, { tool: 'Bash', input: { command: 'cat <<EOF\nnever closed' } }, { tool: 'Bash', input: { command: '$((((' } }, { tool: 'Write', input: {} }, { tool: 'mcp__x', input: 'text' }]) {
    try { const x = risk.classify(bad); if (typeof x.level !== 'number') threw++; } catch { threw++; }
  }
  ok(threw === 0, 'rischio: input rotti o vuoti non fanno eccezioni');
  // tempo: p99 sotto 20 ms (in pratica molto meno), anche con un comando lunghissimo
  const times = [];
  for (let k = 0; k < 20; k++) for (const c of CASES) { const t0 = process.hrtime.bigint(); riskCase(c); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  times.sort((a, b) => a - b);
  const p99 = times[Math.floor(times.length * 0.99)];
  ok(p99 < 20, `rischio: ${times.length} classificazioni, p99 ${p99.toFixed(3)} ms (limite 20)`);
  const t0 = process.hrtime.bigint();
  risk.classify({ tool: 'Bash', input: { command: ('echo "$(date)" && ls -la | grep x; ').repeat(5000) + 'rm -rf ~/x' }, cwd: '/home/u/proj', root: '/home/u/proj', home: '/home/u' });
  const big = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(big < 20, `rischio: un comando di 200 mila caratteri si ferma al limite e risponde in ${big.toFixed(1)} ms`);
}

// 2.14, R2: la prudenza prima di un'azione rischiosa
function prudenceTests(ok) {
  const risk = require(path.join(ROOT, 'src', 'core', 'risk'));
  const { assess, missedFear, gitStatusClean } = require(path.join(ROOT, 'src', 'core', 'prudence'));
  const root = '/home/u/proj';
  let k = 0;
  const run = (cmd, extra = {}) => ({ t: ++k, tool: 'Bash', act: 'run', target: 'cmd:x', sig: 'run:' + cmd, err: false, ...extra });
  const read = file => ({ t: ++k, tool: 'Read', act: 'read', target: file, sig: 'Read:' + file, err: false });
  const edit = file => ({ t: ++k, tool: 'Edit', act: 'edit', target: file, sig: 'Edit:' + file, err: false });
  const go = (cmd, steps = [], prompt = '', o = {}) => {
    const action = { tool: o.tool || 'Bash', input: o.input || { command: cmd } };
    const r = risk.classify({ ...action, cwd: root, root, home: '/home/u', ...o.ctx });
    const p = assess({ risk: r, action, steps, prompt });
    return { r, p, missed: missedFear(r, p) };
  };
  const has = (x, kind) => x.p.present.includes(kind);

  // senza niente prima: paura mancata
  let x = go('git reset --hard');
  ok(x.r.level === 2 && x.p.score === 0 && x.missed && x.p.missing.join() === 'looked,backup,clean,asked', 'prudenza: git reset --hard senza niente prima è una paura mancata, e dice che cosa manca');
  // guardare da solo non basta
  x = go('git reset --hard', [run('git status')]);
  ok(has(x, 'looked') && x.p.score === 0.3 && x.missed, 'prudenza: aver guardato (git status) conta, ma da solo non basta');
  x = go('git reset --hard', [run('ls -la')]);
  ok(!has(x, 'looked'), 'prudenza: per git, un ls non è aver guardato');
  // copia di sicurezza
  for (const b of ['git commit -m "wip"', 'git add -A && git commit -m wip', 'git stash', 'git stash push -u', 'git branch backup-1', 'git checkout -b safe', 'git tag before-reset']) {
    x = go('git reset --hard', [run(b)]);
    ok(has(x, 'backup') && !x.missed, 'prudenza: copia di sicurezza con «' + b + '»');
  }
  for (const b of ['git commit --amend', 'git stash drop', 'git stash pop', 'git branch -D x', 'git tag -d v1', 'git stash list']) {
    x = go('git reset --hard', [run(b)]);
    ok(!has(x, 'backup'), 'prudenza: «' + b + '» non è una copia di sicurezza');
  }
  x = go('git reset --hard', [run('git commit -m wip', { err: true })]);
  ok(!has(x, 'backup') && x.missed, 'prudenza: un commit fallito non è una copia di sicurezza');
  x = go('git reset --hard', [run('git commit -m wip'), ...Array.from({ length: 12 }, (_, i) => run('echo ' + i))]);
  ok(!has(x, 'backup'), 'prudenza: un commit di più di 12 azioni fa non conta più');
  // albero pulito
  x = go('git reset --hard', [run('git status', { act: 'look', clean: true })]);
  ok(has(x, 'clean') && has(x, 'looked') && x.p.score === 1 && !x.missed, 'prudenza: albero pulito all\'ultimo git status');
  x = go('git reset --hard', [run('git status', { act: 'look', clean: true }), edit('src/a.js')]);
  ok(!has(x, 'clean'), 'prudenza: dopo una modifica l\'albero non è più pulito');
  x = go('git reset --hard', [run('git status', { act: 'look', clean: false })]);
  ok(!has(x, 'clean') && x.missed, 'prudenza: albero sporco, niente prudenza "pulito"');
  ok(gitStatusClean('git status', 'On branch main\nnothing to commit, working tree clean') === true && gitStatusClean('git status', 'Changes not staged for commit:\n  modified: a.js') === false &&
    gitStatusClean('git status --porcelain', '') === true && gitStatusClean('git status --short', ' M a.js') === false && gitStatusClean('git status', 'nothing added to commit but untracked files present') === false &&
    gitStatusClean('git log', 'nothing to commit') === null && gitStatusClean('git status', 'fatal: not a git repository') === null, 'prudenza: l\'output di git status dice pulito, sporco o non si sa');
  // il segno arriva dalla mappa: la prova passa da worldmap.js
  {
    const w = new AgentWorld();
    w.start('g1', 'Bash', { command: 'git status' }, 1000, root, 0);
    w.end('g1', false, { content: 'On branch main\nnothing to commit, working tree clean' }, {}, 1100, root);
    w.start('g2', 'Bash', { command: 'git status --short' }, 2000, root, 0);
    w.end('g2', false, { content: ' M src/a.js' }, {}, 2100, root);
    ok(w.steps[0].clean === true && w.steps[1].clean === false && !JSON.stringify(w.steps).includes('nothing to commit'), 'prudenza: la mappa segna pulito/sporco sul passo di git status, senza tenere l\'output');
  }
  // prova a vuoto
  x = go('git clean -fd', [run('git clean -n')]);
  ok(has(x, 'dryrun') && !x.missed, 'prudenza: git clean -n prima di git clean -fd');
  x = go('terraform apply', [run('terraform plan -out=tfplan')]);
  ok(has(x, 'dryrun') && has(x, 'looked') && x.r.level === 3 && !x.missed, 'prudenza: terraform plan prima di apply');
  x = go('terraform apply', [run('kubectl get pods --dry-run=client')]);
  ok(!has(x, 'dryrun') && x.missed, 'prudenza: la prova a vuoto di un altro strumento non conta');
  x = go('npm publish', [run('npm publish --dry-run')]);
  ok(has(x, 'dryrun'), 'prudenza: npm publish --dry-run prima di npm publish');
  x = go('kubectl delete -f k8s/', [run('kubectl delete -f k8s/ --dry-run=server')]);
  ok(has(x, 'dryrun'), 'prudenza: kubectl delete --dry-run prima');
  // guardare il bersaglio, sui file
  x = go('rm -rf data/export', [run('ls data/export')]);
  ok(has(x, 'looked') && x.missed, 'prudenza: ls del bersaglio prima di cancellarlo (da solo non basta)');
  x = go('rm -rf data/export', [run('ls src/other')]);
  ok(!has(x, 'looked'), 'prudenza: guardare un\'altra cartella non conta');
  x = go('rm -rf data/export', [read('data/export/a.csv')]);
  ok(has(x, 'looked'), 'prudenza: aver letto un file del bersaglio conta');
  x = go('rm -rf data/export', [run('cp -r data/export /tmp/export-bak')]);
  ok(has(x, 'backup') && !x.missed, 'prudenza: una copia del bersaglio è una copia di sicurezza');
  x = go('rm -rf data/export', [run('cp -r src/other /tmp/x')]);
  ok(!has(x, 'backup'), 'prudenza: la copia di un\'altra cartella non conta');
  x = go('rm -rf data/export', [run('git add -A && git commit -m "before cleanup"')]);
  ok(has(x, 'backup'), 'prudenza: un commit prima di cancellare');
  // database
  x = go('psql -c "DELETE FROM users"', [run('psql -c "SELECT count(*) FROM users"')]);
  ok(has(x, 'looked') && x.missed, 'prudenza: un SELECT sulla stessa tabella prima del DELETE');
  x = go('psql -c "DELETE FROM users"', [run('psql -c "SELECT count(*) FROM orders"')]);
  ok(!has(x, 'looked'), 'prudenza: un SELECT su un\'altra tabella non conta');
  x = go('psql -c "DROP TABLE users"', [run('pg_dump app > /tmp/app.sql')]);
  ok(has(x, 'backup') && !x.missed, 'prudenza: pg_dump prima di un DROP');
  x = go('psql -c "DROP TABLE users"', [run('git commit -m wip')]);
  ok(!has(x, 'backup'), 'prudenza: un commit non salva un database');
  // l'ha chiesto l'utente (probabile)
  x = go('git reset --hard origin/main', [], 'butta tutto e fai un reset hard a origin/main');
  ok(has(x, 'asked') && x.p.probable.join() === 'asked' && !x.missed, 'prudenza: l\'utente ha chiesto il reset (probabile)');
  x = go('git push --force origin main', [], 'please force push to main');
  ok(has(x, 'asked') && x.r.level === 3, 'prudenza: l\'utente ha chiesto il force push su main');
  x = go('git push --force origin main', [], 'sistema il test che fallisce');
  ok(!has(x, 'asked') && x.missed, 'prudenza: un messaggio che parla d\'altro non è una richiesta');
  x = go('rm -rf data/export', [], 'cancella la cartella export, non serve più');
  ok(has(x, 'asked'), 'prudenza: l\'utente ha chiesto di cancellare proprio quella cartella');
  x = go('rm -rf data/export', [], 'cancella i file temporanei');
  ok(!has(x, 'asked'), 'prudenza: ha chiesto di cancellare, ma un\'altra cosa');
  x = go('terraform apply -auto-approve', [], 'ok, run terraform apply');
  ok(has(x, 'asked'), 'prudenza: l\'utente ha scritto proprio il comando');
  x = go('psql -c "DROP TABLE users"', [], 'elimina la tabella users dal database di prova');
  ok(has(x, 'asked'), 'prudenza: l\'utente ha chiesto di eliminare quella tabella');
  x = go('', [], 'manda la mail a Fabio con il riassunto', { tool: 'mcp__gmail__send_message', input: { to: 'x' } });
  ok(x.r.level === 3 && has(x, 'asked') && !x.missed, 'prudenza: uno strumento esterno che manda, chiesto dall\'utente');
  x = go('', [], 'riassumi le mail di oggi', { tool: 'mcp__gmail__send_message', input: { to: 'x' } });
  ok(!has(x, 'asked') && x.missed, 'prudenza: mandare una mail quando l\'utente ha chiesto solo di leggere è una paura mancata');
  x = go('sudo apt-get install -y jq', [run('git status'), run('git commit -m wip')], '');
  ok(x.p.present.length === 0 && x.p.missing.join() === 'asked', 'prudenza: contano solo le prudenze che la regola dichiara (per sudo, solo la richiesta)');
  // azioni non rischiose e input rotti
  x = go('ls -la');
  ok(x.p.score === 1 && !x.missed && x.p.missing.length === 0, 'prudenza: un\'azione non rischiosa non ha niente da farsi perdonare');
  let threw = 0;
  for (const bad of [undefined, {}, { risk: null }, { risk: { level: 2 } }, { risk: { level: 2, prudence: ['looked'] }, steps: [null, {}, { sig: 5 }], prompt: 7 }]) { try { const r = assess(bad); if (typeof r.score !== 'number') threw++; } catch { threw++; } }
  ok(threw === 0, 'prudenza: input rotti o vuoti non fanno eccezioni');
  ok(!JSON.stringify(go('git reset --hard', [], 'il mio segreto è 12345, fai reset hard').p).includes('12345'), 'prudenza: del messaggio dell\'utente non resta niente nel risultato');
}

// 2.14, R3: le azioni rischiose dal transcript allo storico (fear.js, state.js, history.js)
async function fearStoreTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const { History } = require(path.join(ROOT, 'src', 'core', 'history'));
  const fear = require(path.join(ROOT, 'src', 'core', 'fear'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-fear-'));
  const iso = t => new Date(t).toISOString();
  let now = Date.parse('2026-11-19T10:00:00Z');
  const st = new OfficeState({ clock: () => now, settings: {} });
  const h = new History({ dir: path.join(tmp, 'dati'), backend: 'memory', log() {} });
  h.keys.exec = async () => null;
  st.on('step', (s, a, step) => h.recordStep(s, a, step));
  st.on('risk', (s, a, step) => h.recordRisk(s, a, step));
  const S = 'sess-fear-0001', cwd = '/home/u/proj';
  let n = 0, branch = 'feature/login';
  const line = (type, content, extra = {}) => ({ type, timestamp: iso(now += 1000), cwd, gitBranch: branch, message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + (++n), usage: { input_tokens: 1, output_tokens: 1 } } : {}) }, ...extra });
  const use = (id, name, input) => st.applyTranscriptLine(S, null, line('assistant', [{ type: 'tool_use', id, name, input }]));
  const res = (id, content = 'ok', isErr = false) => st.applyTranscriptLine(S, null, line('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isErr }]));
  const bash = (id, command, out) => { use(id, 'Bash', { command }); res(id, out); };
  try {
    st.applyTranscriptLine(S, null, line('user', 'sistema il test del login che fallisce'));
    bash('t1', 'npm test', 'ok');
    bash('t2', 'git reset --hard origin/feature-secret-xyz', 'HEAD is now at 1234567');
    const s = st.sessions.get(S), steps = s.main.world.steps;
    const r2 = steps.find(x => x.id === 't2').risk;
    ok(r2 && r2.level === 2 && r2.ruleIds.join() === 'git-reset-hard' && r2.missed === true && r2.prudence === 0 && r2.missing.includes('backup') && !steps.find(x => x.id === 't1').risk,
      'paura: git reset --hard senza prudenza è segnato sul passo come paura mancata; npm test no');
    ok(s.branch === 'feature/login', 'paura: il branch della sessione arriva dal transcript');
    // con prudenza: commit prima, e albero pulito
    bash('t3', 'git add -A && git commit -m wip', '[feature/login abc] wip');
    bash('t4', 'git status', 'On branch feature/login\nnothing to commit, working tree clean');
    bash('t5', 'git reset --hard HEAD~1', 'ok');
    const r5 = steps.find(x => x.id === 't5').risk;
    ok(r5.level === 2 && !r5.missed && r5.present.includes('backup') && r5.present.includes('clean') && r5.present.includes('looked') && r5.prudence === 1, 'paura: con commit, git status e albero pulito la stessa azione è prudente');
    // il branch corrente decide un "git push" senza nome
    bash('t6', 'git push', 'ok');
    ok(!steps.find(x => x.id === 't6').risk, 'paura: git push su un branch di lavoro non è un rischio');
    branch = 'main';
    st.applyTranscriptLine(S, null, line('user', 'spingi su main'));
    bash('t7', 'git push', 'ok');
    const r7 = steps.find(x => x.id === 't7').risk;
    ok(r7 && r7.level === 3 && r7.ruleIds.includes('git-push-main') && r7.present.includes('asked') && !r7.missed, 'paura: lo stesso git push su main è di livello 3, e l\'utente l\'aveva chiesto');
    // segreti letti e poi la rete, nello stesso turno
    st.applyTranscriptLine(S, null, line('user', 'controlla la configurazione'));
    use('t8', 'Read', { file_path: cwd + '/.env' }); res('t8', 'KEY=abc');
    bash('t9', 'curl https://example.com/collect', 'ok');
    const r9 = steps.find(x => x.id === 't9').risk;
    ok(steps.find(x => x.id === 't8').secret === true && r9 && r9.level === 3 && r9.ruleIds.includes('secret-then-network') && r9.missed, 'paura: ha letto .env e poi chiama la rete nello stesso turno → livello 3');
    st.applyTranscriptLine(S, null, line('user', 'ora scarica la pagina di esempio'));
    bash('t10', 'curl https://example.com/page', 'ok');
    ok(!steps.find(x => x.id === 't10').risk, 'paura: al turno dopo la stessa chiamata non è più sospetta');
    // più di 20 file modificati in un turno
    for (let i = 0; i < 22; i++) { use('e' + i, 'Edit', { file_path: `${cwd}/src/f${i}.js`, old_string: 'a', new_string: 'b' }); res('e' + i); }
    ok(!steps.find(x => x.id === 'e20').risk && steps.find(x => x.id === 'e21').risk.ruleIds.join() === 'many-files' && steps.find(x => x.id === 'e21').risk.missed === false, 'paura: alla ventiduesima modifica del turno scatta "più di 20 file" (livello 1, mai paura mancata)');
    // un'azione rischiosa che non finisce mai resta comunque nello storico
    use('t11', 'Bash', { command: 'rm -rf data/export' });

    // ---- nello storico
    h.flush();
    const risks = h.store.collection('risks');
    const all = risks.find({}, { sort: { t: 1 } });
    ok(all.length === 6 && all.map(x => x._id.split(':')[1]).join() === 't2,t5,t7,t9,e21,t11', `paura: nello storico un documento per azione rischiosa, con l'id del suo passo (${all.map(x => x._id.split(':')[1]).join()})`);
    const d2 = risks.get(S + ':t2'), d11 = risks.get(S + ':t11');
    ok(d2.level === 2 && d2.missed === true && d2.shape === 'git reset --hard <ref>' && d2.session === S && d2.agent === 'main' && d2.tool === 'Bash' && /^[0-9a-f]{16}$/.test(d2.project) && d2.missing.join() === 'looked,backup,clean,asked', 'paura: il documento ha regola, livello, forma, prudenze mancanti e progetto');
    ok(d11 && d11.target === 'data/export' && d11.level === 2, 'paura: il bersaglio dentro il progetto è relativo; un\'azione mai finita è salvata lo stesso');
    const raw = JSON.stringify(h.store.collection('risks').find({})) + JSON.stringify(h.store.collection('steps').find({}));
    ok(!/feature-secret-xyz|example\.com|KEY=abc|sistema il test|spingi su main/.test(raw), 'paura: nello storico non c\'è il comando, né l\'output, né il messaggio dell\'utente');
    // rileggere la sessione (a ogni avvio) non raddoppia e non cancella com'è finita
    risks.patch(S + ':t2', { outcome: 'damage', at: now });
    h.recordRisk(s, s.main, steps.find(x => x.id === 't2'));
    h.flush();
    ok(risks.count({}) === 6 && risks.get(S + ':t2').outcome === 'damage', 'paura: riscrivere lo stesso evento non lo raddoppia e non cancella l\'esito');
    // la demo non lascia niente
    h.recordRisk({ ...s, demo: true }, s.main, steps.find(x => x.id === 't5'));
    h.recordRisk(s, s.main, { id: 'zz', t: now, tool: 'Bash' });
    h.flush();
    ok(risks.count({}) === 6, 'paura: la demo e i passi senza rischio non scrivono niente');

    // ---- la lettura (GET /api/risks usa questa)
    const q = fear.queryRisks(h.store, {});
    ok(q.length === 6 && q[0].t >= q[5].t && q.every(x => !('_id' in x) && Array.isArray(x.reasons) && x.reasons.length), 'paura: queryRisks dà gli eventi dal più recente, con il perché');
    const m = fear.queryRisks(h.store, { missed: true });
    ok(m.length === 3 && m.every(x => x.missed), 'paura: solo le paure mancate (' + m.length + ')');
    ok(fear.queryRisks(h.store, { session: 'altra' }).length === 0 && fear.queryRisks(h.store, { session: S, limit: 2 }).length === 2 && fear.queryRisks(h.store, { projects: ['0000000000000000'] }).length === 0 &&
      fear.queryRisks(h.store, { from: d11.t }).length === 1 && fear.queryRisks(h.store, { to: d2.t + 1 }).length === 1, 'paura: filtri per sessione, progetto, periodo e limite');
    const en = require(path.join(ROOT, 'src', 'i18n')).withLang('en', () => fear.queryRisks(h.store, { session: S, to: d2.t + 1 })[0]);
    ok(/throws away every change/.test(en.reasons[0]) && /reflog/.test(en.undo) && en.category === 'git', 'paura: i testi arrivano dalla regola, nella lingua dell\'ufficio');
    // conservazione: 365 giorni, e segue le sessioni nelle opzioni
    const { COLLECTIONS } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
    const { retentionFromSettings } = require(path.join(ROOT, 'src', 'core', 'retention'));
    ok(COLLECTIONS.risks.retention.days === 365 && retentionFromSettings({ storeKeepSessions: 30 }).risks === 30, 'paura: conservazione di 365 giorni, o quella scelta per le sessioni');
    // la guardia della privacy rifiuta un campo non dichiarato
    let refused = false;
    try { h.store.collection('risks').put({ _id: 'x:y', project: d2.project, t: now, session: 'x', level: 2, command: 'git reset --hard secret' }); } catch { refused = true; }
    ok(refused || !h.store.collection('risks').get('x:y') || !('command' in h.store.collection('risks').get('x:y')), 'paura: la guardia non lascia entrare un campo "command"');
    // dimenticare un progetto toglie anche i suoi eventi
    h.forgetProject(d2.project, { state: st });
    ok(h.store.collection('risks').count({}) === 0, 'paura: "Dimentica questo progetto" toglie anche le azioni rischiose');
  } finally {
    try { h.stop(); } catch {}
    try { st.stop && st.stop(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run(ok) {
  console.log('libro della bottega');
  bottegaTests(ok);
  riskTests(ok);
  prudenceTests(ok);
  bottegaNameTests(ok);
  elderTests(ok);
  console.log('sorprese');
  surpriseTests(ok);
  console.log('mappa contro territorio');
  groundingTests(ok);
  console.log('comandi di shell che scrivono');
  shellWriteTests(ok);
  sedExpressionTests(ok);
  console.log('percorsi inventati');
  ghostTests(ok);
  console.log('affermazioni');
  claimTests(ok);
  alertTests(ok);
}

module.exports = { run, riskTests, prudenceTests, fearStoreTests };

if (require.main === module) {
  require('./test-guard').requireTempDataDir('unit-test'); // mai nei dati veri: solo con PLATYPUS_DATA_DIR in una cartella temporanea
  let failed = 0;
  run((cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
}
