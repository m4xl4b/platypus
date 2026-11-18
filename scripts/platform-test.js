#!/usr/bin/env node
'use strict';
// Prove di sistema che girano ovunque (Windows, macOS, Linux): collegamenti, avvio all'accesso, osint, cartelle di Cowork.
//   node scripts/platform-test.js          (lo chiamano anche le Actions: .github/workflows/ci.yml)
// Lavora tutto in una cartella temporanea usata come home: non tocca il menu Start, il registro, il Desktop né
// ~/.config del computer vero. Le variabili HOME, USERPROFILE, APPDATA, LOCALAPPDATA e XDG_* si cambiano PRIMA di
// caricare i moduli, perché alcuni calcolano i percorsi quando partono.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platypus-platform-'));
const home = path.join(tmp, 'home');
const dirs = {
  roaming: path.join(home, 'AppData', 'Roaming'),
  local: path.join(home, 'AppData', 'Local'),
  config: path.join(home, '.config'),
  share: path.join(home, '.local', 'share'),
};
for (const d of [home, path.join(home, 'Desktop'), ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: dirs.roaming, LOCALAPPDATA: dirs.local, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.share, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
delete process.env.XDG_SESSION_TYPE; delete process.env.WAYLAND_DISPLAY;

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; };
const write = (f, s = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

console.log(`sistema: ${process.platform} ${os.release()} · Node ${process.versions.node} · home di prova ${home}`);

// ---------------------------------------------------------------- collegamenti
console.log('collegamenti');
{
  const shortcut = require('./shortcut');
  const electron = path.join(tmp, IS_WIN ? 'electron.exe' : 'electron');
  const lines = shortcut.install({ root: ROOT, electron });
  ok(Array.isArray(lines) && lines.length > 0 && lines.every(l => typeof l === 'string'), 'shortcut.install risponde con righe di testo: ' + lines.join(' | ').slice(0, 120));
  if (IS_WIN) {
    const lnk = path.join(home, 'Desktop', 'Platypus.lnk');
    ok(fs.existsSync(lnk), 'Windows: Platypus.lnk sul Desktop della home di prova');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); Write-Output $s.TargetPath; Write-Output $s.Arguments; Write-Output $s.WorkingDirectory; Write-Output $s.IconLocation`], { encoding: 'utf8' });
    const [target, args, wd, icon] = r.stdout.split(/\r?\n/);
    ok(same(target || '', electron), 'Windows: il collegamento punta a Electron');
    ok((args || '') === `"${ROOT}"` || same((args || '').replace(/"/g, ''), ROOT), 'Windows: argomento = cartella del repository');
    ok(same(wd || '', ROOT), 'Windows: cartella di lavoro = repository');
    const iconFile = (icon || '').replace(/,\d+$/, '');
    ok(same(iconFile, path.join(ROOT, 'build', 'icon.ico')) && fs.existsSync(iconFile), 'Windows: icona build\\icon.ico, e il file esiste');
  } else if (IS_MAC) {
    const app = path.join(home, 'Applications', 'Platypus.app'), plist = path.join(app, 'Contents', 'Info.plist'), exe = path.join(app, 'Contents', 'MacOS', 'platypus');
    ok(fs.existsSync(plist) && fs.existsSync(exe), 'macOS: Platypus.app ha Info.plist e il lanciatore');
    ok((fs.statSync(exe).mode & 0o111) !== 0, 'macOS: il lanciatore è eseguibile');
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
    ok(lint.status === 0, 'macOS: plutil -lint approva Info.plist ' + (lint.stdout || lint.stderr || '').trim());
    const icns = path.join(app, 'Contents', 'Resources', 'icon.icns');
    ok(fs.existsSync(icns) && fs.statSync(icns).size > 1000 && /CFBundleIconFile/.test(fs.readFileSync(plist, 'utf8')), 'macOS: icona icon.icns creata con sips + iconutil, e Info.plist la cita');
    ok(/exec node scripts\/launch\.js --background/.test(fs.readFileSync(exe, 'utf8')), 'macOS: il lanciatore apre scripts/launch.js');
  } else {
    const f = path.join(dirs.share, 'applications', 'platypus.desktop');
    const txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    ok(/^\[Desktop Entry\]/.test(txt) && /^Name=Platypus$/m.test(txt), 'Linux: platypus.desktop in XDG_DATA_HOME/applications');
    ok(txt.includes(path.join(ROOT, 'start.sh')) && txt.includes(`Path=${ROOT}`), 'Linux: Exec con start.sh e Path = repository');
    ok(fs.existsSync(path.join(ROOT, 'build', 'icon.png')) && txt.includes(path.join(ROOT, 'build', 'icon.png')), 'Linux: l\'icona esiste');
    ok((fs.statSync(f).mode & 0o111) !== 0, 'Linux: il file .desktop è eseguibile');
  }
  // i lanciatori devono essere eseguibili nel repository (solo dove c'è git)
  const ls = spawnSync('git', ['ls-files', '--stage', 'start.sh', 'start.command', 'start.cmd'], { cwd: ROOT, encoding: 'utf8' });
  if (ls.status === 0 && ls.stdout.trim()) {
    const modes = Object.fromEntries(ls.stdout.trim().split('\n').map(l => { const m = /^(\d+) \S+ \d\t(.+)$/.exec(l); return m ? [m[2], m[1]] : ['?', '?']; }));
    ok(modes['start.sh'] === '100755' && modes['start.command'] === '100755', `start.sh e start.command sono eseguibili in git (${modes['start.sh']}, ${modes['start.command']})`);
  } else ok(true, 'git non disponibile: modo dei lanciatori non controllato');
  ok(/^@echo off/.test(fs.readFileSync(path.join(ROOT, 'start.cmd'), 'utf8')) && fs.readFileSync(path.join(ROOT, 'start.cmd')).includes(13), 'start.cmd ha le righe in stile Windows (CRLF)');
}

// ---------------------------------------------------------------- avvio all'accesso
console.log('avvio all\'accesso');
{
  const autostart = require('../src/autostart');
  const calls = [];
  const fakeApp = { isPackaged: false, commandLine: { hasSwitch: () => false }, setLoginItemSettings: o => calls.push(o), getLoginItemSettings: () => ({ openAtLogin: !!calls.length && calls[calls.length - 1].openAtLogin === true }) };
  if (IS_WIN) {
    ok(autostart.setEnabled(fakeApp, true) === true, 'Windows: acceso, isEnabled risponde sì');
    const on = calls.filter(c => c.openAtLogin === true && !c.name).pop();
    ok(on && same(on.path, process.execPath) && JSON.stringify(on.args) === JSON.stringify([ROOT]), 'Windows: la voce usa il percorso di Electron e la cartella del repository come argomento');
    ok(autostart.setEnabled(fakeApp, false) === false && calls.filter(c => c.openAtLogin === false && !c.name).length > 0, 'Windows: spento, la voce viene tolta');
    ok(calls.some(c => c.openAtLogin === false && c.name === 'com.agentoffice.desktop'), 'Windows: anche la voce che si chiamava come Agent Office viene tolta');
    // il registro vero, ma su un ramo di prova di HKCU: scrivere, leggere, cancellare
    const key = 'HKCU\\Software\\PlatypusPlatformTest';
    const reg = a => spawnSync('reg.exe', a, { encoding: 'utf8' });
    const w = reg(['add', key, '/v', 'prova', '/t', 'REG_SZ', '/d', `"${process.execPath}" "${ROOT}"`, '/f']);
    const q = reg(['query', key, '/v', 'prova']);
    ok(w.status === 0 && q.status === 0 && q.stdout.includes(ROOT), 'Windows: reg.exe scrive e legge un valore con percorso e spazi (ramo di prova di HKCU)');
    reg(['delete', key, '/f']);
    ok(reg(['query', key]).status !== 0, 'Windows: il ramo di prova di HKCU è stato tolto');
  } else if (IS_MAC) {
    const plist = path.join(home, 'Library', 'LaunchAgents', 'com.platypus.desktop.plist'), old = path.join(home, 'Library', 'LaunchAgents', 'com.agentoffice.desktop.plist');
    write(old, '<plist/>');
    ok(autostart.setEnabled(fakeApp, true) === true && fs.existsSync(plist), 'macOS: LaunchAgent creato in ~/Library/LaunchAgents');
    ok(!fs.existsSync(old), 'macOS: il vecchio LaunchAgent di Agent Office è stato tolto');
    const txt = fs.readFileSync(plist, 'utf8');
    ok(txt.includes('<key>RunAtLoad</key><true/>') && txt.includes(ROOT), 'macOS: RunAtLoad e cartella del repository nel plist');
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
    ok(lint.status === 0, 'macOS: plutil -lint approva il LaunchAgent');
    ok(autostart.setEnabled(fakeApp, false) === false && !fs.existsSync(plist), 'macOS: spento, il file sparisce');
  } else {
    const f = path.join(dirs.config, 'autostart', 'platypus.desktop'), old = path.join(dirs.config, 'autostart', 'agent-office.desktop');
    write(old, '[Desktop Entry]\n');
    ok(autostart.setEnabled(fakeApp, true) === true && fs.existsSync(f), 'Linux: platypus.desktop creato in autostart');
    ok(!fs.existsSync(old), 'Linux: il vecchio agent-office.desktop è stato tolto');
    const txt = fs.readFileSync(f, 'utf8');
    ok(/^Exec=.*platypus|^Exec=/m.test(txt) && txt.includes(ROOT) && /X-GNOME-Autostart-enabled=true/.test(txt), 'Linux: Exec con la cartella del repository, voce attiva');
    ok(autostart.setEnabled(fakeApp, false) === false && !fs.existsSync(f), 'Linux: spento, il file sparisce');
  }
}

// ---------------------------------------------------------------- osint
console.log('osint');
(async () => {
  const osint = require('../src/core/osint');
  const dir = path.join(tmp, 'progetto con spazi');
  fs.mkdirSync(dir, { recursive: true });
  ok(osint.cmdArgs('code', dir) !== null && osint.cmdArgs('code', path.join(tmp, 'a%b')) === null, 'cmdArgs: cartella con spazi sì, con «%» no');
  const rw = osint.resumeWin(dir, 'abcd-1234', true);
  ok(rw.how === 'wt' && rw.args.includes(dir), 'resumeWin: con Windows Terminal passa la cartella intera');
  // gli strumenti che servono per portare in primo piano e riprendere: dipende dal sistema, quindi si scrive cosa c'è
  const which = IS_WIN ? 'where.exe' : 'which';
  const tools = (IS_WIN ? ['powershell.exe', 'cmd.exe', 'wt.exe', 'code'] : IS_MAC ? ['osascript', 'ps', 'code'] : ['xdotool', 'wmctrl', 'ps', 'code']).map(t => [t, spawnSync(which, [t], { encoding: 'utf8' }).status === 0]);
  console.log('  info strumenti: ' + tools.map(([t, y]) => `${t} ${y ? 'sì' : 'no'}`).join(', '));
  const base = IS_WIN ? ['powershell.exe'] : IS_MAC ? ['osascript', 'ps'] : ['ps'];
  ok(base.every(t => tools.find(x => x[0] === t)[1]), `strumenti di base presenti: ${base.join(', ')}`);
  // leggere i processi: nelle Actions c'è un utente ma non c'è un desktop, quindi la risposta giusta è «non trovata» senza eccezioni.
  // In locale la prova sarebbe invasiva (porterebbe in primo piano una finestra vera): si fa solo con CI=true o --focus.
  if (process.env.CI || process.argv.includes('--focus')) {
    const t0 = Date.now();
    const r = await osint.focusSession({ pid: process.pid, kind: 'cli', cwd: dir });
    ok(r && typeof r.ok === 'boolean' && (r.ok || typeof r.reason === 'string'), `focusSession(pid vero): risposta ben formata in ${Date.now() - t0} ms → ${JSON.stringify(r)}`);
  } else console.log('  (focusSession non provato qui: serve CI=true o --focus)');

  // ---------------------------------------------------------------- Cowork
  console.log('cartelle di Cowork su un albero finto');
  const { coworkRoots, findCoworkBases } = require('../src/core/sources');
  const roots = coworkRoots();
  const expected = IS_WIN ? [path.join(dirs.roaming, 'Claude'), path.join(dirs.local, 'Claude'), path.join(dirs.local, 'AnthropicClaude'), path.join(dirs.roaming, 'Claude-3p')]
    : IS_MAC ? [path.join(home, 'Library', 'Application Support', 'Claude')] : [path.join(dirs.config, 'Claude')];
  ok(expected.every(e => roots.some(r => same(r, e))), `coworkRoots: ${expected.map(e => path.relative(home, e)).join(', ')}`);
  const root = expected[0];
  const cfgA = path.join(root, 'local-agent-mode-sessions', 'uuid', 'sess', '.claude');
  write(path.join(cfgA, 'projects', '-sessions-demo', 'aaaa.jsonl'), '{"type":"user"}\n');
  write(path.join(root, 'Cache', 'x', 'projects', 'decoy', 'bbbb.jsonl'), '{}\n'); // dentro una cartella da saltare
  write(path.join(root, 'vm_bundles', 'projects', 'p', 'cccc.jsonl'), '{}\n');
  write(path.join(root, 'projects', 'vuota', 'note.txt'), 'senza transcript');
  let r = findCoworkBases();
  ok(r.bases.length === 1 && same(r.bases[0].path, cfgA) && r.bases[0].files === 1, `findCoworkBases: trova solo la cartella con transcript (${r.bases.map(b => path.relative(root, b.path)).join('; ') || 'niente'})`);
  r = findCoworkBases('', [cfgA]);
  ok(r.bases.length === 0, 'findCoworkBases: la cartella esclusa non torna');
  const extra = path.join(home, 'altro posto', '.claude');
  write(path.join(extra, 'projects', 'p', 'dddd.jsonl'), '{}\n');
  r = findCoworkBases(`"~/altro posto"; ${path.join(tmp, 'non-esiste')}`);
  ok(r.bases.some(b => same(b.path, extra)) && r.roots.some(x => !x.exists), 'findCoworkBases: radice extra con «~» e virgolette, e una radice che non esiste');
  // il percorso noto di Cowork (docs/plans/cowork-structure.md), su una radice indicata a mano: titolo e stato dai metadati
  const known = path.join(tmp, 'known-root');
  const kSess = path.join(known, 'local-agent-mode-sessions', 'acct', 'org');
  write(path.join(kSess, 'local_abc', '.claude', 'projects', '-sessions-calm-test-curie', 'cli1.jsonl'), '{}\n');
  write(path.join(kSess, 'local_abc.json'), JSON.stringify({ title: 'Prova', cliSessionId: 'cli1', isArchived: false, emailAddress: 'nobody@example.invalid' }));
  r = findCoworkBases(known);
  const kb = r.bases.find(b => same(b.path, path.join(kSess, 'local_abc', '.claude')));
  ok(kb && kb.meta && kb.meta.title === 'Prova' && kb.meta.cliSessionId === 'cli1' && !('emailAddress' in kb.meta) && r.visited < 50, `findCoworkBases: percorso noto di Cowork con titolo dai metadati, senza ricerca larga (${r.visited} cartelle viste)`);
  if (IS_WIN) {
    const pkg =path.join(dirs.local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    write(path.join(pkg, 'sess', '.claude', 'projects', 'p', 'eeee.jsonl'), '{}\n');
    ok(coworkRoots().some(x => same(x, pkg)), 'Windows: cartella del pacchetto Microsoft Store trovata tra le radici');
    ok(findCoworkBases().bases.some(b => same(b.path, path.join(pkg, 'sess', '.claude'))), 'Windows: e i suoi transcript vengono trovati');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} controlli falliti` : '\nTutto a posto.');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
