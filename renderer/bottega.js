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

  const B = { open: false, q: null, focus: null, data: null, showObs: false, showIgnored: false, timer: null, sig: '', md: null, tab: 'lessons', fb: null, fbAt: 0 };
  // scheda FEEDBACK: i nomi brevi delle funzioni e dei modi (i messaggi partono dagli hook, vedi le opzioni)
  const FEATURE = {
    sessionLessons: tr('Lezioni a inizio sessione'), elder: tr('Il Nonno'), loop: tr('Giro in tondo'),
    stale: tr('File cambiato da un altro'), claims: tr('Affermazioni senza prove'), drift: tr('Ritorno al compito'),
  };
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
    B.tab = opts.tab === 'feedback' ? 'feedback' : 'lessons'; B.fb = null; B.fbAt = 0;
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
      if (d && d.ok) { B.data = d; render(); if (B.tab === 'feedback') loadFeedback(); }
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
        (late ? `<div class="ld">${esc(tr('La risposta è arrivata oltre il tempo massimo: non è stata mandata.'))}</div>` : e.outcome ? `<div class="ld">${esc(tr('Esito: {outcome}', { outcome: e.outcome }))}</div>` : '') +
        '</div>';
    }).join('');
  }
  async function post(path, body) {
    try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...B.q, ...body }) })).json(); } catch { return { ok: false }; }
  }
  function bindClose() { const x = el().querySelector('.x'); if (x) x.onclick = closeBottega; }

  function render() {
    const d = B.data;
    const fbTab = B.tab === 'feedback';
    const sig = JSON.stringify([d.lessons.map(l => [l.id, l.count, l.pinned, l.ignored, l.level]), d.learning, B.showObs, B.showIgnored, B.focus, B.md, d.mute, B.tab, B.fb && [B.fb.length, B.fb[0] && B.fb[0].id, B.fb.map(e => e.outcome).join()]]);
    if (sig === B.sig) return;
    B.sig = sig;
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
      `<div class="tabs"><button data-tab="lessons" class="${fbTab ? '' : 'on'}">${esc(tr('LEZIONI'))}</button><button data-tab="feedback" class="${fbTab ? 'on' : ''}">${esc(tr('FEEDBACK'))}</button></div>` +
      (fbTab
        ? `<p class="honest">${esc(tr('Quello che Platypus ha detto agli agenti di questo progetto, o avrebbe detto («in ombra»). I messaggi partono in inglese: qui li leggi nella lingua dell\'ufficio.'))}</p>`
        : `<p class="honest">${esc(tr('Lezioni dedotte dai fatti (esiti, ripetizioni, correzioni) delle sessioni di questo progetto: indizi, non regole certe.'))}</p>`) +
      (fbTab ? '' : `<div class="bar">${isDemo ? `<span class="dim">${esc(tr('Libro della demo: lezioni finte.'))}</span>` : learn}<span class="dim">${esc(trn('{n} sessione letta dall\'archivio', '{n} sessioni lette dall\'archivio', d.learnedSessions || 0))}</span>` +
      `<button data-do="md" title="${esc(tr('Prepara una sezione per il CLAUDE.md del progetto con le lezioni fissate e le più forti'))}">${esc(tr('PROPONI PER CLAUDE.MD'))}</button></div>`) +
      (isDemo ? '' : `<label class="mute" title="${esc(tr('Vale per le funzioni di feedback delle opzioni: con questa spunta Platypus non manda né registra messaggi per gli agenti di questo progetto.'))}"><input type="checkbox" data-do="mute" ${d.mute ? 'checked' : ''}> ${esc(tr('Non parlare agli agenti di questo progetto'))}</label>`) +
      (fbTab ? `<div class="list">${feedbackHtml()}</div>` : '') +
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
    for (const b of e.querySelectorAll('[data-tab]')) b.onclick = () => {
      if (B.tab === b.dataset.tab) return;
      B.tab = b.dataset.tab; B.md = null;
      render();
      if (B.tab === 'feedback') loadFeedback();
    };
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
