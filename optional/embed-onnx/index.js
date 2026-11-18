'use strict';
// Provider ONNX facoltativo di Platypus: un modello multilingue piccolo che gira sul computer, in un worker_thread.
// Lo stesso contratto dei provider del motore (src/core/embed): { id, dim, embed(texts, kind), ready() }.
//
// Si installa a parte con `npm run embed:onnx:install`, che chiede conferma, esegue npm in questa cartella e
// scarica il modello in <cartella dei dati>/models/ (l'unica chiamata di rete nuova, sempre esplicita).
// Durante l'uso non scarica mai niente: i modelli remoti sono spenti.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MODEL = 'Xenova/multilingual-e5-small'; // MIT, 384 dimensioni, ~100 lingue tra cui l'italiano
const DTYPE = 'q8';                           // il file quantizzato: circa 118 MB invece di circa 470
const SIZE_MB = 118;
const MARKER = '.platypus-ok';                // scritto dopo uno scaricamento riuscito
const LOAD_MS = 60000;                        // la prima richiesta carica il modello: ci può mettere un po'

// i pacchetti npm sono installati in questa cartella?
function installed(transformers) {
  try { require.resolve(transformers || '@huggingface/transformers', { paths: [__dirname] }); return true; } catch { return false; }
}
function markerOf(modelsDir, model = MODEL) { return path.join(modelsDir, ...model.split('/'), MARKER); }
function hasModel(modelsDir, model = MODEL) { try { return !!modelsDir && fs.existsSync(markerOf(modelsDir, model)); } catch { return false; } }
const prefix = kind => (kind === 'query' ? 'query: ' : 'passage: '); // i modelli e5 li vogliono

// carica transformers.js (pacchetto ESM; per le prove un modulo finto indicato con un percorso)
async function loadTransformers(spec) {
  const m = await import(spec && path.isAbsolute(spec) ? pathToFileURL(spec).href : (spec || '@huggingface/transformers'));
  return m.pipeline ? m : m.default;
}

function create(settings = {}, { modelsDir, transformers, timeoutMs = 5000, model = MODEL, dtype = DTYPE } = {}) {
  const id = 'onnx:' + model;
  const p = { id, dim: 0, state: 'unknown', model, detail: '', hint: '', worker: null };
  const pending = new Map();
  let seq = 0, loaded = false;
  const fail = (state, detail, hint) => { Object.assign(p, { state, detail, hint: hint || '', dim: 0 }); return false; };

  function start() {
    if (p.worker) return;
    const { Worker } = require('worker_threads');
    p.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { model, dtype, modelsDir, transformers: transformers || null } });
    p.worker.unref();
    p.worker.on('message', m => { const w = pending.get(m.id); if (!w) return; pending.delete(m.id); m.error ? w.reject(new Error('onnx: ' + m.error)) : w.resolve(m.vecs.map(v => Float32Array.from(v))); });
    const down = e => { for (const w of pending.values()) w.reject(e); pending.clear(); p.worker = null; loaded = false; };
    p.worker.on('error', e => down(new Error('onnx: ' + e.message)));
    p.worker.on('exit', code => down(new Error('onnx: worker exited (' + code + ')')));
  }
  function ask(texts, ms) {
    start();
    return new Promise((resolve, reject) => {
      const n = ++seq;
      const timer = setTimeout(() => { pending.delete(n); reject(new Error('onnx: timeout ' + ms + ' ms')); }, ms);
      if (timer.unref) timer.unref();
      pending.set(n, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      p.worker.postMessage({ id: n, texts });
    });
  }

  p.ready = async () => {
    if (!installed(transformers)) return fail('not-installed', 'the npm packages of optional/embed-onnx are not installed', 'npm run embed:onnx:install');
    if (!hasModel(modelsDir, model)) return fail('not-installed', 'model not downloaded: ' + model, 'npm run embed:onnx:install');
    if (p.state === 'ready' && p.worker && p.dim) return true;
    try {
      const [v] = await ask([prefix('query') + 'ping'], LOAD_MS);
      loaded = true;
      Object.assign(p, { dim: v.length, state: 'ready', detail: '', hint: '' });
      return true;
    } catch (e) { return fail('error', e.message); }
  };
  // per le opzioni: installato e con il modello? Senza avviare il worker
  p.check = async () => {
    if (!installed(transformers)) return fail('not-installed', 'the npm packages of optional/embed-onnx are not installed', 'npm run embed:onnx:install');
    if (!hasModel(modelsDir, model)) return fail('not-installed', 'model not downloaded: ' + model, 'npm run embed:onnx:install');
    if (p.state !== 'ready') Object.assign(p, { state: 'ready', detail: '', hint: '' });
    return true;
  };
  p.embed = async (texts, kind) => {
    if (p.state !== 'ready' || !p.worker) throw new Error('onnx: not ready');
    return ask(texts.map(t => prefix(kind) + t), loaded ? timeoutMs : LOAD_MS);
  };
  p.stop = () => { if (p.worker) { const w = p.worker; p.worker = null; w.terminate().catch(() => {}); } };
  return p;
}

// per lo script di installazione: scarica il modello (l'unica volta in cui si va in rete) e lascia il segno
async function download(modelsDir, { transformers, model = MODEL, dtype = DTYPE, log = console.log } = {}) {
  fs.mkdirSync(modelsDir, { recursive: true });
  const T = await loadTransformers(transformers);
  T.env.allowRemoteModels = true;
  T.env.allowLocalModels = true;
  T.env.cacheDir = modelsDir;
  T.env.localModelPath = modelsDir;
  log('Downloading ' + model + ' (' + dtype + ') into ' + modelsDir + ' …');
  const pipe = await T.pipeline('feature-extraction', model, { dtype });
  const out = await pipe(['query: prova', 'passage: test'], { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  fs.mkdirSync(path.dirname(markerOf(modelsDir, model)), { recursive: true });
  fs.writeFileSync(markerOf(modelsDir, model), JSON.stringify({ model, dtype, dim, at: new Date().toISOString() }) + '\n');
  return { model, dtype, dim };
}

module.exports = { create, download, installed, hasModel, markerOf, loadTransformers, prefix, MODEL, DTYPE, SIZE_MB };
