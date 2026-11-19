'use strict';
// Platypus — finestra desktop (Electron) + icona nella barra di sistema.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, Notification, net } = require('electron');
const path = require('path');
const fs = require('fs');
// il Node.js dentro Electron (44: Node 24) va sempre bene; un Electron più vecchio messo a mano no, e lo si dice
{
  const { nodeOk, nodeMessages } = require('./requirements');
  if (!nodeOk(process.versions.node)) {
    const lines = nodeMessages(process.versions.node);
    for (const line of lines) console.error('[platypus] ' + line);
    try { dialog.showErrorBox('Platypus', `Electron ${process.versions.electron}: ${lines.join('\n')}`); } catch {}
    process.exit(1);
  }
}
const { startCore } = require('./core');
const autostart = require('./autostart');
const { fitBounds } = require('./bounds');
const { isOwnUrl, isExternalUrl } = require('./urls');
const { tr, trn } = require('./i18n');

// PLATYPUS_DATA_DIR (prove, loop in parallelo): anche i dati di Electron stanno lì, in electron/. Va fatto prima del
// blocco "una sola istanza", che dipende da questa cartella: così non si scontra con il Platypus già aperto.
if (process.env.PLATYPUS_DATA_DIR) { try { app.setPath('userData', path.join(require('./paths').dataDir(), 'electron')); } catch {} }
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.platypus.desktop');
// Windows: un CLSID fisso per le notifiche, scritto anche nel collegamento del menu Start (ensureStartMenuShortcut).
// Senza, Electron ne inventa uno a ogni avvio e crea un suo collegamento "Electron.lnk" con lo stesso ID e
// l'icona di Electron, che Windows usa poi per la barra delle applicazioni al posto della nostra.
const TOAST_CLSID = '{7C3E2B19-5A84-4F6D-9B21-0D8E6F4A3C57}';
if (process.platform === 'win32' && typeof app.setToastActivatorCLSID === 'function') { try { app.setToastActivatorCLSID(TOAST_CLSID); } catch {} }
// Linux: app_id su Wayland e WM_CLASS su X11 = "platypus", come il file platypus.desktop (icona e raggruppamento)
if (process.platform === 'linux') app.setDesktopName('platypus.desktop');

const ROOT = path.join(__dirname, '..');
// Wayland nativo (default di Electron 38): niente "sempre in primo piano" né posizione della finestra.
// Con --ozone-platform=x11 l'app gira in XWayland e li riavrebbe.
const OZONE = app.commandLine.getSwitchValue('ozone-platform');
// senza WAYLAND_DISPLAY (es. via ssh con DISPLAY) Electron usa comunque X11
const WAYLAND_SESSION = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const WAYLAND = WAYLAND_SESSION && OZONE !== 'x11' && OZONE !== 'headless';
let win = null, tray = null, core = null, quitting = false;
let counts = { sessions: 0, agents: 0, busy: 0, waiting: 0 };

// ---------------------------------------------------------------- configurazione
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { pin: true, bounds: null, askedHooks: false, showCowork: true, notify: true, x11: false };
function loadCfg() {
  // preferenze della finestra salvate quando l'app si chiamava Agent Office
  let file = cfgFile();
  if (!fs.existsSync(file)) { const old = path.join(app.getPath('appData'), 'Agent Office', 'config.json'); if (fs.existsSync(old)) file = old; }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
}
let saveTimer = null;
function saveCfg() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch {} }, 400);
}

// ---------------------------------------------------------------- finestra
function createWindow() {
  // la posizione salvata vale solo se cade su uno schermo collegato adesso (il primo è il principale)
  const { screen } = require('electron');
  const areas = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map(d => d.workArea);
  const b = fitBounds(cfg.bounds || {}, areas);
  win = new BrowserWindow({
    width: b.width || 980,
    height: b.height || 620,
    // su Wayland la posizione la decide il compositor
    x: WAYLAND ? undefined : b.x, y: WAYLAND ? undefined : b.y,
    minWidth: 380, minHeight: 260,
    frame: false,
    backgroundColor: '#0b0a12',
    alwaysOnTop: pinState(),
    title: 'Platypus',
    icon: path.join(ROOT, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(pinState(), 'floating');
  win.loadURL(`http://127.0.0.1:${core.port}/`);
  win.once('ready-to-show', () => win.show());
  const remember = () => {
    if (widgetMode || win.isMinimized() || win.isMaximized()) return;
    const nb = win.getBounds();
    // su Wayland x/y valgono sempre 0: teniamo quelli salvati (servono in XWayland/X11)
    cfg.bounds = WAYLAND ? { ...cfg.bounds, width: nb.width, height: nb.height } : nb;
    saveCfg();
  };
  win.on('moved', remember);
  win.on('resized', remember);
  // la barra dei titoli è disegnata dalla pagina: tienila allineata allo stato reale della finestra
  const sendMax = () => { if (win && !win.isDestroyed()) win.webContents.send('office:maximized', win.isMaximized()); };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  win.on('focus', () => win.flashFrame(false));
  win.on('close', () => { quitting = true; });
  win.on('closed', () => { win = null; });
  // eventuali link esterni nel browser (solo http/https), mai dentro l'app
  win.webContents.setWindowOpenHandler(({ url }) => { if (isExternalUrl(url)) shell.openExternal(url); return { action: 'deny' }; });
  // la finestra resta sulle pagine dell'ufficio: un'altra pagina avrebbe a disposizione l'API del preload
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnUrl(url, core.port)) return;
    e.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url);
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setPin(on) {
  if (WAYLAND && on) { offerX11(); buildTrayMenu(); return false; }
  cfg.pin = !!on; saveCfg();
  if (win && !widgetMode) win.setAlwaysOnTop(cfg.pin, 'floating');
  buildTrayMenu();
  return cfg.pin;
}
// su Wayland nativo il primo piano non esiste: il PIN risulta spento
function pinState() { return WAYLAND ? false : !!cfg.pin; }

// ---------------------------------------------------------------- Wayland / XWayland
// Riavvia l'app con o senza --ozone-platform=x11 (lo switch va dato all'avvio, non si cambia a caldo).
function setX11(on) {
  cfg.x11 = !!on;
  clearTimeout(saveTimer);
  try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch {}
  const argv = process.argv.slice(1), args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ozone-platform') { i++; continue; } // forma in due parti
    if (!argv[i].startsWith('--ozone-platform=')) args.push(argv[i]);
  }
  if (on) args.push('--ozone-platform=x11');
  process.env.PLATYPUS_X11 = on ? '1' : '0'; // il processo nuovo eredita l'ambiente: vince la scelta appena fatta
  quitting = true;
  if (core) core.stop(); // app.exit non passa da before-quit: salva le statistiche e chiude i permessi in attesa
  app.relaunch({ args });
  app.exit(0);
}
async function offerX11() {
  const r = await dialog.showMessageBox(win, {
    type: 'question', title: 'Platypus',
    buttons: [tr('Riavvia in XWayland'), tr('Annulla')], defaultId: 0, cancelId: 1,
    message: tr('Su Wayland "sempre in primo piano" non è disponibile'),
    detail: tr('Wayland non permette alle app di restare sopra le altre finestre né di scegliere la propria posizione.') + '\n\n' +
      tr('Posso riavviare Platypus in modalità compatibilità (XWayland), dove funzionano. Puoi tornare a Wayland nativo dal menu dell\'icona.'),
  });
  if (r.response === 0) { cfg.pin = true; setX11(true); }
}

// ---------------------------------------------------------------- modalità widget
// una striscia piccola, sempre in primo piano, nell'angolo in basso a destra
let widgetMode = false, normalBounds = null;
function setWidget(on) {
  if (!win || on === widgetMode) return;
  widgetMode = !!on;
  const { screen } = require('electron');
  if (widgetMode) {
    normalBounds = win.getBounds();
    const wa = screen.getDisplayMatching(normalBounds).workArea;
    win.setMinimumSize(300, 120);
    const w = 380, h = 150;
    // su Wayland niente angolo né primo piano: la striscia resta dove la mette il compositor
    if (WAYLAND) win.setSize(w, h);
    else win.setBounds({ x: wa.x + wa.width - w - 12, y: wa.y + wa.height - h - 12, width: w, height: h });
    win.setAlwaysOnTop(true, 'floating');
  } else {
    win.setMinimumSize(380, 260);
    if (normalBounds) { if (WAYLAND) win.setSize(normalBounds.width, normalBounds.height); else win.setBounds(normalBounds); }
    win.setAlwaysOnTop(pinState(), 'floating');
  }
}

// ---------------------------------------------------------------- tutto schermo
// Ingrandisce la finestra a tutta l'area utile dello schermo (la barra dei titoli resta visibile).
function toggleMaximize() {
  if (!win) return false;
  if (widgetMode) setWidget(false); // dalla mini si torna prima alle dimensioni normali
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
}

// ---------------------------------------------------------------- report giornaliero
function openReport() { shell.openExternal(`http://127.0.0.1:${core.port}/report`); }
// ---------------------------------------------------------------- hook di Claude Code
function installHooks() {
  try {
    const r = core.hooks.install();
    dialog.showMessageBox({
      type: 'info', title: 'Platypus',
      message: tr('Collegato a Claude Code'),
      detail: tr('Ho aggiunto gli hook in:\n{path}', { path: r.path }) + '\n\n' + (r.backup ? tr('Copia di sicurezza delle impostazioni precedenti:\n{path}', { path: r.backup }) + '\n\n' : '') +
        tr('Valgono per le sessioni di Claude Code aperte da adesso in poi: chiudi e riapri quelle già aperte.'),
    });
  } catch (e) {
    dialog.showErrorBox('Platypus', tr('Non sono riuscito a modificare le impostazioni di Claude Code:\n{error}', { error: e.message }));
  }
  buildTrayMenu();
}
function uninstallHooks() {
  try { core.hooks.uninstall(); } catch (e) { dialog.showErrorBox('Platypus', e.message); }
  buildTrayMenu();
}

async function askHooksOnce() {
  if (cfg.askedHooks || core.hooks.status()) return;
  cfg.askedHooks = true; saveCfg();
  const r = await dialog.showMessageBox(win, {
    type: 'question', title: 'Platypus',
    buttons: [tr('Collega'), tr('Più tardi')], defaultId: 0, cancelId: 1,
    message: tr('Collegare Platypus a Claude Code?'),
    detail: tr('L\'ufficio funziona già leggendo i file locali di Claude Code.') + '\n\n' +
      tr('Se lo colleghi (aggiungo degli hook in ~/.claude/settings.json) vedi anche in tempo reale quando un agente aspetta il tuo permesso, e puoi rispondere dai fumetti. Puoi scollegarlo quando vuoi dal menu dell\'icona.'),
  });
  if (r.response === 0) installHooks();
}

// ---------------------------------------------------------------- icona nella barra di sistema
function trayImage() {
  const p = path.join(ROOT, 'build', 'tray.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')).resize({ width: 16 }) : img;
}

function buildTrayMenu() {
  if (!tray) return;
  const hooksOn = core.hooks.status();
  const login = autostart.isEnabled(app);
  const menu = Menu.buildFromTemplate([
    { label: tr('Sessioni: {s}  ·  Agenti: {a}', { s: counts.sessions, a: counts.agents }) + (counts.waiting ? '  ·  ' + trn('{n} in attesa', '{n} in attesa', counts.waiting) : ''), enabled: false },
    { type: 'separator' },
    { label: tr('Mostra l\'ufficio'), click: showWindow },
    { label: tr('Sempre in primo piano'), type: 'checkbox', checked: pinState(), click: m => setPin(m.checked) },
    // solo in una sessione Wayland: scegli tra Wayland nativo e XWayland (riavvia l'app)
    ...(WAYLAND_SESSION ? [{ label: tr('Compatibilità XWayland (primo piano e posizione)'), type: 'checkbox', checked: OZONE === 'x11', click: m => setX11(m.checked) }] : []),
    { label: tr('Modalità demo'), type: 'checkbox', checked: core.demo.on, click: m => { m.checked ? core.demo.start() : core.demo.stop(); } },
    { label: tr('Notifiche per i permessi'), type: 'checkbox', checked: cfg.notify !== false, click: m => { cfg.notify = m.checked; saveCfg(); } },
    { label: tr('Mostra le sessioni Cowork'), type: 'checkbox', checked: cfg.showCowork !== false, click: m => { cfg.showCowork = m.checked; saveCfg(); core.state.setIncludeCowork(m.checked); } },
    { type: 'separator' },
    hooksOn
      ? { label: tr('Scollega da Claude Code (rimuovi hook)'), click: uninstallHooks }
      : { label: tr('Collega a Claude Code (installa hook)…'), click: installHooks },
    { label: tr('Report di oggi'), click: openReport },
    { label: tr('Apri nel browser'), click: () => shell.openExternal(`http://127.0.0.1:${core.port}/`) },
    { label: tr('Apri la cartella di Claude Code'), click: () => shell.openPath(core.base) },
    { type: 'separator' },
    { label: tr('Avvia all\'accesso al computer'), type: 'checkbox', checked: login, click: m => { autostart.setEnabled(app, m.checked); buildTrayMenu(); } },
    { label: tr('Esci'), click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('Platypus — ' + trn('{n} agente', '{n} agenti', counts.agents) + ', ' + trn('{n} al lavoro', '{n} al lavoro', counts.busy) + (counts.waiting ? ', ' + trn('{n} ti aspetta', '{n} ti aspettano', counts.waiting) : ''));
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', () => { if (win && win.isVisible() && win.isFocused()) win.minimize(); else showWindow(); });
  buildTrayMenu();
}

// ---------------------------------------------------------------- notifiche
// Quando c'è qualcosa da dire (un agente che aspetta, un avviso nuovo, il report) lo decide il motore (src/core/notify.js),
// uguale per tutte le shell; qui si decide solo se mostrarlo: l'opzione del menu e la finestra già in primo piano.
let activeToasts = [];
function showNotice(ev) {
  if (process.env.PLATYPUS_DEBUG) console.log('[notify]', ev.kind, '|', ev.title, '|', String(ev.body).replace(/\n/g, ' / '), '| supportate:', Notification.isSupported(), 'finestra attiva:', !!(win && win.isFocused()));
  if (cfg.notify === false || !canNotify()) return;
  if (ev.kind !== 'report' && win && win.isVisible() && win.isFocused() && !process.env.PLATYPUS_NOTIFY_TEST) return;
  const n = new Notification({ title: ev.title, body: ev.body, icon: path.join(ROOT, 'build', 'icon.png'), silent: false });
  n.on('click', () => {
    if (ev.kind === 'report') return openReport();
    showWindow(); if (win && ev.sid) win.webContents.send('office:goto', ev.sid);
  });
  n.on('close', () => { activeToasts = activeToasts.filter(x => x !== n); });
  activeToasts.push(n); // tiene vivo l'oggetto finché la notifica è visibile
  n.show();
}

// niente notifiche nelle prove automatiche (modalità snapshot): Electron registrerebbe l'app nel menu Start vero
function canNotify() { return !process.env.PLATYPUS_SNAPSHOT && Notification.isSupported(); }

// Su Windows i toast di un'app non installata compaiono solo se esiste un collegamento
// nel menu Start con lo stesso AppUserModelID: lo creiamo una volta (comodo anche per avviarla).
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  try {
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const lnk = path.join(programs, 'Platypus.lnk');
    try { fs.rmSync(path.join(programs, 'Agent Office.lnk'), { force: true }); } catch {} // il vecchio nome
    // dai sorgenti: Electron con la cartella del repository come argomento, e la nostra icona
    const opts = app.isPackaged
      ? { target: process.execPath, appUserModelId: 'com.platypus.desktop', toastActivatorClsid: TOAST_CLSID, description: 'Platypus', icon: process.execPath, iconIndex: 0 }
      : { target: process.execPath, args: `"${ROOT}"`, cwd: ROOT, appUserModelId: 'com.platypus.desktop', toastActivatorClsid: TOAST_CLSID, description: 'Platypus', icon: path.join(ROOT, 'build', 'icon.ico'), iconIndex: 0 };
    // il collegamento che Electron si era creato da solo (stesso ID, nessun argomento, icona di Electron): via
    const stray = path.join(programs, 'Electron.lnk');
    try {
      const d = shell.readShortcutLink(stray);
      if (d && d.appUserModelId === 'com.platypus.desktop' && !d.args && path.resolve(d.target || '') === path.resolve(process.execPath)) fs.rmSync(stray, { force: true });
    } catch {}
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', opts);
  } catch {}
}

// ---------------------------------------------------------------- IPC dalla pagina
ipcMain.on('office:minimize', () => win && win.minimize());
ipcMain.handle('office:toggleMaximize', () => toggleMaximize());
ipcMain.handle('office:isMaximized', () => !!(win && win.isMaximized()));
ipcMain.on('office:close', () => { quitting = true; app.quit(); });
ipcMain.handle('office:togglePin', () => setPin(!pinState()));
ipcMain.handle('office:getPin', () => pinState());
ipcMain.on('office:setWidget', (_e, on) => setWidget(!!on));
ipcMain.on('office:counts', (_e, c) => {
  const prevWaiting = counts.waiting;
  const changed = JSON.stringify(c) !== JSON.stringify(counts);
  counts = { ...counts, ...c };
  // qualcuno aspetta un tuo OK: fai lampeggiare la finestra nella barra delle applicazioni
  if (win && counts.waiting > prevWaiting && !win.isFocused()) win.flashFrame(true);
  if (changed) buildTrayMenu();
});

// ---------------------------------------------------------------- avvio
app.on('second-instance', showWindow);
app.on('activate', showWindow); // macOS: clic sull'icona nel Dock
app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { quitting = true; if (core) core.stop(); });

// macOS: menu dell'app con le scorciatoie standard (Cmd+C/V/Q...) e icona nel Dock anche dai sorgenti
function setupMac() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu', label: 'Platypus' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  try { if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(ROOT, 'build', 'icon.png')); } catch {}
}

app.whenReady().then(async () => {
  setupMac();
  loadCfg();
  // scelta XWayland salvata (o PLATYPUS_X11=1): lo switch va dato all'avvio, quindi ci riavviamo con lui
  // (scripts/launch.js lo passa già; questo copre avvio automatico, collegamenti e app compilata)
  if (WAYLAND && process.env.PLATYPUS_X11 !== '0' && (cfg.x11 || process.env.PLATYPUS_X11 === '1') && !process.env.PLATYPUS_SNAPSHOT) return setX11(true);
  core = startCore({ includeCowork: cfg.showCowork !== false, fetch: (u, o) => net.fetch(u, o), osLocale: app.getLocale() }); // net.fetch usa il proxy di sistema
  try {
    await core.ready;
  } catch (e) {
    dialog.showErrorBox('Platypus', e.code === 'EADDRINUSE'
      ? tr('La porta {port} è già occupata. Platypus è forse già aperto (anche in modalità browser)?', { port: core.port })
      : tr('Errore di avvio: {error}', { error: e.message }));
    app.quit();
    return;
  }
  if (process.argv.includes('--demo')) core.demo.start();
  ensureStartMenuShortcut();
  core.notify.seenReport(cfg.reportDay); // il report già mostrato oggi quando lo decideva questa shell
  core.notify.on('notify', showNotice);
  core.state.on('lang', () => buildTrayMenu()); // lingua cambiata nelle opzioni
  createWindow();
  createTray();
  if (process.env.PLATYPUS_SNAPSHOT) { // solo per test automatici
    setTimeout(async () => {
      try {
        if (process.env.PLATYPUS_SNAPSHOT_JS) { await win.webContents.executeJavaScript(process.env.PLATYPUS_SNAPSHOT_JS); await new Promise(r => setTimeout(r, 1500)); }
        if (process.env.PLATYPUS_DEBUG) console.log('[snapshot] bounds', JSON.stringify(win.getBounds()), 'onTop', win.isAlwaysOnTop());
        // con xvfb (CI di Linux) capturePage a volte fallisce con UnknownVizError: si riprova qualche volta
        let img;
        for (let attempt = 1; !img; attempt++) {
          try { img = await win.webContents.capturePage(); }
          catch (e) { if (attempt >= 4) throw e; console.error('[snapshot] tentativo ' + attempt + ': ' + e.message); await new Promise(r => setTimeout(r, 2000)); }
        }
        // larghezza fissa (per le immagini dei documenti), indipendente dalla densità dello schermo
        const sw = Number(process.env.PLATYPUS_SNAPSHOT_WIDTH);
        if (sw > 0 && img.getSize().width !== sw) img = img.resize({ width: sw, quality: 'best' });
        fs.writeFileSync(process.env.PLATYPUS_SNAPSHOT, img.toPNG());
      } catch (e) {
        // mai restare aperti: senza questo un errore lasciava la finestra viva fino al timeout della CI
        console.error('[snapshot] non riuscito: ' + (e && e.message || e));
        app.exit(1);
        return;
      }
      app.quit();
    }, Number(process.env.PLATYPUS_SNAPSHOT_DELAY) || 8000);
    return;
  }
  setTimeout(askHooksOnce, 1500);
});
