'use strict';
// Modalità demo: sessioni finte per vedere il palazzo in azione senza Claude Code.
// Tre piani: un progetto con un capo reparto e la sua squadra, una revisione "di massa"
// con decine di agenti in background, e un progetto piccolo con richieste di permesso.

const { tr } = require('../i18n');

// funzioni, così i testi escono nella lingua del momento
const REVIEW_TARGETS = () => [tr('modulo ordini'), tr('API magazzino'), tr('scheduler PLC'), tr('report turni'), tr('login operatori'), tr('export SAP'), tr('allarmi linea 3'), tr('ricette prodotto'), tr('tracciabilità lotti'), tr('dashboard OEE')];

const { DemoWorld, treeFor } = require('./demoworld');
const { classifyFailure } = require('./surprise');
const { errorPattern } = require('./bottega');

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

class Demo {
  constructor(state, { bottega, feedback, dropFeedback } = {}) {
    this.state = state;
    this.bottega = bottega || null; // per il libro finto dei progetti della demo
    // feedback agli agenti (C3): la stessa funzione dell'hook vero, chiamata senza rete; dropFeedback svuota il suo registro
    this.feedback = feedback || null;
    this.dropFeedback = dropFeedback || null;
    this.timer = null;
    this.n = 0;
    this.ids = {};
    this.world = new DemoWorld(state);
  }
  get on() { return !!this.timer; }

  // scale: accorcia i tempi degli scenari costruiti apposta (le prove automatiche usano 0.02)
  start({ scale = 1 } = {}) {
    if (this.timer) return;
    this.state.demo = true;
    this.ids.a = this.open('C:/Progetti/portale-clienti', tr('Refactoring login e sessioni'), 'cli');
    this.ids.b = this.open('D:/dev/mes-clone', tr('Revisione completa delle specifiche'), 'claude-desktop');
    this.ids.c = this.open('C:/Progetti/isms-docs', tr('Revisione policy ISO 27001'), 'claude-vscode');
    this.ids.d = this.open('C:/Users/max/Documents/Cowork', tr('Report trimestrale per il cliente'), 'local-agent');
    for (const d of [tr('Raccogli i dati di vendita Q3'), tr('Cerca i benchmark di settore'), tr('Prepara i grafici')]) this.spawn(this.ids.d, 'general-purpose', d);
    this.spawn(this.ids.d, 'Explore', tr('Leggi i report dei trimestri precedenti'));
    // capo reparto con la sua squadra
    const arch = this.spawn(this.ids.a, 'architect', tr('Progetta il nuovo modulo sessioni'));
    const team = [['Explore', tr('Mappa i moduli di autenticazione')], ['Explore', tr('Trova dove scadono i token')], ['test-runner', tr('Esegui la suite di test')]].map(([t, d]) => this.spawn(this.ids.a, t, d, arch));
    const planId = this.spawn(this.ids.a, 'Plan', tr('Piano di migrazione al nuovo DB'));
    // questo a un certo punto si perde tra i componenti grafici: si vede la deriva dalla stella polare
    const planA = this.state.sessions.get(this.ids.a).subs.get(planId);
    if (planA) planA._demoDrift = 'src/ui/components';
    // folla di revisori
    for (let i = 0; i < 26; i++) this.spawnReviewer();
    this.spawn(this.ids.c, 'general-purpose', tr('Confronta le versioni delle policy'));
    // un agente "bloccato" su un comando lungo, per vedere gli avvisi
    const stuckId = this.spawn(this.ids.a, 'test-runner', tr('Esegui i test end-to-end'));
    const sa = this.state.sessions.get(this.ids.a).subs.get(stuckId);
    const ago = Date.now() - 13 * 60000;
    Object.assign(sa, { _demoStuck: true, pending: 1, pendingSince: ago, lastActivity: ago, pendingDesc: tr('Esegue: {cmd}', { cmd: 'npm run test:e2e' }), pendingName: 'Bash', status: 'working', action: tr('Esegue: {cmd}', { cmd: 'npm run test:e2e' }) });
    // costi finti: tariffa realistica e un po' di token già spesi
    for (const id of [this.ids.a, this.ids.b, this.ids.c, this.ids.d]) {
      const x = this.state.sessions.get(id);
      x.rate = 3.8e-6;
      x.costState = { total: id === this.ids.b ? 9.2 : 1 + Math.random() * 3, weightedAt: 0 };
    }
    // lavagne: lista delle cose da fare e un piano
    this.todoStep = 0;
    this.writeTodos(this.ids.a);
    this.writeTodos(this.ids.b);
    this.state.trackBoards(this.state.sessions.get(this.ids.a), 'ExitPlanMode', { plan: tr('# Nuovo modulo sessioni\n## Analisi dei token\n## Refresh automatico\n## Logout ovunque\n## Test end-to-end') }, Date.now());
    // mappe della realtà: un po' di lavoro già fatto per ogni agente
    for (const id of [this.ids.a, this.ids.b, this.ids.c, this.ids.d]) {
      const x = this.state.sessions.get(id);
      this.world.seed(x, x.main, 14);
      for (const a of x.subs.values()) this.world.seed(x, a, a._demoStuck ? 10 : a._demoDrift ? 24 : 5 + Math.floor(Math.random() * 14), a._demoStuck ? 'npm run test:e2e' : null);
    }
    this.groundingScenario(this.ids.a, { explore: team[0], finder: team[1], architect: arch, tester: team[2], plan: planId }, scale);
    this.synonymsScenario(this.ids.a);
    this.fearScenario(this.ids.c, scale); // isms-docs: pochi agenti, la scena si vede tutta
    this.startWorkflows(this.ids.c);
    this.demoMessage(this.ids.a, arch, tr('Usa i refresh token a rotazione'));
    this.seedBooks();
    // feedback agli agenti, piano 2: una sessione che parte riceve le lezioni del suo progetto
    this.later(2 * scale, () => this.say(this.ids.b, { hook_event_name: 'SessionStart', source: 'startup' }));
    this.timer = setInterval(() => this.step(), 900);
    this.state.touch();
  }

  // Workflow sul piano 3: uno finito un'ora fa (per l'analisi) e uno in corso, con le fasi che avanzano da sole
  startWorkflows(sid) {
    const st = this.state, s = st.sessions.get(sid);
    if (!s) return;
    const now = Date.now(), min = 60000, old = 'wf_demo_gap';
    const phases = [[tr('Raccolta'), 4, 3], [tr('Confronto'), 4, 9], [tr('Sintesi'), 1, 4]]; // fase, agenti, minuti
    let t = now - 70 * min;
    phases.forEach(([phase, n, m], pi) => {
      for (let i = 0; i < n; i++) {
        const id = 'demo-wfo-' + pi + '-' + i, label = ['collect', 'compare', 'summary'][pi] + (n > 1 ? ':A.' + (5 + i * 3) : '');
        st.applyWorkflowEvent(sid, old, { type: 'started', agentId: id, key: label, label, phase });
        const ra = st.runAgent(s, old, id);
        Object.assign(ra, { type: 'general-purpose', t0: t + i * 20000, w: 4e5 + Math.random() * 6e5 });
        ra.t1 = ra.t0 + m * min * (0.6 + Math.random() * 0.4); ra.tokens = Math.round(ra.w / 2);
        st.applyWorkflowEvent(sid, old, { type: pi === 1 && i === 2 ? 'failed' : 'result', agentId: id });
      }
      t += m * min;
    });
    st.ensureRun(s, old).description = tr("Confronto delle policy con l'Annex A");
    st.applyWorkflowSummary(sid, old, { workflowName: 'gap-analysis', status: 'completed', startTime: now - 70 * min, durationMs: 16 * min, phases: phases.map(([title]) => ({ title })),
      agentCount: 9, totalTokens: 1900000, totalToolCalls: 214, summary: tr("9 agenti, 14 scostamenti dall'Annex A, 3 critici") });
    this.runWorkflow(sid);
  }
  runWorkflow(sid) {
    const st = this.state, s = st.sessions.get(sid);
    if (!s) return;
    const run = 'wf_demo_' + (++this.n);
    const phases = [[tr('Lettura'), ['read:A.5', 'read:A.8', 'read:A.12']], [tr('Revisione'), ['review:A.5', 'review:A.8', 'review:A.12', 'review:A.17']], [tr('Verifica'), ['verify:A.5', 'verify:A.12']], [tr('Report'), ['report']]];
    const r = st.ensureRun(s, run);
    Object.assign(r, { name: 'policy-review', description: tr('Revisione delle policy ISO 27001'), startedAt: Date.now(), phases: phases.map(([title]) => ({ title, detail: '' })) });
    this.wf = { sid, run, phases, phase: 0, doneAt: 0 };
    this.workflowPhase();
  }
  workflowPhase() {
    const { sid, run, phases, phase } = this.wf;
    const [title, labels] = phases[phase];
    const s = this.state.sessions.get(sid);
    for (const label of labels) {
      const id = this.spawn(sid, 'general-purpose', label, undefined, { quiet: true, meta: { workflowRunId: run, workflowPhase: title } });
      this.state.applyWorkflowEvent(sid, run, { type: 'started', agentId: id, key: label, label, phase: title });
      const a = s && s.subs.get(id);
      if (a) a._demoWf = true;
      if (s) { const ra = this.state.runAgent(s, run, id); ra.t0 = ra.t1 = Date.now(); } // gli agenti finti non scrivono righe con l'orario
    }
  }
  // a ogni passo: qualche agente della fase finisce (uno ogni tanto fallisce); poi si passa alla fase dopo
  workflowStep() {
    const w = this.wf;
    if (!w) return;
    const st = this.state, s = st.sessions.get(w.sid);
    if (!s) return;
    if (w.doneAt) { if (Date.now() - w.doneAt > 45000) this.runWorkflow(w.sid); return; }
    const live = [...s.subs.values()].filter(a => a.workflow === w.run && !a.finished);
    for (const a of live) st.runAgent(s, w.run, a.id).t1 = Date.now();
    for (const a of live) if (Math.random() < 0.05) st.applyWorkflowEvent(w.sid, w.run, { type: w.phase === 1 && Math.random() < 0.2 ? 'failed' : 'result', agentId: a.id });
    if ([...s.subs.values()].some(a => a.workflow === w.run && !a.finished)) return;
    if (w.phase < w.phases.length - 1) { w.phase++; this.workflowPhase(); return; }
    const r = st.ensureRun(s, w.run);
    st.applyWorkflowSummary(w.sid, w.run, { status: 'completed', durationMs: Date.now() - r.startedAt, startTime: r.startedAt, agentCount: r.agents.size, summary: tr('Policy riviste: 2 punti da sistemare') });
    w.doneAt = Date.now();
  }
  // un messaggio tra agenti (SendMessage), come quelli che il capo manda a chi sta lavorando
  demoMessage(sid, toId, text) {
    const st = this.state, s = st.sessions.get(sid), to = s && s.subs.get(toId);
    if (!to) return;
    const id = 'demo-msg-' + (++this.n);
    st.trackTeam(s, s.main, 'SendMessage', { to: to.type, summary: text }, Date.now(), id);
    st.teamResult(s, 'SendMessage', id, { success: true, resumedAgentId: toId }, Date.now());
  }

  // il Libro della bottega dei progetti della demo: lezioni finte degli ultimi giorni, coerenti con gli scenari
  // del piano 1 (così il Nonno passa nei primi secondi, quando ARCHITECT modifica session.ts). Solo in memoria.
  seedBooks() {
    if (!this.bottega) return;
    const now = Date.now(), day = 86400000;
    const at = (d, h) => now - d * day - h * 3600000;
    const cases = [];
    const add = (kind, key, list, agent, excerpt) => { for (const [d, h, sid] of list) cases.push({ kind, key, t: at(d, h), sid, agent, excerpt }); };
    // lo stesso errore dello scenario: la chiave nasce dallo stesso estratto, così il Nonno lo riconosce
    const fail = classifyFailure("FAIL tests/auth.test.ts\n  ● refresh › renews the token\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at renew (src/auth/refresh.ts:42:18)", 'npm test');
    add('stale-trap', 'src/auth/session.ts', [[4, 3, 'demo-old-1'], [2, 5, 'demo-old-2'], [1, 2, 'demo-old-3']], 'EXPLORE', tr('cambiato da {who}', { who: 'ARCHITECT' }));
    add('ghost-path', 'src/auth/oldToken.ts', [[3, 1, 'demo-old-1'], [1, 4, 'demo-old-3']], 'TEST-RUNNER', 'File does not exist.');
    add('flaky-command', 'npm run test:e2e', [[5, 2, 'demo-old-0'], [3, 6, 'demo-old-1'], [1, 1, 'demo-old-3']], 'TEST-RUNNER', 'Timeout - Async callback was not invoked within the 5000 ms timeout');
    add('slow-step', 'npm run test:e2e', [[2, 3, 'demo-old-2']], 'TEST-RUNNER', tr('{min} min', { min: 13 }));
    add('fragile-file', 'src/auth/refresh.ts', [[4, 2, 'demo-old-1'], [2, 2, 'demo-old-2']], 'TEST-RUNNER', fail.excerpt);
    add('known-fix', errorPattern(fail.excerpt) + ' → src/auth/refresh.ts', [[4, 1, 'demo-old-1'], [2, 1, 'demo-old-2']], 'EXPLORE', fail.excerpt);
    this.bottega.seedDemo('C:/Progetti/portale-clienti', cases);
    const rev = [];
    for (const [d, h, sid] of [[3, 2, 'demo-old-5'], [2, 4, 'demo-old-6'], [1, 3, 'demo-old-7']]) rev.push({ kind: 'flaky-command', key: 'npm test -- specs', t: at(d, h), sid, agent: 'SPEC-CHECKER', excerpt: 'FAIL specs/REQ-012.md' });
    for (const [d, h, sid] of [[2, 1, 'demo-old-6'], [1, 1, 'demo-old-7']]) rev.push({ kind: 'ghost-path', key: 'specs/REQ-049.md', t: at(d, h), sid, agent: 'REVIEWER', excerpt: 'File does not exist.' });
    this.bottega.seedDemo('D:/dev/mes-clone', rev);
    // isms-docs (la scena della paura): una cicatrice di due giorni fa sulla stessa cartella, e il Nonno la ricorda
    this.bottega.seedDemo('C:/Progetti/isms-docs', [{ kind: 'scar', key: 'rm -r <path> → data/export', t: at(2, 2), sid: 'demo-old-8', agent: 'GENERAL-PURPOSE', excerpt: 'backup,asked' }]);
  }

  // un evento fra qualche secondo (accorciato da scale), cancellato se la demo si ferma
  // E7 · sinonimi: il compito dice "login", l'agente lavora sull'autenticazione con altre parole. Con il TF-IDF sembra
  // alla deriva; con un motore che capisce i sinonimi (embedEngine = 'fake' nella demo, o un modello vero) resta sulla rotta.
  synonymsScenario(sid) {
    const s = this.state.sessions.get(sid);
    const id = this.spawn(sid, 'general-purpose', tr('Sistema il login: gli utenti non riescono più a entrare'));
    const a = s && s.subs.get(id);
    if (!a) return null;
    a._demoHold = Infinity; // recita solo il suo copione
    const steps = [
      ['Read', { file_path: 'src/login/LoginForm.tsx' }, 'export function LoginForm() { const [login, setLogin] = useState(""); return <button>Login</button> }'],
      ['Grep', { pattern: 'login', path: 'src/login' }, 'src/login/LoginForm.tsx\nsrc/login/loginApi.ts\nsrc/login/LoginPage.tsx'],
      ['Read', { file_path: 'src/login/loginApi.ts' }, 'export async function login(username, pwd) { return post("/api/login", { username, pwd }) }'],
      ['Read', { file_path: 'src/login/LoginPage.tsx' }, '<LoginPage><LoginForm onLogin={goHome} /></LoginPage>'],
      ['Bash', { command: 'npm test -- login' }, 'FAIL src/login/login.test.ts: login rejected for a valid username', true],
      ['Grep', { pattern: '/api/login', path: 'src/server' }, 'src/server/routes.ts: app.post("/api/login", loginHandler)'],
      ['Read', { file_path: 'src/server/loginHandler.ts' }, 'export function loginHandler(req, res) { login(req.body.username, req.body.pwd) }'],
      ['Edit', { file_path: 'src/login/loginApi.ts', old_string: 'pwd', new_string: 'pwd.trim()' }, 'ok'],
      ['Read', { file_path: 'src/security/authentication.ts' }, 'export function verifyCredentials(account, secret) { return bcrypt.compare(secret, account.hash) }'],
      ['Grep', { pattern: 'verifyCredentials', path: 'src/security' }, 'src/security/authentication.ts\nsrc/security/accessGuard.ts'],
      ['Edit', { file_path: 'src/security/authentication.ts', old_string: 'bcrypt.compare(secret', new_string: 'bcrypt.compare(secret.normalize()' }, 'ok'],
      ['Read', { file_path: 'src/security/passwordHash.ts' }, 'bcrypt rounds 4: hash mismatch for accounts created before the migration'],
      ['Edit', { file_path: 'src/security/passwordHash.ts', old_string: 'rounds: 4', new_string: 'rounds: 12' }, 'ok'],
      ['Read', { file_path: 'src/security/accessGuard.ts' }, 'export function requireAuth(req) { if (!req.identity) throw new Unauthorized() }'],
      ['Edit', { file_path: 'src/security/accessGuard.ts', old_string: 'req.identity', new_string: 'req.identity && req.identity.verified' }, 'ok'],
      ['Read', { file_path: 'src/security/signIn.ts' }, 'signIn(identity, secret) issues the access credentials'],
      ['Edit', { file_path: 'src/security/signIn.ts', old_string: 'issue(', new_string: 'issueVerified(' }, 'ok'],
      ['Read', { file_path: 'docs/security/autenticazione.md' }, 'Accesso degli utenti: credenziali, autenticazione e identità verificata'],
      ['Edit', { file_path: 'docs/security/autenticazione.md', old_string: 'credenziali', new_string: 'credenziali verificate' }, 'ok'],
      ['Read', { file_path: 'src/security/credentials.ts' }, 'export const credentialPolicy = { minLength: 12, rotateDays: 90 }'],
    ];
    const t0 = Date.now() - steps.length * 30000 - 60000;
    steps.forEach(([tool, input, out, err], i) => {
      const tid = 'demo-syn-' + (++this.world.seq), t = t0 + i * 30000;
      this.state.worldStart(s, a, tid, tool, input, t);
      this.state.worldEnd(s, a, tid, !!err, { content: out }, { toolUseResult: {} }, t + 4000);
    });
    return id;
  }

  // 2.14 (R10) · la paura, sul piano di isms-docs. Quattro scene che tornano ogni 4 minuti, senza mai lanciare un comando vero:
  //   1. RIPRISTINO fa git reset --hard senza un commit prima: resta calmo, arriva il Nonno con il timbro PERICOLO
  //   2. INFRA lancia terraform plan, poi terraform apply: suda, perché è stato prudente
  //   3. PULIZIA cancella data/export (che aveva appena letto), poi non lo trova più e i test cadono: la cicatrice
  //   4. CLAUDE chiede il permesso per uno strumento MCP che manda una mail: livello 3 nel fumetto (IRREVERSIBILE)
  fearScenario(sid, scale = 1) {
    const s = this.state.sessions.get(sid);
    if (!s) return;
    const mk = (desc) => { const id = this.spawn(sid, 'general-purpose', desc); const a = id && s.subs.get(id); if (a) a._demoHold = Infinity; return a; };
    const reset = mk(tr('Rimetti il branch come su origin')), infra = mk(tr('Aggiorna l\'infrastruttura di prova')), clean = mk(tr('Pulisci gli export vecchi'));
    if (!reset || !infra || !clean) return;
    const at = (sec, fn) => this.later(sec * scale, fn);
    const tool = (sec, a, name, input, out, err = false, dur = 2) => {
      const id = 'demo-fear-' + (++this.n);
      at(sec, () => this.state.worldStart(s, a, id, name, input, Date.now()));
      at(sec + dur, () => this.state.worldEnd(s, a, id, !!err, { content: out }, { toolUseResult: {} }, Date.now()));
    };
    const round = (t0) => {
      // 1 · il reset senza rete
      tool(t0 + 4, reset, 'Bash', { command: 'npm test' }, 'Tests: 18 passed, 18 total');
      tool(t0 + 9, reset, 'Bash', { command: 'git reset --hard origin/main' }, 'HEAD is now at 4f2a9c1 Merge pull request #41');
      // 2 · plan, poi apply: la paura giusta
      tool(t0 + 14, infra, 'Bash', { command: 'terraform plan -out=tfplan' }, 'Plan: 2 to add, 1 to change, 0 to destroy.');
      tool(t0 + 22, infra, 'Bash', { command: 'terraform apply tfplan' }, 'Apply complete! Resources: 2 added, 1 changed, 0 destroyed.', false, 5);
      // 3 · la cartella cancellata: dopo, il file non c'è più e i test cadono (il motore segna la cicatrice entro un minuto)
      tool(t0 + 30, clean, 'Read', { file_path: s.cwd + '/data/export/ordini-2026.csv' }, 'id,cliente,totale');
      tool(t0 + 34, clean, 'Bash', { command: 'rm -rf data/export' }, '');
      tool(t0 + 40, clean, 'Read', { file_path: s.cwd + '/data/export/ordini-2026.csv' }, 'File does not exist.', true);
      tool(t0 + 44, clean, 'Bash', { command: 'git reflog' }, '4f2a9c1 HEAD@{0}: commit: export mensile');
      // 4 · una mail al cliente da uno strumento MCP: serve il tuo permesso, ed è irreversibile
      at(t0 + 50, () => this.hook(sid, 'PermissionRequest', { tool_name: 'mcp__gmail__send_email', tool_input: { to: 'cliente@example.com', subject: tr('Report di novembre') } }));
    };
    round(0);
    const again = () => { round(0); this.later(240 * scale, again); };
    this.later(240 * scale, again);
  }

  later(sec, fn) { const tm = setTimeout(() => { this.world.timers.delete(tm); try { fn(); } catch {} }, sec * 1000); this.world.timers.add(tm); }
  // un hook di feedback come quello che Claude Code manderebbe per questa sessione (vedi index.js: feedbackAnswer)
  say(sid, input) {
    const s = this.state.sessions.get(sid);
    if (!s || !this.feedback) return;
    try { this.feedback({ session_id: sid, cwd: s.cwd, ...input }); } catch {}
  }

  // mappa contro territorio, costruita apposta sul piano 1: un ricordo scaduto, un percorso inventato,
  // un'affermazione senza prove che nel turno dopo diventa ancorata. Il disco è finto (s.demoDisk).
  // Sullo stesso filo, il feedback agli agenti (C3): una scena per funzione, con gli hook che Claude Code manderebbe.
  groundingScenario(sid, ids, scale) {
    const s = this.state.sessions.get(sid);
    if (!s) return;
    const ag = { main: s.main, explore: s.subs.get(ids.explore), architect: s.subs.get(ids.architect), tester: s.subs.get(ids.tester), plan: s.subs.get(ids.plan) };
    if (!ag.explore || !ag.architect || !ag.tester || !ag.plan) return;
    const finder = s.subs.get(ids.finder);
    s.demoDisk = new Map([['src/auth/oldToken.ts', { exists: false }]]);
    const hold = Date.now() + 150000 * scale; // intanto questi agenti non fanno altro: lo scenario resta leggibile
    for (const a of [...Object.values(ag), finder]) if (a) a._demoHold = hold;
    const at = (sec, fn) => this.later(sec * scale, fn);
    const who = a => (a.kind === 'main' ? {} : { agent_id: a.id, agent_type: a.type });
    // fb: dopo lo strumento parte anche l'hook di feedback (PostToolUse, o PostToolUseFailure se è fallito)
    const tool = (sec, a, name, input, out, err, dur = 1, fb = false) => {
      const id = 'demo-gr-' + (++this.n);
      at(sec, () => {
        this.hook(sid, 'PreToolUse', { agent_id: a.kind === 'main' ? undefined : a.id, agent_type: a.kind === 'main' ? undefined : a.type, tool_name: name, tool_input: input });
        this.state.worldStart(s, a, id, name, input, Date.now());
      });
      at(sec + dur, () => {
        this.state.worldEnd(s, a, id, !!err, { content: out }, { toolUseResult: {} }, Date.now());
        if ((name === 'Edit' || name === 'Write') && !err) s.demoDisk.set(input.file_path, { mtime: Date.now() });
        if (fb) this.say(sid, { hook_event_name: err ? 'PostToolUseFailure' : 'PostToolUse', ...who(a), tool_name: name, tool_input: input, tool_use_id: id,
          ...(err ? { error: (name === 'Bash' ? 'Exit code 1\n' : '') + out } : { tool_response: {} }) });
      });
    };
    const reply = (sec, text) => at(sec, () => {
      this.state.mindOf(s, s.main).add('reply', Date.now(), text.slice(0, 80), text);
      this.state.worldReply(s, s.main, Date.now(), text);
      this.state.setAgent(s.main, 'writing', tr('Scrive: «{text}»', { text: text.slice(0, 44) }), Date.now());
    });
    tool(3, ag.explore, 'Read', { file_path: 'src/auth/session.ts' }, "import { token } from './token';");
    tool(8, ag.architect, 'Edit', { file_path: 'src/auth/session.ts' }, 'ok');
    tool(12, ag.tester, 'Read', { file_path: 'src/auth/oldToken.ts' }, 'File does not exist.', true);
    tool(14, s.main, 'Read', { file_path: 'src/auth/refresh.ts' }, "import { session } from './session';"); // rilegge prima di modificare: niente modifica alla cieca
    // feedback: refresh.ts è fragile, il Nonno lo dice a CLAUDE («lancia i test adesso»)
    tool(16, s.main, 'Edit', { file_path: 'src/auth/refresh.ts' }, 'ok', false, 1, true);
    const claim = tr('Ho corretto il refresh in {file} e i test passano.', { file: '`src/auth/refresh.ts`' });
    reply(19, claim);
    // feedback: a fine turno dice che i test passano, ma dopo la modifica non li ha lanciati (in ombra)
    at(20, () => this.say(sid, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: claim }));
    // feedback: ARCHITECT legge cookies.ts, il cercatore lo cambia, ARCHITECT lo riscrive senza rileggerlo (in ombra), poi lo rilegge
    tool(21, ag.architect, 'Read', { file_path: 'src/auth/cookies.ts' }, 'export const cookie = {};');
    // feedback: lo stesso lint fallisce due volte di fila allo stesso modo; al secondo arriva il giro in tondo, poi cambia qualcosa
    if (finder) {
      const lint = "src/auth/token.ts:12:3  error  'exp' is assigned a value but never used  no-unused-vars\n✖ 1 problem (1 error, 0 warnings)";
      tool(25, finder, 'Edit', { file_path: 'src/auth/cookies.ts' }, 'ok');
      tool(30, finder, 'Bash', { command: 'npm run lint' }, lint, true, 2);
      tool(34, finder, 'Bash', { command: 'npm run lint' }, lint, true, 2, true);
      tool(39, finder, 'Edit', { file_path: 'src/auth/token.ts' }, 'ok');
      tool(44, ag.architect, 'Write', { file_path: 'src/auth/cookies.ts', content: 'export const cookie = { secure: true };' }, 'ok', false, 1, true);
      tool(48, ag.architect, 'Read', { file_path: 'src/auth/cookies.ts' }, 'export const cookie = { secure: true };');
    }
    at(50, () => this.hook(sid, 'UserPromptSubmit', { prompt: tr('Hai lanciato i test?') }));
    tool(53, s.main, 'Bash', { command: 'npm test' }, 'Tests: 42 passed, 42 total', false, 7);
    reply(62, tr('Ho lanciato {cmd}: ora tutti i test passano.', { cmd: '`npm test`' }));
    // sorpresa e cause: una catena completa (il test che prima passava fallisce, segue la traccia, torna verde)
    // e un agente che cerca altrove (l'errore cita migrate.ts, lui modifica un componente grafico)
    const trace = "FAIL tests/auth.test.ts\n  ● refresh › renews the token\n    TypeError: Cannot read properties of undefined (reading 'exp')\n      at renew (src/auth/refresh.ts:42:18)\n      at Object.<anonymous> (tests/auth.test.ts:17:5)\n      at node_modules/jest-circus/build/utils.js:298:28\nTests: 1 failed, 41 passed, 42 total";
    tool(64, ag.tester, 'Read', { file_path: 'package.json' }, '{ "scripts": { "test": "jest" } }');
    tool(67, ag.tester, 'Read', { file_path: 'tests/auth.test.ts' }, "import { renew } from '../src/auth/refresh';");
    tool(70, ag.tester, 'Bash', { command: 'npm test' }, 'Tests: 42 passed, 42 total', false, 3);
    tool(76, ag.tester, 'Bash', { command: 'npm test' }, trace, true, 3, true); // feedback: il Nonno sa dove si è già sistemato
    // feedback: PLAN (il piano di migrazione del DB) è da un pezzo tra i componenti grafici: lontano dal compito (in ombra).
    // Prima del suo tsc su migrate.ts, che parla di nuovo del compito e farebbe ripartire il conto
    // sei letture di fila tra colori, icone e animazioni, poi la settima con l'hook: la deriva è netta, non al limite
    ['Button.tsx', 'theme/palette.css', 'icons/gradient.svg', 'Tooltip.tsx', 'theme/dark.css', 'Header.tsx'].forEach((f, i) =>
      tool(56 + i * 2, ag.plan, 'Read', { file_path: 'src/ui/components/' + f }, 'export const style = { color: palette.dark, hover: gradient, shadow: glow, icon: sparkle, animation: fadeIn };'));
    tool(70, ag.plan, 'Read', { file_path: 'src/ui/components/Sidebar.tsx' }, "import { Menu } from './Menu';\nexport const Sidebar = () => <nav className=\"sidebar dark\" style={{ hover: gradient, icon: sparkle }} />;", false, 1, true);
    tool(81, ag.tester, 'Read', { file_path: 'src/auth/refresh.ts' }, "import { session } from './session';");
    tool(85, ag.tester, 'Edit', { file_path: 'src/auth/refresh.ts' }, 'ok');
    tool(89, ag.tester, 'Bash', { command: 'npm test' }, 'Tests: 42 passed, 42 total', false, 3);
    tool(78, ag.plan, 'Bash', { command: 'npx tsc --noEmit' }, "src/db/migrate.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", true, 2);
    tool(84, ag.plan, 'Edit', { file_path: 'src/ui/components/Menu.tsx' }, 'ok');
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.world.stop();
    this.wf = null;
    if (this.bottega) this.bottega.dropDemo();
    if (this.dropFeedback) this.dropFeedback();
    this.state.demo = false;
    this.state.removeDemo();
  }

  open(cwd, title, ep) {
    const id = 'demo-' + (++this.n);
    const s = this.state.ensureSession(id, cwd);
    s.demo = true;
    s.alive = true;
    s.demoTree = treeFor(cwd);
    s.title = title;
    this.state.setEntrypoint(s, ep);
    // un po' di passato finto, così il grafico dell'ultima ora non parte vuoto
    const minute = Math.floor(Date.now() / 60000);
    const big = /mes-clone/.test(cwd);
    const len = big ? 50 : 25 + Math.floor(Math.random() * 15);
    for (let i = len; i >= 1; i--) {
      const ramp = Math.min(1, (len - i) / 12);
      const a = Math.round((big ? 30 : 5) * ramp * (0.7 + Math.random() * 0.3)) + 1;
      const b = Math.max(0, a - Math.floor(Math.random() * 3));
      s.hist.push({ m: minute - i, a, b, w: Math.random() < 0.06 ? 1 : 0, d: Math.floor(Math.random() * (big ? 5 : 2)) });
    }
    s.main.model = pick(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-1']);
    s.main.effort = pick(['high', 'xhigh', 'max', 'medium']);
    this.hook(id, 'UserPromptSubmit', { prompt: title });
    const g = s.main.mind && s.main.mind.goals[0];
    if (g) { g.t = Date.now() - 16 * 60000; const p = s.main.mind.pieces.find(x => x.kind === 'prompt'); if (p) p.t = g.t; }
    return id;
  }

  // extra.meta: campi in più per il sottoagente (es. il Workflow); extra.quiet: senza la chiamata Agent del capo
  spawn(sid, type, desc, parent, extra = {}) {
    const s = this.state.sessions.get(sid);
    if (!s) return null;
    const aid = 'demo-sub-' + (++this.n);
    if (!extra.quiet) this.hook(sid, 'PreToolUse', { agent_id: parent || undefined, tool_name: 'Agent', tool_input: { subagent_type: type, description: desc } });
    this.state.ensureSub(s, aid, { agentType: type, description: desc, parentAgentId: parent || undefined, background: type === 'reviewer' || type === 'spec-checker', ...(extra.meta || {}) });
    const a = s.subs.get(aid);
    if (a) this.state.mindOf(s, a).setGoal(Date.now() - 16 * 60000, desc); // il suo compito: la stella polare
    if (a) { // modelli ed effort finti: età e costumi diversi in ufficio
      a.model = pick(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-20241022']);
      a.effort = pick(['low', 'medium', 'medium', 'high', 'xhigh', 'max']);
    }
    this.hook(sid, 'SubagentStart', { agent_id: aid, agent_type: type });
    return aid;
  }

  spawnReviewer() {
    const type = Math.random() < 0.7 ? 'reviewer' : 'spec-checker';
    const what = pick(REVIEW_TARGETS());
    return this.spawn(this.ids.b, type, type === 'reviewer' ? tr('Rivedi {what}', { what }) : tr('Verifica le specifiche: {what}', { what }));
  }

  writeTodos(sid) {
    const s = this.state.sessions.get(sid);
    if (!s) return;
    const items = sid === this.ids.b
      ? [tr('Raccogli le specifiche'), tr('Lancia i revisori'), tr('Lancia gli spec-checker'), tr('Unisci i verdetti'), tr('Scrivi il report finale')]
      : [tr('Mappa i moduli auth'), tr('Progetta il refresh token'), tr('Riscrivi il login'), tr('Aggiorna i test'), tr('Prepara la PR')];
    const k = this.todoStep % (items.length + 1);
    this.state.trackBoards(s, 'TodoWrite', { todos: items.map((c, i) => ({ content: c, status: i < k ? 'completed' : i === k ? 'in_progress' : 'pending' })) }, Date.now());
  }

  hook(id, name, extra) {
    this.state.applyHook({ session_id: id, hook_event_name: name, _demo: true, ...extra });
  }

  step() {
    for (const s of [...this.state.sessions.values()].filter(x => x.demo && !x.ended)) {
      const subs = [...s.subs.values()].filter(a => !a.finished);
      const r = Math.random();
      // capo
      if (r < 0.4) this.state.addTokens(s, s.main, { input_tokens: 30, output_tokens: 200 + Math.random() * 500, cache_read_input_tokens: 40000, cache_creation_input_tokens: 1500 }, null);
      if (s.main._demoHold > Date.now()) { /* sta recitando uno scenario: niente azioni a caso */ }
      else if (s.main.status === 'waiting') { if (r < 0.2) this.hook(s.id, 'PostToolUse', {}); }
      else if (s.main.status === 'idle') { if (r < 0.05) this.hook(s.id, 'UserPromptSubmit', { prompt: pick([tr('Ok, procedi'), tr('Aggiungi anche i test'), tr('Ora scrivi il README')]) }); }
      else if (s.id === this.ids.c && r < 0.05) this.hook(s.id, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
      else if (r < 0.03 && !subs.length) this.hook(s.id, 'Stop', {});
      else if (r < 0.35) this.world.act(s, s.main, (name, extra) => this.hook(s.id, name, extra));
      else if (r < 0.45) this.hook(s.id, 'PostToolUse', {});
      // squadre
      for (const a of subs) {
        if (a._demoStuck || a._demoHold > Date.now()) continue;
        const q = Math.random();
        if (a._demoWf) { // agenti del Workflow: lavorano, ma finiscono solo quando lo dice il giornale (workflowStep)
          if (q < 0.5) this.state.addTokens(s, a, { input_tokens: 40, output_tokens: 300 + Math.random() * 600, cache_read_input_tokens: 20000, cache_creation_input_tokens: 800 }, null);
          else if (q < 0.8) this.world.act(s, a, (name, extra) => this.hook(s.id, name, extra));
          continue;
        }
        // token: ogni agente consuma un po' a ogni passo
        if (q < 0.5) this.state.addTokens(s, a, { input_tokens: 40, output_tokens: 300 + Math.random() * 600, cache_read_input_tokens: 20000 + Math.random() * 30000, cache_creation_input_tokens: Math.random() * 3000 }, null);
        if (q > 0.996 && a.type !== 'reviewer') { for (let k = 0; k < 3; k++) this.hook(s.id, 'PostToolUseFailure', { agent_id: a.id, agent_type: a.type, tool_name: 'Bash' }); }
        const kids = subs.filter(k => k.parentId === a.id).length;
        const endP = s.id === this.ids.b ? 0.025 : (kids ? 0 : 0.012);
        if (q < endP) this.hook(s.id, 'SubagentStop', { agent_id: a.id, agent_type: a.type });
        else if (q < 0.004 + endP && a.type !== 'reviewer') this.hook(s.id, 'PermissionRequest', { agent_id: a.id, agent_type: a.type, tool_name: 'Bash', tool_input: { command: 'npm run migrate' } });
        else if (q < 0.45) this.world.act(s, a, (name, extra) => this.hook(s.id, name, extra));
        else if (q < 0.55) this.hook(s.id, 'PostToolUse', { agent_id: a.id, agent_type: a.type });
        else if (q < 0.6 && a.status === 'waiting') this.hook(s.id, 'PostToolUse', { agent_id: a.id, agent_type: a.type });
      }
      if (s.id === this.ids.c) this.workflowStep();
      if (s.id === this.ids.a && Math.random() < 0.004) { const arch = subs.find(a => a.type === 'architect'); if (arch) this.demoMessage(s.id, arch.id, pick([tr('Controlla anche il logout'), tr('Le sessioni vanno in Redis'), tr('Aspetta i test prima della PR')])); }
      // rilasci finti: commit, PR, test verdi
      if (Math.random() < 0.008) {
        const evs = [
          { kind: 'commit', text: tr('Commit {hash}', { hash: Math.random().toString(16).slice(2, 9) }) + ': ' + pick([tr('Fix refresh token'), tr('Aggiunge test e2e'), tr('Pulizia moduli auth'), tr('Nuova policy accessi')]) },
          { kind: 'tests', text: tr('Test verdi: {n} passati', { n: 30 + Math.floor(Math.random() * 90) }) },
          { kind: 'pr', text: tr('PR #{n} aperta', { n: 40 + Math.floor(Math.random() * 30) }) + ': ' + pick([tr('Nuovo modulo sessioni'), tr('Report CSV notturno'), tr('Policy ISO aggiornate')]), url: 'https://github.com/esempio/demo/pull/42' },
          { kind: 'push', text: tr('Push su {branch}', { branch: 'main' }) },
        ];
        if (s.id === this.ids.c || s.id === this.ids.a) { s.testsRed = Math.random() < 0.5; this.state.addRelease(s, s.main, pick(evs), Date.now()); }
      }
      // lavagne: ogni tanto il capo aggiorna la lista; ogni tanto lo interrompi tu
      if (Math.random() < 0.012) { this.todoStep++; this.writeTodos(s.id); }
      if (Math.random() < 0.003 && s.id === this.ids.c) { s.main.interruptedAt = Date.now(); this.state.setAgent(s.main, 'idle', tr('Interrotto da te')); }
      // ricambio
      if (s.id === this.ids.b && subs.length < 30 && Math.random() < 0.5) this.spawnReviewer();
      if (s.id === this.ids.a) {
        const arch = subs.find(a => a.type === 'architect');
        if (arch && subs.filter(a => a.parentId === arch.id).length < 2 && Math.random() < 0.1) this.spawn(s.id, pick(['Explore', 'test-runner', 'code-reviewer']), pick([tr('Controlla i cookie di sessione'), tr('Rivedi le modifiche al login'), tr('Esegui i test di integrazione')]), arch.id);
        if (!arch && Math.random() < 0.02) this.spawn(s.id, 'architect', tr('Progetta il nuovo modulo sessioni'));
        if (subs.length < 3 && Math.random() < 0.05) this.spawn(s.id, pick(['Explore', 'Plan']), pick([tr('Trova dove si leggono i CSV'), tr('Piano per i test end-to-end')]));
      }
      if (s.id === this.ids.c && !subs.length && Math.random() < 0.03) this.spawn(s.id, 'general-purpose', tr('Ricerca requisiti Annex A'));
      if (s.id === this.ids.d && subs.length < 3 && Math.random() < 0.06) this.spawn(s.id, pick(['general-purpose', 'Explore']), pick([tr('Controlla le fonti del report'), tr('Riassumi le email del cliente'), tr('Verifica i numeri della slide 4')]));
    }
  }
}

module.exports = { Demo };
