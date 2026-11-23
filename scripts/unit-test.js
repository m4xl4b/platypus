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
  // le cicatrici (2.14) nascono da un'azione rischiosa segnata dal motore: hanno le loro prove in scarTests
  for (const k of bt.KINDS.filter(k => k !== 'scar')) ok(kinds.has(k), `dai fatti della sessione: ${k}`);
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
  // un comando lunghissimo: la parte oltre il limite non si guarda (il rm -rf in fondo non conta), e il tempo resta basso.
  // Il tempo si confronta con quello di un comando lungo quanto il limite, così la prova non dipende da quanto è veloce
  // la macchina: la prima chiamata a freddo costa di più (anche 50 ms sulle macchine macOS della CI), quindi si scalda e
  // si prende il migliore di 5, che misura il costo del classificatore e non quanto è occupata la macchina. Il p99 qui sopra
  // resta la regola dei 20 ms per i comandi veri; per questo caso estremo basta un tetto largo.
  const ctxRisk = { cwd: '/home/u/proj', root: '/home/u/proj', home: '/home/u' };
  const unit = 'echo "$(date)" && ls -la | grep x; ';
  const huge = { tool: 'Bash', input: { command: unit.repeat(5000) + 'rm -rf ~/x' }, ...ctxRisk };
  const atLimit = { tool: 'Bash', input: { command: unit.repeat(Math.floor(risk.MAX_INPUT / unit.length)) }, ...ctxRisk };
  ok(risk.classify(huge).level === 0 && risk.classify({ ...huge, input: { command: 'echo hi; rm -rf ~/x' } }).level === 3, 'rischio: un comando oltre il limite si guarda solo fino al limite');
  const best = x => { risk.classify(x); let m = Infinity; for (let k = 0; k < 5; k++) { const t0 = process.hrtime.bigint(); risk.classify(x); m = Math.min(m, Number(process.hrtime.bigint() - t0) / 1e6); } return m; };
  const big = best(huge), lim = best(atLimit);
  ok(big <= 3 * lim + 1 && big < 50, `rischio: un comando di 200 mila caratteri si ferma al limite e risponde in ${big.toFixed(1)} ms (lungo quanto il limite: ${lim.toFixed(1)} ms; il migliore di 5)`);
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

// 2.14, R4: le cicatrici. Dopo un'azione rischiosa, i segni di un danno; poi la lezione nel Libro e il Nonno
async function scarTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const { History } = require(path.join(ROOT, 'src', 'core', 'history'));
  const fear = require(path.join(ROOT, 'src', 'core', 'fear'));
  const bt = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const i18n = require(path.join(ROOT, 'src', 'i18n'));
  const iso = t => new Date(t).toISOString();
  const cwd = '/home/u/proj';
  let seq = 0;
  // una sessione finta: scrive righe di transcript e restituisce lo stato
  const session = () => {
    let now = Date.parse('2026-11-19T10:00:00Z') + (++seq) * 3600000, n = 0;
    const st = new OfficeState({ clock: () => now, settings: {} });
    const S = 'sess-scar-' + seq;
    const line = (type, content) => ({ type, timestamp: iso(now += 1000), cwd, gitBranch: 'feature/x', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + (++n), usage: { input_tokens: 1, output_tokens: 1 } } : {}) } });
    const api = {
      st, S,
      say: text => st.applyTranscriptLine(S, null, line('user', text)),
      use: (id, name, input) => st.applyTranscriptLine(S, null, line('assistant', [{ type: 'tool_use', id, name, input }])),
      res: (id, content = 'ok', isErr = false) => st.applyTranscriptLine(S, null, line('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isErr }])),
      bash: (id, command, out, isErr) => { api.use(id, 'Bash', { command }); api.res(id, out, isErr); },
      read: (id, file, out, isErr) => { api.use(id, 'Read', { file_path: cwd + '/' + file }); api.res(id, out || 'contenuto', isErr); },
      get s() { return st.sessions.get(S); },
      get agents() { const s = st.sessions.get(S); return [{ id: 'main', name: 'Claude', world: s.main.world, mind: s.main.mind }]; },
      step: id => st.sessions.get(S).main.world.steps.find(x => x.id === id),
    };
    return api;
  };
  const stops = [];
  try {
    // 1. nessun segno: nessuna cicatrice
    let x = session(); stops.push(x.st);
    x.say('pulisci i file generati');
    x.bash('a1', 'rm -rf data/export', 'ok');
    x.bash('a2', 'npm test', 'ok');
    ok(fear.scars(x.s, x.agents).length === 0, 'cicatrici: un\'azione rischiosa senza segni di danno non lascia cicatrici');

    // 2. file che conosceva e che dopo non c'è più (fantasma), più un errore sul bersaglio
    x = session(); stops.push(x.st);
    x.say('riordina la cartella data');
    x.read('b1', 'data/export/report.csv');
    x.bash('b2', 'rm -rf data/export', 'ok');
    x.read('b3', 'data/export/report.csv', 'File does not exist.', true);
    let sc = fear.scars(x.s, x.agents);
    ok(sc.length === 1 && sc[0].step.id === 'b2' && sc[0].signs.includes('ghost') && sc[0].signs.includes('error') && sc[0].evidence.join() === 'b3' && sc[0].key === 'rm -r <path> → data/export' && !sc[0].probable,
      'cicatrici: dopo rm -rf un file già letto non c\'è più e la lettura fallisce → danno, con il passo come prova');
    // un file mai visto prima che "non esiste" non è un danno di questa azione
    x = session(); stops.push(x.st);
    x.say('riordina');
    x.bash('c1', 'rm -rf data/export', 'ok');
    x.read('c2', 'src/mai-esistito.ts', 'File does not exist.', true);
    ok(fear.scars(x.s, x.agents).length === 0, 'cicatrici: un percorso inventato altrove non è un danno dell\'azione');

    // 3. tentativo di recupero dopo git reset --hard
    x = session(); stops.push(x.st);
    x.say('sistema il test');
    x.bash('d1', 'git reset --hard HEAD~2', 'HEAD is now at abc');
    x.bash('d2', 'git reflog', 'abc HEAD@{0}: reset');
    x.bash('d3', 'git reset --hard HEAD@{1}', 'ok');
    sc = fear.scars(x.s, x.agents);
    ok(sc.length === 1 && sc[0].step.id === 'd1' && sc[0].signs.join() === 'recovery' && sc[0].evidence.join() === 'd2,d3' && sc[0].key === 'git reset --hard <ref> → *', 'cicatrici: git reflog e un reset a HEAD@{1} dopo un reset --hard sono un tentativo di recupero');
    // il recupero oltre le 8 azioni seguenti non conta più
    x = session(); stops.push(x.st);
    x.say('sistema il test');
    x.bash('e1', 'git reset --hard HEAD~2', 'ok');
    for (let i = 0; i < 8; i++) x.bash('ee' + i, 'npm test', 'ok');
    x.bash('e2', 'git reflog', 'abc');
    ok(fear.scars(x.s, x.agents).length === 0, 'cicatrici: si guardano solo le 8 azioni seguenti');

    // 4. l'utente se ne accorge (lessicale: probabile)
    x = session(); stops.push(x.st);
    x.say('pulisci il repository');
    x.bash('f1', 'git clean -fdx', 'Removing notes.md');
    x.say('hai cancellato i miei appunti! ripristina notes.md');
    sc = fear.scars(x.s, x.agents);
    ok(sc.length === 1 && sc[0].signs.join() === 'user' && sc[0].probable === true && sc[0].evidence.length === 0, 'cicatrici: «hai cancellato… ripristina» nel messaggio dopo è un segno, da solo "probabile"');
    // la sola frase dell'utente resta un'osservazione nel Libro; con un secondo caso, o con un segno nei fatti, diventa lezione
    {
      const book = new bt.Bottega({}), t0 = x.step('f1').t;
      const c1 = bt.digest(x.s, x.agents).filter(c => c.kind === 'scar');
      book.learn(cwd, c1);
      const v1 = book.view(cwd, t0 + 60000).lessons.find(l => l.kind === 'scar');
      ok(c1.length === 1 && c1[0].excerpt.startsWith('?') && v1 && v1.level === 'observation' && !/\?/.test(v1.detail.split('.')[1] || ''), 'cicatrici: con il solo segno delle parole dell\'utente è un\'osservazione, non una lezione');
      book.learn(cwd, [{ ...c1[0], sid: 'altra-sessione', t: t0 + 1000 }]);
      ok(book.view(cwd, t0 + 60000).lessons.find(l => l.kind === 'scar').level === 'lesson', 'cicatrici: alla seconda volta, in un\'altra sessione, diventa una lezione come le altre');
      const book2 = new bt.Bottega({});
      book2.learn(cwd, [...c1, { ...c1[0], sid: 'altra', t: t0 + 2000, excerpt: 'backup' }]);
      const v2 = book2.view(cwd, t0 + 60000).lessons.find(l => l.kind === 'scar');
      ok(v2.level === 'lesson' && /fai un commit o una copia/.test(v2.detail), 'cicatrici: basta un caso con un segno nei fatti perché sia una lezione');
      book.stop(); book2.stop();
    }
    x = session(); stops.push(x.st);
    x.say('pulisci il repository');
    x.bash('g1', 'git clean -fdx', 'ok');
    x.say('perfetto, ora aggiungi i test');
    ok(fear.scars(x.s, x.agents).length === 0, 'cicatrici: un messaggio contento non è un segno');
    for (const t of ['you deleted my config', 'undo that please', 'where did the uploads folder go? where is it', 'dov\'è finita la cartella?', 'che fine ha fatto il file', 'rimetti com\'era', 'bring it back']) {
      x = session(); stops.push(x.st);
      x.say('pulisci'); x.bash('h1', 'git clean -fd', 'ok'); x.say(t);
      ok(fear.scars(x.s, x.agents).length === 1, 'cicatrici: «' + t + '» è un segno');
    }
    // un'azione di livello 1 o ancora in corso non lascia cicatrici
    x = session(); stops.push(x.st);
    x.say('aggiungi lodash');
    x.bash('i1', 'npm install lodash', 'ok');
    x.use('i2', 'Bash', { command: 'git clean -fd' });
    x.say('hai cancellato tutto, ripristina');
    ok(fear.scars(x.s, x.agents).length === 0, 'cicatrici: non per il livello 1, né per un\'azione ancora in corso');

    // 5. dal danno allo storico e al Libro
    x = session(); stops.push(x.st);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-scar-'));
    const h = new History({ dir: path.join(tmp, 'dati'), backend: 'memory', log() {} });
    h.keys.exec = async () => null;
    x.st.on('risk', (s, a, step) => h.recordRisk(s, a, step));
    try {
      x.say('sistema il test');
      x.read('k0', 'data/export/report.csv');
      x.bash('k1', 'rm -rf data/export', 'ok');
      x.read('k2', 'data/export/report.csv', 'File does not exist.', true);
      h.flush();
      ok(!h.store.collection('risks').get(x.S + ':k1').outcome, 'cicatrici: appena scritto, l\'evento non ha ancora un esito');
      const fresh = fear.markScars(x.s, x.agents);
      for (const s of fresh) h.recordRisk(x.s, { id: s.agent }, s.step);
      h.flush();
      const doc = h.store.collection('risks').get(x.S + ':k1');
      ok(fresh.length === 1 && doc.outcome === 'damage' && doc.evidence.join() === x.S + ':k2' && doc.at > doc.t && doc.level === 2 && doc.missed === true && x.step('k1').risk.outcome === 'damage', 'cicatrici: l\'evento nello storico prende esito "damage", con i passi come prova');
      ok(fear.markScars(x.s, x.agents).length === 0, 'cicatrici: lo stesso danno non viene segnato due volte');
      ok(fear.queryRisks(h.store, {})[0].outcome === 'damage' && !JSON.stringify(h.store.collection('risks').find({})).includes('does not exist'), 'cicatrici: l\'esito si legge da /api/risks; nessun testo dell\'errore nello storico');

      // nel Libro: una lezione di tipo "scar", forte dal primo caso
      const book = new bt.Bottega({});
      const cases = bt.digest(x.s, x.agents);
      const scase = cases.find(c => c.kind === 'scar');
      ok(scase && scase.key === 'rm -r <path> → data/export' && scase.excerpt === 'backup,asked', 'cicatrici: il caso per il Libro ha la forma, il bersaglio e le prudenze mancate (aveva guardato: manca la copia e la richiesta)');
      book.learn(cwd, cases);
      book.learn(cwd, bt.digest(x.s, x.agents)); // riletto ogni minuto: non conta due volte
      const now = x.step('k1').t + 60000;
      const lesson = book.view(cwd, now).lessons.find(l => l.kind === 'scar');
      ok(lesson && lesson.count === 1 && lesson.level === 'lesson' && /Cicatrice: rm -r <path> su data\/export/.test(lesson.title) && /probabile/.test(lesson.detail) && /prima: fai un commit o una copia e chiedi all'utente\./.test(lesson.detail), 'cicatrici: nel Libro è una lezione dal primo caso, con il consiglio: ' + (lesson && lesson.title));
      // decade più piano: dopo 60 giorni una cicatrice è ancora una lezione, una lezione normale con lo stesso peso no
      const DAY = 86400000, L = (kind, count) => ({ kind, key: 'k', count, sessions: ['s'], last: 0, pinned: false });
      ok(Math.abs(bt.weightOf(L('scar', 1), 90 * DAY) - 0.5) < 1e-9 && Math.abs(bt.weightOf(L('ghost-path', 1), 30 * DAY) - 0.5) < 1e-9 && bt.SCAR_HALF_LIFE === 90 * DAY, 'cicatrici: il peso si dimezza in 90 giorni invece di 30');
      ok(book.view(cwd, now + 60 * DAY).lessons.find(l => l.kind === 'scar').level === 'lesson' && book.view(cwd, now + 120 * DAY).lessons.find(l => l.kind === 'scar').level === 'observation', 'cicatrici: dopo 60 giorni è ancora una lezione, dopo 120 è un\'osservazione');

      // il Nonno: stessa forma, stesso bersaglio; e le cicatrici prima delle altre lezioni
      const y = session(); stops.push(y.st);
      y.say('pulisci');
      y.use('n1', 'Bash', { command: 'rm -rf data/export' });
      const lessons = book.view(cwd, y.step('n1').t).lessons.concat([{ id: 'zz', kind: 'slow-step', key: 'rm -rf data/export', level: 'lesson', weight: 99, evidence: [{ t: 0, agent: 'A' }], count: 3 }]);
      const hint = bt.hints(y.s, y.agents, lessons, y.step('n1').t + 1000);
      ok(hint.length === 1 && hint[0].kind === 'scar' && /Qui rm -r <path> ha già distrutto del lavoro su data\/export/.test(hint[0].text) && /Stavolta, prima: fai un commit o una copia/.test(hint[0].text), 'Nonno: racconta la cicatrice, e prima di una lezione più pesante: ' + (hint[0] && hint[0].text));
      const z = session(); stops.push(z.st);
      z.say('pulisci');
      z.use('o1', 'Bash', { command: 'rm -rf data/other' });
      ok(bt.hints(z.s, z.agents, book.view(cwd, z.step('o1').t).lessons, z.step('o1').t + 1000).length === 0, 'Nonno: la cicatrice su un\'altra cartella non c\'entra');
      // le righe per il CLAUDE.md e per l'inizio sessione: la cicatrice prima, e in inglese
      const lines = bt.lessonLines(lessons.map(l => ({ ...l, pinned: !!l.pinned })));
      ok(/^Qui `rm -r <path>` ha già distrutto del lavoro su `data\/export`\. Prima di rifarlo: fai un commit o una copia e chiedi all'utente\.$/.test(lines[0]), 'cicatrici: è la prima riga tra le lezioni per l\'agente: ' + lines[0]);
      const en = i18n.withLang('en', () => ({ v: book.view(cwd, now).lessons.find(l => l.kind === 'scar'), line: bt.lessonLines(book.view(cwd, now).lessons)[0] }));
      ok(/^Scar: /.test(en.v.title) && /already destroyed work on `data\/export`/.test(en.line) && /Before doing it again: make a commit or a copy and ask the user\.$/.test(en.line), 'cicatrici: testi in inglese: ' + en.line);
      // dimenticarla funziona come per le altre lezioni
      ok(book.act(cwd, 'forget', lesson.id) && !book.view(cwd, now).lessons.some(l => l.kind === 'scar') && book.learn(cwd, bt.digest(x.s, x.agents)) === 0, 'cicatrici: "Dimentica" la toglie e i casi già visti non la riportano');
      book.stop();
    } finally { try { h.stop(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); }
  } finally {
    for (const st of stops) { try { st.stop && st.stop(); } catch {} }
  }
}

// 2.14, R5: quello che l'ufficio riceve per disegnare la paura (a.fear nello stato) e l'opzione fearEnabled
function fearViewTests(ok) {
  const { OfficeState, DEFAULT_SETTINGS } = require(path.join(ROOT, 'src', 'core', 'state'));
  const fear = require(path.join(ROOT, 'src', 'core', 'fear'));
  const iso = t => new Date(t).toISOString();
  let now = Date.parse('2026-11-19T15:00:00Z'), n = 0;
  const st = new OfficeState({ clock: () => now, settings: {} });
  const S = 'sess-view-0001', cwd = '/home/u/proj';
  const line = (type, content) => ({ type, timestamp: iso(now += 1000), cwd, gitBranch: 'feature/x', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + (++n), usage: { input_tokens: 1, output_tokens: 1 } } : {}) } });
  const bash = (id, command, out, isErr = false) => {
    st.applyTranscriptLine(S, null, line('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]));
    if (out !== undefined) st.applyTranscriptLine(S, null, line('user', [{ type: 'tool_result', tool_use_id: id, content: out, is_error: isErr }]));
  };
  const mainView = () => st.snapshot().sessions.find(s => s.id === S).main.fear;
  try {
    ok(DEFAULT_SETTINGS.fearEnabled === true, 'ufficio: la paura è accesa di base (osserva soltanto)');
    st.applyTranscriptLine(S, null, line('user', 'sistema il login'));
    bash('v1', 'npm test', 'ok');
    ok(mainView() === null, 'ufficio: senza azioni rischiose l\'agente non ha niente da mostrare');
    bash('v2', 'git push --force origin main');
    const v = mainView();
    ok(v && v.last && v.last.id === 'v2' && v.last.level === 3 && v.last.missed === true && v.last.shape && /main branch|branch principale/.test(v.last.reasons.join(' ')) && v.last.advice.length >= 2,
      'ufficio: l\'ultima azione rischiosa arriva con livello, paura mancata, il perché e i consigli');
    ok(!JSON.stringify(v).includes('--force origin'), 'ufficio: del comando arriva solo la forma della regola');
    bash('v3', 'git add -A && git commit -m wip', 'ok');
    bash('v4', 'git reset --hard HEAD~1', 'ok');
    const v4 = mainView().last;
    ok(v4.id === 'v4' && v4.missed === false && v4.level === 2, 'ufficio: dopo un commit, il reset --hard è una paura giusta (il personaggio suda)');
    now += fear.FRESH_MS + 1000;
    ok(mainView() === null, 'ufficio: dopo due minuti l\'azione rischiosa non si mostra più');
    // la cicatrice resta per il resto della sessione
    const s = st.sessions.get(S);
    s.main.world.scarAt = now - 5000;
    now += 3600000;
    ok(mainView() && mainView().scarAt === s.main.world.scarAt && !mainView().last, 'ufficio: la cicatrice resta anche un\'ora dopo, senza azione recente');
    // markScars la mette sul mondo dell'agente
    const st2 = new OfficeState({ clock: () => now, settings: {} });
    const S2 = 'sess-view-0002';
    const l2 = (type, content) => ({ ...line(type, content) });
    st2.applyTranscriptLine(S2, null, l2('user', 'pulisci'));
    st2.applyTranscriptLine(S2, null, l2('assistant', [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: 'git clean -fd' } }]));
    st2.applyTranscriptLine(S2, null, l2('user', [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }]));
    st2.applyTranscriptLine(S2, null, l2('user', 'hai cancellato i miei appunti'));
    const s2 = st2.sessions.get(S2);
    fear.markScars(s2, [{ id: 'main', name: 'Claude', world: s2.main.world, mind: s2.main.mind }]);
    ok(s2.main.world.scarAt > 0 && st2.snapshot().sessions.find(x => x.id === S2).main.fear.scarAt === s2.main.world.scarAt, 'ufficio: markScars mette la cicatrice sul personaggio');
    st2.stop && st2.stop();
    // R6: il rischio di una richiesta di permesso
    const pv = (cmd, steps = []) => fear.permissionView({ s, a: { world: { steps, open: new Map() } }, tool: 'Bash', input: { command: cmd } });
    ok(pv('ls -la') === null, 'permesso: un comando innocuo non ha rischio');
    const pf = pv('git push --force origin main');
    ok(pf.level === 3 && /IRREVERSIB/.test(pf.name) && pf.missed && pf.undo === '' && /(Non si torna indietro|no going back)/.test(fear.permissionLine(pf)), 'permesso: force push su main, irreversibile, senza rimedio: ' + fear.permissionLine(pf));
    const pr = pv('git reset --hard HEAD~1', [{ t: 1, act: 'run', sig: 'run:git commit -m wip', err: false }]);
    ok(pr.level === 2 && !pr.missed && /reflog/.test(pr.undo) && /reflog/.test(fear.permissionLine(pr)), 'permesso: reset --hard dopo un commit, con il modo di tornare indietro');
    const pp = pv('git push origin main');
    ok(pp.level === 3 && /revert/.test(pp.undo), 'permesso: un push normale su main si rimedia con un revert, un force push no');
    // il passo aperto per la stessa azione non è prudenza
    const self = { t: 2, act: 'look', sig: 'run:git status', err: null };
    const open = new Map([['x', self]]);
    ok(fear.permissionView({ s, a: { world: { steps: [self], open } }, tool: 'Bash', input: { command: 'git reset --hard' } }).missed === true, 'permesso: l\'azione ancora aperta non conta come prudenza');
    // nello stato solo mentre aspetta
    st.applyHook({ session_id: S, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git clean -fd' } });
    const waitView = st.snapshot().sessions.find(x => x.id === S).main;
    ok(waitView.status === 'waiting' && waitView.perm && waitView.perm.level === 2 && waitView.perm.reasons.length === 1, 'permesso: nello stato, il rischio dell\'agente che aspetta');
    st.applyTranscriptLine(S, null, line('user', [{ type: 'tool_result', tool_use_id: 'zz', content: 'ok' }]));
    st.setAgent(s.main, 'working', 'ok');
    ok(st.snapshot().sessions.find(x => x.id === S).main.perm === null, 'permesso: quando non aspetta più, il rischio sparisce');
    // l'opzione si spegne e si riaccende come le altre
    st.setSettings({ fearEnabled: false });
    ok(st.settings.fearEnabled === false && st.snapshot().settings.fearEnabled === false, 'ufficio: fearEnabled si spegne dalle opzioni');
    st.setSettings({ fearEnabled: 'sì' });
    ok(st.settings.fearEnabled === true, 'ufficio: e si riaccende');
  } finally { st.stop && st.stop(); }
}

// 2.14, R7: la paura prestata all'agente (feedback "fear" al PreToolUse), il suo esito, gli hook da aggiornare
function fearFeedbackTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const fb = require(path.join(ROOT, 'src', 'core', 'feedback'));
  require(path.join(ROOT, 'src', 'core', 'feedback-rules'));
  const { judge } = require(path.join(ROOT, 'src', 'core', 'outcomes'));
  const hooks = require(path.join(ROOT, 'src', 'core', 'hooks'));
  const i18n = require(path.join(ROOT, 'src', 'i18n'));
  const iso = t => new Date(t).toISOString();
  let now = Date.parse('2026-11-19T16:00:00Z'), n = 0, seqS = 0;
  const cwd = '/home/u/proj';
  const mk = () => {
    const st = new OfficeState({ clock: () => now, settings: {} }), S = 'sess-fb-fear-' + (++seqS);
    const line = (type, content, extra = {}) => ({ type, timestamp: iso(now += 1000), cwd, gitBranch: 'feature/x', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + (++n), usage: { input_tokens: 1, output_tokens: 1 } } : {}) }, ...extra });
    const x = {
      st, S,
      say: t => st.applyTranscriptLine(S, null, line('user', t)),
      bash: (id, command, out = 'ok') => { st.applyTranscriptLine(S, null, line('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }])); if (out !== null) st.applyTranscriptLine(S, null, line('user', [{ type: 'tool_result', tool_use_id: id, content: out }])); },
      get s() { return st.sessions.get(S); },
      hook: (command, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: S, cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'hook-' + (++n), ...extra }),
    };
    return x;
  };
  const gate = () => new fb.Gate({ now: () => now });
  const ctxOf = (x, settings = { fbFear: 'on' }, lessons = []) => ({ now: () => now, session: x.s, cwd, settings, lessons: () => lessons });
  const stops = [];
  try {
    // acceso: il messaggio parla dell'azione appena fatta (arriva con il risultato, R0), in inglese, con il perché, che cosa mancava e che cosa fare adesso
    let x = mk(); stops.push(x.st);
    x.say('sistema il test del login');
    x.bash('a1', 'npm test');
    let g = gate();
    let r = fb.respond(x.hook('git push --force origin main'), ctxOf(x), g);
    const txt = r.out && r.out.hookSpecificOutput.additionalContext;
    ok(r.out && r.out.hookSpecificOutput.hookEventName === 'PreToolUse' && /^Platypus: the command you just ran is irreversible \(pushes to the main branch\)\./.test(txt) && /Missing in the actions before it: .*a commit or a copy/.test(txt) && /If the user did not ask for exactly this, check what it changed and tell them now\./.test(txt) && /Before the next risky action: .*make a commit or a copy\.$/.test(txt) && txt.length <= fb.MAX_TEXT,
      'paura all\'agente: dopo l\'azione, irreversibile, che cosa mancava e che cosa fare adesso → ' + txt);
    ok(r.entry.feature === 'fear' && r.entry.mode === 'on' && r.entry.event === 'PreToolUse' && r.entry.about.kind === 'fear' && r.entry.about.cmd === 'git push <remote> main' && /^git-push/.test(r.entry.tag) && r.entry.toolUseId, 'paura all\'agente: nel registro la funzione, la regola e la forma del comando');
    ok(!JSON.stringify(r.entry).includes('--force origin'), 'paura all\'agente: nel registro non c\'è il comando');
    // una volta per regola per sessione: né allo stesso agente né a un altro
    now += 10 * 60000;
    ok(!fb.respond(x.hook('git push --force origin main'), ctxOf(x), g).out && !fb.respond(x.hook('git push -f origin main', { agent_id: 'sub-1' }), ctxOf(x), g).out, 'paura all\'agente: la stessa regola non torna nella stessa sessione, nemmeno a un sottoagente');
    // un'altra regola, più tardi: sì
    now += 3 * 60000;
    ok(/destroys|throws away every change/.test((fb.respond(x.hook('git reset --hard'), ctxOf(x), g).out || { hookSpecificOutput: {} }).hookSpecificOutput.additionalContext || ''), 'paura all\'agente: un\'altra regola, più tardi, sì');
    // di base (in ombra): niente all'agente, ma nel registro
    x = mk(); stops.push(x.st);
    x.say('sistema il login');
    const { DEFAULT_SETTINGS } = require(path.join(ROOT, 'src', 'core', 'state'));
    r = fb.respond(x.hook('git clean -fd'), ctxOf(x, DEFAULT_SETTINGS), gate());
    ok(!r.out && r.entry && r.entry.mode === 'shadow' && r.entry.feature === 'fear', 'paura all\'agente: di base in ombra, registrata ma non detta');
    ok(!fb.respond(x.hook('git clean -fd'), ctxOf(x, { fbFear: 'off' }), gate()).entry, 'paura all\'agente: spenta, niente nemmeno nel registro');
    // quando tace: azione prudente, livello 1, richiesta dell'utente, azione innocua
    x = mk(); stops.push(x.st);
    x.say('sistema il login');
    x.bash('b1', 'git add -A && git commit -m wip', '[x] wip');
    ok(!fb.respond(x.hook('git reset --hard HEAD~1'), ctxOf(x), gate()).entry, 'paura all\'agente: dopo un commit il reset --hard è prudente, niente da dire');
    ok(!fb.respond(x.hook('npm install lodash'), ctxOf(x), gate()).entry && !fb.respond(x.hook('ls -la'), ctxOf(x), gate()).entry, 'paura all\'agente: niente per il livello 1 o per un comando innocuo');
    x = mk(); stops.push(x.st);
    x.say('butta tutto e fai un reset hard');
    ok(!fb.respond(x.hook('git reset --hard'), ctxOf(x), gate()).entry, 'paura all\'agente: niente se l\'utente l\'ha chiesto (probabile)');
    // l'azione stessa, se il transcript è già arrivato, non è prudenza
    x = mk(); stops.push(x.st);
    x.say('sistema il login');
    x.bash('c1', 'git status && git reset --hard', null);
    r = fb.respond(x.hook('git status && git reset --hard', { tool_use_id: 'c1' }), ctxOf(x), gate());
    ok(r.out && r.entry.mode === 'on', 'paura all\'agente: il passo aperto della stessa azione non conta come prudenza');
    // con una cicatrice nel Libro su quell'azione, lo dice: un messaggio solo, niente doppione con il Nonno
    x = mk(); stops.push(x.st);
    x.say('sistema il login');
    const scar = { id: 'L1', kind: 'scar', key: 'git reset --hard <ref> → *', level: 'lesson', ignored: false, weight: 2 };
    r = fb.respond(x.hook('git reset --hard origin/main'), ctxOf(x, { fbFear: 'on' }, [scar]), gate());
    ok(/already destroyed work once/.test(r.out.hookSpecificOutput.additionalContext) && /\/scar$/.test(r.entry.tag), 'paura all\'agente: con una cicatrice nel Libro, lo stesso messaggio la cita');
    // in italiano nell'ufficio, sempre in inglese per l'agente
    const prev = i18n.getLang(); i18n.setLang('it');
    try {
      x = mk(); stops.push(x.st);
      x.say('sistema il login');
      r = fb.respond(x.hook('git clean -fd'), ctxOf(x), gate());
      ok(/^Platypus: the command you just ran is dangerous/.test(r.out.hookSpecificOutput.additionalContext) && /^Platypus: il comando che hai appena lanciato è pericoloso/.test(r.entry.local), 'paura all\'agente: inglese per l\'agente, la lingua dell\'ufficio nel registro');
    } finally { i18n.setLang(prev); }

    // ---- l'esito: nelle 3 azioni dopo quella avvisata
    const E = { t: 1000, agent: 'main', feature: 'fear', toolUseId: 'p1', about: { kind: 'fear', cmd: 'git reset --hard <ref>', pat: 'git-reset-hard' } };
    const step = (id, sig, extra = {}) => ({ id, t: 1000 + Number(String(id).replace(/\D/g, '') || 0), act: 'run', tool: 'Bash', sig: 'run:' + sig, err: false, ...extra });
    const ag = (...rest) => ({ steps: [step('p1', 'git reset --hard'), ...rest], goals: [] });
    ok(judge(E, ag(step('q2', 'git status')), 5000).outcome === 'helped', 'paura, esito: ha guardato dopo l\'avviso → probabilmente utile');
    ok(judge(E, ag(step('q2', 'git stash')), 5000).outcome === 'helped', 'paura, esito: ha messo da parte il lavoro → probabilmente utile');
    ok(judge(E, ag({ id: 'q2', t: 1002, act: 'other', tool: 'AskUserQuestion', sig: 'AskUserQuestion', err: false }), 5000).why.length > 0 && judge(E, ag({ id: 'q2', t: 1002, act: 'other', tool: 'AskUserQuestion', sig: 'AskUserQuestion', err: false }), 5000).outcome === 'helped', 'paura, esito: ha chiesto all\'utente → probabilmente utile');
    ok(judge(E, ag(step('q2', 'git clean -fd', { risk: { level: 2, missed: true } })), 5000).outcome === 'ignored', 'paura, esito: un\'altra azione rischiosa senza prudenza → ignorato');
    ok(judge(E, ag(step('q2', 'npm test'), step('q3', 'npm run lint'), step('q4', 'node x.js')), 5000).outcome === 'unclear', 'paura, esito: tre azioni d\'altro → non si può dire');
    ok(judge(E, ag(step('q2', 'npm test')), 5000) === null, 'paura, esito: meno di tre azioni, ancora presto');
    ok(judge(E, ag(step('q2', 'git status', { err: null })), 5000) === null, 'paura, esito: l\'azione dopo è ancora in corso');
    ok(judge(E, { steps: [step('p1', 'git reset --hard')], goals: [{ t: 3000 }] }, 5000).outcome === 'helped', 'paura, esito: il turno finisce lì → si è fermato e ha lasciato decidere');

    // ---- gli hook di feedback di prima della 2.14 sono da aggiornare
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-fearhooks-'));
    try {
      hooks.installFeedback({ port: 47800, base: tmp });
      const fresh = !hooks.feedbackOutdated({ base: tmp });
      const p = path.join(tmp, 'settings.json'), j = JSON.parse(fs.readFileSync(p, 'utf8'));
      delete j.hooks.PreToolUse;
      fs.writeFileSync(p, JSON.stringify(j));
      ok(fresh && hooks.feedbackOutdated({ base: tmp }) && hooks.feedbackStatus({ base: tmp }), 'hook di feedback senza PreToolUse (installati con la 2.13): da aggiornare');
      hooks.uninstallFeedback({ base: tmp });
      ok(!hooks.feedbackOutdated({ base: tmp }), 'hook di feedback assenti: niente da aggiornare');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } finally { for (const st of stops) { try { st.stop && st.stop(); } catch {} } }
}

// 2.14, R9: report del giorno, scheda PAURE del Libro, metriche nello storico
function fearReportTests(ok) {
  const { openStore } = require(path.join(ROOT, 'src', 'core', 'store'));
  const { declareCollections } = require(path.join(ROOT, 'src', 'core', 'store', 'collections'));
  const fear = require(path.join(ROOT, 'src', 'core', 'fear'));
  const HQ = require(path.join(ROOT, 'src', 'core', 'history-query'));
  const { COUNT_FIELDS } = require(path.join(ROOT, 'src', 'core', 'history'));
  const store = declareCollections(openStore({ requireFields: true, guard: 'reject' }));
  const DAY = 86400000, NOW = Date.parse('2026-11-19T18:00:00'), D0 = Date.parse('2026-11-19T00:00:00');
  let k = 0;
  const risk = (o) => store.collection('risks').put({ _id: 's:' + (++k), project: 'p1', session: 's1', agent: 'main', tool: 'Bash', ruleIds: ['git-reset-hard'], level: 2, prudence: 0, present: [], missing: ['backup'], missed: true, shape: 'git reset --hard <ref>', t: D0 + 3600000, ...o });
  try {
    store.collection('projects').put({ _id: 'p1', name: 'negozio' });
    risk({ name: 'Claude' });
    risk({ name: 'Claude', ruleIds: ['git-push-main', 'git-push-force-shared'], level: 3, shape: 'git push <remote> main' });
    risk({ agent: 'a1', name: 'EXPLORE', missed: false, prudence: 1 });
    risk({ agent: 'a2', name: 'REVIEWER', ruleIds: ['rm-recursive'], shape: 'rm -r <path>', target: 'data/export', outcome: 'damage', at: D0 + 7200000, evidence: ['s:x'] });
    risk({ name: 'Claude', ruleIds: ['lockfile'], level: 1, missed: false, shape: '' });
    risk({ name: 'Claude', t: D0 - 2 * DAY, project: 'p2' }); // un altro giorno, un altro progetto
    risk({ name: 'Claude', t: NOW - 120 * DAY }); // oltre i 90 giorni
    // il report del giorno
    const rd = fear.reportDay(store, D0, D0 + DAY);
    ok(rd.total === 4 && rd.missed === 3 && JSON.stringify(rd.byAgent) === JSON.stringify([{ name: 'Claude', n: 2 }, { name: 'REVIEWER', n: 1 }]), 'report: paure mancate per agente, solo livello 2 o più, solo quel giorno → ' + JSON.stringify(rd.byAgent));
    ok(rd.scars.length === 1 && rd.scars[0].project === 'negozio' && rd.scars[0].name === 'REVIEWER' && rd.scars[0].target === 'data/export' && rd.scars[0].shape === 'rm -r <path>' && rd.scars[0].reason, 'report: le cicatrici del giorno, con il progetto per nome');
    ok(fear.reportDay(store, D0 + DAY, D0 + 2 * DAY).total === 0 && fear.reportDay(null, 0, 1).total === 0, 'report: un giorno senza azioni rischiose, e senza storico');
    // il riassunto per il Libro: ultimi 90 giorni, per livello e per regola, per progetto
    const sm = fear.summary(store, { projects: ['p1'], now: NOW });
    ok(sm.days === 90 && sm.total === 5 && sm.levels[1] === 1 && sm.levels[2] === 3 && sm.levels[3] === 1 && sm.missed === 3 && sm.damage === 1, 'Libro: livelli, paure mancate e danni degli ultimi 90 giorni del progetto');
    ok(sm.rules[0].id === 'git-push-main' && sm.rules[0].text && sm.rules[0].shape && sm.rules.find(r => r.id === 'git-reset-hard').count === 2 && sm.rules.find(r => r.id === 'git-reset-hard').missed === 1, 'Libro: per regola, le più gravi prima, con il testo e la forma');
    ok(sm.recent.length === 5 && sm.recent[0].t >= sm.recent[4].t && sm.recent.every(r => r.reasons), 'Libro: le azioni più recenti, con il perché');
    ok(fear.summary(store, { now: NOW }).total === 6 && fear.summary(null).total === 0, 'Libro: senza progetto, tutti i progetti; senza storico, niente');
    // il nome dell'agente è un campo dichiarato
    ok(store.collection('risks').get('s:1').name === 'Claude', 'storico: l\'evento tiene il nome dell\'agente in ufficio');
    // le tre metriche nuove: nei riassunti delle sessioni, nello storico nel tempo
    ok(['risky_actions', 'missed_fears', 'scars'].every(m => COUNT_FIELDS.includes(m) && HQ.SESSION_METRICS.includes(m) && HQ.LOWER_IS_BETTER.has(m)), 'storico: risky_actions, missed_fears e scars nei riassunti, e meno è meglio');
    for (let i = 0; i < 12; i++) store.collection('sessions').put({ _id: 'S' + i, project: 'p1', t: NOW - (i < 6 ? 3 : 40) * DAY - i * 3600000, actions: 50, risky_actions: 2, missed_fears: i < 6 ? 0 : 2, scars: 0 });
    const all = HQ.queryAll(store, { projects: ['p1'], from: NOW - 70 * DAY, to: NOW, metrics: ['missed_fears', 'risky_actions'] });
    const t = HQ.trend(all.missed_fears, NOW);
    ok(t.verdict === 'fewer' && t.better === true && HQ.trend(all.risky_actions, NOW).verdict === 'same', 'storico: le paure mancate in calo sono un miglioramento; le azioni rischiose stabili');
  } finally { store.close(); }
}

// 2.14, R8: la guardia. Per progetto: spenta, sempre, automatica (stima se c'è qualcuno); regole accettate come normali
function guardTests(ok) {
  const { OfficeState } = require(path.join(ROOT, 'src', 'core', 'state'));
  const guard = require(path.join(ROOT, 'src', 'core', 'guard'));
  const bt = require(path.join(ROOT, 'src', 'core', 'bottega'));
  const iso = t => new Date(t).toISOString();
  let now = Date.parse('2026-11-23T11:00:00Z'), n = 0, k = 0;
  const cwd = '/home/u/proj';
  const mk = (entrypoint = 'cli') => {
    const st = new OfficeState({ clock: () => now, settings: {} }), S = 'sess-guard-' + (++k);
    const line = (type, content, extra = {}) => ({ type, timestamp: iso(now += 1000), cwd, entrypoint, gitBranch: 'feature/x', message: { role: type, content, ...(type === 'assistant' ? { id: 'm' + (++n), usage: { input_tokens: 1, output_tokens: 1 } } : {}) }, ...extra });
    const x = {
      st, S, line,
      say: t => st.applyTranscriptLine(S, null, line('user', t)),
      bash: (id, command) => { st.applyTranscriptLine(S, null, line('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }])); st.applyTranscriptLine(S, null, line('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }])); },
      get s() { return st.sessions.get(S); },
      pre: (command, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: S, cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'pre-' + (++n), ...extra }),
    };
    return x;
  };
  const decide = (x, input, mode, accepted = {}) => guard.decide({ s: x.s, a: input.agent_id ? x.s.subs.get(input.agent_id) : x.s.main, input, mode, accepted, now });
  const stops = [];
  try {
    let x = mk(); stops.push(x.st);
    x.say('sistema il test del login');
    // sempre: livello 3 senza prudenza → ask, con il motivo
    let d = decide(x, x.pre('git push --force origin main'), 'on');
    ok(d && d.ask && d.mode === 'on' && d.risk.level === 3 && /Platypus \((guardia|guard)\)/.test(d.reason) && /IRREVERSIB/.test(d.reason), 'guardia sempre: livello 3 senza prudenza → chiede, con il motivo: ' + (d && d.reason));
    const ans = guard.answer(d, 'Platypus: the command you just ran…');
    ok(ans.hookSpecificOutput.hookEventName === 'PreToolUse' && ans.hookSpecificOutput.permissionDecision === 'ask' && ans.hookSpecificOutput.permissionDecisionReason === d.reason && ans.hookSpecificOutput.additionalContext && !('updatedInput' in ans.hookSpecificOutput),
      'guardia: la risposta è "ask" con il motivo e il contesto della paura, mai "deny" e mai un comando cambiato');
    ok(!guard.answer(null) && !guard.answer({ ask: false, reason: 'x' }), 'guardia: niente da chiedere → nessuna risposta');
    // spenta, livello 2, prudenza, regola accettata: niente
    ok(decide(x, x.pre('git push --force origin main'), 'off') === null && decide(x, x.pre('git push --force origin main'), 'boh') === null, 'guardia spenta (o un modo che non esiste): niente');
    ok(decide(x, x.pre('git reset --hard'), 'on') === null, 'guardia: il livello 2 non la fa scattare (resta la paura che avvisa)');
    ok(decide(x, x.pre('ls -la'), 'on') === null, 'guardia: un comando innocuo, niente');
    ok(decide(x, x.pre('git push --force origin main'), 'on', { 'git-push-main': 1, 'git-push-force-shared': 1 }) === null, 'guardia: le regole accettate come normali qui la zittiscono');
    ok(!!decide(x, x.pre('git push --force origin main'), 'on', { 'git-push-main': 1 }), 'guardia: accettarne una sola non zittisce l\'altra regola dello stesso livello');
    const y = mk(); stops.push(y.st);
    y.say('rilascia la versione');
    y.bash('b1', 'npm publish --dry-run');
    ok(decide(y, y.pre('npm publish'), 'on') === null, 'guardia: dopo una prova a vuoto l\'azione è prudente, niente');
    // automatica: sessione interattiva con un messaggio recente → chiede
    d = decide(x, x.pre('terraform apply -auto-approve'), 'auto');
    ok(d && d.ask && d.estimate.attended && /interattiva|interactive/.test(d.estimate.why), 'guardia automatica: sessione interattiva con un messaggio recente → chiede (' + (d && d.estimate.why) + ')');
    // automatica: nessun messaggio da più di 30 minuti → avvisa soltanto
    now += 31 * 60000;
    d = decide(x, x.pre('terraform apply -auto-approve'), 'auto');
    ok(d && !d.ask && !d.estimate.attended && /31/.test(d.estimate.why), 'guardia automatica: l\'ultimo messaggio è di 31 minuti fa → non chiede, avvisa (' + (d && d.estimate.why) + ')');
    ok(decide(x, x.pre('terraform apply -auto-approve'), 'on').ask === true, 'guardia sempre: chiede anche senza messaggi recenti');
    // automatica: sessione da script (claude -p, SDK)
    const z = mk('sdk-cli'); stops.push(z.st);
    z.say('fai il deploy');
    d = decide(z, z.pre('vercel --prod'), 'auto');
    ok(d && !d.ask && /script|SDK/.test(d.estimate.why), 'guardia automatica: sessione da script → non chiede (' + (d && d.estimate.why) + ')');
    // automatica: sottoagente in background
    const b = mk(); stops.push(b.st);
    b.say('prepara il rilascio');
    b.st.applyTranscriptLine(b.S, null, b.line('assistant', [{ type: 'tool_use', id: 'sp1', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'pubblica', prompt: 'pubblica', run_in_background: true } }]));
    b.st.applyTranscriptLine(b.S, 'ag1', b.line('user', 'pubblica'));
    const sub = b.s.subs.get('ag1');
    if (sub) sub.background = true;
    d = sub ? decide(b, b.pre('npm publish', { agent_id: 'ag1' }), 'auto') : null;
    ok(d && !d.ask && /background/.test(d.estimate.why), 'guardia automatica: sottoagente in background → non chiede');
    // automatica: tipo di sessione sconosciuto, o sessione che Platypus non conosce
    const u = mk(''); stops.push(u.st);
    u.say('pulisci');
    ok(decide(u, u.pre('git push --force origin main'), 'auto').ask === false && guard.attended({ s: null }).attended === false, 'guardia automatica: tipo di sessione sconosciuto, o sessione sconosciuta → nel dubbio non chiede');
    // il Libro tiene la guardia e le regole accettate, e le dimentica a richiesta
    const book = new bt.Bottega({});
    ok(book.guardOf('/p') === 'off' && book.setGuard('/p', 'auto') === 'auto' && book.guardOf('/p') === 'auto' && book.setGuard('/p', 'boh') === 'off', 'Libro: la guardia è spenta di base, si sceglie per progetto, un valore sbagliato la spegne');
    book.accept('/p', 'terraform-apply');
    ok(book.acceptedOf('/p')['terraform-apply'] > 0 && book.view('/p').accepted['terraform-apply'] > 0, 'Libro: una regola accettata come normale resta nel Libro');
    book.accept('/p', 'terraform-apply', false);
    ok(!book.acceptedOf('/p')['terraform-apply'], 'Libro: e si annulla');
    book.stop();
  } finally { for (const st of stops) { try { st.stop && st.stop(); } catch {} } }
}

function run(ok) {
  console.log('libro della bottega');
  bottegaTests(ok);
  riskTests(ok);
  prudenceTests(ok);
  fearViewTests(ok);
  fearFeedbackTests(ok);
  fearReportTests(ok);
  guardTests(ok);
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

module.exports = { run, riskTests, prudenceTests, fearStoreTests, scarTests, fearViewTests, fearFeedbackTests, fearReportTests, guardTests };

if (require.main === module) {
  require('./test-guard').requireTempDataDir('unit-test'); // mai nei dati veri: solo con PLATYPUS_DATA_DIR in una cartella temporanea
  let failed = 0;
  run((cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
}
