'use strict';
// Versione dello schema del database e migrazioni (S4 di docs/plans/2.13-storage.md).
// La tabella `meta` (key, value) tiene `schemaVersion`. Le tabelle delle collezioni le crea store.declare e non
// passano di qui: una migrazione serve quando cambia qualcosa che declare non sa fare da solo (una colonna in
// più, dati da spostare).
// Per aggiungerne una: una voce in fondo a MIGRATIONS con il numero successivo. Mai cambiare una già rilasciata.
//
// All'avvio (migrate):
//   1. se il database è già alla versione giusta, niente;
//   2. se è di una versione più nuova di questo Platypus, non lo si tocca (errore 'newer-schema');
//   3. altrimenti prima una copia, platypus.db.bak-<versione di partenza>, con VACUUM INTO (si tengono le ultime
//      due), poi tutte le migrazioni che mancano in una transazione sola, BEGIN IMMEDIATE: se due Platypus
//      partono insieme, il secondo aspetta e poi trova il lavoro già fatto. Se una fallisce, tutto torna com'era.

const fs = require('fs');
const path = require('path');
const { fail } = require('./common');

const MIGRATIONS = [
  { version: 1, name: 'tabella meta', up() {} }, // la tabella la crea ensureMeta: qui si segna solo la versione
];
const KEEP_BACKUPS = 2;

function ensureMeta(db) { db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)'); }
function hasMeta(db) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get(); }
function getMeta(db, key) {
  if (!hasMeta(db)) return null;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
function schemaVersion(db) { return parseInt(getMeta(db, 'schemaVersion'), 10) || 0; }

function checkList(list) {
  list.forEach((m, i) => {
    if (!m || m.version !== i + 1 || typeof m.up !== 'function') fail('invalid-argument', `migrazioni: la numero ${i + 1} deve avere version ${i + 1} e una funzione up`);
  });
  return list;
}

// le copie fatte prima delle migrazioni, dalla più recente
function backups(file) {
  const dir = path.dirname(file), base = path.basename(file) + '.bak-';
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.startsWith(base)); } catch {}
  return names.map(n => { const p = path.join(dir, n); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch {} return { file: p, version: parseInt(n.slice(base.length), 10) || 0, mtime: m }; })
    .sort((a, b) => b.mtime - a.mtime || b.version - a.version);
}
function backup(db, file, version) {
  const target = `${file}.bak-${version}`;
  fs.rmSync(target, { force: true });
  db.prepare('VACUUM INTO ?').run(target);
  for (const old of backups(file).slice(KEEP_BACKUPS)) fs.rmSync(old.file, { force: true });
  return target;
}

// porta il database all'ultima versione; restituisce { from, to, backup }
function migrate(db, file, list = MIGRATIONS) {
  checkList(list);
  const latest = list.length;
  const from = schemaVersion(db);
  if (from > latest) fail('newer-schema', `il database è alla versione ${from}, questo Platypus arriva alla ${latest}`);
  if (from === latest) return { from, to: latest, backup: null };
  // la copia va fatta fuori dalla transazione (VACUUM non può starci dentro). Un database appena nato non ha niente da salvare
  let saved = null;
  if (from > 0) {
    try { saved = backup(db, file, from); }
    catch (e) { fail('migration-failed', `non riesco a fare la copia prima dell'aggiornamento: ${e.message}`); }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureMeta(db);
    const now = schemaVersion(db); // nel frattempo può averlo aggiornato un altro Platypus
    if (now > latest) fail('newer-schema', `il database è alla versione ${now}, questo Platypus arriva alla ${latest}`);
    for (const m of list.slice(now)) { m.up(db); setMeta(db, 'schemaVersion', m.version); }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    if (e && e.code === 'newer-schema') throw e;
    fail('migration-failed', `aggiornamento del database dalla versione ${from} alla ${latest} non riuscito: ${e && e.message || e}`);
  }
  return { from, to: latest, backup: saved };
}

module.exports = { MIGRATIONS, KEEP_BACKUPS, migrate, schemaVersion, getMeta, setMeta, ensureMeta, backups };
