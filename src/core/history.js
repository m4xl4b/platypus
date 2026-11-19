'use strict';
// Lo storico del motore: lo store (src/core/store) aperto sulla cartella dei dati, con le sue collezioni, la
// chiave dei progetti e il passaggio dei dati della 2.12. È l'unico punto in cui il motore tocca lo store:
// statistiche, Libro e registro dei messaggi lo ricevono da qui.
//
// Non ferma mai l'ufficio: se il database non si apre, lo store è in memoria (lo storico non resta) e
// notice() dà la frase da mostrare. La demo non passa mai di qui: ha i suoi dati finti in memoria.

const { openStoreSafe, fallbackReason } = require('./store');
const { declareCollections } = require('./store/collections');
const { ProjectKeys } = require('./store/project-key');
const { importLegacy } = require('./store/legacy');

class History {
  // dir: la cartella dei dati (dove sta platypus.db); settings: le opzioni vive del motore
  constructor({ dir, settings = {}, backend, clock = Date.now, log = msg => console.error('[platypus] ' + msg) } = {}) {
    this.dir = dir;
    this.log = log;
    this.clock = clock;
    this.store = openStoreSafe({ backend: backend || process.env.PLATYPUS_STORE_BACKEND || 'sqlite', dir, requireFields: true, clock, onGuard: m => log('store: ' + m), onError: e => log('store: ' + (e && e.message || e)) });
    // la conservazione scelta nelle opzioni; se non ha senso valgono i tempi di partenza
    try { declareCollections(this.store, { retention: settings.storeRetention || undefined }); }
    catch (e) { log('store: ' + e.message); declareCollections(this.store); }
    this.keys = new ProjectKeys({ store: this.store, clock });
    this.imported = null; // che cosa ha fatto il passaggio dei dati di prima (per le prove e per il registro)
    if (this.store.fallback) log('store: ' + this.store.fallback.code + ': ' + this.store.fallback.detail);
  }

  // dopo che il server è partito: porta nello store i dati della 2.12, se non è già stato fatto
  async start() {
    if (this.store.fallback) return null; // in memoria non resterebbero: si riprova al prossimo avvio
    try { this.imported = await importLegacy(this.store, this.dir, { keys: this.keys, clock: this.clock }); }
    catch (e) { this.imported = { done: false, error: e.message }; this.log('store: i dati di prima non sono entrati nello storico, riprovo al prossimo avvio (' + e.message + ')'); }
    return this.imported;
  }

  // la frase per l'avviso nell'ufficio («storico non disponibile: …»), o '' se va tutto bene
  notice() { return fallbackReason(this.store.fallback); }
  // per /api/state: quale backend e l'eventuale avviso
  info() { return { backend: this.store.backend, notice: this.notice() }; }

  stop() { try { this.store.close(); } catch (e) { this.log('store: ' + e.message); } }
}

module.exports = { History };
