'use strict';
// Lo storico finto della demo (S14 di docs/plans/2.13-storage.md): tre mesi di sessioni per i progetti della demo, in
// uno store in memoria tutto suo. La demo non scrive mai nello storico vero; questo serve solo a far vedere qualcosa
// nella scheda STORIA del Libro, nell'esperimento della scheda FEEDBACK, nella ricerca e nel report.
//   portale-clienti  migliora: i giri in tondo e le sorprese calano, le lezioni del Libro arrivano agli agenti
//   mes-clone        peggiora: più giri in tondo, più fasi bloccate, più affermazioni senza prove
//   isms-docs        stabile
// Dalla 2.14 anche la paura: azioni rischiose, paure mancate (in calo su portale-clienti, in aumento su mes-clone) e
// cicatrici, più il messaggio "fear" in esperimento (con il messaggio l'agente aggiunge prudenza più spesso).
// e il "giro in tondo" è in esperimento, con un effetto visibile (probabilmente utile più spesso con i messaggi).
// Numeri a caso ma sempre gli stessi (seme fisso), così le prove li possono controllare.

const { openStore } = require('./store');
const { declareCollections } = require('./store/collections');
const { pathKey } = require('./store/project-key');
const { groupOf } = require('./experiments');

const DAY = 86400000, WEEK = 7 * DAY, WEEKS = 13;
// le azioni rischiose finte: regola, livello, forma, bersaglio (senza comandi veri)
const RISKS = [
  ['git-reset-hard', 2, 'git reset --hard <ref>', ''], ['git-clean', 2, 'git clean -fd', ''], ['rm-recursive', 2, 'rm -r <path>', 'data/export'],
  ['git-push-main', 3, 'git push <remote> main', ''], ['terraform-apply', 3, 'terraform apply', ''], ['sql-delete-all', 3, 'DELETE FROM <table>', ''], ['publish', 3, '<tool> publish', ''],
];
const NAMES = ['CLAUDE', 'EXPLORE', 'ARCHITECT', 'TEST-RUNNER', 'PULIZIA'];
const PROJECTS = [
  { cwd: 'C:/Progetti/portale-clienti', name: 'portale-clienti', shape: 'better' },
  { cwd: 'D:/dev/mes-clone', name: 'mes-clone', shape: 'worse' },
  { cwd: 'C:/Progetti/isms-docs', name: 'isms-docs', shape: 'steady' },
];

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// dove sta un valore nel tempo: f va da 0 (13 settimane fa) a 1 (adesso)
const along = (shape, f, from, to) => (shape === 'better' ? from + (to - from) * f : shape === 'worse' ? to + (from - to) * f : (from + to) / 2);

function seedDemoHistory(store, now = Date.now()) {
  const r = rng(20261119);
  const pick = a => a[Math.floor(r() * a.length)];
  // la paura (2.14) ha il suo generatore: così i numeri di prima restano identici
  const rf = rng(20261120), pickF = a => a[Math.floor(rf() * a.length)];
  const sessions = store.collection('sessions'), steps = store.collection('steps'), feedback = store.collection('feedback'), experiments = store.collection('experiments'), projects = store.collection('projects');
  const risks = store.collection('risks');
  let nSessions = 0, nSteps = 0, nFeedback = 0, nRisks = 0;
  store.transaction(() => {
    for (const p of PROJECTS) {
      const key = pathKey(p.cwd);
      projects.put({ _id: key, name: p.name, aliases: {}, firstSeen: now - WEEKS * WEEK, lastSeen: now });
      for (let w = WEEKS - 1; w >= 0; w--) {
        const f = (WEEKS - 1 - w) / (WEEKS - 1);
        const perWeek = 5 + Math.floor(r() * 4);
        for (let k = 0; k < perWeek; k++) {
          const sid = `demo-${p.name}-${w}-${k}`, t = now - w * WEEK - Math.floor(r() * 6 * DAY) - 3600000;
          if (t > now) continue;
          const loopsMean = along(p.shape, f, 3.5, 0.8);
          const lessonsGroup = groupOf(sid, 'sessionLessons');
          const actions = 60 + Math.floor(r() * 80);
          // con le lezioni a inizio sessione gli errori calano di un quinto (l'effetto che l'esperimento deve vedere)
          const errRate = along(p.shape, f, 0.11, 0.05) * (lessonsGroup === 'on' ? 0.8 : 1);
          const loops = Math.max(0, Math.round(loopsMean + (r() - 0.5) * 1.6));
          sessions.put({
            _id: sid, project: key, t, end: t + (20 + Math.floor(r() * 90)) * 60000, kind: 'code', model: pick(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']), effort: pick(['high', 'medium']),
            agents: 1 + Math.floor(r() * 5), actions, errors: Math.round(actions * errRate), surprises: loops * 2 + Math.floor(r() * 3), loops,
            stuck: p.shape === 'steady' ? (k % 3 === 0 ? 1 : 0) : Math.max(0, Math.round(along(p.shape, f, 1.2, 0.2) + (r() - 0.6))), flaky: r() < along(p.shape, f, 0.6, 0.2) ? 1 : 0,
            claims: Math.max(0, Math.round(along(p.shape, f, 1.4, 0.3) + (r() - 0.5))), stale: r() < 0.25 ? 1 : 0,
            lessons: p.shape === 'better' ? Math.round(2.5 * f) : 0, cost: Math.round((0.6 + r() * 2.4) * 100) / 100, tokens: 40000 + Math.floor(r() * 300000),
          });
          nSessions++;
          // la paura (2.14): qualche azione rischiosa per sessione; le paure mancate seguono la forma del progetto
          {
            const n = 2 + Math.floor(rf() * 2), missRate = along(p.shape, f, 0.85, 0.1);
            let missed = 0, scars = 0;
            for (let i = 0; i < n; i++) {
              const [rule, level, shape, target] = pickF(RISKS), miss = rf() < missRate, damage = miss && rf() < 0.12;
              const rt = t + (i + 1) * 300000;
              risks.put({ _id: `${sid}:risk${i}`, project: key, t: rt, session: sid, agent: i ? 'demo-sub' : 'main', name: pickF(NAMES), tool: 'Bash', ruleIds: [rule], level,
                prudence: miss ? 0 : 0.6, present: miss ? [] : ['backup'], missing: miss ? ['looked', 'backup'] : ['looked'], missed: miss, shape, ...(target ? { target } : {}),
                ...(damage ? { outcome: 'damage', at: rt + 120000, evidence: [`${sid}:s0`] } : {}) });
              nRisks++; if (miss) missed++; if (damage) scars++;
              // il messaggio "fear", in esperimento: con il messaggio l'agente aggiunge prudenza più spesso
              if (miss && p.shape !== 'steady') {
                const group = groupOf(sid, 'fear'), u = rf();
                const outcome = u < 0.2 ? 'unclear' : (u - 0.2) / 0.8 < (group === 'on' ? 0.62 : 0.3) ? 'helped' : 'ignored';
                feedback.put({ project: key, t: rt - 1000, sid, agent: 'main', name: 'CLAUDE', feature: 'fear', mode: group, group, event: 'PreToolUse', tag: rule,
                  text: 'Platypus: the command you just ran is dangerous. Missing in the actions before it: a commit or a copy. If the user did not ask for exactly this, check what it changed and tell them now. Before the next risky action: make a commit or a copy.', about: { kind: 'fear', cmd: shape, pat: rule }, outcome, at: rt + 600000 });
                nFeedback++;
              }
            }
            sessions.patch(sid, { risky_actions: n, missed_fears: missed, scars });
          }
          if (p.shape !== 'steady') { experiments.put({ _id: sid + ':sessionLessons', project: key, t, sid, feature: 'sessionLessons', group: lessonsGroup }); }
          // i messaggi del giro in tondo, in esperimento: con i messaggi l'agente cambia strada più spesso
          if (loops > 0 && p.shape !== 'steady') {
            const group = groupOf(sid, 'loop');
            for (let m = 0; m < Math.min(loops, 2); m++) {
              const u = r();
              const outcome = u < 0.15 ? 'unclear' : (u - 0.15) / 0.85 < (group === 'on' ? 0.68 : 0.38) ? 'helped' : 'ignored';
              feedback.put({ project: key, t: t + m * 60000, sid, agent: 'main', name: 'CLAUDE', feature: 'loop', mode: group, group, event: 'PostToolUseFailure',
                text: 'Platypus: this command failed 3 times in a row with the same error. Change something before running it again.', about: { kind: 'loop', cmd: 'npm run test:e2e' }, outcome, at: t + 900000 });
              nFeedback++;
            }
          }
          // qualche passo, per la ricerca
          if (w < 6) {
            const targets = p.name === 'portale-clienti' ? ['src/auth/login.ts', 'src/auth/session.ts', 'src/api/orders.ts', 'tests/e2e/login.spec.ts'] : p.name === 'mes-clone' ? ['specs/ordini.md', 'src/plc/scheduler.py', 'src/plc/alarms.py'] : ['policy/accessi.md', 'policy/backup.md'];
            for (let i = 0; i < 6; i++) {
              const verify = r() < 0.4, fail = verify && r() < 0.5;
              steps.put({ _id: `${sid}:s${i}`, project: key, t: t + i * 120000, session: sid, agent: 'main', action: verify ? 'verify' : pick(['read', 'edit', 'read']), tool: verify ? 'Bash' : pick(['Read', 'Edit']),
                target: verify ? 'cmd:npm' : pick(targets), outcome: fail ? 'error' : 'ok', dur: 1000 + Math.floor(r() * 60000), phase: verify ? 'test' : 'build',
                ...(verify ? { cmd: pick(['npm run test:e2e', 'npm test', 'pytest']) } : {}), ...(fail ? { fail: 'test', err: pick(['TypeError: <…> is not a function', 'AssertionError: expected N to equal N', 'Timeout of Nms exceeded']) } : {}) });
              nSteps++;
            }
          }
        }
      }
    }
  });
  // oggi: qualche azione rischiosa delle ultime ore, così il report del giorno ha qualcosa da mostrare
  store.transaction(() => {
    PROJECTS.forEach((p, j) => {
      const key = pathKey(p.cwd);
      for (let i = 0; i < 2; i++) {
        const [rule, level, shape, target] = RISKS[(j * 2 + i) % RISKS.length], rt = now - (i * 2 + j + 1) * 1800000, damage = j === 1 && i === 0;
        risks.put({ _id: `demo-today-${p.name}-${i}`, project: key, t: rt, session: `demo-today-${p.name}`, agent: 'main', name: NAMES[(i + j) % NAMES.length], tool: 'Bash', ruleIds: [rule], level,
          prudence: i ? 0.6 : 0, present: i ? ['backup'] : [], missing: i ? ['looked'] : ['looked', 'backup'], missed: !i, shape, ...(target ? { target } : {}),
          ...(damage ? { outcome: 'damage', at: rt + 60000, evidence: [`demo-today-${p.name}:s0`] } : {}) });
        nRisks++;
      }
    });
  });
  return { sessions: nSessions, steps: nSteps, feedback: nFeedback, risks: nRisks };
}

// lo store della demo: in memoria, con le collezioni vere, già riempito
function demoHistoryStore(now = Date.now()) {
  const store = declareCollections(openStore({ backend: 'memory', requireFields: true }));
  store.seeded = seedDemoHistory(store, now);
  return store;
}

module.exports = { demoHistoryStore, seedDemoHistory, PROJECTS };
