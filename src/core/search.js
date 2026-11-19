'use strict';
// Ricerca nell'archivio sui passi salvati (S12b di docs/plans/2.13-storage.md): "quando ho toccato questo file?",
// "quante volte è fallito questo comando?", "dove è comparso questo errore?". Si risponde dalla collezione steps, senza
// rileggere i transcript.
//
// Che cosa si può cercare: solo quello che steps tiene già (collections.js): il bersaglio relativo (un file, cmd:…,
// web:…), lo strumento, l'esito, la firma normalizzata dell'errore e la forma del comando (cmdShape, qui sotto).
//
// Come: i passi del progetto, dal più recente, a pagine; il confronto è "contiene" (senza maiuscole), così "login.ts"
// trova "src/auth/login.ts". Con un tempo massimo: oltre, si restituisce quello che si è trovato e quanti passi si sono
// guardati (partial), così la ricerca non tiene mai fermo il motore.

const PAGE = 2000;
const BUDGET_MS = 150;
const MAX_LIMIT = 200;

// La forma di un comando, quella che resta nello storico: le prime parole semplici (lettere, cifre, . _ : @ + -), fino
// al primo flag, percorso o valore, al massimo 4. "npm run test:e2e" resta così; "mysql -u root -phunter2" diventa
// "mysql"; "git commit -m '…'" diventa "git commit". Basta per cercare, e una password non ci arriva.
function cmdShape(core) {
  const out = [];
  for (const w of String(core || '').trim().split(/\s+/)) {
    // la prima parola può essere uno script della cartella ("./run.sh", "../tools/x" no: un solo livello, senza altre barre)
    const ok = /^[A-Za-z0-9._:@+-]+$/.test(w) || (!out.length && /^\.{1,2}\/[A-Za-z0-9._:@+-]+$/.test(w));
    if (!w || w.startsWith('-') || !ok) break;
    out.push(w);
    if (out.length >= 4) break;
  }
  return out.join(' ');
}

const lower = s => String(s || '').toLowerCase();

// q: { projects (chiavi, o null = tutti), file, command, error, outcome ('error'|'ok'), from, to, limit, budgetMs, clock }
// -> { results: [{ t, session, agent, action, tool, target, outcome, err, cmd, fail }], scanned, partial }
function searchSteps(store, q = {}) {
  const file = lower(q.file).trim(), command = lower(q.command).trim(), error = lower(q.error).trim();
  if (!file && !command && !error) throw Object.assign(new Error('serve almeno uno tra file, command ed error'), { code: 'bad-query' });
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(q.limit) || 50));
  const budget = Number.isFinite(q.budgetMs) ? q.budgetMs : BUDGET_MS;
  const now = typeof q.clock === 'function' ? q.clock : Date.now, t0 = now();
  const where = {};
  if (q.projects) where.project = { $in: q.projects };
  if (Number.isFinite(q.from) || Number.isFinite(q.to)) where.t = { ...(Number.isFinite(q.from) ? { $gte: q.from } : {}), ...(Number.isFinite(q.to) ? { $lt: q.to } : {}) };
  if (q.outcome === 'error' || q.outcome === 'ok') where.outcome = q.outcome;
  const match = s => {
    const target = lower(s.target);
    if (file && !(target.includes(file) && !/^(cmd|web|tool|agent):/.test(target))) return false;
    if (command && !(lower(s.cmd).includes(command) || (target.startsWith('cmd:') && target.slice(4).includes(command)))) return false;
    if (error && !(lower(s.err).includes(error) || lower(s.fail) === error)) return false;
    return true;
  };
  const results = [];
  let scanned = 0, skip = 0, partial = false;
  const steps = store.collection('steps');
  for (;;) {
    const page = steps.find(where, { sort: { t: -1 }, limit: PAGE, skip, fields: ['t', 'session', 'agent', 'action', 'tool', 'target', 'outcome', 'err', 'cmd', 'fail'] });
    scanned += page.length;
    for (const s of page) {
      if (!match(s)) continue;
      const { _id, ...rest } = s;
      results.push(rest);
      if (results.length >= limit) break;
    }
    if (results.length >= limit || page.length < PAGE) break;
    if (now() - t0 > budget) { partial = true; break; }
    skip += PAGE;
  }
  return { results, scanned, partial };
}

module.exports = { searchSteps, cmdShape, BUDGET_MS, MAX_LIMIT };
