'use strict';
// Lo storico finto della demo (S14 di docs/plans/2.13-storage.md): tre mesi di sessioni per i progetti della demo, in
// uno store in memoria tutto suo. La demo non scrive mai nello storico vero; questo serve solo a far vedere qualcosa
// nella scheda STORIA del Libro, nell'esperimento della scheda FEEDBACK, nella ricerca e nel report.
//   portale-clienti  migliora: i giri in tondo e le sorprese calano, le lezioni del Libro arrivano agli agenti
//   mes-clone        peggiora: più giri in tondo, più fasi bloccate, più affermazioni senza prove
//   isms-docs        stabile
// e il "giro in tondo" è in esperimento, con un effetto visibile (probabilmente utile più spesso con i messaggi).
// Numeri a caso ma sempre gli stessi (seme fisso), così le prove li possono controllare.

const { openStore } = require('./store');
const { declareCollections } = require('./store/collections');
const { pathKey } = require('./store/project-key');
const { groupOf } = require('./experiments');

const DAY = 86400000, WEEK = 7 * DAY, WEEKS = 13;
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
  const sessions = store.collection('sessions'), steps = store.collection('steps'), feedback = store.collection('feedback'), experiments = store.collection('experiments'), projects = store.collection('projects');
  let nSessions = 0, nSteps = 0, nFeedback = 0;
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
  return { sessions: nSessions, steps: nSteps, feedback: nFeedback };
}

// lo store della demo: in memoria, con le collezioni vere, già riempito
function demoHistoryStore(now = Date.now()) {
  const store = declareCollections(openStore({ backend: 'memory', requireFields: true }));
  store.seeded = seedDemoHistory(store, now);
  return store;
}

module.exports = { demoHistoryStore, seedDemoHistory, PROJECTS };
