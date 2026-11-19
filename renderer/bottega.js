// Libro della bottega: le lezioni di un progetto, dedotte dai fatti (esiti, ripetizioni, correzioni).
// Si apre con openBottega(sid, lessonId) dal tabellone del piano, dal Nonno, o con openBottega(null, null, {key})
// dalla scheda BOTTEGA dell'atrio.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const LOCALE = (window.AO_I18N && AO_I18N.locale) || 'it-IT';
  const day = t => new Date(t).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  const when = t => new Date(t).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const LEVEL = { lesson: [tr('LEZIONE'), 'ok'], observation: [tr('OSSERVAZIONE'), ''] };

  const B = { open: false, q: null, focus: null, data: null, showObs: false, showIgnored: false, timer: null, sig: '', md: null, tab: 'lessons', fb: null, fbAt: 0, hist: null, histTable: false, find: { kind: 'file', q: '', err: false, res: null, busy: false } };
  // scheda FEEDBACK: i nomi brevi delle funzioni e dei modi (i messaggi partono dagli hook, vedi le opzioni)
  const FEATURE = {
    sessionLessons: tr('Lezioni a inizio sessione'), elder: tr('Il Nonno'), loop: tr('Giro in tondo'),
    stale: tr('File cambiato da un altro'), claims: tr('Affermazioni senza prove'), drift: tr('Ritorno al compito'),
  };
  // gli esiti (vedi src/core/outcomes.js): etichette oneste, sono indizi
  const OUTCOME = { helped: tr('PROBABILMENTE UTILE'), ignored: tr('IGNORATO'), unclear: tr('NON SI PUÒ DIRE') };
  // perché la sezione non si può scrivere nel CLAUDE.md (allora resta solo "Copia")
  const WHY_NOT = {
    demo: tr('È la demo: il progetto non esiste davvero.'), cowork: tr('Sessione Cowork: i suoi file non sono su questo computer.'),
    missing: tr('La cartella del progetto non si trova su questo computer.'), notdir: tr('La cartella del progetto non si trova su questo computer.'),
    readonly: tr('Il file o la cartella sono in sola lettura.'), symlink: tr('CLAUDE.md è un collegamento a un altro file: non lo tocco.'),
    notfile: tr('CLAUDE.md non è un file normale.'), empty: tr('Non ci sono ancora lezioni da passare.'),
  };
  function el() { return $('#bottega'); }

  window.openBottega = function (sid, lessonId, opts = {}) {
    B.open = true; B.focus = lessonId || null; B.sig = ''; B.scrolled = false; B.md = null;
    B.tab = ['feedback', 'history'].includes(opts.tab) ? opts.tab : 'lessons'; B.fb = null; B.fbAt = 0; B.hist = null; B.histTable = false; B.find = { kind: 'file', q: '', err: false, res: null, busy: false };
    B.q = sid ? { sid } : opts.key ? { key: opts.key } : null;
    if (!B.q) return;
    el().hidden = false;
    el().innerHTML = `<p class="dim">${esc(tr('Carico il libro…'))}</p>`;
    load();
    clearInterval(B.timer);
    B.timer = setInterval(() => {
      if (!B.open) return;
      if (B.data && B.data.learning && B.data.learning.running) load();
      else if (B.tab === 'feedback' && Date.now() - B.fbAt > 5000) loadFeedback(); // il registro cresce mentre gli agenti lavorano
    }, 1500);
  };
  window.closeBottega = function () { B.open = false; clearInterval(B.timer); const e = el(); if (e) e.hidden = true; };
  window.bottegaOpen = () => B.open;

  async function load() {
    try {
      const d = await (await fetch('/api/bottega?' + new URLSearchParams(B.q))).json();
      if (d && d.ok) { B.data = d; render(); if (B.tab === 'feedback') loadFeedback(); if (B.tab === 'history' && !B.hist) loadHistory(); }
      else el().innerHTML = `<span class="x">X</span><p>${esc(tr('Nessun libro per questo progetto.'))}</p>`, bindClose();
    } catch {}
  }
  // il registro dei messaggi agli agenti di questo progetto, mandati e in ombra
  async function loadFeedback() {
    B.fbAt = Date.now();
    try {
      const d = await (await fetch('/api/feedback/log?' + new URLSearchParams(B.q))).json();
      B.fb = d && d.ok ? d.entries : [];
    } catch { B.fb = B.fb || []; }
    try { const x = await (await fetch('/api/feedback/experiment?' + new URLSearchParams(B.q))).json(); B.exp = x && x.ok ? x : null; } catch { B.exp = null; }
    if (B.open && B.data) render();
  }
  function feedbackHtml() {
    if (!B.fb) return `<p class="dim">${esc(tr('Carico il registro…'))}</p>`;
    if (!B.fb.length) return `<p class="dim">${esc(tr('Ancora nessun messaggio per questo progetto. Le funzioni di feedback si accendono dalle opzioni, una per una.'))}</p>`;
    return B.fb.map(e => {
      const late = e.outcome === 'late', sh = e.mode === 'shadow';
      const [lab, cls] = late ? [tr('IN RITARDO'), 'off'] : sh ? [tr('IN OMBRA'), ''] : [tr('MANDATO'), 'ok'];
      return `<div class="lesson fbrow${sh ? ' sh' : ''}">` +
        `<div class="lt"><b class="${cls}">${esc(lab)}</b> <span class="w">${esc(when(e.t))}</span> <span class="ag">${esc(e.name || (e.agent === 'main' ? 'CLAUDE' : e.agent))}</span> ${esc(FEATURE[e.feature] || e.feature)}</div>` +
        `<div class="ftx">${esc(e.text)}</div>` +
        (e.sent ? `<div class="ld" title="${esc(tr('Il testo arrivato all\'agente: i messaggi partono sempre in inglese.'))}">${esc(tr('In inglese: {text}', { text: e.sent }))}</div>` : '') +
        (late ? `<div class="ld">${esc(tr('La risposta è arrivata oltre il tempo massimo: non è stata mandata.'))}</div>`
          : `<div class="oc ${esc(e.outcome || 'wait')}"><b>${esc(OUTCOME[e.outcome] || tr('IN ATTESA'))}</b> ${esc(e.why || (e.outcome ? '' : tr('si decide dai prossimi passi dell\'agente')))}</div>`) +
        '</div>';
    }).join('');
  }
  // per ogni funzione: i mandati accanto a quelli in ombra, che sono il termine di paragone
  // l'esperimento (S11): i due gruppi a confronto, solo con numeri e solo quando ce ne sono abbastanza
  function experimentHtml() {
    const x = B.exp;
    if (!x || x.demo || !x.all) return '';
    const pct = v => (v * 100).toFixed(0) + '%', num = v => (Math.round(v * 10) / 10).toFixed(1), sgn = (v, f) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v));
    const line = (r, scope) => {
      if (!r) return '';
      if (!r.enough) return tr('{scope}: dati insufficienti (n = {a} con i messaggi, {b} senza; ne servono almeno {min} per gruppo)', { scope, a: r.n.on, b: r.n.shadow, min: x.minN });
      const q = r.result;
      return r.kind === 'messages'
        ? tr('{scope}: probabilmente utili {a} con i messaggi (n = {na}) contro {b} senza (n = {nb}); differenza {d} (al 95% tra {lo} e {hi})',
          { scope, a: pct(q.p1), na: r.n.on, b: pct(q.p2), nb: r.n.shadow, d: sgn(q.diff * 100, v => v.toFixed(0)) + ' pt', lo: sgn(q.lo * 100, v => v.toFixed(0)), hi: sgn(q.hi * 100, v => v.toFixed(0)) })
        : tr('{scope}: errori ogni 100 azioni {a} con le lezioni (n = {na} sessioni) contro {b} senza (n = {nb}); differenza {d} (al 95% tra {lo} e {hi})',
          { scope, a: num(q.m1), na: r.n.on, b: num(q.m2), nb: r.n.shadow, d: sgn(q.diff, num), lo: sgn(q.lo, num), hi: sgn(q.hi, num) });
    };
    const rows = x.all.map((all, i) => {
      const proj = x.project && x.project[i], on = x.modes && x.modes[all.feature] === 'experiment';
      const any = (r) => r && (r.n.on + r.n.shadow > 0);
      if (!on && !any(all)) return '';
      return `<div><b>${esc(FEATURE[all.feature] || all.feature)}</b>${on ? '' : ` <span class="dim">${esc(tr('(esperimento spento)'))}</span>`}` +
        (proj ? `<br>${esc(line(proj, tr('questo progetto')))}` : '') +
        // se tutti i casi vengono da questo progetto, la seconda riga ripeterebbe la prima
        (proj && JSON.stringify(proj.n) === JSON.stringify(all.n) ? '' : `<br>${esc(line(all, tr('tutti i progetti')))}`) + '</div>';
    }).filter(Boolean);
    if (!rows.length) return '';
    return `<div class="fbsum fbexp"><div><b>${esc(tr('ESPERIMENTO'))}</b></div>${rows.join('')}` +
      `<p class="dim">${esc(tr('Ogni sessione finisce a caso nel gruppo con i messaggi o in quello senza: i due gruppi lavorano negli stessi giorni e con gli stessi modelli. Una differenza il cui intervallo comprende lo zero non dice niente.'))}</p></div>`;
  }
  function feedbackSummary() {
    const by = new Map();
    for (const e of B.fb || []) {
      if (e.outcome === 'late') continue;
      const f = by.get(e.feature) || { on: [0, 0, 0], shadow: [0, 0, 0] }; // [in tutto, giudicati, probabilmente utili]
      const c = e.mode === 'on' ? f.on : f.shadow;
      c[0]++; if (e.outcome === 'helped' || e.outcome === 'ignored') { c[1]++; if (e.outcome === 'helped') c[2]++; }
      by.set(e.feature, f);
    }
    if (!by.size) return '';
    const part = (c, sent) => !c[0] ? '' : (sent ? trn('{n} mandato', '{n} mandati', c[0]) : trn('{n} in ombra', '{n} in ombra', c[0])) +
      (c[1] ? ' · ' + tr('probabilmente utili {h} su {j}', { h: c[2], j: c[1] }) : '');
    return `<div class="fbsum">${[...by].map(([f, x]) => `<div><b>${esc(FEATURE[f] || f)}</b> ${esc([part(x.on, true), part(x.shadow, false)].filter(Boolean).join('  |  '))}</div>`).join('')}` +
      `<p class="dim">${esc(tr('Esiti dedotti dai passi successivi dell\'agente: indizi, non prove. Quelli in ombra dicono che cosa fanno gli agenti quando nessuno li avvisa: è il termine di paragone.'))}</p></div>`;
  }
  async function post(path, body) {
    try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...B.q, ...body }) })).json(); } catch { return { ok: false }; }
  }
  function bindClose() { const x = el().querySelector('.x'); if (x) x.onclick = closeBottega; }

  function tabsHtml() {
    const tab = (k, label) => `<button data-tab="${k}" class="${B.tab === k ? 'on' : ''}">${esc(label)}</button>`;
    return `<div class="tabs">${tab('lessons', tr('LEZIONI'))}${tab('feedback', tr('FEEDBACK'))}${tab('history', tr('STORIA'))}</div>`;
  }
  function bindTabs() {
    for (const b of el().querySelectorAll('[data-tab]')) b.onclick = () => {
      if (B.tab === b.dataset.tab) return;
      B.tab = b.dataset.tab; B.md = null;
      render();
      if (B.tab === 'feedback') loadFeedback();
      if (B.tab === 'history') loadHistory();
    };
  }

  // ---- scheda STORIA (S12): come vanno le sessioni del progetto, settimana per settimana
  const HIST = () => [
    ['loops', tr('Giri in tondo')], ['stuck', tr('Fasi bloccate')], ['surprises', tr('Sorprese')], ['flaky', tr('Comandi instabili')],
    ['claims', tr('Affermazioni senza prove')], ['stale', tr('Memorie non aggiornate')], ['lessons', tr('Lezioni del Libro mandate agli agenti')], ['cost', tr('Costo')],
  ];
  const fmt = (m, v) => (v == null ? '—' : m === 'cost' ? '$' + v.toFixed(2) : (Math.round(v * 10) / 10).toFixed(1));
  async function loadHistory() {
    try { const x = await (await fetch('/api/history?metric=all&' + new URLSearchParams(B.q))).json(); B.hist = { ...x, at: Date.now() }; }
    catch { B.hist = { ok: false, at: Date.now() }; }
    if (B.open && B.data && B.tab === 'history') render();
  }
  // la lettura in una frase: le ultime 4 settimane contro le 4 prima, sempre con le sessioni dietro
  function reading(m, t) {
    if (!t) return '';
    const a = fmt(m, t.recent.perSession), b = fmt(m, t.before.perSession);
    if (t.verdict === 'not-enough') return tr('dati insufficienti: {a} sessioni nelle ultime 4 settimane, {b} nelle 4 prima (ne servono {min} per parte)', { a: t.recent.sessions, b: t.before.sessions, min: t.min });
    const base = { a, b, n: t.recent.sessions, m: t.before.sessions };
    const s = t.verdict === 'fewer' ? tr('meno di un mese fa: {a} a sessione ({n} sessioni) contro {b} ({m} sessioni)', base)
      : t.verdict === 'more' ? tr('più di un mese fa: {a} a sessione ({n} sessioni) contro {b} ({m} sessioni)', base)
        : tr('più o meno come un mese fa: {a} a sessione ({n} sessioni) contro {b} ({m} sessioni)', base);
    return s + (t.better === true ? ' · ' + tr('meglio') : t.better === false ? ' · ' + tr('peggio') : '');
  }
  // una linea per metrica: la media per sessione di ogni settimana; una settimana senza sessioni interrompe la linea
  const SW = 220, SH = 36, SP = 5;
  function spark(m, buckets) {
    const vals = buckets.map(b => b.perSession), max = Math.max(...vals.filter(v => v != null), 0) || 1;
    const step = (SW - 2 * SP) / Math.max(1, vals.length - 1), x = i => SP + i * step, y = v => SH - SP - (v / max) * (SH - 2 * SP);
    let d = '', pen = false, last = -1;
    vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; last = i; });
    // una settimana isolata tra due vuote è un punto, non una linea
    const dots = vals.map((v, i) => (v != null && (vals[i - 1] == null) && (vals[i + 1] == null) && i !== last ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" class="sp-dot"/>` : '')).join('');
    return `<svg class="spark" viewBox="0 0 ${SW} ${SH}" width="${SW}" height="${SH}" data-m="${m}" role="img" aria-label="${esc(tr('andamento settimanale'))}">` +
      `<line x1="${SP}" y1="${SH - SP}" x2="${SW - SP}" y2="${SH - SP}" class="sp-base"/>` +
      (d ? `<path d="${d}" class="sp-line"/>` : '') + dots +
      (last >= 0 ? `<circle cx="${x(last).toFixed(1)}" cy="${y(vals[last]).toFixed(1)}" r="4" class="sp-end"/>` : '') +
      `<line x1="0" y1="0" x2="0" y2="${SH}" class="sp-cross" visibility="hidden"/></svg>`;
  }
  function historyBody() {
    const h = B.hist;
    if (!h) return `<p class="dim">${esc(tr('Carico lo storico…'))}</p>`;
    if (h.demo) return `<p class="dim">${esc(tr('Libro della demo: la demo non scrive niente nello storico.'))}</p>`;
    if (!h.ok) return `<p class="dim">${esc(tr('Non riesco a leggere lo storico.'))}</p>`;
    const M = h.metrics;
    // dalla prima settimana con sessioni (sempre almeno 8): un progetto giovane non resta schiacciato in fondo alla linea
    const first = M.loops.buckets.findIndex(b => b.sessions > 0);
    const from = first < 0 ? 0 : Math.max(0, Math.min(first, M.loops.buckets.length - 8));
    B.histFrom = from;
    const cut = m => M[m].buckets.slice(from), weeks = cut('loops');
    const total = weeks.reduce((a, b) => a + b.sessions, 0);
    if (!total) return `<p class="dim">${esc(tr('Ancora nessuna sessione di questo progetto nello storico.'))}</p>`;
    if (B.histTable) {
      const cols = HIST();
      return `<table class="htable"><thead><tr><th>${esc(tr('Settimana'))}</th><th>${esc(tr('Sessioni'))}</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>` +
        weeks.map((w, i) => ({ w, i })).reverse().map(({ w, i }) => `<tr><td>${esc(day(w.start))}</td><td>${w.sessions}</td>${cols.map(([m]) => `<td>${esc(fmt(m, cut(m)[i].perSession))}</td>`).join('')}</tr>`).join('') +
        `</tbody></table>`;
    }
    const rows = HIST().map(([m, label]) => `<div class="hrow"><div><b>${esc(label)}</b><br><span class="dim">${esc(reading(m, M[m].trend))}</span></div>${spark(m, cut(m))}</div>`).join('');
    const f = M.feedback.buckets.reduce((a, b) => { for (const k of Object.keys(a)) a[k] += b[k]; return a; }, { on: 0, shadow: 0, judgedOn: 0, helpedOn: 0, judgedShadow: 0, helpedShadow: 0 });
    const fb = f.on + f.shadow ? `<p class="dim">${esc(tr('Messaggi agli agenti in queste settimane: {on} mandati (probabilmente utili {h1} su {j1}), {sh} in ombra ({h2} su {j2}). Il confronto vero è nell\'esperimento, scheda FEEDBACK.', { on: f.on, h1: f.helpedOn, j1: f.judgedOn, sh: f.shadow, h2: f.helpedShadow, j2: f.judgedShadow }))}</p>` : '';
    return rows + fb;
  }
  // la ricerca nei passi salvati (S12b): un file, un comando o un errore, dal più recente
  const ACTION = () => ({ read: tr('legge'), edit: tr('modifica'), search: tr('cerca'), web: tr('web'), run: tr('lancia'), verify: tr('verifica'), look: tr('guarda'), delegate: tr('delega'), tool: tr('strumento'), other: tr('altro') });
  function findHtml() {
    const f = B.find, opt = (v, l) => `<option value="${v}" ${f.kind === v ? 'selected' : ''}>${esc(l)}</option>`;
    const r = f.res;
    let res = '';
    if (f.busy) res = `<p class="dim">${esc(tr('Cerco…'))}</p>`;
    else if (r && !r.ok) res = `<p class="dim">${esc(r.error || tr('Non riesco a cercare.'))}</p>`;
    else if (r) {
      const A = ACTION();
      res = `<p class="dim">${esc(r.results.length ? trn('{n} passo trovato', '{n} passi trovati', r.results.length) : tr('Nessun passo trovato.'))}` +
        (r.partial ? ' ' + esc(tr('Ricerca parziale: guardati i {n} passi più recenti.', { n: r.scanned })) : '') + '</p>' +
        r.results.map(x => `<div class="hfound"><span class="dim">${esc(when(x.t))}</span> · ${esc(x.agent === 'main' ? 'CLAUDE' : x.agent)} · ${esc(A[x.action] || x.action)} <b>${esc(String(x.target || '').replace(/^cmd:/, ''))}</b>` +
          (x.cmd ? ` <span class="dim">(${esc(x.cmd)})</span>` : '') + ` · <span class="${x.outcome === 'error' ? 'bad' : 'ok'}">${esc(x.outcome === 'error' ? tr('fallito') : tr('riuscito'))}</span>` +
          (x.err ? `<br><span class="dim">${esc(x.err)}</span>` : '') +
          ` <button data-replay="${esc(x.session)}" data-at="${x.t}">${esc(tr('REPLAY'))}</button></div>`).join('');
    }
    return `<div class="hfind"><select data-h="kind">${opt('file', tr('File'))}${opt('command', tr('Comando'))}${opt('error', tr('Errore'))}</select>` +
      `<input type="text" data-h="q" maxlength="200" value="${esc(f.q)}" placeholder="${esc(tr('es. login.ts, npm test, TypeError'))}">` +
      `<label class="chk"><input type="checkbox" data-h="err" ${f.err ? 'checked' : ''}> ${esc(tr('solo falliti'))}</label>` +
      `<button data-do="hfind">${esc(tr('CERCA'))}</button></div>` + (res ? `<div class="hres">${res}</div>` : '');
  }
  async function runFind() {
    const f = B.find;
    if (!f.q.trim()) return;
    f.busy = true; render();
    try {
      const qs = new URLSearchParams({ ...B.q, [f.kind]: f.q.trim(), limit: '50', ...(f.err ? { outcome: 'error' } : {}) });
      const r = await (await fetch('/api/history/search?' + qs)).json();
      f.res = { ...r, at: Date.now() };
    } catch { f.res = { ok: false, at: Date.now() }; }
    f.busy = false; render();
  }

  function renderHistory() {
    const d = B.data;
    el().innerHTML = `<span class="x" title="${esc(tr('Chiudi'))}">X</span>` +
      `<h3>${esc(tr('LIBRO DELLA BOTTEGA'))} · ${esc(d.name)}</h3>` + tabsHtml() +
      `<p class="honest">${esc(tr('Come vanno le sessioni di questo progetto nelle ultime 26 settimane: ogni linea è la media per sessione, settimana per settimana. La frase accanto confronta le ultime 4 settimane con le 4 prima.'))}</p>` +
      (B.hist && B.hist.ok && !B.hist.demo ? `<div class="bar"><button data-do="histtable">${esc(B.histTable ? tr('LINEE') : tr('NUMERI'))}</button></div>` : '') +
      `<div class="list hist">${B.hist && B.hist.ok && !B.hist.demo ? findHtml() : ''}${historyBody()}</div><div class="htip" hidden></div>`;
    bindClose(); bindTabs();
    const e = el(), tip = e.querySelector('.htip');
    // la ricerca: i campi restano come li hai lasciati; Invio cerca
    const fk = e.querySelector('[data-h=kind]'), fq = e.querySelector('[data-h=q]'), fe = e.querySelector('[data-h=err]'), fb = e.querySelector('[data-do=hfind]');
    if (fk) {
      fk.onchange = () => { B.find.kind = fk.value; };
      fq.oninput = () => { B.find.q = fq.value; };
      fq.onkeydown = ev => { if (ev.key === 'Enter') runFind(); };
      fe.onchange = () => { B.find.err = fe.checked; };
      fb.onclick = runFind;
    }
    for (const b of e.querySelectorAll('[data-replay]')) b.onclick = async () => {
      const r = await post('/api/replay', { action: 'start', key: b.dataset.replay, at: Number(b.dataset.at) });
      if (r && r.ok) { closeBottega(); if (window.goTo) goTo('replay'); }
      else if (window.toast) toast((r && r.error) || tr('Sessione non trovata'), false);
    };
    const tg = e.querySelector('[data-do=histtable]');
    if (tg) tg.onclick = () => { B.histTable = !B.histTable; B.sig = ''; render(); };
    // al passaggio del mouse: la settimana, il valore per sessione e quante sessioni
    for (const svg of e.querySelectorAll('svg.spark')) {
      const m = svg.dataset.m, bk = B.hist.metrics[m].buckets.slice(B.histFrom || 0), cross = svg.querySelector('.sp-cross');
      svg.onmousemove = ev => {
        const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (SW / r.width);
        const i = Math.max(0, Math.min(bk.length - 1, Math.round((px - SP) / ((SW - 2 * SP) / Math.max(1, bk.length - 1)))));
        const b = bk[i], cx = SP + i * ((SW - 2 * SP) / Math.max(1, bk.length - 1));
        cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
        tip.textContent = b.sessions ? tr('settimana del {d}: {v} a sessione ({n} sessioni)', { d: day(b.start), v: fmt(m, b.perSession), n: b.sessions }) : tr('settimana del {d}: nessuna sessione', { d: day(b.start) });
        const er = e.getBoundingClientRect();
        tip.style.left = Math.min(er.width - 230, ev.clientX - er.left + 12) + 'px'; tip.style.top = (ev.clientY - er.top + 14) + 'px';
        tip.hidden = false;
      };
      svg.onmouseleave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
    }
  }

  function render() {
    const d = B.data;
    const fbTab = B.tab === 'feedback';
    const sig = JSON.stringify([B.hist && B.hist.at, B.histTable, B.find.res && B.find.res.at, B.find.busy, d.lessons.map(l => [l.id, l.count, l.pinned, l.ignored, l.level]), d.learning, B.showObs, B.showIgnored, B.focus, B.md, d.mute, B.tab, B.fb && [B.fb.length, B.fb[0] && B.fb[0].id, B.fb.map(e => e.outcome).join()]]);
    if (sig === B.sig) return;
    B.sig = sig;
    if (B.tab === 'history') return renderHistory();
    const live = window.sessions ? new Set(sessions().filter(s => !s.demo).map(s => s.id)) : new Set();
    const isDemo = window.sessions && sessions().some(s => s.demo && s.cwd === d.cwd);
    const lessons = d.lessons.filter(l => !l.ignored && l.level === 'lesson');
    const obs = d.lessons.filter(l => !l.ignored && l.level !== 'lesson');
    const ign = d.lessons.filter(l => l.ignored);
    const card = l => {
      const [lab, cls] = l.pinned ? [tr('FISSATA'), 'pin'] : l.ignored ? [tr('IGNORATA'), 'off'] : LEVEL[l.level] || LEVEL.observation;
      const period = l.first && l.last ? (day(l.first) === day(l.last) ? tr('il {a}', { a: day(l.first) }) : tr('dal {a} al {b}', { a: day(l.first), b: day(l.last) })) : '';
      const ev = l.evidence.map(e => `<li><span class="w">${esc(when(e.t))}</span> <span class="ag">${esc(e.agent || '')}</span> ${esc(e.excerpt || '')}` +
        (!isDemo && e.sid && !live.has(e.sid) ? ` <button data-replay="${esc(e.sid)}" data-at="${e.t}" title="${esc(tr('Rivedi la sessione da questo momento'))}">${esc(tr('REPLAY'))}</button>` : '') + '</li>').join('');
      return `<div class="lesson ${l.id === B.focus ? 'focus' : ''}" data-id="${esc(l.id)}">` +
        `<div class="lt"><b class="${cls}">${esc(lab)}</b> ${esc(l.title)}</div>` +
        `<div class="ld">${esc(l.detail)}${period ? ' · ' + esc(period) : ''}</div>` +
        (ev ? `<ul class="ev">${ev}</ul>` : '') +
        `<div class="la"><button data-act="pin">${esc(l.pinned ? tr('NON FISSARE') : tr('FISSA'))}</button>` +
        `<button data-act="${l.ignored ? 'unignore' : 'ignore'}">${esc(l.ignored ? tr('RIPRISTINA') : tr('IGNORA'))}</button>` +
        `<button data-act="forget" class="danger">${esc(tr('DIMENTICA'))}</button></div></div>`;
    };
    const lj = d.learning;
    const learn = lj && lj.running ? `<span class="prog">${esc(tr('Leggo l\'archivio: {a} di {b}…', { a: lj.done, b: lj.total }))}</span>`
      : `<button data-do="learn" title="${esc(tr('Rilegge le sessioni passate di questo progetto (non quelle aperte) e ne ricava le lezioni'))}">${esc(tr('IMPARA DALL\'ARCHIVIO'))}</button>` +
        (lj ? ` <span class="dim">${esc(lj.error ? tr('Finito, con un errore: {e}', { e: lj.error }) : trn('{n} caso nuovo', '{n} casi nuovi', lj.cases))}</span>` : '');
    el().innerHTML = `<span class="x" title="${esc(tr('Chiudi'))}">X</span>` +
      `<h3>${esc(tr('LIBRO DELLA BOTTEGA'))} · ${esc(d.name)}</h3>` +
      tabsHtml() +
      (fbTab
        ? `<p class="honest">${esc(tr('Quello che Platypus ha detto agli agenti di questo progetto, o avrebbe detto («in ombra»). I messaggi partono in inglese: qui li leggi nella lingua dell\'ufficio.'))}</p>`
        : `<p class="honest">${esc(tr('Lezioni dedotte dai fatti (esiti, ripetizioni, correzioni) delle sessioni di questo progetto: indizi, non regole certe.'))}</p>`) +
      (fbTab ? '' : `<div class="bar">${isDemo ? `<span class="dim">${esc(tr('Libro della demo: lezioni finte.'))}</span>` : learn}<span class="dim">${esc(trn('{n} sessione letta dall\'archivio', '{n} sessioni lette dall\'archivio', d.learnedSessions || 0))}</span>` +
      `<button data-do="md" title="${esc(tr('Prepara una sezione per il CLAUDE.md del progetto con le lezioni fissate e le più forti'))}">${esc(tr('PROPONI PER CLAUDE.MD'))}</button></div>`) +
      (isDemo ? '' : `<label class="mute" title="${esc(tr('Vale per le funzioni di feedback delle opzioni: con questa spunta Platypus non manda né registra messaggi per gli agenti di questo progetto.'))}"><input type="checkbox" data-do="mute" ${d.mute ? 'checked' : ''}> ${esc(tr('Non parlare agli agenti di questo progetto'))}</label>` +
        `<button data-do="forgetproject" class="danger forgetproject" title="${esc(tr('Toglie dallo storico tutto quello che riguarda questo progetto. Chiede conferma.'))}">${esc(tr('DIMENTICA QUESTO PROGETTO…'))}</button>`) +
      (fbTab ? `<div class="list">${experimentHtml()}${feedbackSummary()}${feedbackHtml()}</div>` : '') +
      (fbTab ? '' : (B.md ? `<div class="md"><div class="mh">${esc(tr('ANTEPRIMA'))} <span class="dim">${esc(B.md.path)}</span></div>` +
        (B.md.markdown ? `<pre>${esc(B.md.markdown)}</pre>` : `<p class="dim">${esc(WHY_NOT.empty)}</p>`) +
        `<div class="la"><button data-do="copy" ${B.md.markdown ? '' : 'disabled'}>${esc(tr('COPIA'))}</button>` +
        `<button data-do="write" ${B.md.writable ? '' : 'disabled'} title="${esc(B.md.writable ? tr('Scrive la sezione tra i marcatori di Platypus, dopo aver salvato una copia del file') : (WHY_NOT[B.md.reason] || B.md.reason))}">${esc(tr('AGGIUNGI A CLAUDE.MD'))}</button>` +
        `<button data-do="mdclose">${esc(tr('CHIUDI'))}</button></div>` +
        (!B.md.writable && B.md.markdown ? `<p class="dim">${esc(tr('Solo «Copia»: {why}', { why: WHY_NOT[B.md.reason] || B.md.reason }))}</p>` : '') + '</div>' : '') +
      `<div class="list">` +
      (lessons.length ? lessons.map(card).join('') : `<p class="dim">${esc(tr('Ancora nessuna lezione: servono più casi, in più sessioni.'))}</p>`) +
      (obs.length ? `<button class="tog" data-tog="obs">${esc((B.showObs ? '▾ ' : '▸ ') + trn('{n} osservazione (un caso solo o peso basso)', '{n} osservazioni (un caso solo o peso basso)', obs.length))}</button>` + (B.showObs ? obs.map(card).join('') : '') : '') +
      (ign.length ? `<button class="tog" data-tog="ign">${esc((B.showIgnored ? '▾ ' : '▸ ') + trn('{n} ignorata', '{n} ignorate', ign.length))}</button>` + (B.showIgnored ? ign.map(card).join('') : '') : '') +
      `</div>`);
    bindClose();
    const e = el();
    bindTabs();
    for (const b of e.querySelectorAll('[data-act]')) b.onclick = async () => {
      const id = b.closest('.lesson').dataset.id, action = b.dataset.act;
      if (action === 'forget' && !confirm(tr('Dimenticare questa lezione? Se i fatti si ripetono, il libro la imparerà di nuovo.'))) return;
      await post('/api/bottega', { action, id });
      load();
    };
    for (const b of e.querySelectorAll('[data-tog]')) b.onclick = () => { if (b.dataset.tog === 'obs') B.showObs = !B.showObs; else B.showIgnored = !B.showIgnored; render(); };
    for (const b of e.querySelectorAll('[data-replay]')) b.onclick = async () => {
      const r = await post('/api/replay', { action: 'start', key: b.dataset.replay, at: Number(b.dataset.at) });
      if (r && r.ok) { closeBottega(); if (window.goTo) goTo('replay'); }
      else if (window.toast) toast((r && r.error) || tr('Sessione non trovata'), false);
    };
    // tutto il progetto, dallo storico: con la stessa conferma della sezione ARCHIVIO delle opzioni
    const fp = e.querySelector('[data-do=forgetproject]');
    if (fp) fp.onclick = async () => {
      let info = null;
      try { info = await (await fetch('/api/store')).json(); } catch {}
      const ask = window.storeForgetConfirm ? storeForgetConfirm(d.name, info) : tr('Dimenticare il progetto «{name}»?', { name: d.name });
      if (!confirm(ask)) return;
      const r = await post('/api/store', { action: 'forget', confirm: true });
      if (window.toast) toast(r && r.ok ? tr('Progetto dimenticato: {n} documenti tolti', { n: r.documents }) : tr('Non sono riuscito a dimenticare il progetto'), !!(r && r.ok));
      if (r && r.ok) closeBottega(); else load(); // il Libro non c'è più
    };
    const mute = e.querySelector('[data-do=mute]');
    if (mute) mute.onchange = async () => { await post('/api/bottega', { action: mute.checked ? 'mute' : 'unmute' }); load(); };
    // CLAUDE.md: anteprima, copia, e scrittura solo dopo una conferma che mostra il percorso
    const mdBtn = e.querySelector('[data-do=md]');
    if (mdBtn) mdBtn.onclick = async () => {
      try { const r = await (await fetch('/api/bottega/claudemd?' + new URLSearchParams(B.q))).json(); if (r && r.ok) { B.md = r; render(); } } catch {}
    };
    const mc = e.querySelector('[data-do=mdclose]');
    if (mc) mc.onclick = () => { B.md = null; render(); };
    const cp = e.querySelector('[data-do=copy]');
    if (cp) cp.onclick = async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(B.md.markdown); ok = true; } catch {
        const ta = document.createElement('textarea'); ta.value = B.md.markdown; document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch {} ta.remove();
      }
      if (window.toast) toast(ok ? tr('Sezione copiata negli appunti') : tr('Non riesco a copiare: selezionala a mano'), ok);
    };
    const wr = e.querySelector('[data-do=write]');
    if (wr) wr.onclick = async () => {
      if (!confirm(tr('Scrivere la sezione nel file {path}? Il resto del file resta com\'è e prima ne salvo una copia ({backup}).', { path: B.md.path, backup: 'CLAUDE.md.platypus-backup' }))) return;
      const r = await post('/api/bottega/claudemd', { confirm: true });
      if (window.toast) toast(r.ok ? (r.mode === 'replace' ? tr('Sezione aggiornata in {path}', { path: r.path }) : tr('Sezione aggiunta in {path}', { path: r.path })) : tr('Non ho scritto nulla: {why}', { why: WHY_NOT[r.reason || r.error] || r.reason || r.error || '?' }), !!r.ok);
      if (r.ok) { B.md = null; render(); }
    };
    const lb = e.querySelector('[data-do=learn]');
    if (lb) lb.onclick = async () => {
      const r = await post('/api/bottega/learn', {});
      if (!r.ok && window.toast) toast(r.reason || tr('Non riesco a leggere l\'archivio.'), false);
      load();
    };
    if (B.focus && !B.scrolled) { const f = e.querySelector('.lesson.focus'); if (f) { f.scrollIntoView({ block: 'center' }); B.scrolled = true; } }
  }
})();
