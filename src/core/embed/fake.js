'use strict';
// Provider "finto" per la demo (embedEngine = 'fake', nascosto): un piccolo dizionario di concetti che tratta i
// sinonimi come la stessa cosa ("login", "accesso", "autenticazione", "credentials" → un solo concetto).
// Non è un modello: serve solo a far vedere nella demo, senza Ollama, perché i vettori neurali servono.
// Vale solo per le sessioni della demo; le sessioni vere restano sulla fonte scelta o sul TF-IDF.
// Come i modelli veri, ha una somiglianza "di fondo" tra testi che non c'entrano (BIAS), calibrata in drift-rule.js.

const ID = 'fake:synonyms';
const DIM = 96;
const BIAS = 0.6; // una componente comune a tutti i testi: il "fondo" dei modelli neurali

// radice (5 lettere, come semantic.js) → concetto
const CONCEPTS = {
  auth: 'login logon signi sign acces acced auten authe auth crede passw otp totp 2fa ident ident autor logou',
  bill: 'fattu invoi iva vat tax tasse arrot round total total valut curre prezz price pagam payme impor amoun cent',
  stock: 'magaz wareh stock lotto lotti lot batch parti giace inven scort reord picki',
  ship: 'spedi ship parce pacco track corri carri conse deliv',
  ui: 'tema theme color colou css sideb barra later menu butto pulsa layou scuro dark palet style stile icon icona mobil respo telef phone scher scree tap toggl navig sinis',
  docs: 'polic docum docs iso audit backu copie runbo proce regol rules incid postm escal',
  db: 'datab db tabel table migra schem sql postg mysql colon colum index indic query',
  ci: 'ci pipel workf build relea tag windo matri yml',
  i18n: 'tradu trans lingu langu i18n ingle engli germa tedes deuts',
  mail: 'mail email notif conte confi messa avvis',
  search: 'cerca searc ricer catal fullt rank trigr typo',
  log: 'log logs logge rotaz rotat',
  perf: 'lento lenta slow veloc fast perfo memor heap bench strea expla',
};
const OF = new Map();
for (const [c, words] of Object.entries(CONCEPTS)) for (const w of words.split(' ')) OF.set(w, c);

function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function vector(text) {
  const v = new Float32Array(DIM);
  const words = String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  for (const w of words) {
    const k = w.length > 5 ? w.slice(0, 5) : w;
    const c = OF.get(k);
    if (c) v[1 + (fnv('c:' + c) % (DIM - 1))] += 3; // il concetto pesa più della parola
    else v[1 + (fnv(k) % (DIM - 1))] += 0.4;
  }
  let n = 0; for (let i = 1; i < DIM; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1;
  for (let i = 1; i < DIM; i++) v[i] = (v[i] / n) * Math.sqrt(1 - BIAS);
  v[0] = Math.sqrt(BIAS);
  return v;
}

function create() {
  return { id: ID, dim: DIM, state: 'ready', model: 'synonyms', detail: '', hint: '', ready: async () => true, check: async () => true, embed: async texts => texts.map(vector) };
}

module.exports = { create, vector, ID, DIM };
