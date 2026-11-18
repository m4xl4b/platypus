# Platypus · Alternative Tauri shell

This is the English version of Max's `PIANO-TAURI.md`, adapted to the code after 2.11.

Development plan to carry out step by step, one task at a time. It lives in the repository at `docs/plans/tauri-shell.md`, on the branch `sviluppo-tauri`.
Each task has a checkbox: `[ ]` to do, `[~]` in progress, `[x]` done, `[!]` blocked (with the reason below it).
The labels `[win]` and `[linux]` say on which computer the task is done; with no label, either one is fine. There is no Mac: for macOS the GitHub Actions are the only proof.
At the bottom is the **Journal**, where whoever works on the plan records, at every step, what they did, what they verified and the decisions they made. The Journal is written in English.

## The goal

A second desktop shell, in Tauri 2, **next to** Electron, which stays the default. It is there to measure size, memory and start-up time, and then to decide with numbers.

The engine (`src/core`) and the interface (`renderer/`) are not touched, except for what is needed to avoid duplicating logic between the two shells.

## Rules on top of `docs/plans/parallel.md`

- **Where the code lives:** the whole Tauri shell lives in `shells/tauri/`, with its own `package.json` (for `@tauri-apps/cli`) and its own `Cargo.toml`. The main `package.json` gets no new dependencies: whoever uses Electron must not download anything new.
- **The engine stays Node:** the shell starts it as a child process with `node src/standalone.js --no-open`, on the chosen port. No embedded Node and no engine rewritten in Rust: both are outside this plan.
- **Installing Rust or the system libraries** (rustup, WebView2, webkit2gtk) is a change to Max's computer: ask first. Rust is not installed on this computer today (`rustc` and `cargo` were not found, checked 2026-11-18). Tasks that do not need Rust (T2 is pure Node, T9 is docs) may go ahead while waiting for that permission; note it in the Journal.
- **No compiled program to distribute:** the builds are only for measuring and for the Actions, with artifacts that last 3 days.
- **Strings:** new ones go in `src/i18n/locales/en/tauri.json` (the keys are the Italian text). The tray menu is in Rust, so the shell asks the engine for the translations (see T4).

## Map of the Electron shell to replicate

Checked against the code of 2.11 (Electron 44, see `package.json`). Places are given by function name, not by line.

| What | Where it is in Electron | Notes for Tauri |
|---|---|---|
| Frameless window, 980×620 by default, minimum 380×260, remembered position, always on top | `src/main.js` (`createWindow`, `cfg`, `fitBounds` from `src/bounds.js`, `setPin`, `pinState`) | `decorations: false`, `window-state` plugin; a saved position counts only if it falls on a connected screen |
| The `window.officeApp` contract: `minimize`, `close`, `toggleMaximize`, `isMaximized`, `onMaximized`, `togglePin`, `getPin`, `setCounts`, `setWidget`, `onGoto` | `src/preload.js` and the `ipcMain` handlers at the end of `src/main.js` | initialisation script that calls `invoke` (see T3) |
| Full screen (maximize to the work area; the page draws its own title bar and follows the real state) | `toggleMaximize()` and the `maximize`/`unmaximize` events that send `office:maximized` | `maximize`/`unmaximize` and the window events, sent to the page as `onMaximized` |
| Mini mode: small strip (380×150) in the bottom-right corner of the screen, always on top; back to the old size on exit | `setWidget()` (called by `office:setWidget`) | `set_size`, `set_position`, `set_always_on_top`; from mini, maximize first goes back to normal size |
| Counters, tray icon, window flashing | `office:counts`, `trayImage()`, `flashFrame` | `TrayIcon::set_icon`, `request_user_attention` |
| Notifications for permissions, alerts and the daily report | `src/main.js`: `checkWaiting`, `checkAlerts`, `checkReport`, `scheduleWaitCheck`, `canNotify` | logic to move into the engine (T2) |
| Tray menu | `buildTrayMenu()` | same items, texts translated by the engine |
| Connect to / disconnect from Claude Code | `installHooks`, `uninstallHooks`, `askHooksOnce` (calls `core.hooks`) | the shell runs `src/hooks-cli.js` (T4) |
| Start at login | `src/autostart.js` (Windows login item, macOS LaunchAgent or login item, Linux `.desktop` in `~/.config/autostart`; it also removes the old Agent Office entries) | `autostart` plugin, same entry name so it is not duplicated |
| Single instance | `requestSingleInstanceLock`, `second-instance` | `single-instance` plugin |
| Start menu entry and AppUserModelID (Windows) | `ensureStartMenuShortcut`, `setAppUserModelId`, `setToastActivatorCLSID` | needed for notifications from source: to check in T6 |
| Linux Wayland: no always on top and no position natively, XWayland on request (`x11` in `config.json`) | `WAYLAND`, `setX11`, `offerX11` | WebKitGTK has the same limits on Wayland: check and note it in T5 |
| Links and navigation | `setWindowOpenHandler` and `will-navigate` (only own pages stay in the window, external `http`/`https` go to the browser) | the same rule on the Tauri side (T3) |

---

## T1 · Study and decisions  [ ]

- Read the Tauri 2 documentation for:
  - a window on an external URL (`http://127.0.0.1:<port>/`);
  - `capabilities` with `remote.urls`, to allow `invoke` from that page;
  - initialisation scripts;
  - the system tray;
  - the `notification`, `autostart`, `single-instance`, `window-state`, `shell` or `process` plugins.
- Prerequisites per system: Windows (WebView2, MSVC), Linux (`webkit2gtk-4.1`, `libayatana-appindicator`), macOS (Xcode CLT). Write them in the Journal.
- Check what is already on the computer (`rustc -V`, `cargo -V`; today neither is there) and **ask Max** before installing anything. While waiting, go ahead with T2 and T9.
- **Decision to record: how to expose `officeApp` to the page served by the engine.** The proposed way is an initialisation script that defines `window.officeApp` on top of `window.__TAURI__.core.invoke`, with the permission limited to `http://127.0.0.1:*`. Check that it is safe: no dangerous command exposed and no other domain.

## T2 · Notifications decided by the engine, the same for both shells  [ ]

Today it is Electron that decides when to send a notification, by listening to the state in its own process. Tauri cannot do that, because the engine is a separate process.

- Move the decision into `src/core/notify.js`:
  - `notify` events with `{kind, title, body, sid, key}`;
  - the same logic as today: permissions, alerts, report;
  - the same respect for the options (`notify`, `alertsNotify`, `reportHour`);
  - no duplicates.
- Electron subscribes to these events in its own process.
- The engine exposes `GET /api/shell/events`: an SSE stream of notifications and counters only, protected by the same Host and Origin checks. It is a separate small stream: the engine already has the general SSE stream `/events` and the 2.11 feedback route `/platypus-hook/feedback`, and neither of them changes or is reused for this.
- **Electron's behaviour must not change:** add a test in `scripts/smoke-test.js` that makes a permission appear in the demo and receives the notification from the stream. This task is pure Node: it needs no Rust.

## T3 · Skeleton of the shell  [ ]

- Create `shells/tauri/`:
  - `package.json` with `@tauri-apps/cli` 2.x and the `dev` and `build` scripts;
  - `src-tauri/Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`;
  - icons generated from `build/icon.png` with `tauri icon`.
- **Starting the engine:**
  - find `node` in the PATH, with a clear message if it is missing;
  - choose the port: `PLATYPUS_PORT`, or 47800 if free;
  - **if a Platypus already answers on the port** (`GET /api/state`), attach to that one instead of starting another;
  - otherwise start `node <repo>/src/standalone.js --no-open` and wait for it to answer, 15 s at most;
  - then open the window.
- **On close:** the engine process is ended if the shell started it, and only in that case.
- **The `officeApp` contract** (see `docs/ARCHITECTURE.md`), the same as Electron:
  - `minimize`, `close` (Electron today quits the app on `close`; decide here between that and hiding in the tray, and write the decision in the Journal);
  - `toggleMaximize`, `isMaximized`, `onMaximized(cb)`;
  - `togglePin`, `getPin`;
  - `setCounts`;
  - `setWidget`;
  - `onGoto`.
- **Navigation:** the window stays on the office pages; any other page does not get the `invoke` permission, and external `http`/`https` links open in the browser.
- **Check:** `npm run dev` in `shells/tauri` opens the office with the demo (`--demo` passed to the engine) and the title bar buttons work, full screen included.

## T4 · Tray and notifications  [ ]

- Menu with the same items as `buildTrayMenu()`. The actions go through the engine's APIs:
  - demo: `/api/demo`;
  - Cowork: `/api/cowork`;
  - settings: `/api/settings`.
- The menu texts: add to the engine `GET /api/i18n?keys=…`, or reuse `/i18n.js`, so the menu changes language with the options.
- **Connect to / disconnect from Claude Code:** the shell runs `node src/hooks-cli.js install` or `uninstall`, after a confirmation window as in Electron. In the tests nothing is really installed: only check that the command starts, with `status`.
- **Notifications:** the shell reads `GET /api/shell/events` and uses the `notification` plugin.
  - If a click on the notification cannot be intercepted on some system, at least bring the window to the front. Note the limit.
- **Icon and counters:** the icon changes with the waiting count and the window flashes (`request_user_attention`).

## T5 · Mini mode, window and start-up  [ ]

- **Mini mode:** a small window in the bottom-right corner of the active screen, always on top; on exit it goes back as before.
- **Window:** a single instance; a second start brings the first to the front. Position and size are remembered.
- **Start at login** with the `autostart` plugin: the entry must have the same name as Electron's, or the two shells must recognise each other. There must never be two active. Check on `[win]` (the `Run` registry key) and on `[linux]` (`~/.config/autostart`).
- **Wayland (`[linux]`):** see whether the always-on-top and the window position work in WebKitGTK on Wayland; if not, say so in the options and in the Journal, as Electron does.

## T6 · Launcher  [ ]

- `node scripts/launch.js --shell tauri`:
  - if it finds the compiled program in `shells/tauri/src-tauri/target/release`, it starts it;
  - otherwise it explains how to build it (`npm run build` in `shells/tauri`) and falls back to Electron.
- Scripts `npm run tauri:dev` and `npm run tauri:build` in the main `package.json`: only commands, no dependencies.
- **`[win]`:** check that notifications appear also when starting from source. If a Start menu shortcut with the AppUserModelID is needed, create it as Electron does (`ensureStartMenuShortcut`).

## T7 · Measurements  [ ]

On `[win]` and on `[linux]`, Electron against Tauri, with the demo on:

- **Size on disk:**
  - Electron: `node_modules/electron`;
  - Tauri: the compiled program plus the repository folder, without the intermediate `target/`.
- **Memory** after 2 minutes, summing all the processes:
  - Windows: `Get-Process`;
  - Linux: `ps` or `smem`.
  - The Node engine is counted in both cases.
- **Time** from start to the first answer of `/api/state` with the window visible.
- **Time of the first build** of Tauri: it is the cost for whoever starts from source.
- **Output:** a table in `docs/plans/tauri-measurements.md`, with the measuring method written so that it can be repeated.

## T8 · GitHub Actions  [ ]

- A `tauri` job in `.github/workflows/ci.yml`, which runs only with `workflow_dispatch` or when `shells/tauri/**` changes. The normal CI must stay fast.
- The job:
  - builds on Windows, macOS and Linux;
  - starts the program with a `--smoke` option, which starts, waits for the engine and the window, and then exits with 0;
  - saves as an artifact (3 days) only the size of the program, not the program.
- On macOS it is the only proof possible: read the logs carefully.
- The Actions need the branch on GitHub, and pushing a branch needs Max's permission at that moment: stop and ask. Until then, write the workflow and check it by reading, without pushing.

## T9 · Docs  [ ]

- **`docs/ARCHITECTURE.md`:** the section "Moving to Tauri (or another shell)" becomes "Tauri shell (experimental)", with how it is made, the limits and the link to the measurements. The Italian `docs/ARCHITETTURA.md` is updated to match.
- **Installation guides** (Italian and English): an optional section "Tauri shell", with the prerequisites per system.
- **CHANGELOG:** nothing. The notes for the changelog go in the "For the CHANGELOG" section below: the integration will use them.
- This task does not need Rust and may go ahead while waiting for Max's permission to install it.

---

## For the CHANGELOG

(to be filled in at the end)

## Journal

(Every step adds an entry: date, task, what was done, how it was verified, decisions and doubts.)

### 2026-11-18 · Plan written

- Done: this is the English version of Max's `PIANO-TAURI.md`, adapted to the code after 2.11: the Electron map was checked against `src/main.js`, `src/preload.js`, `src/autostart.js` and the `officeApp` table in `docs/ARCHITECTURE.md`, and the line numbers were replaced by function names.
- Decisions: Rust is not installed on this computer (`rustc` and `cargo` not found). Installing Rust, WebView2 or system libraries needs Max's permission first. Tasks that do not need Rust (T2, which is pure Node, and T9, which is docs) may go ahead while waiting for that permission. Pushing the branch for T8 also needs his permission at that moment.
- Questions for Max: may Rust and the system libraries be installed (T1)?
