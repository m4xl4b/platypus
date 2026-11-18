// Che cosa dice il nome di un modello: famiglia, versione, contesto da 1M, e quindi l'età del personaggio.
// Scritto una volta sola: lo usano il motore (la stima del contesto in worldmap.js) e la pagina (età, bolla, scheda),
// che lo riceve da /models.js. Funziona sia con require (Node) sia come script nella pagina (window.PlatypusModels).
//
// Nomi che si incontrano:
//   claude-3-5-sonnet-20241022          versione prima della famiglia (vecchio schema)
//   claude-sonnet-4-5-20250929          famiglia, poi versione (schema attuale), con o senza data
//   claude-opus-4-8[1m]                 il suffisso [1m]: la stessa versione con il contesto da 1M token
//   claude-fable-5, claude-mythos-5-2   famiglie nuove (o che non conosciamo): valgono le stesse regole
//   claude-2-1, claude-instant-1-2      modelli vecchi senza una famiglia di oggi
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlatypusModels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // la versione più recente conosciuta per famiglia: le versioni di famiglie diverse non si confrontano (Fable 5.2
  // è più nuova di Opus 4.8, anche se 5.2 < 5.5). Se ne arrivano di più nuove, si aggiornano da sole (newest).
  const NEWEST_KNOWN = Object.freeze({ opus: 5.5, sonnet: 5.5, haiku: 5.5, fable: 5.2 });
  // per una famiglia che non conosciamo: la più recente di tutte, così un modello nuovo resta giovane
  const NEWEST_ANY = 5.5;
  const FAMILY_NAME = Object.freeze({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' });
  const CTX = 200000, CTX_1M = 1000000;
  // età: 0 giovane · 1 maturo · 2 anziano · 3 vecchietto (distanza dalla versione più recente della stessa famiglia)
  const AGE_GAPS = Object.freeze([0.3, 0.8, 1.5]);

  const cache = new Map();
  function info(id) {
    if (!id) return null;
    const key = String(id);
    if (cache.has(key)) return cache.get(key);
    const raw = key.toLowerCase();
    const ctx1m = /\[1m\]/.test(raw);
    const m = raw.replace(/\[[^\]]*\]/g, '');
    let fam = null, ver = null, r;
    const v = (a, b) => Number(a) + (b ? Number(b) / 10 : 0);
    if ((r = /claude-(\d+)(?:-(\d))?-([a-z]+)/.exec(m))) { fam = r[3]; ver = v(r[1], r[2]); }                    // claude-3-5-sonnet
    else if ((r = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(m))) { fam = r[1]; ver = v(r[2], r[3]); }  // claude-sonnet-4-5, claude-fable-5
    else if ((r = /claude-(\d+)(?:-(\d))?(?![\d-])/.exec(m))) { ver = v(r[1], r[2]); }                         // claude-2-1
    else if ((r = /(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/.exec(m))) { fam = r[1]; ver = r[2] ? v(r[2], r[3]) : null; }
    const name = fam ? (FAMILY_NAME[fam] || fam.charAt(0).toUpperCase() + fam.slice(1)) : ver != null ? 'Claude' : null;
    // name: la famiglia da mostrare; rest: il nome senza "claude-" quando la famiglia non si riconosce. La pagina
    // compone l'etichetta con la sua virgola dei decimali; label è la stessa con il punto (per il motore e le prove)
    const rest = key.replace(/^claude-/i, '').replace(/\[1m\]/i, '');
    const out = Object.freeze({
      id: key, fam, ver, ctx1m, name, rest, known: !!(fam && FAMILY_NAME[fam]),
      label: (name ? name + (ver != null ? ' ' + String(ver) : '') : rest) + (ctx1m ? ' · 1M' : ''),
    });
    if (cache.size > 500) cache.clear();
    cache.set(key, out);
    return out;
  }

  // la finestra di contesto: 1M con il suffisso [1m]; altrimenti 200k, finché il contesto visto non lo supera
  // (una sessione da 1M senza il suffisso nel nome, per esempio un modello che ce l'ha di serie)
  function contextLimit(model, seen) {
    const i = info(model);
    if (i && i.ctx1m) return CTX_1M;
    return (Number(seen) || 0) > CTX ? CTX_1M : CTX;
  }

  // la versione più recente vista per famiglia, a partire da quelle conosciute: { fam: ver, '*': la più alta }
  function newest(models) {
    const out = { ...NEWEST_KNOWN, '*': NEWEST_ANY };
    for (const id of models || []) {
      const i = info(id);
      if (!i || i.ver == null) continue;
      const k = i.fam || '*';
      if (!(out[k] >= i.ver)) out[k] = i.ver;
      if (i.ver > out['*']) out['*'] = i.ver;
    }
    return out;
  }

  // l'età del personaggio. Senza una versione nel nome non si può dire quanto è vecchio: giovane (di solito è un
  // modello nuovo, con un nome che non conosciamo ancora)
  function ageTier(model, seen) {
    const i = info(model);
    if (!i || i.ver == null) return 0;
    const top = seen || newest();
    // una famiglia conosciuta si confronta con sé stessa; una sconosciuta con la versione più recente di tutte
    // (altrimenti claude-instant-1-2, visto da solo, sarebbe "la più recente" della sua famiglia, e giovane)
    const ref = i.known && top[i.fam] != null ? top[i.fam] : (top['*'] != null ? top['*'] : NEWEST_ANY);
    const gap = Math.max(0, ref - i.ver);
    return gap <= AGE_GAPS[0] ? 0 : gap <= AGE_GAPS[1] ? 1 : gap <= AGE_GAPS[2] ? 2 : 3;
  }

  return { info, contextLimit, newest, ageTier, NEWEST_KNOWN, NEWEST_ANY, FAMILY_NAME, CTX, CTX_1M };
});
