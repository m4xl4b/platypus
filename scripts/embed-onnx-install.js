#!/usr/bin/env node
'use strict';
// npm run embed:onnx:install — installa il provider ONNX facoltativo (optional/embed-onnx) e scarica il suo modello.
// È l'unica chiamata di rete nuova del significato neurale, ed è sempre esplicita: prima dice quanto pesa e chiede
// conferma. Dopo, durante l'uso, il modello gira sul computer e non va più in rete.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'optional', 'embed-onnx');
const onnx = require(DIR);
const { dataDir } = require(path.join(ROOT, 'src', 'paths'));

function say(msg) { console.log('[platypus] ' + msg); }
function ask(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    rl.question(q, a => { done = true; rl.close(); resolve(String(a || '').trim().toLowerCase()); });
    rl.on('close', () => { if (!done) resolve(''); });
  });
}

(async () => {
  const modelsDir = path.join(dataDir(), 'models');
  const lock = fs.existsSync(path.join(DIR, 'package-lock.json'));
  say('Significato più preciso (facoltativo): il modello ' + onnx.MODEL + ' gira sul tuo computer, in un thread a parte.');
  say('More precise meaning (optional): the model ' + onnx.MODEL + ' runs on your computer, in a separate thread.');
  say('Scarica · downloads:');
  say('  - i pacchetti npm di ' + path.relative(ROOT, DIR) + ' (@huggingface/transformers e onnxruntime-node, circa 380 MB · about 380 MB)');
  say('  - il modello (' + onnx.DTYPE + ', circa ' + onnx.SIZE_MB + ' MB · about ' + onnx.SIZE_MB + ' MB) in ' + modelsDir);
  say('Da registry.npmjs.org e huggingface.co. Non manda niente delle tue sessioni · Nothing from your sessions is sent.');
  const a = await ask('Procedo? · Go ahead? [s/y/N] ');
  if (!['s', 'si', 'sì', 'y', 'yes'].includes(a)) { say('Annullato: non ho scaricato niente · Cancelled: nothing was downloaded.'); process.exit(1); }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // su Windows npm è un .cmd e va lanciato con la shell: allora un comando solo, senza argomenti a parte (sono fissi)
  const args = [lock ? 'ci' : 'install', '--no-audit', '--no-fund', '--omit=dev'];
  const r = process.platform === 'win32' ? spawnSync(npm + ' ' + args.join(' '), { cwd: DIR, stdio: 'inherit', shell: true }) : spawnSync(npm, args, { cwd: DIR, stdio: 'inherit' });
  if (r.status !== 0) { say('npm non è riuscito · npm failed (' + (r.status ?? r.error) + ').'); process.exit(1); }
  try {
    const info = await onnx.download(modelsDir, { log: say });
    say('Fatto: ' + info.model + ', ' + info.dim + ' dimensioni. Nelle opzioni, «Motore del significato» su ONNX (in automatico si usa solo una fonte calibrata).');
    say('Done: ' + info.model + ', ' + info.dim + ' dimensions. In the options, set "Meaning engine" to ONNX (automatic mode uses calibrated sources only).');
  } catch (e) {
    say('Il modello non si è scaricato · the model download failed: ' + e.message);
    process.exit(1);
  }
})();
