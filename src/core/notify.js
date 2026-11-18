'use strict';
// Notifiche decise dal motore, uguali per tutte le shell (Electron nel suo processo, Tauri dal flusso /api/shell/events).
// Il motore decide QUANDO c'è qualcosa da dire (un agente che aspetta, un avviso nuovo, il report del giorno);
// la shell decide SE mostrarlo (la sua opzione "Notifiche per i permessi", la finestra già in primo piano).
//   evento 'notify': { kind: 'wait'|'alert'|'report', title, body, sid, key }
//   GET /api/shell/events: stream SSE con soli due eventi, 'counts' (quando cambiano) e 'notify'

const { EventEmitter } = require('events');
const fs = require('fs');
const { tr, trn, money } = require('../i18n');

function agentLabel(a) {
  if (a.kind === 'main') return 'CLAUDE';
  return String(a.name || a.type || tr('agente')).toUpperCase() + (!a.name && a.seq > 1 ? '-' + a.seq : '');
}
function sessionLabel(s) { return s.wing === 'cowork' ? (s.title || s.project) + ' (Cowork)' : s.project; }
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

class Notifier extends EventEmitter {
  // file: dove ricordare il giorno dell'ultimo report (accanto alle opzioni), così non torna dopo un riavvio
  constructor(state, { stats, file, now = () => new Date() } = {}) {
    super();
    this.state = state; this.stats = stats; this.file = file; this.now = now;
    this.notified = new Set(); this.primed = false;
    this.alertSeen = new Set(); this.alertsPrimed = false;
    this.reportDay = '';
    try { this.reportDay = String(JSON.parse(fs.readFileSync(file, 'utf8')).reportDay || ''); } catch {}
    this.shells = new Set(); // le risposte SSE aperte su /api/shell/events
    this.lastCounts = '';
    this.timer = null; this.reportTimer = null; this.pingTimer = null;
    this.onChange = () => { this.schedule(); this.pushCounts(); };
  }

  start() {
    this.state.on('change', this.onChange);
    this.reportTimer = setInterval(() => { try { this.checkReport(); } catch {} }, 60000);
    this.reportTimer.unref && this.reportTimer.unref();
    this.pingTimer = setInterval(() => { for (const r of this.shells) try { r.write(': ping\n\n'); } catch {} }, 20000);
    this.pingTimer.unref && this.pingTimer.unref();
    return this;
  }

  stop() {
    this.state.off('change', this.onChange);
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
        ? tr('Piano {n}', { n: first.floor }) + ' · ' + sessionLabel(first.s) + '\n' + (first.a.action || '')
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
    if (this.file) { try { fs.writeFileSync(this.file, JSON.stringify({ reportDay: day }, null, 2)); } catch {} }
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

  // ---- lo stream per le shell esterne: contatori e notifiche, nient'altro (lo stato intero resta su /events)
  pushCounts() {
    if (!this.shells.size) return;
    const c = JSON.stringify(this.state.counts());
    if (c === this.lastCounts) return;
    this.lastCounts = c;
    for (const r of this.shells) try { r.write('event: counts\ndata: ' + c + '\n\n'); } catch {}
  }
  attach(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    res.write('event: counts\ndata: ' + JSON.stringify(this.state.counts()) + '\n\n');
    const send = ev => { try { res.write('event: notify\ndata: ' + JSON.stringify(ev) + '\n\n'); } catch {} };
    this.shells.add(res);
    this.on('notify', send);
    req.on('close', () => { this.shells.delete(res); this.off('notify', send); });
  }
}

module.exports = { Notifier, agentLabel, sessionLabel };
