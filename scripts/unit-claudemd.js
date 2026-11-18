#!/usr/bin/env node
'use strict';
// Prove dello scrittore della sezione di Platypus nel CLAUDE.md (src/core/claudemd.js).
// Solo cartelle temporanee: non scrive mai il CLAUDE.md di un progetto vero.
// Si possono lanciare da sole o richiamare con run(ok), come unit-test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cm = require(path.join(ROOT, 'src', 'core', 'claudemd'));
const { MARKERS } = cm;
const S = MARKERS.start, E = MARKERS.end;
const BOMB = Buffer.from([0xef, 0xbb, 0xbf]);

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-claudemd-'));
  try { fn(dir); } finally {
    // un file in sola lettura su Windows blocca la cancellazione: prima si rimette scrivibile
    try { for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o666); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const files = dir => fs.readdirSync(dir).sort();

function planTests(ok) {
  // nuovo testo, accodamento con LF
  {
    const r = cm.planUpsert('# Progetto\n\nRegole.\n', 'Lezione uno.\nLezione due.');
    ok(r.mode === 'append' && r.text === `# Progetto\n\nRegole.\n\n${S}\nLezione uno.\nLezione due.\n${E}\n`, 'accodata in fondo, separata da una riga vuota (LF)');
    const r2 = cm.planUpsert('', 'x');
    ok(r2.mode === 'append' && r2.text === `${S}\nx\n${E}\n`, 'testo vuoto: solo il blocco');
  }
  // CRLF: il blocco usa CRLF, anche se la sezione arriva con LF
  {
    const r = cm.planUpsert('# P\r\nRiga\r\n', 'a\nb');
    ok(r.text === `# P\r\nRiga\r\n\r\n${S}\r\na\r\nb\r\n${E}\r\n`, 'file CRLF: il blocco inserito usa CRLF');
    ok(!/[^\r]\n/.test(r.text), 'file CRLF: nessun LF solitario');
  }
  // BOM
  {
    const r = cm.planUpsert('\uFEFF# P\n', 'x');
    ok(r.text.startsWith('\uFEFF# P\n') && r.text.indexOf('\uFEFF', 1) < 0, 'BOM conservato, una volta sola');
  }
  // senza a capo finale: se ne aggiungono solo quanti servono
  {
    ok(cm.planUpsert('# P', 'x').text === `# P\n\n${S}\nx\n${E}\n`, 'senza a capo finale: aggiunta la riga vuota di separazione');
    ok(cm.planUpsert('# P\n\n\n', 'x').text === `# P\n\n\n${S}\nx\n${E}\n`, 'righe vuote già in fondo: non si toccano e non se ne aggiungono');
  }
  // sostituzione e idempotenza
  {
    const before = `# P\n\n${S}\nvecchio\n${E}\n\nDopo.\n`;
    const r = cm.planUpsert(before, 'nuovo');
    ok(r.mode === 'replace' && r.text === `# P\n\n${S}\nnuovo\n${E}\n\nDopo.\n`, 'sezione esistente sostituita, marcatori tenuti');
    ok(cm.planUpsert(r.text, 'nuovo').text === r.text, 'sostituire due volte dà lo stesso risultato');
    const ind = cm.planUpsert(`a\n  ${S}  \nb\n\t${E}\nc`, 'z');
    ok(ind.mode === 'replace' && ind.text === `a\n  ${S}  \nz\n\t${E}\nc`, 'marcatori con spazi intorno: le loro righe restano com\'erano');
    ok(cm.planUpsert(`a\n${S}\nb\n${E}\n`, '').text === `a\n${S}\n${E}\n`, 'sezione vuota: restano i due marcatori');
  }
  // marcatori rovinati
  const bad = [
    [`a\n${S}\nb\n`, 'solo l\'apertura'],
    [`a\n${E}\nb\n`, 'solo la chiusura'],
    [`a\n${E}\nb\n${S}\n`, 'chiusura prima dell\'apertura'],
    [`${S}\n1\n${E}\n${S}\n2\n${E}\n`, 'marcatori doppi'],
    [`a\n${S}\nb\n${E}\nNe parlo qui: ${S}\n`, 'marcatore citato in mezzo a una riga'],
  ];
  for (const [text, what] of bad) { const r = cm.planUpsert(text, 'x'); ok(r.error === 'markers' && r.text === undefined, 'marcatori rovinati: ' + what); }
  ok(cm.planUpsert('a\n', `x\n${E}`).error === 'section', 'una sezione che contiene un marcatore viene rifiutata');
}

function fileTests(ok) {
  // file nuovo: solo il blocco, nessuna copia
  withTmp(dir => {
    const f = path.join(dir, 'CLAUDE.md');
    const r = cm.upsertSection(f, 'Lezione.');
    ok(r.ok && r.mode === 'append' && r.backup === null && r.error === null, 'file nuovo: creato, nessuna copia');
    ok(fs.readFileSync(f, 'utf8') === `${S}\nLezione.\n${E}\n`, 'file nuovo: contiene solo il blocco');
    ok(JSON.stringify(files(dir)) === JSON.stringify(['CLAUDE.md']), 'nessun file temporaneo lasciato in giro');
  });

  // accodamento: tutto quello che c'era resta identico byte per byte, e la copia è il contenuto di prima
  const cases = [
    ['LF', Buffer.from('# Regole\n\n- usa `npm test`\n- àèìòù €\n')],
    ['CRLF', Buffer.from('# Regole\r\n\r\n- usa `npm test`\r\n')],
    ['BOM', Buffer.concat([BOMB, Buffer.from('# Regole\r\nriga\r\n')])],
    ['senza a capo finale', Buffer.from('# Regole\n\nultima riga')],
  ];
  for (const [what, before] of cases) withTmp(dir => {
    const f = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(f, before);
    const r = cm.upsertSection(f, 'Il test e2e è instabile: rilancialo una volta.\nSecondo punto.');
    const after = fs.readFileSync(f);
    const crlf = before.includes('\r\n');
    ok(r.ok && r.mode === 'append', `accodamento (${what})`);
    ok(after.subarray(0, before.length).equals(before), `accodamento (${what}): il contenuto di prima è intatto byte per byte`);
    ok(r.backup === f + '.platypus-backup' && fs.readFileSync(r.backup).equals(before), `accodamento (${what}): la copia è il contenuto di prima`);
    const added = after.subarray(before.length).toString('utf8');
    ok(crlf ? !/[^\r]\n/.test(added) && added.includes('\r\n') : !added.includes('\r'), `accodamento (${what}): fine riga del file rispettata`);
    if (what === 'BOM') ok(after.subarray(0, 3).equals(BOMB) && after.indexOf(BOMB, 3) < 0, 'accodamento (BOM): BOM conservato una volta sola');
  });

  // sostituzione: fuori dai marcatori identico byte per byte, idempotente, copia aggiornata
  withTmp(dir => {
    const f = path.join(dir, 'CLAUDE.md');
    const pre = Buffer.concat([BOMB, Buffer.from(`# Progetto\r\n\r\nPrima.  \r\n${S}\r\n`)]);
    const post = Buffer.from(`${E}\r\n\r\nDopo, con è e niente a capo`);
    const before = Buffer.concat([pre, Buffer.from('vecchia lezione\r\n'), post]);
    fs.writeFileSync(f, before);
    const r = cm.upsertSection(f, 'nuova lezione');
    const after = fs.readFileSync(f);
    ok(r.ok && r.mode === 'replace', 'sostituzione della sezione esistente');
    ok(after.subarray(0, pre.length).equals(pre) && after.subarray(after.length - post.length).equals(post), 'sostituzione: prima e dopo i marcatori identico byte per byte');
    ok(after.toString('utf8').includes(`${S}\r\nnuova lezione\r\n${E}`), 'sostituzione: la nuova sezione tra i marcatori, in CRLF');
    ok(fs.readFileSync(r.backup).equals(before), 'sostituzione: la copia è il contenuto di prima');
    const r2 = cm.upsertSection(f, 'nuova lezione');
    ok(r2.ok && r2.mode === 'replace' && fs.readFileSync(f).equals(after), 'sostituzione ripetuta: stesso file (idempotente)');
    ok(fs.readFileSync(r2.backup).equals(after), 'la copia vecchia viene sovrascritta');
    ok(JSON.stringify(files(dir)) === JSON.stringify(['CLAUDE.md', 'CLAUDE.md.platypus-backup']), 'solo il file e la sua copia nella cartella');
  });

  // marcatori rovinati: non si scrive niente, nemmeno la copia
  const bad = [
    ['solo l\'apertura', `a\n${S}\nb\n`],
    ['solo la chiusura', `a\n${E}\n`],
    ['al contrario', `${E}\nx\n${S}\n`],
    ['doppi', `${S}\n${E}\n${S}\n${E}\n`],
  ];
  for (const [what, text] of bad) withTmp(dir => {
    const f = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(f, text);
    const r = cm.upsertSection(f, 'x');
    ok(!r.ok && r.error === 'markers' && fs.readFileSync(f, 'utf8') === text && JSON.stringify(files(dir)) === '["CLAUDE.md"]', `marcatori rovinati (${what}): nessuna scrittura`);
  });

  // file non UTF-8: riscriverlo cambierebbe anche il resto
  withTmp(dir => {
    const f = path.join(dir, 'CLAUDE.md');
    const before = Buffer.from([0x23, 0x20, 0xe8, 0x0a]); // "# è" in Latin-1
    fs.writeFileSync(f, before);
    const r = cm.upsertSection(f, 'x');
    ok(!r.ok && r.error === 'encoding' && fs.readFileSync(f).equals(before), 'file non UTF-8: nessuna scrittura');
  });

  // solo dentro la cartella del file, e solo un CLAUDE.md
  withTmp(dir => {
    const r = cm.upsertSection(path.join(dir, 'README.md'), 'x');
    ok(!r.ok && r.error === 'name' && !files(dir).length, 'un file che non è CLAUDE.md non si scrive');
    const m = cm.upsertSection(path.join(dir, 'manca', 'CLAUDE.md'), 'x');
    ok(!m.ok && m.error === 'missing' && !fs.existsSync(path.join(dir, 'manca')), 'cartella mancante: non si crea');
  });
}

function canWriteTests(ok) {
  withTmp(dir => {
    ok(cm.canWrite(dir).ok && cm.canWrite(dir).reason === '', 'cartella scrivibile');
    const miss = cm.canWrite(path.join(dir, 'non-esiste'));
    ok(!miss.ok && miss.reason === 'missing', 'cartella mancante: missing');
    ok(cm.canWrite('').reason === 'missing', 'cartella vuota: missing');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    ok(cm.canWrite(path.join(dir, 'file.txt')).reason === 'notdir', 'un file al posto della cartella: notdir');

    const f = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(f, '# P\n');
    ok(cm.canWrite(dir).ok, 'CLAUDE.md scrivibile');
    fs.chmodSync(f, 0o444);
    // da root (o dove i permessi non si possono simulare) il file resta scrivibile: si salta
    let simulated = true;
    try { fs.accessSync(f, fs.constants.W_OK); simulated = false; } catch {}
    if (simulated) {
      const r = cm.canWrite(dir);
      ok(!r.ok && r.reason === 'readonly', 'CLAUDE.md in sola lettura: readonly');
      const u = cm.upsertSection(f, 'x');
      ok(!u.ok && u.error === 'readonly' && fs.readFileSync(f, 'utf8') === '# P\n' && JSON.stringify(files(dir)) === '["CLAUDE.md","file.txt"]', 'CLAUDE.md in sola lettura: nessuna scrittura, nessuna copia');
    } else console.log('  --   sola lettura non simulabile qui (root?): controllo saltato');
    fs.chmodSync(f, 0o666);
  });

  // un collegamento (es. CLAUDE.md -> AGENTS.md) non si spezza
  withTmp(dir => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n');
    let linked = true;
    try { fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'), 'file'); } catch { linked = false; }
    if (linked) {
      const u = cm.upsertSection(path.join(dir, 'CLAUDE.md'), 'x');
      ok(cm.canWrite(dir).reason === 'symlink' && !u.ok && u.error === 'symlink' && fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8') === '# A\n', 'CLAUDE.md collegamento: symlink, nessuna scrittura');
    } else console.log('  --   collegamenti non permessi qui (Windows senza modalità sviluppatore): controllo saltato');
  });
}

function run(ok) {
  console.log('CLAUDE.md: piano');
  planTests(ok);
  console.log('CLAUDE.md: file');
  fileTests(ok);
  console.log('CLAUDE.md: si può scrivere?');
  canWriteTests(ok);
}

module.exports = { run };

if (require.main === module) {
  require('./test-guard').requireTempDataDir('unit-claudemd'); // mai nei dati veri: solo con PLATYPUS_DATA_DIR in una cartella temporanea
  let failed = 0, n = 0;
  run((cond, msg) => { n++; console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; });
  console.log(`\n${n} controlli`);
  console.log(failed ? `${failed} controlli falliti` : 'Tutto a posto.');
  process.exit(failed ? 1 : 0);
}
