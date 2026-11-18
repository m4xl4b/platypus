'use strict';
// Provider Ollama: i vettori da un Ollama che gira su questo computer, con http di Node.
// Solo indirizzi di loopback (127.0.0.1, ::1, localhost): i testi degli agenti non escono dal computer.
// Non scarica mai modelli: se non ce n'è uno di embedding, lo dice con il comando da lanciare.
//
//   GET  /api/tags        quali modelli ci sono
//   POST /api/embed       { model, input: [...] } → { embeddings: [[...]] }
//   POST /api/embeddings  { model, prompt } → { embedding: [...] }  (versioni vecchie, un testo alla volta)

const http = require('http');
const https = require('https');

const DEFAULT_URL = 'http://127.0.0.1:11434';
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const MAX_BODY = 64 * 1024 * 1024;
// il modello da proporre quando non ce n'è nessuno: il migliore misurato sull'insieme italiano e inglese, e il più piccolo
// (0,64 GB; vedi docs/plans/embedding-calibration.md)
const SUGGESTED = 'qwen3-embedding:0.6b';

// l'indirizzo, se è di loopback; altrimenti null
function loopbackUrl(v) {
  const s = String(v == null ? '' : v).trim() || DEFAULT_URL;
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'http://' + s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!LOOPBACK.has(u.hostname.toLowerCase())) return null;
  return u.origin;
}

// i modelli di embedding tra quelli presenti, i multilingue per primi
const EMBED_NAME = /embed|bge|e5|gte|minilm|mpnet|paraphrase|arctic|granite-embedding|jina|nomic/i;
const EMBED_FAMILY = /bert|xlm|roberta|nomic/i;
// i multilingue, nell'ordine in cui si preferiscono: prima quelli misurati con scripts/embed-eval.js, dal migliore
// (qualità sull'insieme, poi dimensione), poi gli altri multilingue non ancora misurati
const MULTI = [/qwen3-embedding:0\.6b/i, /qwen3-embedding/i, /embeddinggemma/i, /arctic-embed2/i, /nomic-embed-text-v2/i, /bge-m3/i, /granite-embedding/i, /multilingual-e5|(^|[/:-])e5/i, /paraphrase-multilingual|multilingual/i, /jina-embeddings-v3/i];
function isEmbedModel(m) {
  const name = String(m && (m.name || m.model) || '');
  const fam = m && m.details ? [m.details.family, ...(m.details.families || [])].join(' ') : '';
  return EMBED_NAME.test(name) || EMBED_FAMILY.test(fam);
}
function pickModel(models, wanted) {
  const names = (models || []).map(m => String(m.name || m.model || '')).filter(Boolean);
  if (wanted) {
    const w = String(wanted).trim();
    return names.find(n => n === w) || names.find(n => n === w + ':latest') || names.find(n => n.replace(/:latest$/, '') === w.replace(/:latest$/, '')) || null;
  }
  const emb = (models || []).filter(isEmbedModel).map(m => String(m.name || m.model));
  for (const re of MULTI) { const n = emb.find(x => re.test(x)); if (n) return n; }
  return emb[0] || null;
}
// i prefissi che alcuni modelli vogliono per distinguere la domanda dal documento
function prefix(model, kind) {
  const m = String(model || '').toLowerCase();
  if (/(^|[/:-])e5|multilingual-e5/.test(m)) return kind === 'query' ? 'query: ' : 'passage: ';
  if (/nomic-embed/.test(m)) return kind === 'query' ? 'search_query: ' : 'search_document: ';
  if (/embeddinggemma/.test(m)) return kind === 'query' ? 'task: search result | query: ' : 'title: none | text: ';
  if (/qwen3-embedding/.test(m)) return kind === 'query' ? 'Instruct: Given a task for a coding agent, retrieve the agent actions that work on it\nQuery: ' : '';
  return '';
}

function request(base, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request(u, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > MAX_BODY) { req.destroy(new Error('ollama: answer too big')); return; } chunks.push(c); });
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(txt); } catch {}
        resolve({ status: res.statusCode, json: j, text: txt });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ollama: timeout ' + timeoutMs + ' ms')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Il primo uso di un modello lo carica in memoria: può volerci più dei 5 s di una richiesta, e interromperla farebbe
// annullare il caricamento a Ollama (che allora non finisce mai). Così la richiesta "a freddo" ha fino a loadMs, e si
// chiede a Ollama di tenere il modello caricato per KEEP_ALIVE; finché è caldo valgono i 5 s.
const KEEP_ALIVE = '10m', WARM_MS = 9 * 60 * 1000, LOAD_MS = 60000;
function create(settings = {}, { timeoutMs = 5000, loadMs = LOAD_MS, now = Date.now } = {}) {
  const base = loopbackUrl(settings.ollamaUrl);
  const p = { id: 'ollama', dim: 0, state: 'unknown', model: '', detail: '', hint: '', url: base || String(settings.ollamaUrl || ''), legacy: false };
  const fail = (state, detail, hint = '') => { Object.assign(p, { state, detail, hint, dim: 0 }); return false; };
  const toVec = a => (Array.isArray(a) && a.length && a.every(Number.isFinite) ? Float32Array.from(a) : null);
  let warmUntil = 0;
  p.timeoutFor = () => (now() < warmUntil ? timeoutMs : loadMs); // per la coda: quanto può durare la prossima richiesta
  p.readyTimeoutMs = loadMs + timeoutMs;

  async function embedRaw(texts, kind) {
    const input = texts.map(t => prefix(p.model, kind) + t);
    const ms = p.timeoutFor();
    const out = await embedReq(input, ms);
    warmUntil = now() + WARM_MS;
    return out;
  }
  async function embedReq(input, ms) {
    const texts = input;
    if (!p.legacy) {
      const r = await request(base, 'POST', '/api/embed', { model: p.model, input, truncate: true, keep_alive: KEEP_ALIVE }, ms);
      if (r.status === 404 && !(r.json && /model/i.test(String(r.json.error || '')))) p.legacy = true; // Ollama vecchio: niente /api/embed
      else {
        if (r.status !== 200 || !r.json || !Array.isArray(r.json.embeddings)) throw new Error('ollama /api/embed: ' + r.status + ' ' + ((r.json && r.json.error) || r.text.slice(0, 120)));
        const out = r.json.embeddings.map(toVec);
        if (out.length !== texts.length || out.some(v => !v)) throw new Error('ollama /api/embed: wrong answer');
        return out;
      }
    }
    const out = [];
    for (const prompt of input) {
      const r = await request(base, 'POST', '/api/embeddings', { model: p.model, prompt, keep_alive: KEEP_ALIVE }, ms);
      const v = r.status === 200 && r.json ? toVec(r.json.embedding) : null;
      if (!v) throw new Error('ollama /api/embeddings: ' + r.status + ' ' + ((r.json && r.json.error) || r.text.slice(0, 120)));
      out.push(v);
    }
    return out;
  }

  p.ready = async () => {
    if (!base) return fail('error', 'not a loopback address: ' + String(settings.ollamaUrl || ''), '');
    let tags;
    try { tags = await request(base, 'GET', '/api/tags', null, timeoutMs); } catch (e) { return fail('not-found', 'Ollama is not answering at ' + base + ' (' + e.message + ')', ''); }
    if (tags.status !== 200 || !tags.json) return fail('not-found', 'Ollama at ' + base + ': /api/tags ' + tags.status, '');
    const models = Array.isArray(tags.json.models) ? tags.json.models : [];
    const model = pickModel(models, settings.embedModel);
    if (!model) {
      const want = String(settings.embedModel || '').trim();
      return fail('not-found', want ? 'model not found: ' + want : 'no embedding model', 'ollama pull ' + (want || SUGGESTED));
    }
    p.model = model; p.id = 'ollama:' + model;
    try {
      const [v] = await embedRaw(['ping'], 'query');
      p.dim = v.length;
    } catch (e) { return fail('error', e.message, ''); }
    Object.assign(p, { state: 'ready', detail: '', hint: '' });
    return true;
  };
  // per le opzioni: c'è, e con quale modello? Solo /api/tags, senza caricare il modello in memoria
  p.check = async () => {
    if (p.state === 'ready' && p.dim) return true;
    if (!base) return fail('error', 'not a loopback address: ' + String(settings.ollamaUrl || ''), '');
    let tags;
    try { tags = await request(base, 'GET', '/api/tags', null, timeoutMs); } catch (e) { return fail('not-found', 'Ollama is not answering at ' + base + ' (' + e.message + ')', ''); }
    const model = tags.status === 200 && tags.json ? pickModel(Array.isArray(tags.json.models) ? tags.json.models : [], settings.embedModel) : null;
    const want = String(settings.embedModel || '').trim();
    if (!model) return fail('not-found', tags.status !== 200 ? 'Ollama at ' + base + ': /api/tags ' + tags.status : want ? 'model not found: ' + want : 'no embedding model', tags.status === 200 ? 'ollama pull ' + (want || SUGGESTED) : '');
    Object.assign(p, { model, id: 'ollama:' + model, state: 'ready', detail: '', hint: '' });
    return true;
  };
  p.embed = async (texts, kind) => {
    if (p.state !== 'ready' || !p.dim) throw new Error('ollama: not ready');
    const out = await embedRaw(texts, kind);
    if (out.some(v => v.length !== p.dim)) throw new Error('ollama: the model changed dimension');
    return out;
  };
  return p;
}

module.exports = { create, loopbackUrl, pickModel, isEmbedModel, prefix, DEFAULT_URL, SUGGESTED, KEEP_ALIVE, LOAD_MS };
