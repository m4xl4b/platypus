// La sezione ARCHIVIO delle opzioni (S10 di docs/plans/2.13-storage.md): dove sta lo storico, quanto pesa, per quanto
// tiene ogni cosa, e i tre gesti COMPATTA, ESPORTA e DIMENTICA UN PROGETTO. game.js la inserisce nel pannello OPZIONI con
// due agganci: storeOptionsHtml(st) e storeOptionsBind(box). I giorni e il limite sono campi numerici: li salva SALVA.
// "Dimentica" anche dal Libro: storeForgetConfirm(name, info) dà il testo della conferma, uguale nei due posti.
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const size = n => (n == null ? '—' : n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const NAMES = () => ({ projects: tr('progetti'), lessons: tr('lezioni'), steps: tr('passi'), sessions: tr('sessioni'), feedback: tr('messaggi agli agenti'), experiments: tr('esperimenti'), daily: tr('statistiche') });
  const FIELDS = () => [
    ['storeKeepSteps', tr('Passi (giorni)'), tr('Ogni azione degli agenti, senza testo: per quanti giorni tenerla. 0 = per sempre.')],
    ['storeKeepSessions', tr('Riassunti delle sessioni (giorni)'), tr('0 = per sempre.')],
    ['storeKeepFeedback', tr('Messaggi agli agenti (giorni)'), tr('Vale anche per gli esperimenti. 0 = per sempre.')],
    ['storeKeepLessons', tr('Lezioni deboli (giorni)'), tr('Solo le lezioni sotto la soglia e non fissate: quelle forti restano. 0 = per sempre.')],
    ['storeMaxMB', tr('Limite di dimensione (MB)'), tr('Oltre il limite se ne vanno per primi i passi più vecchi. 0 = nessun limite.')],
  ];

  function html(st) {
    return `<fieldset class="storeopts"><legend>${esc(tr('ARCHIVIO'))}</legend>` +
      `<p>${esc(tr('Lo storico di Platypus: Libro, statistiche, messaggi agli agenti e i fatti delle sessioni, per vedere come vanno le cose nei mesi. Solo fatti, mai il testo delle richieste, delle risposte o dei file. Resta su questo computer.'))}</p>` +
      FIELDS().map(([k, label, help]) => `<label title="${esc(help)}"><span>${esc(label)}</span><input type="number" min="0" step="1" name="${k}" value="${esc(st[k] ?? '')}"></label>`).join('') +
      `<div class="storestate stat"><p class="dim">${esc(tr('Leggo lo stato dello storico…'))}</p></div></fieldset>`;
  }

  // il testo della conferma di "Dimentica": che cosa se ne va, e che non si torna indietro
  function forgetConfirm(name, info) {
    const b = (info && info.backups) || [];
    return tr('Dimenticare il progetto «{name}»? Tolgo dallo storico tutto quello che lo riguarda (lezioni, passi, sessioni, messaggi, statistiche), anche dai file della 2.12.', { name }) + '\n\n' +
      (b.length ? tr('Cancello anche le copie di sicurezza, che contengono tutti i progetti: {list}.', { list: b.join(', ') }) + '\n\n' : '') +
      tr('Non si può annullare.');
  }

  function stateHtml(r) {
    if (!r || !r.ok) return `<p class="bad">${esc(tr('Non riesco a leggere lo stato dello storico.'))}</p>`;
    const N = NAMES();
    const where = r.persistent
      ? tr('Database: {file}, {size} su disco ({used} in uso).', { file: r.file, size: size(r.sizeBytes), used: size(r.usedBytes) })
      : tr('Lo storico è in memoria: non resta dopo la chiusura.');
    const counts = (r.collections || []).map(c => `${N[c.name] || c.name} ${c.count}`).join(' · ');
    let last = '';
    if (r.last && r.last.at) {
      const rem = Object.values(r.last.removed || {}).reduce((a, b) => a + b, 0);
      last = tr('Ultima pulizia: {when}, {n} documenti tolti per la conservazione', { when: new Date(r.last.at).toLocaleString(), n: rem }) +
        (r.last.trimmedForSize ? ' ' + tr('e {n} passi più vecchi per stare sotto il limite.', { n: r.last.trimmedForSize }) : '.');
    }
    const projects = r.projects || [];
    return (r.notice ? `<p class="bad">${esc(r.notice)}</p>` : '') +
      `<p>${esc(where)}</p><p class="dim">${esc(counts)}</p>` + (last ? `<p class="dim">${esc(last)}</p>` : '') +
      (r.backups && r.backups.length ? `<p class="dim">${esc(tr('Copie di sicurezza accanto: {list}', { list: r.backups.join(', ') }))}</p>` : '') +
      `<div class="btns"><button type="button" data-do="storecompact" ${r.persistent ? '' : 'disabled'} title="${esc(tr('Restituisce al disco lo spazio lasciato libero da quello che è stato tolto'))}">${esc(tr('COMPATTA'))}</button>` +
      `<button type="button" data-do="storeexport" title="${esc(tr('Un file JSONL per ogni parte dello storico, in una cartella nuova'))}">${esc(tr('ESPORTA…'))}</button>` +
      `<button type="button" data-do="storeforget" class="danger" ${projects.length ? '' : 'disabled'}>${esc(tr('DIMENTICA UN PROGETTO…'))}</button></div>` +
      `<div class="storeexport fbconfirm" hidden><label><span>${esc(tr('Cartella'))}</span><input type="text" data-store="dir" maxlength="500" placeholder="${esc(tr('vuoto = Scaricati/platypus-export-<data>'))}"></label>` +
      `<div class="btns"><button type="button" data-do="storeexportgo">${esc(tr('ESPORTA'))}</button><button type="button" data-do="storeclose">${esc(tr('ANNULLA'))}</button></div></div>` +
      `<div class="storeforget fbconfirm" hidden><label><span>${esc(tr('Progetto'))}</span><select data-store="key">` +
      projects.map(p => `<option value="${esc(p.key)}">${esc(p.name || p.key)}${p.remote ? ' · ' + esc(p.remote) : ''}</option>`).join('') + `</select></label>` +
      `<p class="dim" data-store="forgetwhat"></p>` +
      `<div class="btns"><button type="button" data-do="storeforgetgo" class="danger">${esc(tr('SÌ, DIMENTICA'))}</button><button type="button" data-do="storeclose">${esc(tr('ANNULLA'))}</button></div></div>`;
  }

  async function bind(box) {
    const el = box.querySelector('.storestate');
    if (!el) return;
    const post = async body => { try { return await (await fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return null; } };
    const load = async () => { let r = null; try { r = await (await fetch('/api/store')).json(); } catch {} show(r); };
    const show = r => {
      el.innerHTML = stateHtml(r);
      const q = s => el.querySelector(s);
      const ex = q('.storeexport'), fg = q('.storeforget');
      for (const c of el.querySelectorAll('[data-do=storeclose]')) c.onclick = () => { ex.hidden = true; fg.hidden = true; };
      const cb = q('[data-do=storecompact]');
      if (cb) cb.onclick = async () => {
        const x = await post({ action: 'compact' });
        if (x && x.ok && window.toast) toast(x.size ? tr('Storico compattato: da {a} a {b}', { a: size(x.size.before), b: size(x.size.after) }) : tr('Storico compattato'));
        load();
      };
      q('[data-do=storeexport]').onclick = () => { fg.hidden = true; ex.hidden = !ex.hidden; };
      q('[data-do=storeexportgo]').onclick = async () => {
        const x = await post({ action: 'export', dir: q('[data-store=dir]').value.trim() });
        if (window.toast) toast(x && x.ok ? tr('Storico esportato in {dir}', { dir: x.dir }) : (x && x.reason) || tr('Non sono riuscito a esportare lo storico'), !!(x && x.ok));
        if (x && x.ok) ex.hidden = true;
      };
      const fb = q('[data-do=storeforget]');
      if (fb) fb.onclick = () => {
        ex.hidden = true; fg.hidden = !fg.hidden;
        const sel = q('[data-store=key]'), what = q('[data-store=forgetwhat]');
        const upd = () => { const o = sel.options[sel.selectedIndex]; what.textContent = forgetConfirm(o ? o.textContent : '', r); };
        sel.onchange = upd; upd();
      };
      const go = q('[data-do=storeforgetgo]');
      if (go) go.onclick = async () => {
        const sel = q('[data-store=key]'), o = sel.options[sel.selectedIndex];
        if (!o || !confirm(forgetConfirm(o.textContent, r))) return;
        const x = await post({ action: 'forget', key: sel.value, confirm: true });
        if (window.toast) toast(x && x.ok ? tr('Progetto dimenticato: {n} documenti tolti', { n: x.documents }) : tr('Non sono riuscito a dimenticare il progetto'), !!(x && x.ok));
        load();
      };
    };
    load();
  }

  window.storeOptionsHtml = html;
  window.storeOptionsBind = bind;
  window.storeForgetConfirm = forgetConfirm;
})();
