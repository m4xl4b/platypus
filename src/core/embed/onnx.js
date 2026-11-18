'use strict';
// Provider ONNX: il modulo facoltativo in optional/embed-onnx/, caricato con require solo se c'è.
// Se manca (o mancano i suoi pacchetti, o il modello), il provider risulta "non installato" e la catena passa oltre.

const path = require('path');

const MODULE = path.join(__dirname, '..', '..', '..', 'optional', 'embed-onnx');
const HINT = 'npm run embed:onnx:install';

function notInstalled(detail) {
  return { id: 'onnx', dim: 0, state: 'not-installed', model: '', detail, hint: HINT, ready: async () => false, embed: async () => { throw new Error('onnx: not installed'); } };
}

// deps: modelsDir (dove sta il modello, di solito <dati>/models), onnxModule e transformers solo per le prove
function create(settings = {}, deps = {}) {
  let mod;
  try { mod = require(deps.onnxModule || MODULE); } catch (e) { return notInstalled('optional/embed-onnx is missing (' + e.code + ')'); }
  if (!mod || typeof mod.create !== 'function') return notInstalled('optional/embed-onnx has no create()');
  return mod.create(settings, { modelsDir: deps.modelsDir, transformers: deps.transformers, timeoutMs: deps.timeoutMs || 5000, ...(deps.model ? { model: deps.model } : {}) });
}

module.exports = { create, MODULE, HINT };
