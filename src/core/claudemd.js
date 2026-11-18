'use strict';
// Scrive la sezione di Platypus (il Libro di bottega) nel CLAUDE.md di un progetto, tra due marcatori.
// Solo la scrittura, e prudente: fuori dai marcatori il file resta identico byte per byte
// (fine riga, BOM e tutto il resto), prima di scrivere si salva una copia CLAUDE.md.platypus-backup,
// si scrive in modo atomico (file temporaneo nella stessa cartella, poi rename) e mai fuori da quella cartella.
// Se i marcatori sono rovinati non si scrive niente: decide l'utente.
// Il testo della sezione e l'interfaccia stanno altrove.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKERS = { start: '<!-- platypus:bottega:start -->', end: '<!-- platypus:bottega:end -->' };
const BOM = '\uFEFF';
const BACKUP_EXT = '.platypus-backup';
const NAME = /^claude\.md$/i;

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// un marcatore conta solo se sta da solo sulla sua riga (spazi ammessi); il \r di un CRLF resta fuori
const onLine = m => new RegExp('^[ \\t]*' + esc(m) + '[ \\t]*(?=\\r?$)', 'gm');
const count = (s, sub) => { let n = 0, i = 0; while ((i = s.indexOf(sub, i)) >= 0) { n++; i += sub.length; } return n; };

// la fine riga del file: quella più usata (a pari merito o senza righe, LF)
function eolOf(s) {
  const crlf = count(s, '\r\n'), lf = count(s, '\n') - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

// funzione pura sulle stringhe: {text, mode: 'replace'|'append'} oppure {error: 'markers'|'section'}
function planUpsert(text, section) {
  let s = String(text == null ? '' : text);
  const bom = s.startsWith(BOM) ? BOM : '';
  if (bom) s = s.slice(1);
  const eol = eolOf(s);
  let body = String(section == null ? '' : section).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  // una sezione che contiene i marcatori rovinerebbe il file alla prossima scrittura
  if (body.includes(MARKERS.start) || body.includes(MARKERS.end)) return { error: 'section' };
  body = body.split('\n').join(eol);
  const inner = body ? eol + body + eol : eol;

  const starts = [...s.matchAll(onLine(MARKERS.start))], ends = [...s.matchAll(onLine(MARKERS.end))];
  // un marcatore citato in mezzo a una riga è ambiguo: meglio non toccare niente
  if (starts.length !== count(s, MARKERS.start) || ends.length !== count(s, MARKERS.end)) return { error: 'markers' };
  if (starts.length === 1 && ends.length === 1) {
    const a = starts[0], b = ends[0];
    if (b.index < a.index) return { error: 'markers' };
    // si sostituisce solo quello che sta tra la fine della riga di apertura e l'inizio della riga di chiusura
    return { text: bom + s.slice(0, a.index + a[0].length) + inner + s.slice(b.index), mode: 'replace' };
  }
  if (starts.length || ends.length) return { error: 'markers' };

  // in fondo, separata da una riga vuota; le righe vuote già presenti in fondo si tengono
  const block = MARKERS.start + inner + MARKERS.end + eol;
  if (!s) return { text: bom + block, mode: 'append' };
  const tail = (s.match(/(?:\r?\n)+$/) || [''])[0];
  const nl = count(tail, '\n');
  return { text: bom + s + eol.repeat(Math.max(0, 2 - nl)) + block, mode: 'append' };
}

// la cartella c'è e si può scrivere? (e il CLAUDE.md, se c'è, si può sovrascrivere?)
// reason: 'missing' | 'notdir' | 'readonly' | 'notfile' | 'symlink' | '' se ok
function canWrite(dir) {
  if (!dir || typeof dir !== 'string') return { ok: false, reason: 'missing' };
  let st;
  try { st = fs.statSync(dir); } catch { return { ok: false, reason: 'missing' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'notdir' };
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { return { ok: false, reason: 'readonly' }; }
  const file = path.join(dir, 'CLAUDE.md');
  let lst = null;
  try { lst = fs.lstatSync(file); } catch (e) { if (!e || e.code !== 'ENOENT') return { ok: false, reason: 'readonly' }; }
  if (lst) {
    // un collegamento (es. CLAUDE.md -> AGENTS.md) si spezzerebbe con il rename: non si tocca
    if (lst.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!lst.isFile()) return { ok: false, reason: 'notfile' };
    try { fs.accessSync(file, fs.constants.W_OK); } catch { return { ok: false, reason: 'readonly' }; }
  }
  return { ok: true, reason: '' };
}

// scrive dati in dest passando da un file temporaneo nella stessa cartella (mai seguendo collegamenti)
function atomicWrite(dest, data, mode) {
  const tmp = path.join(path.dirname(dest), '.' + path.basename(dest) + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, data, 0, data.length, 0);
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd); fd = null;
    if (mode != null && process.platform !== 'win32') { try { fs.chmodSync(tmp, mode & 0o777); } catch {} }
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// {ok, mode: 'replace'|'append'|null, backup: percorso|null, error: codice|null}
function upsertSection(filePath, section) {
  const fail = error => ({ ok: false, mode: null, backup: null, error });
  if (!filePath || typeof filePath !== 'string') return fail('missing');
  const file = path.resolve(filePath), dir = path.dirname(file);
  if (!NAME.test(path.basename(file))) return fail('name');
  const cw = canWrite(dir);
  if (!cw.ok) return fail(cw.reason);
  // canWrite guarda "CLAUDE.md": ricontrolla il nome vero (su Linux potrebbe essere claude.md)
  let lst = null;
  try { lst = fs.lstatSync(file); } catch (e) { if (!e || e.code !== 'ENOENT') return fail('readonly'); }
  if (lst && lst.isSymbolicLink()) return fail('symlink');
  if (lst && !lst.isFile()) return fail('notfile');

  let buf = null;
  if (lst) {
    try { buf = fs.readFileSync(file); } catch { return fail('read'); }
  }
  const text = buf ? buf.toString('utf8') : '';
  // se il file non è UTF-8 valido, riscriverlo cambierebbe anche quello che sta fuori dai marcatori
  if (buf && !Buffer.from(text, 'utf8').equals(buf)) return fail('encoding');
  const plan = planUpsert(text, section);
  if (plan.error) return fail(plan.error);

  let backup = null;
  try {
    if (buf) { backup = file + BACKUP_EXT; atomicWrite(backup, buf, lst.mode); }
    atomicWrite(file, Buffer.from(plan.text, 'utf8'), lst ? lst.mode : null);
  } catch { return { ok: false, mode: null, backup, error: 'write' }; }
  return { ok: true, mode: plan.mode, backup, error: null };
}

// il CLAUDE.md di quella cartella ha già la sezione di Platypus? Una lettura sola, tenuta finché il file non cambia
// (serve al feedback: le lezioni già scritte lì non si ripetono all'agente a inizio sessione)
const sectionCache = new Map(); // cartella -> { sig, has }
function hasSection(dir) {
  try {
    const p = path.join(String(dir || ''), 'CLAUDE.md');
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return false;
    const sig = st.mtimeMs + ':' + st.size, c = sectionCache.get(p);
    if (c && c.sig === sig) return c.has;
    const has = fs.readFileSync(p, 'utf8').includes(MARKERS.start);
    if (sectionCache.size > 200) sectionCache.clear();
    sectionCache.set(p, { sig, has });
    return has;
  } catch { return false; }
}

module.exports = { MARKERS, BACKUP_EXT, canWrite, planUpsert, upsertSection, hasSection };
