#!/usr/bin/env node
'use strict';
// Calibrazione del significato: quanto bene una fonte di vettori separa le azioni "sul compito" da quelle "fuori",
// e con quali soglie la regola della deriva funziona meglio. Usa l'insieme scritto apposta in embed-eval-set.js.
//
//   node scripts/embed-eval.js                         TF-IDF
//   node scripts/embed-eval.js --source ollama [--url http://127.0.0.1:11434] [--model bge-m3]
//   node scripts/embed-eval.js --source onnx           (dopo npm run embed:onnx:install)
//   node scripts/embed-eval.js --source fake           il provider finto della demo (un dizionario di sinonimi, non un modello)
//   node scripts/embed-eval.js --json                  i numeri in JSON
//
// Con Ollama o ONNX i testi dell'insieme (non dati veri) vanno al modello locale; niente esce dal computer.
// Misure per fonte:
//   AUC        probabilità che un'azione sul compito sia più vicina al compito di una fuori (1 = perfetto, 0,5 = a caso)
//   zero       somiglianza media tra un compito e azioni che non c'entrano (il "fondo" della fonte)
//   deriva     sessioni simulate: 8 azioni sul compito e poi 12 sul compito (controllo) o 12 fuori (deriva);
//              la soglia rel che separa meglio (Youden: veri allarmi meno falsi allarmi) e quella in uso
//   weak       la base dei compiti veri e di quelli che non si possono misurare (parole che non compaiono mai)

const path = require('path');
const ROOT = path.join(__dirname, '..');
const sem = require(path.join(ROOT, 'src', 'core', 'semantic'));
const rule = require(path.join(ROOT, 'src', 'core', 'drift-rule'));
const SET = require('./embed-eval-set');

const T0 = Date.parse('2026-11-18T09:00:00Z');
const BASE_N = 8, TAIL_N = 12;

// le sessioni simulate: per ogni compito un controllo e una deriva; più i compiti non misurabili
function sessions(set = SET) {
  const out = [];
  set.forEach((task, i) => {
    const other = set.find((x, k) => k > i && x.domain !== task.domain) || set.find(x => x.domain !== task.domain);
    const off = other.on;
    const mk = (kind, tail) => {
      const corpus = new sem.Corpus(), mind = new sem.AgentMind(corpus);
      let t = T0, n = 0;
      mind.setGoal(T0, task.goal);
      const act = text => mind.action('a' + (++n), t += 1000, text.slice(0, 40), text + ' step ' + n);
      for (let k = 0; k < BASE_N; k++) act(task.on[k % task.on.length]);
      for (let k = 0; k < TAIL_N; k++) act(tail[(k + BASE_N) % tail.length]);
      return { kind, task: i, lang: task.lang, syn: !!task.syn, corpus, mind, on: task.on, off };
    };
    out.push(mk('control', task.on), mk('drift', off));
  });
  for (const [k, goal] of (set.UNMEASURABLE || SET.UNMEASURABLE).entries()) {
    const task = set[(k * 7) % set.length];
    const corpus = new sem.Corpus(), mind = new sem.AgentMind(corpus);
    let t = T0, n = 0;
    mind.setGoal(T0, goal);
    for (let j = 0; j < BASE_N + TAIL_N; j++) mind.action('u' + (++n), t += 1000, 'x', task.on[j % task.on.length] + ' step ' + n);
    out.push({ kind: 'unmeasurable', task: -1, corpus, mind });
  }
  return out;
}

function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const quant = (a, q) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.max(0, Math.floor(q * (b.length - 1))))] : NaN; };
const r3 = x => (Number.isFinite(x) ? +x.toFixed(3) : null);

// space(session) → lo spazio di significato di quella sessione (TF-IDF: quello del suo corpus)
// calibrate: misura anche il fondo (zero) e la soglia per allargare il compito (widen) e li usa; senza, usa quelli di base
function evaluate(src, spaceOf, { base = rule.thresholdsFor(src), calibrate = false } = {}) {
  const S = sessions();
  // 1 · AUC e zero, con il coseno grezzo compito-azione
  const perTask = [], synT = [], offRaw = [];
  for (const x of S.filter(s => s.kind === 'drift')) {
    const sp = spaceOf(x), g = sp.goal(x.mind.goals[0]);
    const acts = x.mind.pieces.filter(p => p.kind === 'action');
    const sc = acts.map(p => sem.cosine(g, sp.piece(p)));
    const on = sc.slice(0, BASE_N), off = sc.slice(BASE_N);
    offRaw.push(...off);
    const a = auc(on, off);
    perTask.push(a); if (x.syn) synT.push(a);
  }
  const measuredZero = mean(offRaw);
  const zero = calibrate ? measuredZero : (base.zero || 0);
  const sc = c => (zero ? Math.max(0, (c - zero) / (1 - zero)) : Math.max(0, c));
  // widen: la migliore delle prime azioni, per i compiti veri e per quelli non misurabili (che non devono allargarsi)
  const topEarly = x => { const sp = spaceOf(x), g = sp.goal(x.mind.goals[0]); return Math.max(0, ...x.mind.pieces.filter(p => p.kind === 'action').slice(0, 10).map(p => sc(sem.cosine(g, sp.piece(p))))); };
  const realTop = S.filter(s => s.kind === 'control').map(topEarly), unTop = S.filter(s => s.kind === 'unmeasurable').map(topEarly);
  const wLo = quant(realTop, 0.05), wHi = Math.max(...unTop);
  const measuredWiden = wHi < wLo ? (wHi + wLo) / 2 : wHi;
  const widen = calibrate ? measuredWiden : (base.widen || 0);
  // 2 · la regola della deriva sulle sessioni simulate, con le soglie della fonte (zero, widen, floor) e rel da scegliere
  const th = { ...base, calibrated: true, zero, widen };
  const rows = S.map(x => ({ x, al: sem.alignment(x.mind, x.corpus, { ...spaceOf(x), th }) }));
  const real = rows.filter(r => r.x.kind !== 'unmeasurable');
  const rels = real.map(r => { const l = r.al[r.al.length - 1]; return { drift: r.x.kind === 'drift', rel: l[2] / l[3], base: l[3] }; });
  const relAuc = auc(rels.filter(r => !r.drift).map(r => r.rel), rels.filter(r => r.drift).map(r => r.rel));
  // come il motore: una sessione con la base sotto weak non si giudica (né allarme né via libera)
  const at = rel => {
    let tp = 0, fp = 0, P = 0, N = 0, weak = 0;
    for (const r of real) { const j = rule.judge(r.al, { ...th, rel }); if (j.weak) weak++; if (r.x.kind === 'drift') { P++; if (j.drifting) tp++; } else { N++; if (j.drifting) fp++; } }
    return { rel: r3(rel), tpr: r3(tp / P), fpr: r3(fp / N), j: tp / P - fp / N, unjudged: r3(weak / real.length) };
  };
  let best = null;
  const grid = [];
  for (let t = 0.05; t <= 0.951; t += 0.01) grid.push(at(t));
  const top = Math.max(...grid.map(g => g.j));
  const ties = grid.filter(g => g.j >= top - 1e-9);
  best = ties[Math.floor(ties.length / 2)]; // a metà dell'intervallo migliore (Youden)
  // la soglia proposta: a metà di quelle che prendono almeno il 90% delle derive senza nessun falso allarme, così c'è
  // margine da tutti e due i lati; se non ce n'è nessuna, quella di Youden
  const good = grid.filter(g => g.fpr === 0 && g.tpr >= 0.9);
  const chosen = good.length ? good[Math.floor(good.length / 2)] : best;
  // 3 · weak: la base dei compiti veri e di quelli non misurabili
  const realBase = rows.filter(r => r.x.kind === 'control').map(r => r.al[r.al.length - 1][3]);
  const unBase = rows.filter(r => r.x.kind === 'unmeasurable').map(r => r.al[r.al.length - 1][3]);
  const lo = quant(realBase, 0.05), hi = Math.max(...unBase);
  return {
    src, tasks: SET.length, sessions: real.length,
    auc: r3(mean(perTask)), aucSyn: r3(mean(synT)), aucMin: r3(Math.min(...perTask)),
    zero: r3(measuredZero), widen: { realP05: r3(wLo), unmeasurableMax: r3(wHi), suggested: r3(measuredWiden) }, used: { zero: r3(zero), widen: r3(widen) }, relAuc: r3(relAuc),
    best: { rel: best.rel, tpr: best.tpr, fpr: best.fpr }, chosen: { rel: chosen.rel, tpr: chosen.tpr, fpr: chosen.fpr }, current: (({ rel, tpr, fpr, unjudged }) => ({ rel, tpr, fpr, unjudged }))(at(base.rel)),
    weak: { realP05: r3(lo), unmeasurableMax: r3(hi), suggested: r3(hi < lo ? (hi + lo) / 2 : hi), current: base.weak },
  };
}

// vettori neurali: tutti i testi delle sessioni, a lotti, con la fonte data
async function neuralSpaces(provider) {
  const S = sessions(), want = new Map();
  for (const x of S) { for (const g of x.mind.goals) want.set('query|' + g.text, [g.text, 'query']); for (const p of x.mind.pieces) want.set('document|' + p.text, [p.text, 'document']); }
  const got = new Map(), items = [...want.entries()];
  for (const kind of ['query', 'document']) {
    const these = items.filter(([, v]) => v[1] === kind);
    for (let i = 0; i < these.length; i += 16) {
      const b = these.slice(i, i + 16);
      const vecs = await provider.embed(b.map(([, v]) => v[0]), kind);
      b.forEach(([k], j) => got.set(k, Float32Array.from(vecs[j])));
    }
  }
  return () => ({ src: provider.id, goal: g => got.get('query|' + g.text), piece: p => got.get('document|' + p.text) });
}

function table(r) {
  return [
    `fonte ${r.src} · ${r.tasks} compiti, ${r.sessions} sessioni simulate`,
    `  AUC sul compito/fuori: ${r.auc} (sinonimi ${r.aucSyn}, il compito peggiore ${r.aucMin}) · fondo (zero) ${r.zero}`,
    `  allargare il compito: la migliore delle prime azioni, compiti veri (5° percentile) ${r.widen.realP05}, non misurabili al massimo ${r.widen.unmeasurableMax} → widen ${r.widen.suggested} · usati: zero ${r.used.zero}, widen ${r.used.widen}`,
    `  deriva: AUC di rel ${r.relAuc} · Youden rel ${r.best.rel} (veri ${r.best.tpr}, falsi ${r.best.fpr}) · proposta rel ${r.chosen.rel} (veri ${r.chosen.tpr}, falsi ${r.chosen.fpr}) · in uso rel ${r.current.rel} (veri ${r.current.tpr}, falsi ${r.current.fpr}; non giudicabili ${r.current.unjudged})`,
    `  non misurabile: base dei compiti veri (5° percentile) ${r.weak.realP05}, dei non misurabili al massimo ${r.weak.unmeasurableMax} → weak ${r.weak.suggested} (in uso ${r.weak.current})`,
  ].join('\n');
}

module.exports = { evaluate, sessions, neuralSpaces, auc, table };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    const source = arg('--source') || 'tfidf';
    let r;
    if (source === 'tfidf') r = evaluate('tfidf', x => sem.tfidfSpace(x.corpus));
    else {
      const settings = { ollamaUrl: arg('--url') || undefined, embedModel: arg('--model') || '' };
      const p = source === 'fake' ? require(path.join(ROOT, 'src', 'core', 'embed', 'fake')).create() : source === 'onnx' ? require(path.join(ROOT, 'src', 'core', 'embed', 'onnx')).create(settings, { modelsDir: path.join(require(path.join(ROOT, 'src', 'paths')).dataDir(), 'models'), timeoutMs: 60000 })
        : require(path.join(ROOT, 'src', 'core', 'embed', source)).create(settings, { timeoutMs: 60000 });
      if (!(await p.ready())) { console.error(`${source}: ${p.state} ${p.detail || ''} ${p.hint ? '→ ' + p.hint : ''}`); process.exit(1); }
      const spaceOf = await neuralSpaces(p);
      // misura il fondo e la soglia per allargare il compito, e calibra la regola con quelli, come farà il motore
      r = evaluate(p.id, spaceOf, { base: { ...rule.TFIDF }, calibrate: true });
      r.row = { rel: r.chosen.rel, run: rule.TFIDF.run, weak: r.weak.suggested, warn: +Math.min(0.95, r.chosen.rel + 0.25).toFixed(2), floor: rule.TFIDF.floor, zero: r.used.zero, widen: r.used.widen, calibrated: true };
      if (p.stop) p.stop();
    }
    console.log(args.includes('--json') ? JSON.stringify(r, null, 1) : table(r) + (r.row ? '\n  riga per drift-rule.js: ' + JSON.stringify(r.row) : ''));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
