'use strict';
// "Mente" di un agente (sperimentale): il suo contesto come nuvola di punti in uno spazio di significato
// e l'obiettivo del compito come stella polare.
//
// Motore "lessicale": ogni pezzo di testo diventa un vettore TF-IDF (parole e pezzi di identificatori,
// con una radice grezza italiano/inglese) compresso con il feature hashing in DIM dimensioni.
// Due testi sono vicini se usano le stesse parole importanti. Non capisce i sinonimi come un modello
// neurale, ma è immediato, non scarica nulla e non manda niente fuori dal computer.

const DIM = 256;
const MAX_PIECES = 900;
const MAX_TERMS = 48;

const STOP = new Set((
  // italiano
  'il lo la i gli le un uno una di da in con su per tra fra che chi cui non come dove quando perche anche ancora piu meno molto poco tutto tutti tutte ogni questo questa questi queste quello quella quelli sono sei siamo siete era erano essere stato stata avere abbiamo hanno aveva fare fatto puo deve devo vuoi voglio fai dei delle degli della dello del dal dalla dai dalle nel nella nei nelle sul sulla sui sulle col alla alle allo agli ai al ed se ma poi gia cosa cose qui li ora adesso solo sempre mai bene male allora quindi oppure invece dopo prima sopra sotto dentro fuori senza verso fino mentre essa esso loro mio mia tuo tua suo sua nostro vostro vedi via ' +
  // inglese
  'the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get got let put say she too use with that this from they have will your what when where which while about after again also been before being both each few into just like more most much must only other over same should some such than then them there these those through under until very were would could shall does doing done here why ' +
  // codice e rumore tecnico
  'head tail grep sed awk echo cat print printf replace open close join split strip len range python python3 node bash npm npx cd ls rm mkdir cp mv sudo dev tmp home root usr bin opt mnt var users appdata local roaming documents desktop progetti projects scratchpad eof ' +
  'const let var function return true false null undefined this new import export default class extends async await try catch finally throw typeof instanceof void delete else switch case break continue require module exports string number object array boolean int str def self none elif lambda pass yield public private static final void bool char long float double value item items http https www com org json html css src lib index main'
).split(/\s+/));

// piccolo vocabolario italiano → inglese del software: i compiti si scrivono spesso in italiano,
// mentre file e codice parlano inglese ("autenticazione" deve incontrare "auth/")
const SYN = {
  auten: ['auth'], utent: ['user'], ordin: ['order'], fattu: ['invoi'], magaz: ['wareh'], scade: ['expir'], scado: ['expir'], scadu: ['expir'],
  chiav: ['key'], pagam: ['payme'], prodo: ['produ'], ricet: ['recip'], lotto: ['lot', 'batch'], lotti: ['lot', 'batch'], turno: ['shift'], turni: ['shift'],
  allar: ['alarm'], impos: ['setti'], grafi: ['chart'], rappo: ['repor'], vendi: ['sales'], ricer: ['searc'], pagin: ['page'], regis: ['log'],
  avvis: ['alert'], perme: ['permi'], ruolo: ['role'], ruoli: ['role'], carte: ['folde'], aggio: ['updat'], crea: ['creat'], creare: ['creat'],
  elimi: ['delet'], salva: ['save'], caric: ['load'], scari: ['downl'], espor: ['expor'], verif: ['check'], prova: ['test'], prove: ['test'],
  dati: ['data'], datab: ['db'], basi: ['db'], sicur: ['secur'], crypt: ['crypt'], critt: ['crypt'], backu: ['backu'], copia: ['backu', 'copy'],
  fornit: ['suppl', 'vendo'], forni: ['suppl', 'vendo'], incid: ['incid'], rischi: ['risk'], risch: ['risk'], polic: ['polic'], proce: ['proce'],
  docum: ['doc'], manua: ['guide'], schem: ['schem'], tabel: ['table'], campo: ['field'], campi: ['field'], modul: ['modul', 'form'],
  inter: ['ui'], scher: ['scree'], pulsa: ['butto'], menu: ['menu'], gesti: ['manag'], servi: ['servi'], notif: ['notif'], rilas: ['relea'],
};
const SHORT = new Set(['db', 'ui', 'ux', 'ai', 'ml', 'io', 'os', 'ci', 'qa', 'pr', 'id', 'ip', 'vm', 'k8']);
function stem(w) {
  let x = w;
  if (x.length > 4 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  return x.length > 5 ? x.slice(0, 5) : x; // radice corta: "migrazione" e "migrate" diventano la stessa cosa
}
// testo → mappa radice → conteggio (con la prima forma vista, per le etichette)
function terms(text, surface) {
  const out = new Map();
  if (!text) return out;
  let s = String(text).slice(0, 24000);
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2'); // camelCase → parole
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let n = 0;
  for (const w of s.split(/[^a-z0-9]+/)) {
    if ((w.length < 3 && !SHORT.has(w)) || w.length > 24 || /^\d+$/.test(w) || /^[0-9a-f]{8,}$/.test(w) || (/\d/.test(w) && /^[0-9a-f]+$/.test(w)) || /^\d+[a-z]{1,2}$/.test(w) || STOP.has(w)) continue;
    const k = stem(w);
    if (STOP.has(k)) continue;
    out.set(k, (out.get(k) || 0) + 1);
    if (surface && !surface.has(k)) surface.set(k, w);
    const syn = SYN[k];
    if (syn) for (const x of syn) if (x !== k) out.set(x, (out.get(x) || 0) + 1);
    if (++n > 5000) break;
  }
  if (out.size > MAX_TERMS) return new Map([...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS));
  return out;
}
function mergeTerms(a, b) {
  const m = new Map(a);
  for (const [k, v] of b) m.set(k, (m.get(k) || 0) + v);
  if (m.size > MAX_TERMS * 2) return new Map([...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_TERMS * 2));
  return m;
}

function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// documenti della sessione: servono a pesare le parole (rare = importanti)
class Corpus {
  constructor() { this.df = new Map(); this.docs = 0; this.surface = new Map(); }
  add(tm) { this.docs++; for (const k of tm.keys()) this.df.set(k, (this.df.get(k) || 0) + 1); }
  idf(k) { return Math.log((1 + this.docs) / (1 + (this.df.get(k) || 0))) + 1; }
  vector(tm) {
    const v = new Float32Array(DIM);
    for (const [k, c] of tm) {
      const h = fnv(k), w = (1 + Math.log(c)) * this.idf(k);
      v[h % DIM] += (h & 0x80000000) ? -w : w;
    }
    let n = 0;
    for (let i = 0; i < DIM; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < DIM; i++) v[i] /= n;
    return v;
  }
  weights(tm) { return [...tm.entries()].map(([k, c]) => [k, (1 + Math.log(c)) * this.idf(k)]); }
}
function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// ---------------------------------------------------------------- contesto e obiettivo di un agente
class AgentMind {
  constructor(corpus) {
    this.corpus = corpus;
    this.pieces = [];
    this.goals = [];   // [{t, label, terms}]
    this.gen = 0;      // compattazioni del contesto avvenute
    this.compactions = []; // [{t, pre, post}]
    this.ctxHist = []; // [[t, token nel contesto]]
    this.byTool = new Map(); // toolUseId -> pezzo "azione"
    this.pendingBoundary = null;
    this.seq = 0;
  }
  add(kind, t, label, text, tokens, extra) {
    const tm = terms(text, this.corpus.surface);
    if (!tm.size && kind !== 'summary') return null;
    this.corpus.add(tm);
    const p = { id: ++this.seq, t, kind, label: String(label || '').slice(0, 140), terms: tm, tokens: Math.max(1, Math.round(tokens || String(text || '').length / 4)), gen: this.gen, ...extra };
    this.pieces.push(p);
    if (this.pieces.length > MAX_PIECES) this.pieces.splice(0, this.pieces.length - MAX_PIECES);
    return p;
  }
  setGoal(t, text) {
    const tm = terms(text, this.corpus.surface);
    if (!tm.size) return;
    const last = this.goals[this.goals.length - 1];
    if (last && last.text === String(text).slice(0, 300)) return;
    this.corpus.add(tm);
    this.goals.push({ t, label: String(text).replace(/\s+/g, ' ').slice(0, 160), text: String(text).slice(0, 300), terms: tm });
    if (this.goals.length > 1 && this.goals[this.goals.length - 2].t > t) this.goals.sort((a, b) => a.t - b.t);
    if (this.goals.length > 60) this.goals.shift();
    this.add('prompt', t, String(text).replace(/\s+/g, ' ').slice(0, 140), text);
  }
  action(id, t, label, text) {
    const p = this.add('action', t, label, text, 40);
    if (p && id) { this.byTool.set(id, p); if (this.byTool.size > 300) this.byTool.delete(this.byTool.keys().next().value); }
  }
  result(id, t, kind, label, text, isErr) {
    const act = id && this.byTool.get(id);
    if (act) { this.byTool.delete(id); if (isErr) act.err = true; }
    if (!text) return;
    const p = this.add(kind, t, label, text, String(text).length / 4, isErr ? { err: true } : null);
    // per la stella polare conta l'azione insieme a quello che ha restituito
    if (act && p) act.terms = mergeTerms(act.terms, p.terms);
  }
  boundary(t, meta) { this.pendingBoundary = { t, pre: meta && meta.preTokens, post: meta && meta.postTokens }; }
  compact(t, summaryText) {
    this.gen++;
    const b = this.pendingBoundary || {};
    this.compactions.push({ t: b.t || t, pre: b.pre || 0, post: b.post || 0 });
    this.pendingBoundary = null;
    this.add('summary', t, 'summary', summaryText, (b.post || String(summaryText || '').length / 4));
  }
  noteCtx(t, ctx) {
    if (!ctx) return;
    const last = this.ctxHist[this.ctxHist.length - 1];
    if (last && t - last[0] < 2000) { last[1] = ctx; return; }
    this.ctxHist.push([t, ctx]);
    if (this.ctxHist.length > 600) this.ctxHist.splice(0, this.ctxHist.length - 600);
  }
}

// ---------------------------------------------------------------- geometria: PCA a 3 assi e gruppi
function pca3(vecs, prevAxes) {
  const n = vecs.length, d = DIM;
  const mean = new Float32Array(d);
  for (const v of vecs) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const X = vecs.map(v => { const x = new Float32Array(d); for (let i = 0; i < d; i++) x[i] = v[i] - mean[i]; return x; });
  const axes = [];
  for (let c = 0; c < 3; c++) {
    let a = new Float32Array(d);
    const seed = prevAxes && prevAxes[c];
    for (let i = 0; i < d; i++) a[i] = seed ? seed[i] : Math.sin(i * 12.9898 + c * 78.233);
    for (let it = 0; it < 40; it++) {
      const b = new Float32Array(d);
      for (const x of X) { let s = 0; for (let i = 0; i < d; i++) s += x[i] * a[i]; for (let i = 0; i < d; i++) b[i] += s * x[i]; }
      for (const p of axes) { let s = 0; for (let i = 0; i < d; i++) s += b[i] * p[i]; for (let i = 0; i < d; i++) b[i] -= s * p[i]; }
      let nn = 0; for (let i = 0; i < d; i++) nn += b[i] * b[i];
      nn = Math.sqrt(nn);
      if (!nn) break;
      for (let i = 0; i < d; i++) b[i] /= nn;
      a = b;
    }
    // stesso verso del calcolo precedente: i punti non si ribaltano a ogni aggiornamento
    if (seed) { let s = 0; for (let i = 0; i < d; i++) s += a[i] * seed[i]; if (s < 0) for (let i = 0; i < d; i++) a[i] = -a[i]; }
    axes.push(a);
  }
  const proj = v => axes.map(a => { let s = 0; for (let i = 0; i < d; i++) s += (v[i] - mean[i]) * a[i]; return s; });
  const coords = vecs.map(proj);
  // scala sul 90° percentile: pochi punti estremi non schiacciano tutti gli altri al centro
  const mags = coords.map(c => Math.hypot(c[0], c[1], c[2])).sort((a, b) => a - b);
  const mx = Math.max(1e-6, mags[Math.floor(mags.length * 0.9)] || mags[mags.length - 1] || 1);
  return { axes, mean, scale: 1 / mx, coords: coords.map(c => c.map(x => Math.max(-1.4, Math.min(1.4, x / mx)))), project: v => proj(v).map(x => Math.max(-1.4, Math.min(1.4, x / mx))) };
}
function kmeans(vecs, k, weights) {
  const n = vecs.length;
  if (n <= k) return vecs.map((_, i) => i);
  const cents = [vecs[0]];
  while (cents.length < k) { // il più lontano da tutti i centri già scelti
    let best = -1, bi = 0;
    for (let i = 0; i < n; i++) { let m = Infinity; for (const c of cents) m = Math.min(m, 1 - cosine(vecs[i], c)); if (m > best) { best = m; bi = i; } }
    cents.push(vecs[bi]);
  }
  const lab = new Array(n).fill(0);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < n; i++) { let b = -2, bj = 0; for (let j = 0; j < k; j++) { const s = cosine(vecs[i], cents[j]); if (s > b) { b = s; bj = j; } } lab[i] = bj; }
    for (let j = 0; j < k; j++) {
      const c = new Float32Array(DIM); let cnt = 0;
      for (let i = 0; i < n; i++) if (lab[i] === j) { const w = weights ? weights[i] : 1; for (let q = 0; q < DIM; q++) c[q] += vecs[i][q] * w; cnt++; }
      if (!cnt) continue;
      let nn = 0; for (let q = 0; q < DIM; q++) nn += c[q] * c[q]; nn = Math.sqrt(nn) || 1;
      for (let q = 0; q < DIM; q++) c[q] /= nn;
      cents[j] = c;
    }
  }
  return lab;
}

// ---------------------------------------------------------------- stella polare
// Allineamento con l'obiettivo: per ogni azione, quanto parla della stessa cosa.
// L'obiettivo viene "allargato" con le prime azioni che gli somigliano di più (retroazione di pertinenza):
// "rifai il login" impara così che anche auth/ e token.ts fanno parte del compito.
// Una riga per azione: [t, punteggio, media delle ultime 6, base (le prime 8 del compito), indice del compito, etichetta, errore]
function alignment(mind, corpus) {
  const align = [];
  const acts = mind.pieces.filter(p => p.kind === 'action');
  const gv = mind.goals.map((g, gi) => {
    const v0 = corpus.vector(g.terms);
    const end = gi + 1 < mind.goals.length ? mind.goals[gi + 1].t : Infinity;
    const early = acts.filter(p => p.t >= g.t && p.t < end).slice(0, 10).map(p => corpus.vector(p.terms));
    const top = early.map(v => [cosine(v, v0), v]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter(x => x[0] > 0);
    if (!top.length) return { t: g.t, v: v0 };
    const v = new Float32Array(v0.length);
    for (let i = 0; i < v.length; i++) { v[i] = v0[i]; for (const [, x] of top) v[i] += 0.6 * x[i] / top.length; }
    let nn = 0; for (let i = 0; i < v.length; i++) nn += v[i] * v[i]; nn = Math.sqrt(nn) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= nn;
    return { t: g.t, v };
  });
  let gi = -1, win = [], base = [];
  for (const p of acts) {
    while (gi + 1 < gv.length && gv[gi + 1].t <= p.t) { gi++; win = []; base = []; }
    if (gi < 0) continue;
    const s = Math.max(0, cosine(corpus.vector(p.terms), gv[gi].v));
    win.push(s); if (win.length > 6) win.shift();
    if (base.length < 8) base.push(s);
    const avg = win.reduce((a, x) => a + x, 0) / win.length;
    const b = Math.max(0.03, base.reduce((a, x) => a + x, 0) / base.length);
    align.push([p.t, +s.toFixed(3), +avg.toFixed(3), +b.toFixed(3), gi, p.label, p.err ? 1 : 0]);
  }
  return align;
}
// Alla deriva: la stessa regola della mappa (worldmap.js). L'allineamento (media su base) resta sotto DRIFT_REL per
// DRIFT_RUN azioni di fila, tutte del compito in corso. Con una base minima le parole del compito non compaiono mai nel
// lavoro, e non si può giudicare (weak).
const DRIFT_REL = 0.35, DRIFT_RUN = 6, WEAK_BASE = 0.031;
function drift(mind, corpus) {
  if (!mind || !corpus || !mind.goals || !mind.goals.length) return null;
  const al = alignment(mind, corpus);
  if (!al.length) return null;
  const last = al[al.length - 1], gi = last[4];
  if (gi !== mind.goals.length - 1) return null; // c'è una richiesta più nuova, ancora senza azioni
  let run = 0;
  for (let i = al.length - 1; i >= 0 && al[i][4] === gi && al[i][2] / al[i][3] < DRIFT_REL; i--) run++;
  const weak = last[3] <= WEAK_BASE, g = mind.goals[gi];
  return { goal: { t: g.t, label: g.label }, run, rel: +(last[2] / last[3]).toFixed(3), weak, drifting: !weak && run >= DRIFT_RUN };
}

// ---------------------------------------------------------------- vista per la pagina
const cache = new Map();
function snapshotMinds(minds, corpus, key, ctxLimitHint) {
  const all = [];
  for (const { id, name, mind } of minds) for (const p of mind.pieces) all.push({ p, owner: id, ownerName: name, mind });
  const sig = all.length + ':' + (all.length ? all[all.length - 1].p.id : 0) + ':' + corpus.docs;
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.v;
  const recent = all.slice(-1200);
  const vecs = recent.map(x => corpus.vector(x.p.terms));
  const goalsAll = [];
  for (const { id, mind } of minds) for (const g of mind.goals) goalsAll.push({ g, owner: id, v: corpus.vector(g.terms) });
  const prevAxes = hit && hit.axes;
  const P = vecs.length >= 4 ? pca3(vecs.concat(goalsAll.map(x => x.v)), prevAxes) : null;
  // gruppi di significato: di cosa è fatto il contesto
  const k = Math.min(6, Math.max(1, Math.round(Math.sqrt(vecs.length / 3))));
  const lab = vecs.length ? kmeans(vecs, k, recent.map(x => Math.log(1 + x.p.tokens))) : [];
  const clusters = [];
  for (let j = 0; j < k; j++) {
    const idx = lab.map((l, i) => (l === j ? i : -1)).filter(i => i >= 0);
    if (!idx.length) continue;
    const w = new Map();
    for (const i of idx) for (const [t, x] of corpus.weights(recent[i].p.terms)) w.set(t, (w.get(t) || 0) + x);
    const top = [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => corpus.surface.get(t) || t);
    clusters.push({ id: j, label: top.join(' · '), n: idx.length });
  }
  const align = minds.length === 1 ? alignment(minds[0].mind, corpus) : [];
  const pieces = recent.map((x, i) => {
    const c = P ? P.coords[i] : [0, 0, 0];
    return [x.p.t, x.p.kind, x.p.label, x.p.tokens, x.p.gen, +c[0].toFixed(3), +c[1].toFixed(3), +c[2].toFixed(3), lab[i] ?? 0, x.owner, x.p.err ? 1 : 0];
  });
  const goals = goalsAll.map(x => { const c = P ? P.project(x.v) : [0, 0, 0]; return [x.g.t, x.g.label, +c[0].toFixed(3), +c[1].toFixed(3), +c[2].toFixed(3), x.owner]; });
  const ctx = minds.map(({ id, mind }) => ({ id, hist: mind.ctxHist.slice(-400), compactions: mind.compactions, gen: mind.gen }));
  const v = { engine: 'lexical', pieces, goals, clusters, align, ctx, limitHint: ctxLimitHint || 0 };
  cache.set(key, { sig, v, axes: P ? P.axes : null });
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return v;
}

module.exports = { AgentMind, Corpus, terms, cosine, snapshotMinds, alignment, drift, DIM, DRIFT_REL, DRIFT_RUN };
