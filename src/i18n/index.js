'use strict';
// Traduzioni di Platypus.
// L'italiano è la lingua di partenza: la chiave di ogni testo è il testo italiano stesso
// (come in gettext). Le altre lingue stanno in locales/<lingua>/*.json come { "testo italiano": "traduzione" }.
// Segnaposto: {nome}. Plurali: trn('{n} agente', '{n} agenti', n). Nel codice si usano tr()/trn()
// (alias di t/tn) perché "t" è spesso il nome della variabile del tempo.
// Per aggiungere una lingua: copia locales/en in locales/<codice>, traduci i valori,
// aggiungi la lingua a LANGS qui sotto. `npm run i18n:check` dice cosa manca.

const fs = require('fs');
const path = require('path');

const LANGS = { it: 'Italiano', en: 'English' };
const LOCALE_TAG = { it: 'it-IT', en: 'en-GB' };
const DIR = path.join(__dirname, 'locales');

const cache = new Map();
function dict(lang) {
  if (!lang || lang === 'it') return {};
  if (cache.has(lang)) return cache.get(lang);
  const out = {};
  try {
    for (const f of fs.readdirSync(path.join(DIR, lang)).sort()) {
      if (!f.endsWith('.json')) continue;
      try { Object.assign(out, JSON.parse(fs.readFileSync(path.join(DIR, lang, f), 'utf8'))); } catch (e) { console.error('[i18n] ' + lang + '/' + f + ': ' + e.message); }
    }
  } catch {}
  cache.set(lang, out);
  return out;
}

let current = 'it';
let currentDict = {};

// "auto" segue la lingua del sistema; se non è tra quelle disponibili si usa l'inglese
function resolveLang(setting, osLocale) {
  if (setting && setting !== 'auto' && LANGS[setting]) return setting;
  const sys = String(osLocale || (Intl.DateTimeFormat().resolvedOptions().locale) || process.env.LANG || 'en').toLowerCase();
  const base = sys.split(/[-_.]/)[0];
  return LANGS[base] ? base : 'en';
}

function setLang(lang) {
  current = LANGS[lang] ? lang : 'it';
  currentDict = dict(current);
  return current;
}
function getLang() { return current; }
// esegue fn con i testi in una lingua precisa, poi rimette quella di prima (es. i messaggi agli agenti, sempre in inglese)
function withLang(lang, fn) {
  const prev = current;
  setLang(lang);
  try { return fn(); } finally { setLang(prev); }
}
function localeTag(lang = current) { return LOCALE_TAG[lang] || 'en-GB'; }

function fill(s, p) {
  if (!p) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (p[k] !== undefined && p[k] !== null ? String(p[k]) : m));
}
function t(s, p) {
  const v = currentDict[s];
  return fill(typeof v === 'string' && v ? v : s, p);
}
function tn(one, many, n, p) { return t(n === 1 ? one : many, { n, ...(p || {}) }); }

// numeri e soldi nel formato della lingua: 5,34 $ in italiano, $5.34 in inglese
function money(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  const s = Number(v).toFixed(digits);
  return current === 'it' ? s.replace('.', ',') + ' $' : '$' + s;
}

module.exports = { LANGS, t, tn, tr: t, trn: tn, setLang, getLang, withLang, resolveLang, dict, localeTag, money, fill };
