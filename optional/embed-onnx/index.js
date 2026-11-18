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

// i modelli che il provider sa usare, ognuno con le sue impostazioni:
//   dtype    il file da scaricare (q8 = quantizzato), sizeMB quanto pesa, pooling come si fa un vettore da un testo,
//   prefix   che cosa va davanti al testo (la domanda e il documento si scrivono diversi per questi modelli)
const QWEN3_QUERY = 'Instruct: Given a task for a coding agent, retrieve the agent actions that work on it\nQuery: '; // come per Ollama
// Qwen3-Embedding 0.6B (Apache-2.0, 1024 dimensioni, multilingue): misurato il 2026-11-18 batte il TF-IDF
// (docs/plans/embedding-calibration.md) e ha preso il posto di Xenova/multilingual-e5-small, che non lo batteva
const MODELS = Object.freeze({
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': Object.freeze({ dtype: 'q8', sizeMB: 585, pooling: 'last_token', license: 'Apache-2.0', prefix: kind => (kind === 'query' ? QWEN3_QUERY : '') }),
});
const MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'; // il modello che si installa
// un modello che il provider non conosce (scelto per una prova): impostazioni neutre
const GENERIC = Object.freeze({ dtype: 'q8', sizeMB: 0, pooling: 'mean', license: '', prefix: () => '' });
const specOf = model => MODELS[model] || GENERIC;
const DTYPE = specOf(MODEL).dtype;
const SIZE_MB = specOf(MODEL).sizeMB;
const MARKER = '.platypus-ok';                // scritto dopo uno scaricamento riuscito
const LOAD_MS = 60000;                        // la prima richiesta carica il modello: ci può mettere un po'

// i pacchetti npm sono installati in questa cartella?
function installed(transformers) {
  try { require.resolve(transformers || '@huggingface/transformers', { paths: [__dirname] }); return true; } catch { return false; }
}
function markerOf(modelsDir, model = MODEL) { return path.join(modelsDir, ...model.split('/'), MARKER); }
function hasModel(modelsDir, model = MODEL) { try { return !!modelsDir && fs.existsSync(markerOf(modelsDir, model)); } catch { return false; } }
const prefix = (kind, model = MODEL) => specOf(model).prefix(kind);

// carica transformers.js (pacchetto ESM; per le prove un modulo finto indicato con un percorso)
async function loadTransformers(spec) {
  const m = await import(spec && path.isAbsolute(spec) ? pathToFileURL(spec).href : (spec || '@huggingface/transformers'));
  return m.pipeline ? m : m.default;
}

function create(settings = {}, { modelsDir, transformers, timeoutMs = 5000, model = MODEL, dtype } = {}) {
  dtype = dtype || specOf(model).dtype;
  const pooling = specOf(model).pooling;
  const id = 'onnx:' + model;
  const p = { id, dim: 0, state: 'unknown', model, detail: '', hint: '', worker: null };
  const pending = new Map();
  let seq = 0, loaded = false;
  const fail = (state, detail, hint) => { Object.assign(p, { state, detail, hint: hint || '', dim: 0 }); return false; };
  p.timeoutFor = () => (loaded ? timeoutMs : LOAD_MS); // per la coda del motore: il primo uso carica il modello
  p.readyTimeoutMs = LOAD_MS + timeoutMs;

  function start() {
    if (p.worker) return;
    const { Worker } = require('worker_threads');
    p.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { model, dtype, pooling, modelsDir, transformers: transformers || null } });
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
      const [v] = await ask([prefix('query', model) + 'ping'], LOAD_MS);
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
    return ask(texts.map(t => prefix(kind, model) + t), loaded ? timeoutMs : LOAD_MS);
  };
  p.stop = () => { if (p.worker) { const w = p.worker; p.worker = null; w.terminate().catch(() => {}); } };
  return p;
}

// per lo script di installazione: scarica il modello (l'unica volta in cui si va in rete) e lascia il segno
async function download(modelsDir, { transformers, model = MODEL, dtype, log = console.log } = {}) {
  dtype = dtype || specOf(model).dtype;
  fs.mkdirSync(modelsDir, { recursive: true });
  const T = await loadTransformers(transformers);
  T.env.allowRemoteModels = true;
  T.env.allowLocalModels = true;
  T.env.cacheDir = modelsDir;
  T.env.localModelPath = modelsDir;
  log('Downloading ' + model + ' (' + dtype + ') into ' + modelsDir + ' …');
  const pipe = await T.pipeline('feature-extraction', model, { dtype });
  const out = await pipe([prefix('query', model) + 'prova', prefix('document', model) + 'test'], { pooling: specOf(model).pooling, normalize: true });
  const dim = out.dims[out.dims.length - 1];
  fs.mkdirSync(path.dirname(markerOf(modelsDir, model)), { recursive: true });
  fs.writeFileSync(markerOf(modelsDir, model), JSON.stringify({ model, dtype, dim, at: new Date().toISOString() }) + '\n');
  return { model, dtype, dim };
}

module.exports = { create, download, installed, hasModel, markerOf, loadTransformers, prefix, specOf, MODELS, MODEL, DTYPE, SIZE_MB };
