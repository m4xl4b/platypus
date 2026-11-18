// Opzioni del "motore del significato" (piano docs/plans/neural-embeddings.md, E6): la scelta della fonte dei vettori,
// lo stato di ogni fonte, il modello in uso, la cache. game.js le inserisce nel pannello OPZIONI con tre agganci:
// embedOptionsHtml(st), embedOptionsBind(box) e embedOptionsCollect(box, body).
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const ENGINES = () => [['tfidf', tr('Solo lessicale (TF-IDF)')], ['auto', tr('Automatico: Ollama, poi ONNX, poi lessicale')], ['ollama', tr('Ollama (su questo computer)')], ['onnx', tr('Modello ONNX facoltativo')]];
  const STATES = () => ({ ready: tr('pronto'), 'not-found': tr('non trovato'), 'not-installed': tr('non installato'), error: tr('errore'), unknown: tr('non ancora controllato') });
  const NAMES = () => ({ tfidf: tr('Lessicale (TF-IDF)'), ollama: 'Ollama', onnx: 'ONNX' });
  const mb = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

  // un'etichetta onesta per la fonte dei vettori (anche per la bolla, in worldmap.js)
  function sourceLabel(src) {
    const s = String(src || 'tfidf');
    if (s === 'tfidf') return tr('lessicale (TF-IDF): confronta parole, non concetti');
    const [kind, ...rest] = s.split(':'), model = rest.join(':').replace(/:latest$/, '');
    if (kind === 'fake') return tr('significato: prova della demo (sinonimi)');
    return tr('significato: {source} · {model}', { source: NAMES()[kind] || kind, model });
  }

  function html(st) {
    const cur = st.embedEngine || 'tfidf';
    return `<fieldset class="embedopts"><legend>${esc(tr('MOTORE DEL SIGNIFICATO'))}</legend>` +
      `<p>${esc(tr('Come la bolla e la stella polare misurano di che cosa parla un agente. Il lessicale confronta le parole; un modello neurale capisce anche i sinonimi («login» e «autenticazione»). I testi restano sul computer.'))}</p>` +
      `<label><span>${esc(tr('Fonte dei vettori'))}</span><select name="embedEngine">` +
      ENGINES().map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('') + (cur === 'fake' ? `<option value="fake" selected>${esc(tr('Prova della demo'))}</option>` : '') + '</select></label>' +
      `<label title="${esc(tr('Vuoto: il primo modello di embedding presente in Ollama, preferendo i multilingue.'))}"><span>${esc(tr('Modello Ollama'))}</span><input type="text" name="embedModel" maxlength="80" value="${esc(st.embedModel || '')}" placeholder="${esc(tr('automatico'))}"></label>` +
      `<label title="${esc(tr('Solo indirizzi di questo computer (127.0.0.1, ::1, localhost): un altro indirizzo viene rifiutato.'))}"><span>${esc(tr('Indirizzo di Ollama'))}</span><input type="text" name="ollamaUrl" maxlength="200" value="${esc(st.ollamaUrl || '')}"></label>` +
      `<div class="embedstate stat"><p class="dim">${esc(tr('Controllo le fonti…'))}</p></div></fieldset>`;
  }

  function stateHtml(r) {
    if (!r || !r.sources) return `<p class="dim">${esc(tr('Non riesco a leggere lo stato del motore del significato.'))}</p>`;
    const S = STATES(), N = NAMES();
    const row = k => {
      const x = r.sources[k] || {}, inUse = r.active === 'tfidf' ? k === 'tfidf' : String(r.active).split(':')[0] === k;
      return `<p><b>${esc(N[k])}</b>: <span class="${x.state === 'ready' ? 'on' : x.state === 'error' ? 'bad' : 'dim'}">${esc(S[x.state] || x.state)}</span>` +
        (x.model ? ' · ' + esc(x.model) : '') + (inUse ? ' · <b>' + esc(tr('in uso')) + '</b>' : '') +
        (x.hint ? `<br><span class="dim">${esc(tr('per averlo:'))}</span> <code>${esc(x.hint)}</code>` : '') +
        (x.detail && x.state !== 'ready' ? `<br><small class="dim">${esc(x.detail)}</small>` : '') + '</p>';
    };
    const fb = r.fallback ? `<p class="bad">${esc(tr('Hai scelto {source}, ma non è disponibile: uso il lessicale.', { source: N[r.fallback.source] || r.fallback.source }))}</p>` : '';
    return fb + ['ollama', 'onnx', 'tfidf'].map(row).join('') +
      `<p>${esc(tr('Cache: {n} vettori in memoria, {disk} su disco (solo vettori, mai il testo).', { n: r.cache.vectors, disk: mb(r.cache.diskBytes) }))}</p>` +
      `<p class="dim">${esc(tr('Platypus non scarica modelli da solo: Ollama li scarica con il comando indicato, il modello ONNX con «npm run embed:onnx:install», che prima chiede conferma.'))}</p>` +
      `<button type="button" data-do="embedclear">${esc(tr('SVUOTA LA CACHE'))}</button>`;
  }

  async function bind(box) {
    const el = box.querySelector('.embedstate');
    if (!el) return;
    const post = async body => { try { return await (await fetch('/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return null; } };
    const show = r => {
      el.innerHTML = stateHtml(r);
      const b = el.querySelector('[data-do=embedclear]');
      if (b) b.onclick = async () => { const x = await post({ action: 'clear' }); show(x); if (x && window.toast) toast(tr('Cache del significato svuotata')); };
    };
    show(await post({ action: 'probe' }));
  }

  function collect(box, body) {
    for (const k of ['embedEngine', 'embedModel', 'ollamaUrl']) { const i = box.querySelector(`[name=${k}]`); if (i) body[k] = i.value; }
  }

  window.embedOptionsHtml = html;
  window.embedOptionsBind = bind;
  window.embedOptionsCollect = collect;
  window.embedSourceLabel = sourceLabel;
})();
