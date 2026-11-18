#!/usr/bin/env node
'use strict';
// Prove dei parser del sismografo delle sorprese (src/core/surprise.js): che fallimento è,
// la riga che lo riassume, i file citati dall'errore. Si possono lanciare anche da sole.

const path = require('path');

const ROOT = path.join(__dirname, '..');
const { classifyFailure, errorExcerpt, extractErrorRefs } = require(path.join(ROOT, 'src', 'core', 'surprise'));

const L = (...lines) => lines.join('\n');
const is = (r, kind, framework) => !!r && r.kind === kind && r.framework === framework;
const same = (refs, want) => JSON.stringify(refs.map(r => r.file + ':' + r.line)) === JSON.stringify(want);

// ---- output veri (accorciati) ----
const JEST_FAIL = L(
  '> platypus@2.9.0 test',
  '> jest',
  '',
  'FAIL src/auth/refresh.test.ts',
  '  ● refresh › rotates the token',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: "b"',
  '    Received: "a"',
  '',
  '      40 |   const t = rotate(old);',
  '    > 42 |   expect(t).toBe(\'b\');',
  '         |             ^',
  '',
  '      at Object.<anonymous> (src/auth/refresh.test.ts:42:15)',
  '      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)',
  '      at new Promise (<anonymous>)',
  '',
  'Tests:       1 failed, 3 passed, 4 total',
  'npm ERR! Test failed.  See above for more details.');
const JEST_THROW = L(
  'FAIL src/ui/menu.test.js',
  '  ● Menu › renders items',
  '',
  '    TypeError: Cannot read properties of undefined (reading \'map\')',
  '',
  '      at Menu (/home/max/proj/src/ui/Menu.js:12:20)',
  '      at renderWithHooks (/home/max/proj/node_modules/react-dom/cjs/react-dom.development.js:14985:18)',
  '',
  'Test Suites: 1 failed, 1 total');
const JEST_SYNTAX = L(
  'FAIL src/db/migrate.test.ts',
  '  ● Test suite failed to run',
  '',
  '    SyntaxError: /home/max/proj/src/db/migrate.ts: Unexpected token (14:2)',
  '',
  'Test Suites: 1 failed, 1 total');
const JEST_OK = L('PASS src/auth/refresh.test.ts', '  refresh', '    ✓ rotates the token (3 ms)', '', 'Test Suites: 1 passed, 1 total', 'Tests:       4 passed, 4 total', 'Time:        0.8 s');
const VITEST_FAIL = L(
  ' RUN  v1.6.0 /home/max/proj',
  '',
  ' ❯ src/auth/refresh.test.ts (4 tests | 1 failed) 12ms',
  '   × refresh > rotates the token',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  src/auth/refresh.test.ts > refresh > rotates the token',
  'AssertionError: expected \'a\' to be \'b\' // Object.is equality',
  ' ❯ src/auth/refresh.test.ts:42:17',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 3 passed (4)');
const PYTEST_FAIL = L(
  '============================= test session starts ==============================',
  'platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0',
  'collected 4 items',
  '',
  'tests/test_auth.py ..F.                                                  [100%]',
  '',
  '=================================== FAILURES ===================================',
  '_________________________________ test_refresh _________________________________',
  '',
  '    def test_refresh():',
  '>       assert rotate("a") == "b"',
  'E       AssertionError: assert \'a\' == \'b\'',
  '',
  'tests/test_auth.py:12: AssertionError',
  '=========================== short test summary info ============================',
  'FAILED tests/test_auth.py::test_refresh - AssertionError: assert \'a\' == \'b\'',
  '========================= 1 failed, 3 passed in 0.12s ==========================');
const PYTEST_COLLECT = L(
  '=================================== ERRORS ====================================',
  '____________________ ERROR collecting tests/test_db.py ____________________',
  'E     File "/home/max/proj/tests/test_db.py", line 7',
  'E       def broken(:',
  'E                  ^',
  'E   SyntaxError: invalid syntax',
  '=========================== short test summary info ============================',
  'ERROR tests/test_db.py',
  '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!');
const PYTEST_OK = L('============================= test session starts ==============================', 'collected 5 items', '', 'tests/test_auth.py .....  [100%]', '', '======================== 5 passed, 1 warning in 0.12s =========================');
const GO_FAIL = L(
  '--- FAIL: TestRefresh (0.00s)',
  '    refresh_test.go:42: expected b, got a',
  'FAIL',
  'FAIL\texample.com/proj/auth\t0.012s',
  'FAIL');
const GO_BUILD = L('# example.com/proj/auth', './refresh.go:12:2: undefined: rotateToken', 'FAIL\texample.com/proj/auth [build failed]');
const GO_PANIC = L(
  'panic: runtime error: index out of range [3] with length 3',
  '',
  'goroutine 1 [running]:',
  'main.load(...)',
  '\t/home/max/proj/cmd/load.go:31 +0x1d',
  'main.main()',
  '\t/home/max/proj/cmd/main.go:9 +0x25',
  'runtime.main()',
  '\t/usr/local/go/src/runtime/proc.go:267 +0x2bb',
  'exit status 2');
const GO_OK = L('ok  \texample.com/proj/auth\t0.012s', 'ok  \texample.com/proj/db\t(cached)');
const CARGO_FAIL = L(
  'running 2 tests',
  'test tests::it_works ... ok',
  'test tests::refresh ... FAILED',
  '',
  'failures:',
  '',
  '---- tests::refresh stdout ----',
  'thread \'tests::refresh\' panicked at src/lib.rs:42:9:',
  'assertion `left == right` failed',
  '  left: 1',
  ' right: 2',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  'error: test failed, to rerun pass `--lib`');
const CARGO_COMPILE = L(
  '   Compiling proj v0.1.0 (/home/max/proj)',
  'error[E0425]: cannot find value `tokn` in this scope',
  '  --> src/auth/refresh.rs:14:9',
  '   |',
  '14 |     tokn.rotate()',
  '   |     ^^^^ help: a local variable with a similar name exists: `token`',
  '',
  'error: could not compile `proj` (lib) due to 1 previous error');
const CARGO_OK = L('   Compiling proj v0.1.0 (/home/max/proj)', 'warning: unused variable: `x`', '    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.52s', 'running 3 tests', 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s');
const NPM_MISSING_SCRIPT = L('npm ERR! Missing script: "tset"', 'npm ERR! ', 'npm ERR! To see a list of scripts, run:', 'npm ERR!   npm run', '', 'npm ERR! A complete log of this run can be found in:', 'npm ERR!     /home/max/.npm/_logs/2026-10-23T10_15_30_123Z-debug-0.log');
const NPM_ENOENT = L('npm ERR! code ENOENT', 'npm ERR! syscall open', 'npm ERR! path /home/max/proj/package.json', 'npm ERR! errno -2', 'npm ERR! enoent ENOENT: no such file or directory, open \'/home/max/proj/package.json\'', 'npm ERR! enoent This is related to npm not being able to find a file.');
const NPM_WARN = L('npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory.', 'npm WARN deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported', '', 'added 412 packages, and audited 413 packages in 9s', 'found 0 vulnerabilities');
const TSC_PAREN = L('src/auth/refresh.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.', 'src/db/migrate.ts(3,10): error TS2305: Module \'"./pool"\' has no exported member \'Pool\'.');
const TSC_PRETTY = L(
  'src/auth/refresh.ts:12:5 - error TS2322: Type \'string\' is not assignable to type \'number\'.',
  '',
  '12     const n: number = token;',
  '           ~',
  '',
  'Found 1 error in src/auth/refresh.ts:12');
const TSC_OK = 'Found 0 errors. Watching for file changes.';
const NODE_CRASH = L(
  '/home/max/proj/src/server.js:12',
  '    throw new Error(\'boom\');',
  '    ^',
  '',
  'Error: boom',
  '    at Object.<anonymous> (/home/max/proj/src/server.js:12:11)',
  '    at Module._compile (node:internal/modules/cjs/loader:1256:14)',
  '    at Module.load (node:internal/modules/cjs/loader:1119:32)',
  '    at node:internal/main/run_main_module:28:49',
  '',
  'Node.js v20.5.0');
const NODE_ESM_WIN = L(
  'file:///C:/proj/src/app.mjs:7',
  'TypeError: cfg.load is not a function',
  '    at start (file:///C:/proj/src/app.mjs:7:7)',
  '    at file:///C:/proj/src/main.mjs:3:1',
  '    at ModuleJob.run (node:internal/modules/esm/module_job:194:25)');
const NODE_WARN = '(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)';
const PY_TRACE = L(
  'Traceback (most recent call last):',
  '  File "/home/max/proj/app/main.py", line 14, in <module>',
  '    run()',
  '  File "/home/max/proj/app/jobs.py", line 31, in run',
  '    data = json.loads(raw)',
  '  File "/usr/lib/python3.11/json/__init__.py", line 346, in loads',
  '    return _default_decoder.decode(s)',
  '  File "/home/max/.venv/lib/python3.11/site-packages/requests/api.py", line 59, in get',
  '    raise ValueError("bad")',
  'ValueError: Expecting value: line 1 column 1 (char 0)');
const PY_WIN = L(
  'Traceback (most recent call last):',
  '  File "C:\\proj\\tools\\build.py", line 8, in <module>',
  '    main()',
  '  File "C:\\Users\\max\\AppData\\Local\\Programs\\Python\\Python311\\Lib\\shutil.py", line 256, in copyfile',
  '    with open(src, \'rb\') as fsrc:',
  'FileNotFoundError: [Errno 2] No such file or directory: \'dist/app.exe\'');
const PY_PERM = L('Traceback (most recent call last):', '  File "/home/max/proj/sync.py", line 5, in <module>', '    open("/etc/hosts", "w")', 'PermissionError: [Errno 13] Permission denied: \'/etc/hosts\'');
const PS_EN = L(
  'Get-Content : Cannot find path \'C:\\proj\\src\\conf.json\' because it does not exist.',
  'At line:1 char:1',
  '+ Get-Content src\\conf.json',
  '+ ~~~~~~~~~~~~~~~~~~~~~~~~~',
  '    + CategoryInfo          : ObjectNotFound: (C:\\proj\\src\\conf.json:String) [Get-Content], ItemNotFoundException',
  '    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand');
const PS_IT = L(
  'Get-Content : Impossibile trovare il percorso \'C:\\proj\\src\\conf.json\' perché non esiste.',
  'In riga:1 car:1',
  '+ Get-Content src\\conf.json',
  '    + CategoryInfo          : ObjectNotFound: (C:\\proj\\src\\conf.json:String) [Get-Content], ItemNotFoundException',
  '    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand');
const PS_CMD_IT = L(
  'foo : Termine \'foo\' non riconosciuto come nome di cmdlet, funzione, programma eseguibile o file script.',
  'In riga:1 car:1',
  '+ foo',
  '+ ~~~',
  '    + CategoryInfo          : ObjectNotFound: (foo:String) [], CommandNotFoundException',
  '    + FullyQualifiedErrorId : CommandNotFoundException');
const PS_DENIED = L(
  'Set-Content : Accesso al percorso \'C:\\Windows\\hosts\' negato.',
  'In riga:1 car:1',
  '    + CategoryInfo          : PermissionDenied: (C:\\Windows\\hosts:String) [Set-Content], UnauthorizedAccessException');

function classifyTests(ok) {
  let r = classifyFailure(JEST_FAIL, 'npm test');
  ok(is(r, 'test', 'jest') && r.excerpt === '● refresh › rotates the token', 'jest: test fallito, riassunto dal nome del test');
  r = classifyFailure(JEST_THROW, 'npx jest src/ui');
  ok(is(r, 'test', 'jest') && /^TypeError: Cannot read/.test(r.excerpt), 'jest: eccezione nel test, riassunto dall\'errore');
  ok(is(classifyFailure(JEST_SYNTAX, 'npm test'), 'syntax', 'jest'), 'jest: la suite non parte per un errore di sintassi');
  ok(classifyFailure(JEST_OK, 'npm test') === null, 'jest: tutti i test passano, nessun fallimento');
  r = classifyFailure(VITEST_FAIL, 'npm test');
  ok(is(r, 'test', 'vitest') && /^AssertionError: expected 'a'/.test(r.excerpt), 'vitest: test fallito');
  r = classifyFailure(PYTEST_FAIL, 'pytest -q');
  ok(is(r, 'test', 'pytest') && r.excerpt === 'AssertionError: assert \'a\' == \'b\'', 'pytest: test fallito, riga "E" ripulita');
  ok(is(classifyFailure(PYTEST_COLLECT, 'python -m pytest'), 'syntax', 'pytest'), 'pytest: errore di sintassi durante la raccolta');
  ok(classifyFailure(PYTEST_OK, 'pytest') === null, 'pytest: 5 passati con un avviso, nessun fallimento');
  r = classifyFailure(GO_FAIL, 'go test ./...');
  ok(is(r, 'test', 'go') && r.excerpt === '--- FAIL: TestRefresh (0.00s)', 'go test: test fallito');
  ok(is(classifyFailure(GO_BUILD, 'go test ./auth'), 'syntax', 'go'), 'go test: il pacchetto non compila');
  ok(is(classifyFailure(GO_PANIC, 'go run ./cmd'), 'command', 'go'), 'go: panic a runtime, comando fallito');
  ok(classifyFailure(GO_OK, 'go test ./...') === null, 'go test: ok, nessun fallimento');
  r = classifyFailure(CARGO_FAIL, 'cargo test');
  ok(is(r, 'test', 'cargo') && /^thread 'tests::refresh' panicked/.test(r.excerpt), 'cargo test: test fallito');
  r = classifyFailure(CARGO_COMPILE, 'cargo build');
  ok(is(r, 'syntax', 'cargo') && /^error\[E0425\]/.test(r.excerpt), 'cargo: errore di compilazione');
  ok(classifyFailure(CARGO_OK, 'cargo test') === null, 'cargo test: ok con un warning, nessun fallimento');
  r = classifyFailure(NPM_MISSING_SCRIPT, 'npm run tset');
  ok(is(r, 'command', 'npm') && r.excerpt === 'Missing script: "tset"', 'npm ERR!: script inesistente');
  r = classifyFailure(NPM_ENOENT, 'npm install');
  ok(is(r, 'missing', 'npm') && /^enoent ENOENT: no such file/.test(r.excerpt), 'npm ERR!: package.json mancante');
  ok(classifyFailure(NPM_WARN, 'npm install') === null, 'npm WARN: solo avvisi, nessun fallimento');
  r = classifyFailure(TSC_PAREN, 'npx tsc --noEmit');
  ok(is(r, 'syntax', 'tsc') && /^src\/auth\/refresh\.ts\(12,5\): error TS2322/.test(r.excerpt), 'tsc: file(12,5): error TS');
  ok(is(classifyFailure(TSC_PRETTY, 'npm run build'), 'syntax', 'tsc'), 'tsc: file:12:5 - error TS');
  ok(is(classifyFailure('> proj@1.0 build\n> tsc\n\n' + TSC_PAREN + '\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 2', 'npm run build'), 'syntax', 'tsc'), 'tsc dentro npm: vince tsc');
  ok(classifyFailure(TSC_OK, 'tsc -w') === null, 'tsc: "Found 0 errors", nessun fallimento');
  r = classifyFailure(NODE_CRASH, 'node src/server.js');
  ok(is(r, 'command', 'node') && r.excerpt === 'Error: boom', 'node: eccezione con stack, riassunto da "Error: boom"');
  ok(is(classifyFailure(NODE_ESM_WIN, ''), 'command', 'node'), 'node: stack ESM su Windows');
  ok(is(classifyFailure('node:internal/modules/cjs/loader:1080\n  throw err;\n  ^\n\nError: Cannot find module \'/home/max/proj/scripts/gen.js\'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1077:15)\n\nNode.js v20.5.0', 'node scripts/gen.js'), 'missing', 'node'), 'node: modulo mancante');
  ok(classifyFailure(NODE_WARN, 'node app.js') === null, 'node: DeprecationWarning, nessun fallimento');
  r = classifyFailure(PY_TRACE, 'python app/main.py');
  ok(is(r, 'command', 'python') && /^ValueError: Expecting value/.test(r.excerpt), 'python: traceback, riassunto dall\'eccezione finale');
  ok(is(classifyFailure(PY_WIN, 'python tools\\build.py'), 'missing', 'python'), 'python: FileNotFoundError su Windows');
  ok(is(classifyFailure(PY_PERM, 'python sync.py'), 'permission', 'python'), 'python: PermissionError');
  ok(is(classifyFailure('  File "/home/max/proj/x.py", line 3\n    def f(:\n          ^\nSyntaxError: invalid syntax', 'python x.py'), 'syntax', 'python'), 'python: SyntaxError');
  r = classifyFailure(PS_EN, '');
  ok(is(r, 'missing', 'powershell') && /^Get-Content : Cannot find path/.test(r.excerpt), 'PowerShell: percorso mancante (inglese)');
  r = classifyFailure(PS_IT, '');
  ok(is(r, 'missing', 'powershell') && /Impossibile trovare il percorso/.test(r.excerpt), 'PowerShell: "Impossibile trovare" (italiano)');
  ok(is(classifyFailure(PS_CMD_IT, ''), 'command', 'powershell'), 'PowerShell: comando sconosciuto (italiano)');
  ok(is(classifyFailure(PS_DENIED, ''), 'permission', 'powershell'), 'PowerShell: accesso negato (italiano)');
  r = classifyFailure('bash: pnpm: command not found', 'pnpm i');
  ok(is(r, 'command', 'shell') && r.excerpt === 'bash: pnpm: command not found', 'bash: command not found');
  ok(is(classifyFailure('zsh: command not found: rg', 'rg foo'), 'command', 'shell'), 'zsh: command not found');
  ok(is(classifyFailure('\'pnpm\' is not recognized as an internal or external command,\noperable program or batch file.', 'pnpm i'), 'command', 'shell'), 'cmd: is not recognized as an internal or external command');
  ok(is(classifyFailure('bash: rg: comando non trovato', 'rg foo'), 'command', 'shell'), 'bash in italiano: comando non trovato');
  ok(is(classifyFailure('bash: ./deploy.sh: Permesso negato', './deploy.sh'), 'permission', 'shell'), 'bash in italiano: Permesso negato');
  ok(is(classifyFailure('cat: src/auth/sesion.ts: File o directory non esistente', 'cat src/auth/sesion.ts'), 'missing', 'shell'), 'cat in italiano: file mancante');
  ok(is(classifyFailure('ls: cannot access \'dist\': No such file or directory', 'ls dist'), 'missing', 'shell'), 'ls: file mancante');
  ok(is(classifyFailure('<tool_use_error>String to replace not found in file.\nString: const a = 1;</tool_use_error>', ''), 'edit', ''), 'Edit: la stringa da sostituire non c\'è');
  ok(is(classifyFailure('Command timed out after 2m 0.0s\n PASS src/a.test.ts', 'npm test'), 'timeout', 'jest'), 'timeout di Claude Code durante i test');
  ok(is(classifyFailure('curl: (28) Operation timed out after 10001 milliseconds with 0 bytes received', 'curl http://localhost:3000'), 'timeout', ''), 'curl: timeout');
  ok(classifyFailure('FAIL', 'ls') === null || classifyFailure('FAIL', 'ls').kind !== 'test', '"FAIL" senza un comando di test non è un test fallito');
  ok(is(classifyFailure('3 passing (12ms)\n1 failing\n\n1) auth\n   refresh:\n   AssertionError: expected 1 to equal 2', 'npm test'), 'test', 'npm'), 'mocha via npm test: "FAIL" + comando di test = test');
  ok(is(classifyFailure('..F.\nE   assert 1 == 2\ntests/test_a.py:3: AssertionError\n1 failed, 3 passed in 0.12s', 'pytest -q'), 'test', 'pytest'), 'pytest -q: test fallito senza le cornici');
  ok(is(classifyFailure('src/a.js\n  3:7  error  \'x\' is not defined  no-undef\n\n✖ 1 problem (1 error, 0 warnings)', 'npx eslint src'), 'command', ''), 'eslint: "1 error", comando fallito');
  ok(classifyFailure('src/a.js:12: // TODO handle error\nsrc/b.js:3: throw new Error("x")', 'grep -rn error src') === null, 'grep che trova la parola "error": nessun fallimento');
  ok(is(classifyFailure('Impossibile trovare il percorso specificato.', 'cd x'), 'missing', ''), 'cmd in italiano: percorso non trovato');
  ok(is(classifyFailure('\'foo\' non è riconosciuto come comando interno o esterno,\n un programma eseguibile o un file batch.', 'foo'), 'command', 'shell'), 'cmd in italiano: comando non riconosciuto');
  ok(is(classifyFailure('fatal: not a git repository (or any of the parent directories): .git', 'git status'), 'command', ''), 'git: fatal, comando fallito');
  ok(classifyFailure('', 'npm test') === null, 'output vuoto: nessun fallimento');
  ok(classifyFailure('On branch main\nnothing to commit, working tree clean', 'git status') === null, 'git status pulito: nessun fallimento');
  ok(classifyFailure('Compiled successfully in 1.2s\n0 errors, 2 warnings', 'npm run build') === null, '"0 errors, 2 warnings": nessun fallimento');
}

function excerptTests(ok) {
  ok(errorExcerpt('\x1b[31m\x1b[1mError\x1b[22m: listen EADDRINUSE: address already in use :::3000\x1b[39m') === 'Error: listen EADDRINUSE: address already in use :::3000', 'estratto: senza colori ANSI');
  ok(errorExcerpt('\n\n2026-10-23T10:15:30.123Z ERROR db: connection refused\n') === 'ERROR db: connection refused', 'estratto: senza orario ISO e righe vuote');
  ok(errorExcerpt('[10:15:30] Starting...\n[10:15:31] fatal: remote origin already exists.') === 'fatal: remote origin already exists.', 'estratto: senza orario tra parentesi');
  ok(errorExcerpt('> proj@1.0.0 lint\n> eslint .\n\nnpm ERR! npm ERR! Missing script: "lint:fix"') === 'Missing script: "lint:fix"', 'estratto: salta l\'eco degli script e i prefissi npm ripetuti');
  ok(errorExcerpt('npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\nnpm ERR! proj@1.0.0 build: `webpack`\nnpm ERR! Exit status 1\nnpm ERR!\nnpm ERR! Failed at the proj@1.0.0 build script.') === 'Failed at the proj@1.0.0 build script.', 'estratto: npm ELIFECYCLE senza code/errno');
  ok(errorExcerpt(NODE_CRASH) === 'Error: boom', 'estratto: Node, non la riga di codice "throw new Error"');
  ok(errorExcerpt(PY_WIN) === 'FileNotFoundError: [Errno 2] No such file or directory: \'dist/app.exe\'', 'estratto: traceback Python, l\'ultima eccezione');
  ok(errorExcerpt('Exit code 1\nnpm WARN config production Use `--omit=dev` instead.\nsh: 1: jest: not found') === 'sh: 1: jest: not found', 'estratto: salta "Exit code" e gli avvisi');
  const long = errorExcerpt('Error: ' + 'x'.repeat(400));
  ok(long.length === 160 && long.endsWith('…'), 'estratto: al massimo 160 caratteri');
  ok(errorExcerpt('\n   \n\x1b[0m\n') === '', 'estratto: niente di significativo → stringa vuota');
  ok(errorExcerpt('just some text\nmore text') === 'just some text', 'estratto: senza errori riconoscibili, la prima riga utile');
}

function refsTests(ok) {
  const CWD = '/home/max/proj';
  // 1. jest: frame relativi, node_modules e <anonymous> scartati
  let r = extractErrorRefs(JEST_FAIL, CWD);
  ok(same(r.refs, ['src/auth/refresh.test.ts:42']) && r.discarded === 2, 'jest: il file del test; node_modules e <anonymous> scartati e contati');
  // 2. Node assoluti con frame interni
  r = extractErrorRefs(NODE_CRASH, CWD);
  ok(same(r.refs, ['src/server.js:12']) && r.discarded === 3, 'Node: at fn (percorso:riga:col), node:internal scartato (3 frame)');
  // 3. jest con percorso assoluto, react-dom in node_modules scartato
  r = extractErrorRefs(JEST_THROW, CWD);
  ok(same(r.refs, ['src/ui/Menu.js:12']) && r.discarded === 1, 'jest: percorso assoluto dentro il progetto');
  // 4. Node ESM su Windows: file:///C:/…, anche "at percorso:riga:col" senza funzione
  r = extractErrorRefs(NODE_ESM_WIN, 'C:\\proj');
  ok(same(r.refs, ['src/app.mjs:7', 'src/main.mjs:3']) && r.discarded === 1, 'Node ESM: file:///C:/… e at percorso:riga:col');
  // 5. Python: progetto sì, lib/python3.x e site-packages no
  r = extractErrorRefs(PY_TRACE, CWD);
  ok(same(r.refs, ['app/main.py:14', 'app/jobs.py:31']) && r.discarded === 2, 'Python: File "x.py", line N; lib/python3.11 e site-packages scartati');
  // 6. Python su Windows: barre rovesciate, Python311\Lib scartato
  r = extractErrorRefs(PY_WIN, 'C:\\proj');
  ok(same(r.refs, ['tools/build.py:8']) && r.discarded === 1, 'Python su Windows: C:\\proj\\tools\\build.py; la libreria standard scartata');
  // 7. pytest: percorso.py:riga e la riga "E File ..." della raccolta
  r = extractErrorRefs(PYTEST_FAIL, CWD);
  ok(same(r.refs, ['tests/test_auth.py:12']), 'pytest: tests/test_auth.py:12: AssertionError');
  r = extractErrorRefs(PYTEST_COLLECT, CWD);
  ok(same(r.refs, ['tests/test_db.py:7']), 'pytest: errore di raccolta con File "…", line N');
  // 8. tsc con le parentesi, più file
  r = extractErrorRefs(TSC_PAREN, CWD);
  ok(same(r.refs, ['src/auth/refresh.ts:12', 'src/db/migrate.ts:3']) && r.discarded === 0, 'tsc: percorso(riga,col): error TS');
  // 9. tsc --pretty e gcc/clang: percorso:riga:col: error
  r = extractErrorRefs(TSC_PRETTY, CWD);
  ok(same(r.refs, ['src/auth/refresh.ts:12']), 'tsc: percorso:riga:col - error TS');
  r = extractErrorRefs('src/codec.c:88:14: error: \'len\' undeclared (first use in this function)\nsrc/codec.c:88:14: note: each undeclared identifier is reported only once\n/usr/include/stdio.h:12:1: error: conflicting types', CWD);
  ok(same(r.refs, ['src/codec.c:88']) && r.discarded === 1, 'gcc: percorso:riga:col: error; /usr/include scartato; le note non contano');
  r = extractErrorRefs('C:\\proj\\src\\main.cpp:14:5: fatal error: missing.h: No such file or directory', 'C:\\proj');
  ok(same(r.refs, ['src/main.cpp:14']), 'clang su Windows: C:\\…\\main.cpp:14:5: fatal error');
  r = extractErrorRefs('/home/max/proj/src/a.js:3:7: \'x\' is not defined. [Error/no-undef]\n/home/max/proj/src/b.js:1:1: Unexpected console statement. [Warning/no-console]', CWD);
  ok(same(r.refs, ['src/a.js:3']), 'eslint (formato unix): solo gli errori, non gli avvisi');
  // 10. MSBuild/tsc su Windows con le parentesi
  r = extractErrorRefs('C:\\proj\\App\\Program.cs(12,5): error CS1002: ; expected [C:\\proj\\App\\App.csproj]', 'C:/proj');
  ok(same(r.refs, ['App/Program.cs:12']), 'MSBuild su Windows: C:\\…\\Program.cs(12,5): error');
  // 11. go test: percorso relativo al pacchetto, dalla cartella della shell (cd)
  r = extractErrorRefs(GO_FAIL, CWD, '/home/max/proj/auth');
  ok(same(r.refs, ['auth/refresh_test.go:42']), 'go test: refresh_test.go:42 dalla cartella in cui la shell ha fatto cd');
  r = extractErrorRefs(GO_BUILD, CWD, '/home/max/proj/auth');
  ok(same(r.refs, ['auth/refresh.go:12']), 'go build: ./refresh.go:12:2 risolto dalla cartella della shell');
  // 12. go panic: frame del progetto sì, runtime di Go no
  r = extractErrorRefs(GO_PANIC, CWD);
  ok(same(r.refs, ['cmd/load.go:31', 'cmd/main.go:9']) && r.discarded === 1, 'go panic: frame del progetto; /usr/local/go scartato');
  // 13. Rust: --> percorso:riga:col e panic
  r = extractErrorRefs(CARGO_COMPILE, CWD);
  ok(same(r.refs, ['src/auth/refresh.rs:14']), 'Rust: --> src/auth/refresh.rs:14:9');
  r = extractErrorRefs(CARGO_FAIL, CWD);
  ok(same(r.refs, ['src/lib.rs:42']), 'Rust: panicked at src/lib.rs:42:9');
  r = extractErrorRefs('thread \'main\' panicked at \'called `Option::unwrap()` on a `None` value\', /home/max/.cargo/registry/src/index.crates.io-6f17d22bba15001f/toml-0.5.11/src/de.rs:120:5', CWD);
  ok(!r.refs.length && r.discarded === 1, 'Rust: panic nel registro di cargo scartato');
  // 14. Vitest: ❯ percorso:riga:col
  r = extractErrorRefs(VITEST_FAIL, CWD);
  ok(same(r.refs, ['src/auth/refresh.test.ts:42']), 'Vitest: ❯ src/auth/refresh.test.ts:42:17');
  // 15. cd relativo e ./ e ../ nella cartella della shell
  r = extractErrorRefs('    at load (./lib/cfg.js:4:2)\n    at main (../shared/util.js:9:1)', CWD, '/home/max/proj/web');
  ok(same(r.refs, ['web/lib/cfg.js:4', 'shared/util.js:9']), 'shell in web/: ./lib e ../shared normalizzati');
  // 16. percorsi Windows con barre doppie (JSON) e con spazi, cartella del progetto in maiuscolo diverso
  r = extractErrorRefs('    at run (C:\\\\Users\\\\Max Pane\\\\proj\\\\src\\\\job.ts:22:3)\n    at C:\\Users\\Max Pane\\proj\\src\\main.ts:5:1\n    at x (C:\\Program Files\\nodejs\\node_modules\\npm\\lib\\cli.js:1:1)', 'c:/users/max pane/proj');
  ok(same(r.refs, ['src/job.ts:22', 'src/main.ts:5']) && r.discarded === 1, 'Windows: barre doppie, spazi, maiuscole; Program Files scartato');
  // 17. file fuori dal progetto: restano, come abs:
  r = extractErrorRefs('    at boot (/opt/tools/runner.js:3:9)', CWD);
  ok(same(r.refs, ['abs:/opt/tools/runner.js:3']), 'file fuori dal progetto: abs:…');
  // 18. doppioni, ordine di apparizione, massimo 30
  const many = Array.from({ length: 40 }, (_, i) => `    at f${i} (src/m${i % 35}.js:${i % 35 + 1}:1)`).join('\n');
  r = extractErrorRefs('    at b (src/b.js:2:1)\n    at a (src/a.js:1:1)\n    at b (src/b.js:2:1)\n', CWD);
  ok(same(r.refs, ['src/b.js:2', 'src/a.js:1']), 'doppioni tolti, ordine di apparizione');
  r = extractErrorRefs(many, CWD);
  ok(r.refs.length === 30 && r.refs[0].file === 'src/m0.js' && r.refs[29].file === 'src/m29.js', 'al massimo 30 riferimenti, i primi');
  // 19. nessun file citato
  r = extractErrorRefs('bash: pnpm: command not found', CWD);
  ok(!r.refs.length && r.discarded === 0, 'nessun file citato: elenco vuoto');
  ok(!extractErrorRefs('', CWD).refs.length, 'output vuoto: elenco vuoto');
}

function run(ok) {
  console.log('sorprese: classificazione dei fallimenti');
  classifyTests(ok);
  console.log('sorprese: estratto dell\'errore');
  excerptTests(ok);
  console.log('sorprese: file citati dall\'errore');
  refsTests(ok);
}

module.exports = { run };

if (require.main === module) {
  require('./test-guard').requireTempDataDir('unit-surprise'); // mai nei dati veri: solo con PLATYPUS_DATA_DIR in una cartella temporanea
  let failed = 0;
  run((cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
}
