'use strict';
// Il modello ONNX gira qui, in un worker_thread: l'ufficio non si blocca mai mentre calcola i vettori.
// Riceve {id, texts} e risponde {id, vecs} oppure {id, error}. Non va mai in rete: i modelli remoti sono spenti.

const { parentPort, workerData } = require('worker_threads');
const { loadTransformers } = require('./index');

let loading = null;
async function load() {
  const T = await loadTransformers(workerData.transformers);
  T.env.allowRemoteModels = false;
  T.env.allowLocalModels = true;
  if (workerData.modelsDir) { T.env.cacheDir = workerData.modelsDir; T.env.localModelPath = workerData.modelsDir; }
  return T.pipeline('feature-extraction', workerData.model, { dtype: workerData.dtype });
}

parentPort.on('message', async ({ id, texts }) => {
  try {
    const pipe = await (loading || (loading = load()));
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1], data = out.data;
    const vecs = texts.map((_, i) => Array.from(data.subarray(i * dim, (i + 1) * dim)));
    parentPort.postMessage({ id, vecs });
  } catch (e) {
    if (loading && !(await loading.then(() => true, () => false))) loading = null; // il caricamento è fallito: si riprova la prossima volta
    parentPort.postMessage({ id, error: e && e.message ? e.message : String(e) });
  }
});
