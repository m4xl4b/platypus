// La regola della deriva dalla stella polare, scritta una volta sola: la usano il motore (semantic.drift, e quindi il
// feedback "ritorno al compito") e la mappa (renderer/worldmap.js, che la riceve da /drift-rule.js).
// Funziona sia con require (Node) sia come script nella pagina (window.PlatypusDrift).
//
// Le soglie dipendono dalla fonte dei vettori: i vettori neurali hanno somiglianze di base molto più alte del TF-IDF.
// Si misurano con scripts/embed-eval.js; i risultati sono in docs/plans/embedding-calibration.md.
//   rel    allineamento (media delle ultime 6 / base) sotto il quale un'azione conta come lontana
//   run    quante azioni lontane di fila, sullo stesso compito, fanno "alla deriva"
//   weak   base sotto la quale non si può giudicare (le parole del compito non compaiono nel lavoro)
//   warn   sotto questo allineamento "si allontana" (la fascia gialla della mappa)
//   floor  il minimo della base (in alignment)
//   zero   la somiglianza tipica di due testi che non c'entrano: i punteggi si riscalano da lì ((s - zero) / (1 - zero))
//   widen  il punteggio minimo perché una delle prime azioni allarghi il compito (in alignment); con il TF-IDF basta > 0
// Una fonte neurale senza misure non giudica: risulta "non misurabile" (non calibrata), mai una deriva inventata.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlatypusDrift = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TFIDF = Object.freeze({ rel: 0.35, run: 6, weak: 0.031, warn: 0.6, floor: 0.03, zero: 0, widen: 0, calibrated: true });
  // una riga per fonte misurata (chiave: la fonte senza ":latest")
  const TABLE = Object.freeze({
    tfidf: TFIDF,
    // il provider finto della demo (embed/fake.js): un dizionario di sinonimi, non un modello; misurato il 2026-11-18
    'fake:synonyms': Object.freeze({ rel: 0.53, run: 6, weak: 0.309, warn: 0.78, floor: 0.03, zero: 0.621, widen: 0.381, calibrated: true }),
    // modelli veri di Ollama, misurati il 2026-11-18 con scripts/embed-eval.js (docs/plans/embedding-calibration.md);
    // nomic-embed-text:v1.5 non batte il TF-IDF e resta senza riga (non calibrato)
    'ollama:qwen3-embedding:0.6b': Object.freeze({ rel: 0.62, run: 6, weak: 0.299, warn: 0.87, floor: 0.03, zero: 0.348, widen: 0.277, calibrated: true }),
    'ollama:qwen3-embedding:4b': Object.freeze({ rel: 0.62, run: 6, weak: 0.325, warn: 0.87, floor: 0.03, zero: 0.404, widen: 0.34, calibrated: true }),
    'ollama:embeddinggemma-2:570m': Object.freeze({ rel: 0.68, run: 6, weak: 0.278, warn: 0.93, floor: 0.03, zero: 0.62, widen: 0.167, calibrated: true }),
    'ollama:snowflake-arctic-embed2': Object.freeze({ rel: 0.62, run: 6, weak: 0.222, warn: 0.87, floor: 0.03, zero: 0.24, widen: 0.174, calibrated: true }),
    'ollama:nomic-embed-text-v2-moe': Object.freeze({ rel: 0.78, run: 6, weak: 0.227, warn: 0.95, floor: 0.03, zero: 0.218, widen: 0.04, calibrated: true }),
    'ollama:bge-m3': Object.freeze({ rel: 0.66, run: 6, weak: 0.186, warn: 0.91, floor: 0.03, zero: 0.399, widen: 0.14, calibrated: true }),
  });
  const UNCALIBRATED = Object.freeze({ ...TFIDF, calibrated: false });

  function thresholdsFor(src) {
    if (!src || src === 'tfidf') return TFIDF;
    const s = String(src);
    return TABLE[s] || TABLE[s.replace(/:latest$/, '')] || UNCALIBRATED;
  }

  // rows: le righe di alignment(), [t, punteggio, media delle ultime 6, base, indice del compito, etichetta, errore]
  function judge(rows, th) {
    const T = th || TFIDF;
    if (!rows || !rows.length) return null;
    const last = rows[rows.length - 1], gi = last[4];
    let run = 0;
    for (let i = rows.length - 1; i >= 0 && rows[i][4] === gi && rows[i][2] / rows[i][3] < T.rel; i--) run++;
    const rel = last[2] / last[3];
    const uncalibrated = T.calibrated === false;
    const weak = uncalibrated || last[3] <= T.weak;
    const drifting = !weak && run >= T.run;
    return { run, rel: +rel.toFixed(3), weak, uncalibrated, drifting, state: weak ? 'weak' : drifting ? 'drifting' : rel < T.warn ? 'leaving' : 'on' };
  }

  return { TFIDF, TABLE, thresholdsFor, judge };
});
