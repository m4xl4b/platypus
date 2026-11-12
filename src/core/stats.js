'use strict';
// Statistiche che restano nel tempo (~/.platypus/stats.json):
// costi, token e lavoro per giorno e per progetto, premi della settimana per tipo di agente,
// rilasci e avvisi. Servono al grafico dei costi, al report giornaliero e al dipendente del mese.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { tr } = require('../i18n');

function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function weekKey(t) { // settimana ISO, es. 2026-W43
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const w = 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return d.getFullYear() + '-W' + String(w).padStart(2, '0');
}

class Stats {
  constructor(state, file = path.join(require('../paths').dataDir(), 'stats.json')) {
    this.state = state;
    this.file = file;
    this.data = { days: {}, weeks: {}, last: {} };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
    this.dirty = false;
    this.timer = setInterval(() => this.collect(), 10000);
    this.saveTimer = setInterval(() => this.save(), 30000);
    this.timer.unref && this.timer.unref(); this.saveTimer.unref && this.saveTimer.unref();
    setTimeout(() => this.collect(), 3000).unref();
  }

  stop() { clearInterval(this.timer); clearInterval(this.saveTimer); this.save(); }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    // tieni 120 giorni e 26 settimane
    const days = Object.keys(this.data.days).sort();
    for (const k of days.slice(0, Math.max(0, days.length - 120))) delete this.data.days[k];
    const weeks = Object.keys(this.data.weeks).sort();
    for (const k of weeks.slice(0, Math.max(0, weeks.length - 26))) delete this.data.weeks[k];
    const cutoff = Date.now() - 10 * 86400000;
    for (const [k, v] of Object.entries(this.data.last)) if ((v.t || 0) < cutoff) delete this.data.last[k];
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch {}
  }

  day(t) {
    const k = dayKey(t);
    return this.data.days[k] || (this.data.days[k] = { projects: {}, releases: [], alerts: 0 });
  }
  proj(day, name, wing) {
    return day.projects[name] || (day.projects[name] = { cost: 0, tokens: 0, sessions: [], completed: 0, commits: 0, prs: 0, tests: 0, wing });
  }
  agentWeek(t, type) {
    const k = weekKey(t);
    const w = this.data.weeks[k] || (this.data.weeks[k] = {});
    return w[type] || (w[type] = { completed: 0, errors: 0, tools: 0, cost: 0 });
  }

  // confronta lo stato attuale con l'ultimo visto e somma le differenze al giorno di oggi
  collect() {
    const st = this.state, t = Date.now();
    const today = dayKey(t);
    for (const s of st.sessions.values()) {
      if (s.demo) continue;
      const name = st.label(s) || s.project || '…';
      const prev = this.data.last[s.id];
      const cur = {
        t, cost: st.costOf(s), tok: s.tok.in + s.tok.out + s.tok.cr + s.tok.cw, completed: s.completed,
        cbt: { ...s.completedByType }, err: { ...s.errByType }, tools: { ...s.toolsByType },
        costType: Object.fromEntries(Object.entries(s.wByType).map(([k, w]) => [k, w * st.rateOf(s)])),
        rel: s.releases.length ? s.releases[s.releases.length - 1].id : '', alerts: s.alerts.map(a => a.id),
      };
      // prima volta che vediamo la sessione: se è nata oggi conta tutto, altrimenti si parte da qui
      const base = prev || (dayKey(s.createdAt) === today
        ? { cost: 0, tok: 0, completed: 0, cbt: {}, err: {}, tools: {}, costType: {}, rel: '', alerts: [] }
        : { ...cur, alerts: [] });
      const d = this.day(t);
      // il titolo di una sessione Cowork arriva (o cambia) a lavoro iniziato: quel che era sotto il vecchio nome passa al nuovo
      if (prev && prev.name && prev.name !== name) this.rename(d, s.id, prev.name, name);
      const p = this.proj(d, name, s.kind === 'cowork' ? 'cowork' : 'code');
      if (!p.sessions.includes(s.id)) { p.sessions.push(s.id); this.dirty = true; }
      const dc = cur.cost - (base.cost || 0), dt = cur.tok - (base.tok || 0), dd = cur.completed - (base.completed || 0);
      if (dc > 0.0001) { p.cost += dc; this.dirty = true; }
      if (dt > 0) { p.tokens += dt; this.dirty = true; }
      if (dd > 0) { p.completed += dd; this.dirty = true; }
      for (const [type, n] of Object.entries(cur.cbt)) { const x = n - ((base.cbt || {})[type] || 0); if (x > 0) { this.agentWeek(t, type).completed += x; this.dirty = true; } }
      for (const [type, n] of Object.entries(cur.err)) { const x = n - ((base.err || {})[type] || 0); if (x > 0) { this.agentWeek(t, type).errors += x; this.dirty = true; } }
      for (const [type, n] of Object.entries(cur.tools)) { const x = n - ((base.tools || {})[type] || 0); if (x > 0) { this.agentWeek(t, type).tools += x; this.dirty = true; } }
      for (const [type, c] of Object.entries(cur.costType)) { const x = c - ((base.costType || {})[type] || 0); if (x > 0.0001) { this.agentWeek(t, type).cost += x; this.dirty = true; } }
      // rilasci nuovi
      const seenIdx = base.rel ? s.releases.findIndex(r => r.id === base.rel) : -1;
      const fresh = prev || dayKey(s.createdAt) === today ? s.releases.slice(seenIdx + 1) : [];
      for (const r of fresh) {
        if (dayKey(r.t) !== today) continue;
        d.releases.push({ t: r.t, kind: r.kind, text: r.text, url: r.url, agent: r.agent, project: name });
        if (r.kind === 'commit') p.commits++;
        if (r.kind === 'pr') p.prs++;
        if (r.kind === 'tests') p.tests++;
        this.dirty = true;
      }
      if (d.releases.length > 300) d.releases.splice(0, d.releases.length - 300);
      const newAlerts = cur.alerts.filter(id => !(base.alerts || []).includes(id)).length;
      if (newAlerts) { d.alerts += newAlerts; this.dirty = true; }
      cur.name = name;
      this.data.last[s.id] = cur;
    }
  }

  // sposta la voce di una sessione da un nome progetto a un altro (solo se quella voce è solo sua)
  rename(d, sid, from, to) {
    const o = d.projects[from];
    if (!o || !o.sessions.includes(sid)) return;
    if (o.sessions.length > 1) return; // voce condivisa: i costi non si possono dividere
    delete d.projects[from];
    const n = d.projects[to];
    if (!n) d.projects[to] = o;
    else {
      n.cost += o.cost; n.tokens += o.tokens; n.completed += o.completed; n.commits += o.commits; n.prs += o.prs; n.tests += o.tests;
      for (const x of o.sessions) if (!n.sessions.includes(x)) n.sessions.push(x);
    }
    for (const r of d.releases) if (r.project === from) r.project = to;
    this.dirty = true;
  }

  // ---------- letture ----------
  costHistory(days = 14) {
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = dayKey(d.getTime());
      const day = this.data.days[k];
      const projects = {};
      let total = 0, tokens = 0, completed = 0;
      if (day) for (const [name, p] of Object.entries(day.projects)) { projects[name] = p.cost; total += p.cost; tokens += p.tokens; completed += p.completed; }
      out.push({ day: k, total, tokens, completed, projects });
    }
    if (this.state.demo && out.every(x => !x.total)) return demoHistory(days);
    return out;
  }

  honors(t = Date.now()) {
    let w = this.data.weeks[weekKey(t)] || {};
    if (this.state.demo && !Object.keys(w).length) w = demoWeek(this.state);
    const rows = Object.entries(w).filter(([type]) => type && type !== 'Sottoagente').map(([type, v]) => ({ type, ...v, rate: v.tools ? v.errors / v.tools : 0 }));
    const pick = (f, cmp) => rows.filter(f).sort(cmp)[0] || null;
    return {
      week: weekKey(t),
      rows: rows.sort((a, b) => b.completed - a.completed).slice(0, 10),
      employee: pick(r => r.type !== 'Claude' && r.completed > 0, (a, b) => (b.completed - b.errors * 0.5) - (a.completed - a.errors * 0.5)),
      coffee: pick(r => r.cost > 0, (a, b) => b.cost - a.cost),            // il più costoso
      butter: pick(r => r.errors > 0, (a, b) => b.errors - a.errors),      // mani di burro
      worker: pick(r => r.tools > 0, (a, b) => b.tools - a.tools),         // stacanovista
    };
  }

  report(day = dayKey(Date.now())) {
    const d = this.data.days[day] || { projects: {}, releases: [], alerts: 0 };
    const projects = Object.entries(d.projects).map(([name, p]) => ({ name, ...p, sessions: p.sessions.length })).sort((a, b) => b.cost - a.cost);
    const tot = projects.reduce((t, p) => ({ cost: t.cost + p.cost, tokens: t.tokens + p.tokens, completed: t.completed + p.completed, sessions: t.sessions + p.sessions, commits: t.commits + p.commits, prs: t.prs + p.prs }), { cost: 0, tokens: 0, completed: 0, sessions: 0, commits: 0, prs: 0 });
    return { day, projects, totals: { ...tot, alerts: d.alerts }, releases: d.releases.slice(-50), honors: this.honors(new Date(day + 'T12:00:00').getTime()) };
  }
}

// dati finti per la demo, così il grafico non è vuoto
function demoHistory(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const wd = d.getDay();
    const f = wd === 0 || wd === 6 ? 0.2 : 1;
    const projects = { 'portale-clienti': +(f * (2 + Math.random() * 5)).toFixed(2), 'mes-clone': +(f * (4 + Math.random() * 12)).toFixed(2), 'isms-docs': +(f * Math.random() * 3).toFixed(2), [tr('Report trimestrale per il cliente')]: +(f * Math.random() * 2).toFixed(2) };
    const total = Object.values(projects).reduce((a, b) => a + b, 0);
    out.push({ day: dayKey(d.getTime()), total, tokens: Math.round(total * 250000), completed: Math.round(total * 4), projects });
  }
  return out;
}
function demoWeek(state) {
  const w = {};
  for (const s of state.sessions.values()) {
    for (const [type, n] of Object.entries(s.completedByType)) (w[type] = w[type] || { completed: 0, errors: 0, tools: 0, cost: 0 }).completed += n + 20;
    for (const [type, n] of Object.entries(s.errByType)) (w[type] = w[type] || { completed: 0, errors: 0, tools: 0, cost: 0 }).errors += n;
    for (const [type, wgt] of Object.entries(s.wByType)) (w[type] = w[type] || { completed: 0, errors: 0, tools: 0, cost: 0 }).cost += wgt * state.rateOf(s) + 3;
  }
  for (const v of Object.values(w)) v.tools = v.completed * 12;
  return w;
}

module.exports = { Stats, dayKey, weekKey };
