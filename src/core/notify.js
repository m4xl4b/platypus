'use strict';
// Notifiche decise dal motore, uguali per tutte le shell (Electron nel suo processo, Tauri dal flusso /api/shell/events).
// Il motore decide QUANDO c'è qualcosa da dire (un agente che aspetta, un avviso nuovo, il report del giorno);
// la shell decide SE mostrarlo (la sua opzione "Notifiche per i permessi", la finestra già in primo piano).
//   evento 'notify': { kind: 'wait'|'alert'|'report', title, body, sid, key }
//   GET /api/shell/events: stream SSE per i gusci esterni (Tauri), con tre eventi:
//     'counts' {sessions, agents, busy, waiting, label, tooltip}  quando cambiano (testi già tradotti)
//     'menu'   {texts, hooks, demo, cowork, base}                 i testi del menu dell'icona e lo stato delle voci
//     'notify' {kind, title, body, sid, key, n}

const { EventEmitter } = require('events');
const { tr, trn, money } = require('../i18n');
const { permissionLine } = require('./fear'); // 2.14: il rischio di una richiesta di permesso

function agentLabel(a) {
  if (a.kind === 'main') return 'CLAUDE';
  return String(a.name || a.type || tr('agente')).toUpperCase() + (!a.name && a.seq > 1 ? '-' + a.seq : '');
}
function sessionLabel(s) { return s.wing === 'cowork' ? (s.title || s.project) + ' (Cowork)' : s.project; }
// i testi del menu dell'icona, come in buildTrayMenu() di src/main.js, per i gusci che non hanno le traduzioni (Rust)
function menuTexts() {
  return {
    show: tr('Mostra l\'ufficio'), pin: tr('Sempre in primo piano'), demo: tr('Modalità demo'),
    notify: tr('Notifiche per i permessi'), cowork: tr('Mostra le sessioni Cowork'),
    hooksOff: tr('Scollega da Claude Code (rimuovi hook)'), hooksOn: tr('Collega a Claude Code (installa hook)…'),
    report: tr('Report di oggi'), browser: tr('Apri nel browser'), folder: tr('Apri la cartella di Claude Code'),
    login: tr('Avvia all\'accesso al computer'), quit: tr('Esci'),
    // la conferma prima di collegare gli hook, e l'esito (come askHooksOnce e installHooks)
    askTitle: tr('Collegare Platypus a Claude Code?'),
    askDetail: tr('L\'ufficio funziona già leggendo i file locali di Claude Code.') + '\n\n' +
      tr('Se lo colleghi (aggiungo degli hook in ~/.claude/settings.json) vedi anche in tempo reale quando un agente aspetta il tuo permesso, e puoi rispondere dai fumetti. Puoi scollegarlo quando vuoi dal menu dell\'icona.'),
    askYes: tr('Collega'), askLater: tr('Più tardi'),
    done: tr('Collegato a Claude Code'), doneDetail: tr('Valgono per le sessioni di Claude Code aperte da adesso in poi: chiudi e riapri quelle già aperte.'),
    failed: tr('Non sono riuscito a modificare le impostazioni di Claude Code:\n{error}', { error: '{error}' }),
  };
}
// la prima voce del menu e il suggerimento dell'icona, come in buildTrayMenu()
function countsTexts(c) {
  return {
    label: tr('Sessioni: {s}  ·  Agenti: {a}', { s: c.sessions, a: c.agents }) + (c.waiting ? '  ·  ' + trn('{n} in attesa', '{n} in attesa', c.waiting) : ''),
    tooltip: 'Platypus — ' + trn('{n} agente', '{n} agenti', c.agents) + ', ' + trn('{n} al lavoro', '{n} al lavoro', c.busy) + (c.waiting ? ', ' + trn('{n} ti aspetta', '{n} ti aspettano', c.waiting) : ''),
  };
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const REPORT_DAY = 'notifyReportDay'; // il segno nello storico (fino alla 2.12: reportDay in notify.json)

class Notifier extends EventEmitter {
  // memo: dove ricordare il giorno dell'ultimo report, così non torna dopo un riavvio ({ get(chiave), set(chiave, valore) };
  // il motore gli passa i segni dello storico). Senza, il giorno resta in memoria
  // shellInfo: () => {hooks, demo, cowork, base}, lo stato delle voci del menu dei gusci (lo conosce index.js)
  constructor(state, { stats, memo = null, now = () => new Date(), shellInfo = () => ({}) } = {}) {
    super();
    this.state = state; this.stats = stats; this.memo = memo; this.now = now; this.shellInfo = shellInfo;
    this.notified = new Set(); this.primed = false;
    this.alertSeen = new Set(); this.alertsPrimed = false;
    this.reportDay = '';
    try { this.reportDay = String((memo && memo.get(REPORT_DAY)) || ''); } catch {}
    this.shells = new Set(); // le risposte SSE aperte su /api/shell/events
    this.lastCounts = ''; this.lastMenu = '';
    this.timer = null; this.reportTimer = null; this.pingTimer = null;
    this.onChange = () => { this.schedule(); this.pushCounts(); this.pushMenu(); };
    this.onLang = () => { this.pushCounts(); this.pushMenu(); }; // lingua cambiata: i testi nuovi
  }

  start() {
    this.state.on('change', this.onChange);
    this.state.on('lang', this.onLang);
    this.reportTimer = setInterval(() => { try { this.checkReport(); } catch {} }, 60000);
    this.reportTimer.unref && this.reportTimer.unref();
    this.pingTimer = setInterval(() => { for (const r of this.shells) try { r.write(': ping\n\n'); } catch {} }, 20000);
    this.pingTimer.unref && this.pingTimer.unref();
    return this;
  }

  stop() {
    this.state.off('change', this.onChange);
    this.state.off('lang', this.onLang);
    clearTimeout(this.timer); clearInterval(this.reportTimer); clearInterval(this.pingTimer);
    for (const r of this.shells) try { r.end(); } catch {}
    this.shells.clear();
  }

  // qualcuno ascolta? (Electron nel suo processo o una shell sullo stream): il report del giorno si "consuma" solo così,
  // altrimenti la modalità browser lo segnerebbe come mostrato senza averlo mostrato a nessuno
  listening() { return this.listenerCount('notify') > 0; }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; try { this.checkWaiting(); } catch {} try { this.checkAlerts(); } catch {} }, 300);
    this.timer.unref && this.timer.unref();
  }

  // un agente aspetta il tuo permesso (o una risposta, o l'approvazione di un piano)
  checkWaiting() {
    const snap = this.state.snapshot();
    const current = new Set(), fresh = [];
    snap.sessions.forEach((s, i) => {
      for (const a of [s.main, ...s.subs]) {
        if (a.status !== 'waiting' || a.finished || s.demo) continue;
        const k = s.id + ':' + a.id;
        current.add(k);
        if (!this.notified.has(k)) { this.notified.add(k); fresh.push({ s, a, floor: i + 1, k }); }
      }
    });
    for (const k of [...this.notified]) if (!current.has(k)) this.notified.delete(k);
    // all'avvio non notifichiamo le attese già in corso: le vedi aprendo la finestra
    if (!this.primed) { this.primed = true; return null; }
    if (!fresh.length) return null;
    const first = fresh[0];
    const ev = {
      kind: 'wait',
      title: fresh.length === 1
        ? tr('{agent} ti aspetta', { agent: agentLabel(first.a) }) // un permesso, una domanda o un piano: lo dice la riga sotto
        : tr('{n} agenti ti aspettano', { n: fresh.length }),
      body: fresh.length === 1
        ? tr('Piano {n}', { n: first.floor }) + ' · ' + sessionLabel(first.s) + '\n' + (first.a.action || '') + (first.a.perm ? '\n' + permissionLine(first.a.perm) : '')
        : fresh.slice(0, 4).map(f => agentLabel(f.a) + ' · ' + tr('piano {n}', { n: f.floor }) + ' ' + sessionLabel(f.s)).join('\n'),
      sid: first.s.id,
      key: 'wait:' + first.k,
      n: fresh.length,
    };
    this.emit('notify', ev);
    return ev;
  }

  // avvisi intelligenti (agente fermo, errori di fila, budget, sessione che ti aspetta)
  checkAlerts() {
    const snap = this.state.snapshot();
    const current = new Set(), fresh = [];
    snap.sessions.forEach((s, i) => {
      for (const al of s.alerts || []) {
        if (al.kind === 'wait' || s.demo) continue; // le attese hanno già la loro notifica
        const k = s.id + ':' + al.id;
        current.add(k);
        if (!this.alertSeen.has(k)) { this.alertSeen.add(k); fresh.push({ s, al, floor: i + 1, k }); }
      }
    });
    for (const k of [...this.alertSeen]) if (!current.has(k)) this.alertSeen.delete(k);
    if (!this.alertsPrimed) { this.alertsPrimed = true; return null; }
    if (!fresh.length || snap.settings.alertsNotify === false) return null;
    const first = fresh[0];
    const ev = {
      kind: 'alert',
      title: fresh.length === 1 ? tr('Avviso · piano {n}', { n: first.floor }) + ' ' + sessionLabel(first.s) : tr('{n} nuovi avvisi', { n: fresh.length }),
      body: fresh.slice(0, 4).map(f => (fresh.length > 1 ? `P${f.floor}: ` : '') + f.al.text).join('\n'),
      sid: first.s.id,
      key: 'alert:' + first.k,
      n: fresh.length,
    };
    this.emit('notify', ev);
    return ev;
  }

  // il report della giornata, una volta al giorno dopo l'ora scelta nelle opzioni (reportHour)
  checkReport() {
    if (!this.listening()) return null;
    const hour = Number((this.state.settings || {}).reportHour);
    if (!(hour >= 0 && hour <= 23)) return null;
    const now = this.now();
    const day = now.toDateString();
    if (this.reportDay === day || now.getHours() < hour) return null;
    this.reportDay = day;
    if (this.memo) { try { this.memo.set(REPORT_DAY, day); } catch {} }
    let r = null;
    try { r = this.stats.report(); } catch {}
    if (!r || (!r.projects.length && !process.env.PLATYPUS_NOTIFY_TEST)) return null; // giornata vuota: niente avviso
    const t = r.totals;
    const ev = {
      kind: 'report',
      title: tr('Report della giornata pronto'),
      body: [money(t.cost), trn('{n} sessione', '{n} sessioni', t.sessions), trn('{n} sottoagente', '{n} sottoagenti', t.completed), trn('{n} commit', '{n} commit', t.commits)].join(' · '),
      sid: '',
      key: 'report:' + isoDay(now),
      n: 1,
    };
    this.emit('notify', ev);
    return ev;
  }

  // il giorno del report già mostrato da una shell più vecchia (Electron lo teneva nel suo config.json)
  seenReport(day) { if (day && day === this.now().toDateString() && this.reportDay !== day) this.reportDay = day; }

  // ---- lo stream per le shell esterne: contatori, menu e notifiche, nient'altro (lo stato intero resta su /events)
  countsData() { const c = this.state.counts(); return JSON.stringify({ ...c, ...countsTexts(c) }); }
  menuData() {
    let info = {};
    try { info = this.shellInfo() || {}; } catch {}
    return JSON.stringify({ texts: menuTexts(), hooks: !!info.hooks, demo: !!info.demo, cowork: info.cowork !== false, base: info.base || '' });
  }
  pushCounts() {
    if (!this.shells.size) return;
    const c = this.countsData();
    if (c === this.lastCounts) return;
    this.lastCounts = c;
    for (const r of this.shells) try { r.write('event: counts\ndata: ' + c + '\n\n'); } catch {}
  }
  pushMenu() {
    if (!this.shells.size) return;
    const m = this.menuData();
    if (m === this.lastMenu) return;
    this.lastMenu = m;
    for (const r of this.shells) try { r.write('event: menu\ndata: ' + m + '\n\n'); } catch {}
  }
  attach(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    res.write('event: counts\ndata: ' + (this.lastCounts = this.countsData()) + '\n\n');
    res.write('event: menu\ndata: ' + (this.lastMenu = this.menuData()) + '\n\n');
    const send = ev => { try { res.write('event: notify\ndata: ' + JSON.stringify(ev) + '\n\n'); } catch {} };
    this.shells.add(res);
    this.on('notify', send);
    req.on('close', () => { this.shells.delete(res); this.off('notify', send); });
  }
}

module.exports = { Notifier, agentLabel, sessionLabel, menuTexts, countsTexts };
