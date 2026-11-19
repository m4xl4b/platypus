#!/usr/bin/env node
'use strict';
// Prova su una sessione vera di Claude Code (piano 2.11, docs/plans/2.11-real-check.md): quali risposte degli hook
// arrivano davvero al modello. La lancia Max, non il loop: la sessione di prova usa il suo account.
//
//   node scripts/feedback-check.js [--curl] [--port 47811]
//
// Prepara una cartella usa e getta con gli hook SOLO lì dentro (.claude/settings.json del progetto: il tuo
// ~/.claude/settings.json non viene toccato) e avvia un Platypus di prova su un'altra porta, con dati temporanei e senza
// leggere le tue sessioni. A ogni hook risponde con un marcatore fisso (PLATY-START, PLATY-PRE, PLATY-POST, PLATY-FAIL,
// PLATY-STOP): quelli che il modello ti sa ripetere sono quelli che gli arrivano. Ctrl+C per finire.

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const useCurl = args.includes('--curl');
const pi = args.indexOf('--port');
const port = (pi >= 0 && Number(args[pi + 1])) || 47811;
const url = `http://127.0.0.1:${port}/platypus-hook/feedback`;

const root = path.join(os.tmpdir(), 'platypus-feedback-check');
const proj = path.join(root, 'project'), data = path.join(root, 'data');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.mkdirSync(path.join(data, 'claude', 'projects'), { recursive: true });

// gli hook della cartella di prova: http (quelli che userà la 2.11) oppure, con --curl, il comando degli hook di oggi
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
const hook = useCurl
  ? { type: 'command', command: `${curl} -s -m 2 -X POST -H "Content-Type: application/json" --data-binary "@-" ${url}`, timeout: 3 }
  : { type: 'http', url, timeout: 3 };
const tools = { matcher: '*', hooks: [hook] }, plain = { hooks: [hook] };
const settings = { hooks: { SessionStart: [plain], PreToolUse: [tools], PostToolUse: [tools], PostToolUseFailure: [tools], Stop: [plain] } };
fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'platypus-feedback-check', private: true, scripts: { test: 'node -e "console.error(\'FAIL: 1 test failed\'); process.exit(1)"' } }, null, 2) + '\n');
fs.writeFileSync(path.join(proj, 'notes.txt'), 'This folder only exists to check Platypus hooks. Nothing here needs fixing.\n');

const PROMPT = 'This is a test of hooks, do not fix anything. 1) Run `npm test` once (it fails on purpose). 2) Read notes.txt. 3) Try to read missing.txt (it does not exist). Then list every line of context you received that starts with "Platypus check", quoted exactly, and say after which step you saw each one.';

process.env.PLATYPUS_FEEDBACK_CHECK = '1';
const { startCore } = require(path.join(__dirname, '..', 'src', 'core'));
const core = startCore({ port, base: path.join(data, 'claude'), includeCowork: false, settingsPath: path.join(data, 'settings.json'), bottegaDir: path.join(data, 'bottega'), fetch: async () => { throw new Error('offline'); } });
core.ready.then(() => {
  console.log(`
Platypus feedback check · listening on ${url}
Hooks: ${useCurl ? 'command (curl)' : 'http'}, only inside the test folder.

1. Open another terminal in this folder (or open it in the Claude desktop app):
     ${proj}
2. Start Claude Code there (it may ask to trust the folder and its hooks: say yes), and send this prompt:

     ${PROMPT}

3. Watch this terminal: every hook that arrives is printed as a [feedback-check] line.
4. Copy Claude's answer and these lines into the Journal entry described in docs/plans/2.11-real-check.md.
5. Press Ctrl+C here, then send one more prompt in the same session ("read notes.txt again"):
   Claude Code must work as usual with Platypus closed.
6. Delete the folder when you are done: ${root}
`);
}).catch(err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is busy: try --port ${port + 1}` : err);
  process.exit(1);
});
process.on('SIGINT', () => {
  console.log(`\nHook calls received: ${core.feedbackStats.calls}. Platypus check closed: now try step 5.`);
  try { core.stop(); } catch {}
  process.exit(0);
});
