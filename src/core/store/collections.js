'use strict';
// Le collezioni dello storico di Platypus (S7 di docs/plans/2.13-storage.md): che cosa c'è in ognuna, con quali
// campi, quali indici e per quanto tempo. È l'unico posto dove si decide che cosa lo storico può contenere:
// la guardia (privacy.js) scarta tutto quello che non è scritto qui.
//
//   projects     i progetti: chiave, alias, remote senza credenziali, nome della cartella      per sempre (finché "dimentica")
//   lessons      le lezioni del Libro della bottega                                            180 giorni se di poco peso
//   steps        un fatto per ogni azione: quando, chi, che cosa, su che cosa, com'è finita    90 giorni
//   sessions     il riassunto di ogni sessione                                                 365 giorni
//   feedback     i messaggi agli agenti (2.11) e che cosa è successo dopo                      365 giorni
//   experiments  il gruppo assegnato a ogni sessione per ogni funzione del feedback (S11)      365 giorni
//   daily        le statistiche per giorno e per settimana (lo stats.json di prima)            per sempre (sono piccole)
//
// Mai il testo: niente richieste, risposte, uscite dei comandi, contenuto dei file. Dove resta una riga
// ('excerpt') è perché l'ufficio la mostrava già (la prova di una lezione, la riga dell'errore, il titolo di un
// commit), e passa dal filtro dei segreti. 'note' è solo per le frasi che Platypus stesso ha scritto a un agente.

const { fail, isPlain } = require('./common');

const DAY = 86400000;
const NUM = { '*': 'number' };

const COLLECTIONS = {
  projects: {
    projectField: '_id', // qui la chiave del progetto è l'_id
    fields: {
      name: 'string', remote: 'string', aliases: NUM, firstSeen: 'number', lastSeen: 'number',
      // del Libro: le lezioni dimenticate (id → quando) e le sessioni d'archivio già lette (id → fine)
      forgotten: NUM, learned: NUM, mute: 'boolean', // mute: "non parlare agli agenti di questo progetto" (2.11)
    },
    indexes: [],
    retention: null,
  },
  lessons: {
    // _id: "<chiave del progetto>:<id della lezione>"; t: l'ultimo caso
    fields: {
      lesson: 'id', kind: 'string', key: 'excerpt', count: 'number', sessions: ['id'], first: 'number', last: 'number',
      evidence: [{ sid: 'id', t: 'number', agent: 'string', excerpt: 'excerpt' }], // i casi: rimandi ai passi, con la riga che l'ufficio mostra
      seen: ['string'], pinned: 'boolean', ignored: 'boolean',
    },
    indexes: [['project', 'kind']],
    retention: { days: 180, onlyIf: 'low-weight' }, // S10: solo sotto la soglia di peso e mai se fissate
  },
  steps: {
    // t: quando è cominciata l'azione
    fields: {
      session: 'id', agent: 'string', action: 'string', tool: 'string', target: 'path', outcome: 'string',
      err: 'excerpt',  // la firma normalizzata dell'errore (senza numeri, percorsi, testi tra virgolette)
      fail: 'string',  // che tipo di fallimento (test, build, comando…)
      cmd: 'excerpt',  // il cuore del comando ("npm test"), per la ricerca nell'archivio (S12b)
      phase: 'string', dur: 'number',
    },
    indexes: [['project', 't'], ['session', 't']],
    retention: { days: 90 },
  },
  sessions: {
    // _id: l'id della sessione; t: l'inizio
    fields: {
      end: 'number', kind: 'string', model: 'string', effort: 'string', agents: 'number',
      actions: 'number', errors: 'number', surprises: 'number', claims: 'number', loops: 'number', stale: 'number', lessons: 'number',
      stuck: 'number', flaky: 'number', // fasi bloccate e comandi instabili (S12)
      cost: 'number', tokens: 'number',
    },
    indexes: [['project', 't']],
    retention: { days: 365 },
  },
  feedback: {
    // _id: l'id del messaggio; t: quando è stato mandato (o sarebbe stato mandato, in ombra)
    fields: {
      sid: 'id', agent: 'string', name: 'string', feature: 'string', mode: 'string', event: 'string', lessonId: 'id', tag: 'string', toolUseId: 'id',
      text: 'note', local: 'note', // la frase di Platypus all'agente, in inglese e nella lingua dell'ufficio
      about: { kind: 'string', cmd: 'excerpt', pat: 'excerpt', file: 'path' },
      group: 'string',             // con l'esperimento (S11): il gruppo della sessione
      outcome: 'string', at: 'number', why: 'excerpt',
    },
    indexes: [['project', 't'], ['feature', 't'], 'sid'],
    retention: { days: 365 },
  },
  experiments: {
    // _id: "<sessione>:<funzione>"; t: quando è stato assegnato
    fields: { sid: 'id', feature: 'string', group: 'string' },
    indexes: [['feature', 't']],
    retention: { days: 365 },
  },
  daily: {
    // _id: "day:2026-11-19", "week:2026-W47", "last:<sessione>"; kind dice quale dei tre
    fields: {
      kind: 'string', day: 'string', week: 'string',
      // per giorno: i progetti per nome (come nel report) e i rilasci
      projects: { '*': { cost: 'number', tokens: 'number', completed: 'number', commits: 'number', prs: 'number', tests: 'number', sessions: ['id'], wing: 'string' } },
      releases: [{ t: 'number', kind: 'string', text: 'excerpt', url: 'excerpt', agent: 'string', project: 'string' }],
      alerts: 'number',
      // per settimana: i premi per tipo di agente
      types: { '*': { completed: 'number', errors: 'number', tools: 'number', cost: 'number' } },
      // per sessione: l'ultimo stato visto, per sommare solo le differenze
      last: { cost: 'number', tok: 'number', completed: 'number', cbt: NUM, err: NUM, tools: NUM, costType: NUM, rel: 'string', alerts: ['string'], name: 'string' },
    },
    indexes: ['kind'],
    retention: null,
  },
};
const NAMES = Object.keys(COLLECTIONS);

// i giorni di conservazione di ogni collezione: quelli scritti qui, o quelli scelti nelle opzioni
// ({ steps: 30, sessions: 0, … }: 0 o null = per sempre). Un valore che non ha senso è un errore.
function retentionOf(name, overrides) {
  const base = COLLECTIONS[name].retention;
  if (!overrides || !(name in overrides)) return base ? { ...base } : null;
  const v = overrides[name];
  if (v === null || v === 0) return null;
  if (!Number.isInteger(v) || v < 1 || v > 3650) fail('invalid-argument', `conservazione di ${name}: un numero intero di giorni tra 1 e 3650, oppure 0 per sempre (ricevuto ${JSON.stringify(v)})`);
  return { ...(base || {}), days: v };
}

// dichiara tutte le collezioni nello store. options.retention: i giorni scelti nelle opzioni, per collezione
function declareCollections(store, options = {}) {
  const overrides = options.retention;
  if (overrides !== undefined && overrides !== null) {
    if (!isPlain(overrides)) fail('invalid-argument', 'retention deve essere un oggetto { collezione: giorni }');
    for (const k of Object.keys(overrides)) if (!COLLECTIONS[k]) fail('invalid-argument', `conservazione: collezione sconosciuta ${JSON.stringify(k)}`);
  }
  for (const name of NAMES) {
    const c = COLLECTIONS[name];
    store.declare(name, { fields: c.fields, indexes: c.indexes, retention: retentionOf(name, overrides), projectField: c.projectField || 'project' });
  }
  return store;
}
// per le opzioni (S10): { nome: giorni di partenza, o 0 se per sempre }
function defaultRetention() {
  return Object.fromEntries(NAMES.map(n => [n, COLLECTIONS[n].retention ? COLLECTIONS[n].retention.days : 0]));
}

module.exports = { COLLECTIONS, NAMES, DAY, declareCollections, retentionOf, defaultRetention };
