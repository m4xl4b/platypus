// Report giornaliero (report.html): in un file a parte, così la pagina funziona con una CSP senza script in linea.
'use strict';
const $ = s => document.querySelector(s);
const LOCALE = (window.AO_I18N && AO_I18N.locale) || 'it-IT';
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const money = v => aoMoney(v || 0);
const dec = (v, d) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const tok = n => n >= 1e6 ? dec(n / 1e6, 1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n || 0);
const hhmm = t => new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
const KIND = { commit: 'COMMIT', pr: 'PR', merge: 'MERGE', tag: 'TAG', tests: tr('TEST'), push: 'PUSH' };
let data = null;
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function shift(day, n) { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function honorBox(title, r, what) { return `<div class="honor"><h3>${esc(title)}</h3>${r ? `<b>${esc(String(r.type).toUpperCase())}</b><div class="dim">${what(r)}</div>` : `<div class="dim">${esc(tr('nessuno'))}</div>`}</div>`; }

// la tendenza della settimana in una riga: ultime 4 settimane contro le 4 prima, tutti i progetti
const TREND_NAME = () => ({ loops: tr('giri in tondo'), stuck: tr('fasi bloccate'), surprises: tr('sorprese'), claims: tr('affermazioni senza prove') });
const TREND_WORD = () => ({ fewer: tr('in calo'), more: tr('in aumento'), same: tr('stabili') });
function trendLine(tr0) {
  if (!tr0) return '';
  const N = TREND_NAME(), W = TREND_WORD();
  const parts = Object.entries(tr0.metrics).filter(([, t]) => t.verdict !== 'not-enough').map(([m, t]) => `${N[m] || m} ${W[t.verdict]}`);
  if (!parts.length) return tr('Tendenza della settimana: dati insufficienti ({a} sessioni nelle ultime 4 settimane, {b} nelle 4 prima; ne servono {min} per parte).', { a: tr0.recent, b: tr0.before, min: tr0.min });
  return tr('Tendenza della settimana, tutti i progetti (ultime 4 settimane contro le 4 prima, {a} e {b} sessioni): {list}.', { a: tr0.recent, b: tr0.before, list: parts.join(', ') }) + (tr0.demo ? ' ' + tr('(dati finti della demo)') : '');
}

function text() {
  if (!data) return '';
  const t = data.totals;
  const lines = [tr('Report Platypus del {day}', { day: data.day }), '',
    tr('Costo: {cost} · Token: {tokens} · Sessioni: {sessions} · Sottoagenti conclusi: {completed}', { cost: money(t.cost), tokens: tok(t.tokens), sessions: t.sessions, completed: t.completed }),
    tr('Commit: {commits} · PR: {prs} · Avvisi: {alerts}', { commits: t.commits, prs: t.prs, alerts: t.alerts }), ...(data.trend ? [trendLine(data.trend)] : []), '', tr('Per progetto:')];
  for (const p of data.projects) lines.push('- ' + tr('{name}: {cost}, {completed} sottoagenti, {commits} commit, {prs} PR', { name: p.name, cost: money(p.cost), completed: p.completed, commits: p.commits, prs: p.prs }));
  if (data.releases.length) { lines.push('', tr('Rilasci:')); for (const r of data.releases) lines.push(`- ${hhmm(r.t)} [${r.project}] ${r.text}${r.url ? ' ' + r.url : ''}`); }
  const h = data.honors;
  if (h.employee) lines.push('', tr('Dipendente della settimana: {type} ({n} compiti)', { type: h.employee.type, n: h.employee.completed }));
  return lines.join('\n');
}

async function load(day) {
  $('#day').value = day;
  data = await (await fetch('/api/report?day=' + day)).json();
  const t = data.totals;
  $('#sub').textContent = new Date(day + 'T12:00:00').toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const h = data.honors;
  $('#out').innerHTML =
    `<div class="tiles">
      <div class="tile"><b>${money(t.cost)}</b><span>${esc(tr('costo'))}</span></div>
      <div class="tile"><b>${tok(t.tokens)}</b><span>${esc(tr('token'))}</span></div>
      <div class="tile"><b>${t.sessions}</b><span>${esc(trn('sessione', 'sessioni', t.sessions))}</span></div>
      <div class="tile"><b>${t.completed}</b><span>${esc(trn('sottoagente concluso', 'sottoagenti conclusi', t.completed))}</span></div>
      <div class="tile"><b>${t.commits} / ${t.prs}</b><span>${esc(tr('commit / PR'))}</span></div>
      <div class="tile"><b>${t.alerts}</b><span>${esc(trn('avviso', 'avvisi', t.alerts))}</span></div>
    </div>` +
    (data.trend ? `<p class="trend">${esc(trendLine(data.trend))}</p>` : '') +
    `<h2>${esc(tr('PROGETTI'))}</h2>` +
    (data.projects.length ? `<table><thead><tr><th>${esc(tr('PROGETTO'))}</th><th></th><th>${esc(tr('COSTO'))}</th><th>${esc(tr('TOKEN'))}</th><th>${esc(tr('SESSIONI'))}</th><th>${esc(tr('SOTTOAG.'))}</th><th>${esc(tr('COMMIT'))}</th><th>PR</th></tr></thead><tbody>` +
      data.projects.map(p => `<tr><td>${esc(p.name)}</td><td><span class="tag" style="color:${p.wing === 'cowork' ? '#ffec27' : '#00e436'}">${p.wing === 'cowork' ? 'COWORK' : 'CODE'}</span></td><td class="n">${money(p.cost)}</td><td class="n">${tok(p.tokens)}</td><td class="n">${p.sessions}</td><td class="n">${p.completed}</td><td class="n">${p.commits}</td><td class="n">${p.prs}</td></tr>`).join('') + '</tbody></table>'
      : `<div class="empty">${esc(tr('Nessuna attività registrata in questo giorno (le statistiche partono da quando l\'ufficio è aperto).'))}</div>`) +
    `<h2>${esc(tr('RILASCI E TEST'))}</h2>` +
    (data.releases.length ? `<ul class="rel">${data.releases.slice().reverse().map(r => `<li><i class="k-${esc(r.kind)}">${esc(KIND[r.kind] || r.kind)}</i>${hhmm(r.t)} · <b>${esc(r.project)}</b> · ${esc(r.text)} <span class="dim">(${esc(r.agent)})</span>${r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(tr('apri'))}</a>` : ''}</li>`).join('')}</ul>` : `<div class="empty">${esc(tr('Nessun commit, PR o test verde.'))}</div>`) +
    `<h2>${esc(tr('ONORI DELLA SETTIMANA {week}', { week: h.week }))}</h2><div class="honors">` +
    honorBox(tr('DIPENDENTE DELLA SETTIMANA'), h.employee, r => esc(tr('{completed} compiti chiusi, {errors} errori', { completed: r.completed, errors: r.errors }))) +
    honorBox(tr('PREMIO CAFFÈ (IL PIÙ COSTOSO)'), h.coffee, r => money(r.cost)) +
    honorBox(tr('STACANOVISTA'), h.worker, r => esc(tr('{n} strumenti usati', { n: r.tools }))) +
    honorBox(tr('MANI DI BURRO'), h.butter, r => esc(tr('{n} errori', { n: r.errors }))) + '</div>';
}
$('#prev').onclick = () => load(shift($('#day').value, -1));
$('#next').onclick = () => load(shift($('#day').value, 1));
$('#day').onchange = () => load($('#day').value);
$('#print').onclick = () => window.print();
$('#copy').onclick = async () => { try { await navigator.clipboard.writeText(text()); $('#copy').textContent = tr('COPIATO!'); setTimeout(() => { $('#copy').textContent = tr('COPIA TESTO'); }, 1500); } catch {} };
$('#mail').onclick = () => { location.href = 'mailto:?subject=' + encodeURIComponent(tr('Report Platypus {day}', { day: data.day })) + '&body=' + encodeURIComponent(text().slice(0, 1800)); };
load(new URLSearchParams(location.search).get('day') || today());
