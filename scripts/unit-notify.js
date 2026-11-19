#!/usr/bin/env node
'use strict';
// Prove delle notifiche decise dal motore (src/core/notify.js, T2 di docs/plans/tauri-shell.md):
// le stesse regole che aveva Electron (attese, avvisi, report), senza doppioni. Uno stato finto in memoria.
// Le richiama smoke-test.js; si possono lanciare anche da sole.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');

function fakeState(settings = {}) {
  const st = new EventEmitter();
  st.settings = { alertsNotify: true, reportHour: 18, ...settings };
  st.sessions = [];
  st.snapshot = () => ({ settings: st.settings, sessions: st.sessions });
  st.counts = () => ({ sessions: st.sessions.length, agents: 0, busy: 0, waiting: st.sessions.reduce((n, s) => n + [s.main, ...s.subs].filter(a => a.status === 'waiting').length, 0) });
  return st;
}
const agent = (id, status, extra = {}) => ({ id, kind: id === 'main' ? 'main' : 'sub', status, action: 'Serve il tuo OK: ls', ...extra });
const session = (id, extra = {}) => ({ id, project: 'progetto-' + id, main: agent('main', 'working'), subs: [], alerts: [], ...extra });

function run(ok) {
  console.log('notifiche dal motore');
  const { Notifier } = require(path.join(ROOT, 'src', 'core', 'notify'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-notify-'));
  try {
    const st = fakeState();
    const n = new Notifier(st, { stats: { report: () => null } });
    const got = [];
    n.on('notify', e => got.push(e));
    st.sessions = [session('a', { main: agent('main', 'waiting') })];
    n.checkWaiting();
    ok(got.length === 0, 'all\'avvio le attese già in corso non si notificano');
    st.sessions.push(session('b', { main: agent('main', 'waiting') }));
    n.checkWaiting(); n.checkWaiting();
    ok(got.length === 1 && got[0].kind === 'wait' && got[0].sid === 'b' && got[0].key === 'wait:b:main' && /CLAUDE/.test(got[0].title) && /2/.test(got[0].body), 'un agente nuovo in attesa: una notifica sola, col piano e la sessione → ' + (got[0] && got[0].title));
    st.sessions[1].main.status = 'working'; n.checkWaiting();
    st.sessions[1].main.status = 'waiting'; n.checkWaiting();
    ok(got.length === 2, 'torna ad aspettare dopo aver lavorato: di nuovo una notifica');
    st.sessions.push(session('c', { main: agent('main', 'waiting') }), session('d', { main: agent('main', 'waiting') }));
    n.checkWaiting();
    ok(got.length === 3 && got[2].n === 2 && got[2].body.split('\n').length === 2, 'due attese insieme: una notifica per tutte e due');
    st.sessions.push(session('demo-1', { demo: true, main: agent('main', 'waiting') }), session('e', { main: agent('main', 'waiting', { finished: true }) }));
    n.checkWaiting();
    ok(got.length === 3, 'la demo e gli agenti finiti non si notificano');

    // avvisi: stessa regola, e l'opzione alertsNotify
    n.checkAlerts();
    st.sessions[0].alerts = [{ id: 'stuck', kind: 'stuck', text: 'fermo da 10 minuti' }, { id: 'w', kind: 'wait', text: 'ti aspetta' }];
    n.checkAlerts(); n.checkAlerts();
    const al = got.filter(e => e.kind === 'alert');
    ok(al.length === 1 && al[0].body === 'fermo da 10 minuti' && al[0].sid === 'a', 'un avviso nuovo: una notifica (le attese hanno già la loro)');
    st.settings.alertsNotify = false;
    st.sessions[1].alerts = [{ id: 'budget', kind: 'budget', text: 'budget superato' }];
    n.checkAlerts();
    ok(got.filter(e => e.kind === 'alert').length === 1, 'avvisi spenti nelle opzioni: niente notifica');

    // report: dopo l'ora scelta, una volta al giorno, solo se qualcuno ascolta, ricordato nello storico (qui un memo finto)
    const saved = new Map();
    const memo = { get: k => saved.get(k) || null, set: (k, v) => saved.set(k, v) };
    let clock = new Date(2026, 10, 18, 17, 0);
    let report = { projects: [{}], totals: { cost: 1.5, sessions: 2, completed: 3, commits: 4 } };
    const st2 = fakeState({ reportHour: 18 });
    const r = new Notifier(st2, { stats: { report: () => report }, memo, now: () => clock });
    ok(r.checkReport() === null && !saved.size, 'nessuno ascolta: il report non si consuma');
    const rep = [];
    r.on('notify', e => rep.push(e));
    ok(r.checkReport() === null, 'prima dell\'ora scelta: niente report');
    clock = new Date(2026, 10, 18, 18, 5);
    r.checkReport(); r.checkReport();
    ok(rep.length === 1 && rep[0].kind === 'report' && rep[0].key === 'report:2026-11-18' && rep[0].body.split(' · ').length === 4, 'dopo l\'ora: un report solo → ' + (rep[0] && rep[0].body));
    const r2 = new Notifier(st2, { stats: { report: () => report }, memo, now: () => clock });
    r2.on('notify', e => rep.push(e));
    r2.checkReport();
    ok(rep.length === 1, 'dopo un riavvio, lo stesso giorno: non torna');
    clock = new Date(2026, 10, 19, 19, 0);
    report = { projects: [], totals: {} };
    r2.checkReport();
    ok(rep.length === 1 && saved.get('notifyReportDay') === clock.toDateString(), 'giornata vuota: niente avviso, ma il giorno è segnato');
    st2.settings.reportHour = -1; // fuori da 0–23: report spento
    const r3 = new Notifier(st2, { stats: { report: () => report }, now: () => new Date(2026, 10, 20, 23, 0) });
    r3.on('notify', () => rep.push(1));
    r3.checkReport();
    ok(rep.length === 1, 'report spento nelle opzioni: niente');
    const r4 = new Notifier(st2, { now: () => new Date(2026, 10, 21, 9, 0) });
    r4.seenReport(new Date(2026, 10, 20).toDateString());
    r4.seenReport(new Date(2026, 10, 21).toDateString());
    ok(r4.reportDay === new Date(2026, 10, 21).toDateString(), 'il giorno già visto da Electron (config.json) vale solo se è oggi');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) {
  require('./test-guard').requireTempDataDir('unit-notify'); // mai nei dati veri: solo con PLATYPUS_DATA_DIR in una cartella temporanea
  let failed = 0;
  run((c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failed++; });
  process.exit(failed ? 1 : 0);
}
