#!/usr/bin/env node
'use strict';
// Controllo del log di una prova della modalità mini (usato da .github/workflows/ci.yml):
//   PLATYPUS_DEBUG=1 PLATYPUS_SNAPSHOT=... PLATYPUS_SNAPSHOT_JS="document.getElementById('btn-mini').click()" electron . --demo | tee mini.log
//   node scripts/check-mini-log.js mini.log
// src/main.js scrive «[snapshot] bounds {...} onTop true» poco prima della foto: la striscia deve essere piccola e sempre in primo piano.
const fs = require('fs');

function check(text) {
  const m = /\[snapshot\] bounds (\{.*?\}) onTop (\w+)/.exec(text);
  if (!m) return { ok: false, why: 'nessuna riga [snapshot] nel log' };
  const b = JSON.parse(m[1]);
  if (b.width > 420 || b.height > 200) return { ok: false, why: `la striscia è troppo grande: ${b.width}x${b.height}`, bounds: b };
  if (m[2] !== 'true') return { ok: false, why: 'la striscia non è in primo piano', bounds: b };
  return { ok: true, bounds: b };
}

if (require.main === module) {
  const r = check(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(r.ok ? `modalità mini: ${r.bounds.width}x${r.bounds.height}, in primo piano` : `modalità mini: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
module.exports = { check };
