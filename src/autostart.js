'use strict';
// "Avvia all'accesso": funziona sia con l'app compilata sia lanciata dai sorgenti (git clone).
//  - Windows: voce di avvio di Windows, chiave Run di HKCU (con percorso ed argomenti di Electron)
//  - macOS:   LaunchAgent in ~/Library/LaunchAgents (dai sorgenti) o login item (app compilata)
//  - Linux:   file .desktop in ~/.config/autostart

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LABEL = 'com.platypus.desktop';

// voci create quando l'app si chiamava Agent Office: le togliamo quando cambi l'impostazione
const LEGACY = [
  path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agentoffice.desktop.plist'),
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'agent-office.desktop'),
];
const LEGACY_WIN_NAME = 'com.agentoffice.desktop'; // nome del valore nella chiave Run di HKCU
function plistPath() { return path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist'); }
function desktopPath() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'platypus.desktop'); }
function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function launchArgs(app) {
  const args = app.isPackaged ? [] : [ROOT];
  if (process.platform === 'linux' && app.commandLine.hasSwitch('no-sandbox')) args.push('--no-sandbox');
  return args;
}

function isEnabled(app) {
  if (process.platform === 'win32') return app.getLoginItemSettings({ path: process.execPath, args: launchArgs(app) }).openAtLogin;
  if (process.platform === 'darwin') return app.isPackaged ? app.getLoginItemSettings().openAtLogin : fs.existsSync(plistPath());
  return fs.existsSync(desktopPath());
}

function setEnabled(app, on) {
  for (const f of LEGACY) { try { fs.rmSync(f, { force: true }); } catch {} }
  // Windows: la voce di avvio di Agent Office si chiamava come il suo AppUserModelID
  if (process.platform === 'win32') { try { app.setLoginItemSettings({ openAtLogin: false, name: LEGACY_WIN_NAME }); } catch {} }
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: launchArgs(app) });
    } else if (process.platform === 'darwin') {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on });
      else if (on) {
        fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
        fs.writeFileSync(plistPath(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${[process.execPath, ...launchArgs(app)].map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
      } else fs.rmSync(plistPath(), { force: true });
    } else if (on) {
      fs.mkdirSync(path.dirname(desktopPath()), { recursive: true });
      const exec = [process.execPath, ...launchArgs(app)].map(a => JSON.stringify(a)).join(' ');
      fs.writeFileSync(desktopPath(), `[Desktop Entry]\nType=Application\nName=Platypus\nExec=${exec}\nIcon=${path.join(ROOT, 'build', 'icon.png')}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`);
    } else fs.rmSync(desktopPath(), { force: true });
  } catch { /* nessun permesso: resta com'era */ }
  return isEnabled(app);
}

module.exports = { isEnabled, setEnabled };
