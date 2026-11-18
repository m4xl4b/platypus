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

## T1 · Study and decisions  [x]

- Read the Tauri 2 documentation for:
  - a window on an external URL (`http://127.0.0.1:<port>/`);
  - `capabilities` with `remote.urls`, to allow `invoke` from that page;
  - initialisation scripts;
  - the system tray;
  - the `notification`, `autostart`, `single-instance`, `window-state`, `shell` or `process` plugins.
- Prerequisites per system: Windows (WebView2, MSVC), Linux (`webkit2gtk-4.1`, `libayatana-appindicator`), macOS (Xcode CLT). Write them in the Journal.
- Check what is already on the computer (`rustc -V`, `cargo -V`; today neither is there) and **ask Max** before installing anything. While waiting, go ahead with T2 and T9.
- **Decision to record: how to expose `officeApp` to the page served by the engine.** The proposed way is an initialisation script that defines `window.officeApp` on top of `window.__TAURI__.core.invoke`, with the permission limited to `http://127.0.0.1:*`. Check that it is safe: no dangerous command exposed and no other domain.

## T2 · Notifications decided by the engine, the same for both shells  [x]

Today it is Electron that decides when to send a notification, by listening to the state in its own process. Tauri cannot do that, because the engine is a separate process.

- Move the decision into `src/core/notify.js`:
  - `notify` events with `{kind, title, body, sid, key}`;
  - the same logic as today: permissions, alerts, report;
  - the same respect for the options (`notify`, `alertsNotify`, `reportHour`);
  - no duplicates.
- Electron subscribes to these events in its own process.
- The engine exposes `GET /api/shell/events`: an SSE stream of notifications and counters only, protected by the same Host and Origin checks. It is a separate small stream: the engine already has the general SSE stream `/events` and the 2.11 feedback route `/platypus-hook/feedback`, and neither of them changes or is reused for this.
- **Electron's behaviour must not change:** add a test in `scripts/smoke-test.js` that makes a permission appear in the demo and receives the notification from the stream. This task is pure Node: it needs no Rust.

## T3 · Skeleton of the shell  [x]

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

## T4 · Tray and notifications  [x]

- Menu with the same items as `buildTrayMenu()`. The actions go through the engine's APIs:
  - demo: `/api/demo`;
  - Cowork: `/api/cowork`;
  - settings: `/api/settings`.
- The menu texts: add to the engine `GET /api/i18n?keys=…`, or reuse `/i18n.js`, so the menu changes language with the options.
- **Connect to / disconnect from Claude Code:** the shell runs `node src/hooks-cli.js install` or `uninstall`, after a confirmation window as in Electron. In the tests nothing is really installed: only check that the command starts, with `status`.
- **Notifications:** the shell reads `GET /api/shell/events` and uses the `notification` plugin.
  - If a click on the notification cannot be intercepted on some system, at least bring the window to the front. Note the limit.
- **Icon and counters:** the icon changes with the waiting count and the window flashes (`request_user_attention`).

## T5 · Mini mode, window and start-up  [x]

- **Mini mode:** a small window in the bottom-right corner of the active screen, always on top; on exit it goes back as before.
- **Window:** a single instance; a second start brings the first to the front. Position and size are remembered.
- **Start at login** with the `autostart` plugin: the entry must have the same name as Electron's, or the two shells must recognise each other. There must never be two active. Check on `[win]` (the `Run` registry key) and on `[linux]` (`~/.config/autostart`).
- **Wayland (`[linux]`):** see whether the always-on-top and the window position work in WebKitGTK on Wayland; if not, say so in the options and in the Journal, as Electron does.

## T6 · Launcher  [x]

- `node scripts/launch.js --shell tauri`:
  - if it finds the compiled program in `shells/tauri/src-tauri/target/release`, it starts it;
  - otherwise it explains how to build it (`npm run build` in `shells/tauri`) and falls back to Electron.
- Scripts `npm run tauri:dev` and `npm run tauri:build` in the main `package.json`: only commands, no dependencies.
- **`[win]`:** check that notifications appear also when starting from source. If a Start menu shortcut with the AppUserModelID is needed, create it as Electron does (`ensureStartMenuShortcut`).

## T7 · Measurements  [x]

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

## T8 · GitHub Actions  [!]

Blocked: the workflow is written and checked by reading, and `--smoke` works locally, but the Actions only run on GitHub, and pushing the branch needs Max's permission at that moment.

- A `tauri` job in `.github/workflows/ci.yml`, which runs only with `workflow_dispatch` or when `shells/tauri/**` changes. The normal CI must stay fast.
- The job:
  - builds on Windows, macOS and Linux;
  - starts the program with a `--smoke` option, which starts, waits for the engine and the window, and then exits with 0;
  - saves as an artifact (3 days) only the size of the program, not the program.
- On macOS it is the only proof possible: read the logs carefully.
- The Actions need the branch on GitHub, and pushing a branch needs Max's permission at that moment: stop and ask. Until then, write the workflow and check it by reading, without pushing.

## T9 · Docs  [x]

- **`docs/ARCHITECTURE.md`:** the section "Moving to Tauri (or another shell)" becomes "Tauri shell (experimental)", with how it is made, the limits and the link to the measurements. The Italian `docs/ARCHITETTURA.md` is updated to match.
- **Installation guides** (Italian and English): an optional section "Tauri shell", with the prerequisites per system.
- **CHANGELOG:** nothing. The notes for the changelog go in the "For the CHANGELOG" section below: the integration will use them.
- This task does not need Rust and may go ahead while waiting for Max's permission to install it.

---

## For the CHANGELOG

(Draft notes, completed as the tasks close; the integration writes the real entry.)

- Notifications (agent waiting, new alert, daily report) are now decided by the engine (`src/core/notify.js`) and only shown by the shell, so every desktop shell notifies the same things. Electron behaves as before. New `GET /api/shell/events`: an SSE stream with only counters and notifications, for a shell that runs the engine as a separate process. The day of the last report notification now lives in `~/.platypus/notify.json`.
- Docs: the architecture section about Tauri became "Tauri shell (experimental)", with the design, the limits, the prerequisites and the Windows measurements (`docs/plans/tauri-measurements.md`).
- New, experimental: a second desktop shell in Tauri 2 (`shells/tauri/`), next to Electron, which stays the default and gets no new dependency. Build it with `npm run tauri:build` (needs Rust and the system libraries) and start it with `node scripts/launch.js --shell tauri`; without a build the launcher explains what is needed and opens Electron. It has the same window, title bar, full screen, mini mode, PIN, tray menu, notifications, start at login (same entry as Electron, never two) and single instance. On Windows it is about 5 MB instead of about 370 MB, with the same memory and start-up time.
- The engine has `--parent-stdin` (`src/standalone.js`): started by a shell that holds its stdin, it saves and exits when the shell closes, even if the shell crashes.
- The shell stream `/api/shell/events` also carries the tray texts (translated, following the language of the options) and the counters' label and tooltip.
- New workflow `.github/workflows/tauri.yml` (by hand or when `shells/tauri` changes): builds the Tauri shell on Windows, macOS and Linux, starts it once with `--smoke`, and keeps only the program's size for 3 days. `ci.yml` is unchanged.

## Journal

(Every step adds an entry: date, task, what was done, how it was verified, decisions and doubts.)

### 2026-11-18 · Plan written

- Done: this is the English version of Max's `PIANO-TAURI.md`, adapted to the code after 2.11: the Electron map was checked against `src/main.js`, `src/preload.js`, `src/autostart.js` and the `officeApp` table in `docs/ARCHITECTURE.md`, and the line numbers were replaced by function names.
- Decisions: Rust is not installed on this computer (`rustc` and `cargo` not found). Installing Rust, WebView2 or system libraries needs Max's permission first. Tasks that do not need Rust (T2, which is pure Node, and T9, which is docs) may go ahead while waiting for that permission. Pushing the branch for T8 also needs his permission at that moment.
- Questions for Max: may Rust and the system libraries be installed (T1)?

### 2026-11-18 · T1 · Study and decisions

- Done: read the Tauri 2 docs (v2.tauri.app: capabilities, ACL reference, prerequisites, system tray, plugins notification / autostart / single-instance / window-state / shell / process / opener; docs.rs for `tauri` 2.12.7, `WebviewWindowBuilder`, `Window`, `WindowEvent`, `TrayIcon`, `tauri_build::AppManifest`). Nothing installed. `rustc -V` and `cargo -V`: not found.
- Prerequisites per system (from https://v2.tauri.app/start/prerequisites/):
  - all: Rust through rustup, 1.90 or newer (the plugins ask for it); `@tauri-apps/cli` 2.x from npm, only in `shells/tauri`.
  - Windows: Microsoft C++ Build Tools with "Desktop development with C++" (MSVC), `rustup default stable-msvc`; WebView2 runtime, already part of Windows 10 1803+ and Windows 11, so nothing to install for it on this PC.
  - Debian/Ubuntu: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.
  - Fedora: `webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel` and the group "c-development".
  - Arch: `webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool`.
  - macOS: Xcode Command Line Tools (`xcode-select --install`), macOS 10.15 or newer.
- What the docs settle for the next tasks:
  - The window is built in Rust (`WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))`) once the port is known, with `decorations(false)`, `min_inner_size(380, 260)`, `always_on_top`. On Windows the builder can deadlock if called from a synchronous command: build it in `setup` or from an async command.
  - There is no "maximized" window event: on `WindowEvent::Resized` the shell compares `is_maximized()` with the last value and tells the page only when it changes.
  - `initialization_script` runs before the page's scripts on every top-level navigation, main frame only (on Windows also subframes): the script must check `location.origin` itself.
  - `on_navigation(|url| bool)` blocks navigations; `on_new_window` handles `window.open`; the opener plugin (`OpenerExt::open_url`) opens external links in the browser, called from Rust only.
  - Tray: `TrayIconBuilder` with the `tray-icon` cargo feature. On Linux the tray click events are not emitted (only the menu works) and `set_tooltip` is not supported: the counters must also be in the first, disabled menu item, as in Electron.
  - Notifications: on Windows the plugin shows proper toasts only for an installed app (from source they look like PowerShell's); the docs give no click event on desktop. T4 must assume that a click on a notification cannot be intercepted, and T6 must check the Start menu shortcut.
  - The engine is started with `std::process::Command` from Rust: no shell plugin, so no process spawning is reachable from the page.
  - `single-instance` must be registered first; on Linux it uses DBus. `autostart` lets us choose the entry name (`app_name`); the exact registry / `.desktop` names must be checked in T5.
- Decision (`officeApp` security): how the page served by the engine gets `window.officeApp`.
  - An initialisation script, built in Rust with the real port, defines `window.officeApp` on top of `window.__TAURI_INTERNALS__.invoke`, only if `location.origin === "http://127.0.0.1:<port>"`. `app.withGlobalTauri` stays false: the page never gets the full `window.__TAURI__` API.
  - Only our own commands are reachable: `build.rs` declares them with `tauri_build::AppManifest::new().commands(&[...])` (`minimize`, `close`, `toggle_maximize`, `is_maximized`, `toggle_pin`, `get_pin`, `set_counts`, `set_widget`), which turns each into an `allow-<command>` permission. The one capability, for the window `main` only, lists just those permissions: no `core:default`, no plugin permission (notification, opener, autostart, window-state are used from Rust only).
  - The capability's `remote.urls` is the engine's origin. Preferred: built at runtime with the exact port (`CapabilityBuilder::new("office").remote("http://127.0.0.1:<port>/*")`, cargo feature `dynamic-acl`). Fallback if that does not work: a static file with `http://127.0.0.1:*/*` (URLPattern syntax; not stated in the docs whether the port wildcard needs the path part: test it in T3), which is still safe because `on_navigation` keeps the window on the engine's own port, so no other local server can ever be loaded in it.
  - Rust → page messages (`onMaximized`, `onGoto`) go through `webview.eval()` of a fixed call with JSON-encoded data, so the page does not need `core:event:allow-listen`.
  - No command takes a path, a URL or a command line; `set_counts` takes four numbers, `set_widget` a boolean. The page cannot install hooks, start processes or open URLs through the shell: those stay in the tray menu (Rust) and in the engine's own API with its Host and Origin checks.
  - Known limit from the docs: on Linux Tauri cannot tell an iframe on an allowed origin from the window. The office pages only allow frames from themselves (CSP `default-src 'self'`, `frame-ancestors 'none'`), so no foreign iframe can get the commands.
- Checked: the plan's links and the commands above against the docs pages listed; `npm test` (temporary home, port 47830, `PLATYPUS_DATA_DIR`) ends with "Tutto a posto.".
- Questions for Max: may I install Rust (rustup, stable MSVC toolchain, 1.90+) and the Microsoft C++ Build Tools ("Desktop development with C++") on this PC? WebView2 is already part of Windows 11. On the Linux computer the packages above would be needed for the `[linux]` tasks. Until then I go on with T2 and T9.

### 2026-11-18 · T2 · Notifications decided by the engine

- Done:
  - New `src/core/notify.js` (`Notifier`): the logic that was in `src/main.js` (`checkWaiting`, `checkAlerts`, `checkReport`, `scheduleWaitCheck`) moved there unchanged: same texts, same 300 ms debounce after a state change, waits already in progress at start-up are not notified, demo sessions and finished agents are skipped, alerts of kind `wait` are skipped, `alertsNotify: false` silences alerts, the report comes once a day after `reportHour` and not for an empty day (except with `PLATYPUS_NOTIFY_TEST`).
  - It emits `notify` events `{kind: 'wait'|'alert'|'report', title, body, sid, key, n}`. `key` is `wait:<sid>:<agent>`, `alert:<sid>:<alert>` or `report:<YYYY-MM-DD>`, for shells that want a notification tag.
  - `src/core/index.js` (small hooks only): creates the notifier next to `stats`, exposes it as `core.notify`, stops it in `stop()`, and serves `GET /api/shell/events`. That stream sends `event: counts` (the engine's own `state.counts()`, at once and then only when they change) and `event: notify`, plus a comment ping every 20 s. It sits behind the same Host and Origin checks as every other route, and it is a separate set of clients: it does not count as an open office window, so a permission is not held for it. `/events` and `/platypus-hook/feedback` are untouched.
  - `src/main.js`: Electron subscribes with `core.notify.on('notify', showNotice)`. `showNotice` keeps the shell-side rules: the tray option "Notifiche per i permessi" (`cfg.notify`), `canNotify()` (no toasts in snapshot mode), no wait or alert toast when the window is visible and focused, a click on a wait or alert brings the window up and goes to that floor, a click on the report opens `/report`.
- Decisions:
  - The engine decides *when* there is something to say; the shell decides *whether* to show it. So `cfg.notify` (a tray option stored in Electron's `config.json`) and the "window already focused" rule stay in the shell; `alertsNotify` and `reportHour` (engine settings) are applied by the engine. The Tauri shell will need its own `notify` option (T4).
  - The day of the last report is now kept by the engine in `notify.json` next to `settings.json` (so both shells share it and a second shell does not show the report again). Electron hands over its old `cfg.reportDay` once at start (`seenReport`), only if it is today. The report is only "consumed" when someone listens (Electron in-process or a shell on the stream), so the browser mode does not swallow it.
  - Notifications still skip the demo sessions, as before. The smoke test therefore checks with a permission on a non-demo session (`smoke-1`) posted while the demo is running.
- Checked:
  - `npm test` (temporary home, port 47830, `PLATYPUS_DATA_DIR`): "Tutto a posto.". New `scripts/unit-notify.js` (14 checks: start-up priming, no duplicates, again after working, two waits in one toast, demo and finished skipped, alerts and `alertsNotify`, report hour, once a day, restart on the same day, empty day, report off, hand-over of Electron's day). New smoke checks: the stream sends counters at once, a permission during the demo arrives on the stream and in-process exactly once, the counters see the wait, another Origin or Host gets 403, and the permission is still not held (204).
  - `npm run i18n:check`: 0 missing (the texts kept the same keys).
  - Electron itself, from the binary already in the main checkout's `node_modules` (nothing installed), in snapshot mode with `--demo`, port 47830, temporary home: a permission posted to the engine reached `showNotice` (`[notify] wait | CLAUDE is waiting for you | Floor 4 · t2 / Needs your OK: Runs: ls`), the screenshot shows the office with floor 4 waiting, and the process exited by itself.
- Doubts for Max: none blocking. The tray option "Notifiche per i permessi" stays per shell: if you want it shared between Electron and Tauri, it could move into the engine's settings later.

### 2026-11-18 · T9 · Docs

- Done:
  - `docs/ARCHITECTURE.md`: the section "Moving to Tauri (or another shell)" became "Tauri shell (experimental)": how it is made (own folder, engine as a Node child process or attach to a running one, window on the engine's URL, `officeApp` over `invoke` with one permission per command, notifications from `/api/shell/events`, plugins used from Rust only), the limits known from the Tauri 2 docs, and where the measurements will be. Also added `notify.js` to the engine table, `GET /api/shell/events` to the API table, the engine/shell split of notifications in "Desktop shell", and `~/.platypus/notify.json` to "Data on disk".
  - `docs/ARCHITETTURA.md`: the same changes in Italian.
  - "For the CHANGELOG" above: draft notes for T2 and T9.
- Decision: the installation guides (`docs/INSTALL.md`, `docs/INSTALLAZIONE.md`) are **not** changed here. `docs/plans/parallel.md` reserves them for the integration (only the platform-tests plan may touch them, in its X2 task, which would also make a merge conflict likely), and when two rules disagree the more cautious one wins. The draft for both guides is below, ready to paste at integration, to go after "Browser mode" / "Modalità browser".
- Also decided: the architecture section describes the design decided in T1 and T2, and says so. It must be refreshed when T3–T7 close (the close decision of T3, the real limits found in T4–T5, the link to `tauri-measurements.md` from T7).
- Checked: links and names against the code (`src/core/notify.js`, `src/core/index.js`, `src/main.js`); `npm test` with a temporary home: "Tutto a posto."; `npm run i18n:check`: 0 missing.

Draft for `docs/INSTALL.md`:

```markdown
## Tauri shell (optional, experimental)

Electron stays the default and needs nothing of this. The Tauri shell in `shells/tauri/` is there to compare size, memory and start-up time; to build it from source you need, on top of Node.js:

- **Rust** 1.90 or newer, through [rustup](https://rustup.rs).
- **Windows:** the Microsoft C++ Build Tools with "Desktop development with C++", and `rustup default stable-msvc`. WebView2 is already part of Windows 10 (1803 and later) and Windows 11.
- **macOS:** the Xcode Command Line Tools (`xcode-select --install`), macOS 10.15 or newer.
- **Debian / Ubuntu:** `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **Fedora:** `sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel` and `sudo dnf group install "c-development"`
- **Arch:** `sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool`

Then `npm run tauri:build` once (the first build takes several minutes) and `node scripts/launch.js --shell tauri`. Without a build, the launcher explains how to make one and opens Electron.
```

Draft for `docs/INSTALLAZIONE.md`:

```markdown
## Guscio Tauri (facoltativo, sperimentale)

Il guscio predefinito resta Electron, che non ha bisogno di niente di tutto questo. Il guscio Tauri in `shells/tauri/` serve a confrontare dimensioni, memoria e tempo di avvio; per compilarlo dai sorgenti servono, oltre a Node.js:

- **Rust** 1.90 o più recente, con [rustup](https://rustup.rs).
- **Windows:** i Microsoft C++ Build Tools con "Sviluppo di applicazioni desktop con C++", e `rustup default stable-msvc`. WebView2 c'è già in Windows 10 (dalla 1803) e in Windows 11.
- **macOS:** gli Xcode Command Line Tools (`xcode-select --install`), macOS 10.15 o più recente.
- **Debian / Ubuntu:** `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **Fedora:** `sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel` e `sudo dnf group install "c-development"`
- **Arch:** `sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool`

Poi una volta `npm run tauri:build` (la prima compilazione richiede alcuni minuti) e `node scripts/launch.js --shell tauri`. Senza una compilazione, il lanciatore spiega come farla e apre Electron.
```

The commands `npm run tauri:build` and `--shell tauri` come with T3 and T6: check the draft against them before pasting it.

### 2026-11-18 · Rust installed (Max's permission)

- Max allowed installing Rust and the Microsoft C++ Build Tools ("Sì, installa", given in the Tauri session's chat).
- Checked first: WebView2 runtime 157.0.4341.60 already present; **Visual Studio Build Tools 2022 17.14 already installed**, with the C++ workload (MSVC 14.44.35207) and the Windows 10/11 SDK 10.0.26100.0. So nothing was installed for them.
- Installed: `rustup-init.exe` (12.8 MB, from `https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe`, SHA-256 checked against the published `.sha256`), run as `rustup-init.exe -y --default-toolchain stable --profile minimal --default-host x86_64-pc-windows-msvc`. Result: rustup 1.29.3, rustc 1.100.0, cargo 1.100.0, toolchain `stable-x86_64-pc-windows-msvc`. Files: `%USERPROFILE%\.rustup` (about 600 MB) and `%USERPROFILE%\.cargo` (bin and the crate cache); `%USERPROFILE%\.cargo\bin` added to the user `PATH`.
- To remove it: `rustup self uninstall` (removes both folders and the `PATH` entry). The build output of the shell is in `shells/tauri/src-tauri/target` (about 2 GB after a debug build), deleted with the worktree or by `cargo clean` there.
- Note for every check: the engine runs with a temporary home, but `cargo` needs the real one, so builds get `CARGO_HOME` and `RUSTUP_HOME` pointing to the real folders.

### 2026-11-18 · T3 · Skeleton of the shell

- Done:
  - `shells/tauri/`: `package.json` with only `@tauri-apps/cli` 2.12.5 and the scripts `dev` (`tauri dev -- -- --demo`) and `build` (`tauri build --no-bundle`: only the program, no installer), its own `.gitignore`, a placeholder `frontend/index.html` (Tauri wants a frontend folder; the window never shows it).
  - `src-tauri/`: `Cargo.toml` (tauri 2.12.7, `tauri-plugin-opener`, `tauri-plugin-dialog` for the error and confirmation windows, serde, `sys-locale`; release profile with LTO, `opt-level = "s"`, strip), `Cargo.lock`, `build.rs` (the app manifest with the shell's commands), `tauri.conf.json` (identifier `com.platypus.desktop`, the same as Electron's AppUserModelID; no windows in the config, `withGlobalTauri: false`), icons made with `tauri icon` from `build/icon.png` (only the desktop ones kept).
  - `src/engine.rs`: finds `node` (`PLATYPUS_NODE` or `PATH`) and the repository (`PLATYPUS_ROOT`, or the first parent of the program with `src/standalone.js`, or the source tree), chooses the port (`PLATYPUS_PORT`, else 47800), probes it with `GET /api/state` (Free / Platypus / Other), and starts `node src/standalone.js --no-open --parent-stdin [--demo]` with no console window, waiting 15 s at most (it fails early if the engine exits).
  - `src/office.rs`: the window and the whole `officeApp` contract (`minimize`, `close`, `toggleMaximize`, `isMaximized`, `onMaximized`, `togglePin`, `getPin`, `setCounts`, `setWidget`, `onGoto`), the mini mode, the navigation rules (the same as `src/urls.js`), and a snapshot mode for checks (`PLATYPUS_SNAPSHOT`, `PLATYPUS_SNAPSHOT_JS`, `PLATYPUS_SNAPSHOT_DELAY`, like Electron's; it prints the window state instead of an image).
  - `src/standalone.js`: new `--parent-stdin`. The engine stops cleanly (saves, closes pending permissions) when the shell closes its stdin, also if the shell crashes, so no engine is left running alone. On exit the shell closes the stdin, waits 3 s, then kills the process.
- Decisions:
  - **`close` quits** the app (and the engine, if this shell started it), as in Electron. The tray (T4) keeps "Show the office" but the window is not hidden in the tray: the two shells behave the same, which is what the measurements compare.
  - The T1 security design is implemented as decided, with the **capability built at start-up with the exact origin** (`CapabilityBuilder` with `local(false)`, `remote("http://127.0.0.1:<port>/*")`, window `main`, one `allow-<command>` each). Tauri's own source (`webview/mod.rs`) confirms that a remote origin always goes through the ACL, so no static capability file exists. A debug-only `report` command is granted only when `PLATYPUS_SNAPSHOT_JS` is set.
  - The window is created hidden and shown when the page has loaded (no white flash), like Electron's `ready-to-show`.
  - With `PLATYPUS_DATA_DIR` the shell's preferences go in `<dir>/tauri/config.json` and the WebView2 data in `<dir>/tauri/webview`; otherwise in the app's config folder.
  - The few messages written before the engine runs (node missing, port taken, engine not starting) are in Italian or English in Rust, chosen like `resolveLang` (the `lang` of the engine's settings, else the system locale): the engine cannot translate them because it is not running yet.
- Checked (temporary home, port 47830, `PLATYPUS_DATA_DIR`, the shell started and stopped by its PID):
  - first debug build: 54 s on this PC (crates already downloaded).
  - `npm run dev` in `shells/tauri`: builds, starts `platypus.exe --demo`, the engine starts with the demo (4 floors, 42 agents counted through `setCounts`), the window becomes visible; on exit the engine stops and port 47830 is free.
  - title bar from the page (snapshot JS clicking `#btn-max` and calling `officeApp`): full screen on and off, with `onMaximized` delivering `[true, false]`; maximized window 2560×1540 on a 2560×1600 screen (the taskbar stays visible); pin toggles and comes back; mini mode is 380×150 logical (475×187 at 125 %) at the bottom right of the work area, always on top. Screenshots looked at: the office maximized, and the mini strip with its three waiting items.
  - security from the page: `window.__TAURI__` is undefined; `plugin:opener|open_url`, `plugin:event|listen`, `plugin:window|close` and `plugin:dialog|message` are all denied; a navigation to another origin is blocked (the page stays on `http://127.0.0.1:47830/`).
  - attaching: with an engine already on 47830 the shell attaches (`attached: true`) and leaves it running on exit (I then stopped my engine by its PID).
  - `PLATYPUS_NODE` pointing to a missing file: a clear error window ("Node.js (node) was not found in the PATH…", screenshot looked at) and exit code 1.
  - `npm test`: "Tutto a posto.", with a new check that `--parent-stdin` makes the engine exit by itself (the child gets its own fake home); `npm run i18n:check`: 0 missing.
- Not checked yet: the Linux and macOS builds (T8), the remembered position (T5).

### 2026-11-18 · T4 · Tray and notifications

- Done:
  - Engine (`src/core/notify.js`, small hook in `index.js`): the shell stream now also carries the tray texts, already translated, so the Rust shell never translates anything. `counts` gained `label` (the first menu item) and `tooltip`, built exactly as in `buildTrayMenu()`; a new `menu` event carries `texts` (every menu item, plus the texts of the "connect to Claude Code" confirmation and its result), `hooks`, `demo`, `cowork` and `base` (the Claude Code folder). It is sent at connection and whenever it changes, also when the language changes in the options (`lang` event). `index.js` passes a `shellInfo()` function with those four values. No new keys: all texts already existed for Electron, so `tauri.json` is still not needed.
  - Shell (`shells/tauri/src-tauri/src/tray.rs`, `engine.rs`): the tray icon (from `build/tray@2x.png`) with the same items as Electron: counters (disabled), show the office, always on top, demo mode, notifications for permissions, show Cowork sessions, connect / disconnect Claude Code, today's report, open in the browser, open the Claude Code folder, quit. Left click shows the window or minimises it if it is in front. Actions: demo and Cowork through `POST /api/demo` and `POST /api/cowork`, report and browser through the opener plugin, the folder with `open_path`. "Start at login" comes with T5.
  - Connect to Claude Code: a confirmation window (the same texts as `askHooksOnce`), then `node src/hooks-cli.js install` for the engine's port, and a window with what it printed; disconnect runs `uninstall`. Asked once at first start, like Electron (once per shell: the two shells keep separate preferences). In the automatic checks only `status` runs.
  - Notifications: a reader thread on `/api/shell/events` (plain HTTP/1.0, reconnects after 1.5 s), the `notification` plugin, and Electron's rules (`notify` option of the shell; no wait/alert toast while the window is visible and focused). A wait also flashes the window if it is not in front.
  - The icon gets a red dot while someone is waiting (the plan asked for it; Electron keeps a fixed icon and only changes tooltip and menu).
  - The shell's preferences gained `notify`, `show_cowork` (passed to the engine as `--no-cowork` when this shell starts it) and `asked_hooks`.
- Decisions and limits:
  - Instead of `GET /api/i18n?keys=…` or `/i18n.js`, the texts travel on the shell stream (`menu` and `counts`). It is one place, it follows the language at once, and the keys stay in a `.js` file, so `npm run i18n:check` still sees them.
  - A click on a desktop notification cannot be intercepted with `tauri-plugin-notification`. So the floor of the last wait or alert is remembered, and the next time the window is opened from the tray (within two minutes) the page goes there (`onGoto`). It is not the same as Electron's click, but close.
  - On Windows, from a build that is not installed, the toast shows "Windows PowerShell" as its sender (seen on screen). The Start menu shortcut with our AppUserModelID is T6's job.
  - On Linux the tray has no click event and no tooltip (Tauri docs): there, everything is in the menu. Not tested yet (`[linux]`).
- Checked (temporary home, port 47830, `PLATYPUS_DATA_DIR`, snapshot mode with `PLATYPUS_SNAPSHOT_MENU` choosing items by id):
  - the menu is built with the engine's texts and counters ("Sessions: 4 · Agents: 44"), and follows them as the demo runs, including "1 waiting" with its tooltip;
  - chosen from the menu: Cowork off (engine and saved option), notifications off and on again, Claude Code `status` through `hooks-cli` ("Platypus hooks: not installed / Feedback hooks: not installed": nothing installed), demo off (the engine stops the demo and the menu shows it);
  - a permission posted to the engine during the run reaches the shell and is shown as a real Windows toast with `PLATYPUS_NOTIFY_TEST=1` (looked at on screen, then the capture was deleted because it showed other windows too);
  - language: `POST /api/settings {"lang":"it"}` turns the menu, counters and tooltip into Italian at once, and `auto` brings them back to English;
  - `cargo test`: the waiting icon has the red dot in the corner and the rest is unchanged;
  - `npm test`: "Tutto a posto.", with two new checks on the `menu` event and on the counters' texts; `npm run i18n:check`: 0 missing.
- Not checked: really installing or removing the hooks (not in the tests, by the plan's rule); Linux and macOS.

### 2026-11-18 · T5 · Mini mode, window and start-up

- Done (`shells/tauri/src-tauri/src/office.rs`, `startup.rs`, `main.rs`, `tray.rs`):
  - Mini mode was already complete in T3 (a 380×150 strip in the bottom-right corner of the work area of the screen the window is on, always on top, back to the previous position and size on exit; maximize from mini goes back to normal first).
  - Single instance: `tauri-plugin-single-instance`, registered first; a second start brings the first window to the front (`show_window`, which also goes to the floor of a recent notification).
  - Position and size remembered in the shell's `config.json` (`bounds`, physical pixels), saved 400 ms after the last move or resize, never for the mini strip, maximized or minimised. At start the saved place is used only if it passes the same check as `fitBounds` in `src/bounds.js` (the top of the window at least 120×40 px inside a connected screen; the size never larger than the main screen), with three Rust tests for it.
  - Start at login: `tauri-plugin-autostart` with **the same entry name as Electron** on each system: Windows `com.platypus.desktop` in `HKCU\…\Run` (Electron's default name is its AppUserModelID), macOS `~/Library/LaunchAgents/com.platypus.desktop.plist`, Linux `~/.config/autostart/platypus.desktop`. One name means there can never be two entries. Each shell shows "Start at login" as on only if the entry starts its own program, so turning it off in one shell never removes the other's entry, and turning it on replaces it. The tray item is back in the menu.
  - Wayland (Linux): like Electron, on native Wayland (`WAYLAND_DISPLAY` set and `GDK_BACKEND` not `x11`) the PIN is reported off and cannot be turned on, the saved position is not applied and x/y are not overwritten with Wayland's zeros. `GDK_BACKEND=x11` would run it in XWayland.
  - `config.json` is also read when saved with a UTF-8 BOM (Windows PowerShell 5.1 writes one; found during the check).
- Decisions:
  - Position memory is our own code instead of `tauri-plugin-window-state`: it keeps Electron's exact rule for disconnected screens and stores the data in the shell's own folder (so `PLATYPUS_DATA_DIR` keeps it apart in the checks).
  - `PLATYPUS_AUTOSTART_NAME` overrides the entry name, only for the checks: on Windows the Run key is in the real registry (a temporary home does not move it), and the checks must never touch a real entry.
  - The single-instance lock is per identifier, not per `PLATYPUS_DATA_DIR` as in Electron. That is enough today (Max does not run the Tauri shell), but two Tauri shells with different data folders cannot run at the same time.
- Checked on `[win]` (temporary home, port 47830, `PLATYPUS_DATA_DIR`):
  - saved place 300,200 1000×640 → the window opens exactly there, and it is saved again on exit; saved x = 9000 (a screen that is not there) → the size is kept and Windows chooses the position.
  - a second start exits after 48 ms with code 0 and the first one gets the event (`[second-instance]`).
  - start at login with the test name `com.platypus.desktop.loop-test`, starting from an Electron-like value (`"C:\fake\electron.exe" "D:\fake\platypus"`): the item shows off (not ours), choosing it writes our program's path, choosing it again removes the value. `auto-launch` leaves its `StartupApproved\Run` value behind; I removed both test values. Before the test the real Run key had no Platypus entry, and it was not touched.
  - `cargo test`: 4 tests; `npm test`: "Tutto a posto."; `npm run i18n:check`: 0 missing.
- **Open, for the Linux computer (`[linux]`)**: the `~/.config/autostart/platypus.desktop` entry, and whether always on top and the position work in WebKitGTK on Wayland and in XWayland (`GDK_BACKEND=x11`); if XWayland works, the PIN could offer it as Electron does. Not possible on this PC.

### 2026-11-18 · T6 · Launcher

- Done:
  - `scripts/launch.js`: `--shell tauri` (or `--shell=tauri`). If `shells/tauri/src-tauri/target/release/platypus(.exe)` exists, it starts it with the other options (`--demo` …), also with `--background`. If it does not exist, it says (in Italian and English) that Rust is needed, points to the Tauri section of the architecture docs and to `npm run tauri:build`, and then follows the normal Electron path. `--shell` and its value are never passed on. An unknown shell name falls back to Electron with a message.
  - `package.json` (main): only two scripts, no dependency: `tauri:dev` and `tauri:build` (`npm --prefix shells/tauri install`, then `run dev` / `run build`).
  - `[win]` notifications from source: `tauri-plugin-notification` sets the app's ID only for an installed program, so from `target\release` the toasts said "Windows PowerShell" (seen in T4) and a click did nothing. New `winnotify.rs`: on Windows the shell shows its toasts with `tauri-winrt-notification` (already a dependency of the plugin) and the ID `com.platypus.desktop` (the same as Electron), registered at start under `HKCU\Software\Classes\AppUserModelId\com.platypus.desktop` with `DisplayName` "Platypus" and `IconUri` `build/icon.png`. A click on the toast now opens the office on the notification's floor, as in Electron. macOS and Linux keep the plugin.
- Decisions:
  - No Start menu shortcut for Tauri. The registry registration of the ID is what Windows needs for a program that is not installed, it leaves Electron's `Platypus.lnk` alone (Electron rewrites it at every start with its own target), and the two shells share the ID, so their toasts look the same.
  - `PLATYPUS_AUMID` overrides the ID, only for the checks: the registration is in the real registry, so the checks use a test ID and remove it.
- Checked:
  - the missing build: `launch.js --shell tauri --demo` with `child_process` replaced by stubs (nothing installed, nothing started), before the first release build: the two messages, then the Electron path (`npm ci` attempted, then the browser mode as usual when npm fails), and the engine got only `--demo`.
  - first release build with `npm run tauri:build` from the repository: 2 min 34 s on this PC (crates already downloaded by the debug build), `platypus.exe` 5,063,680 bytes.
  - `node scripts/launch.js --shell tauri --demo` (temporary home, port 47830, snapshot mode): the release program starts, the engine starts with the demo, the menu and counters arrive, it quits and port 47830 is free. With `--shell=tauri --background` the launcher returns after 94 ms, the engine answers while the shell runs, and the port is free after the shell quits.
  - toasts with the test ID `com.platypus.desktop.loop-test`: a permission posted to the engine is shown, and Windows lists the toast in that ID's notification history ("CLAUDE is waiting for you | Floor 1 · t4 | Needs your OK: Runs: ls"), with the registry key holding "Platypus" and the icon. I cleared that history and removed the test key; the real `com.platypus.desktop` key was not created.
  - `cargo build` without warnings; `npm test`: "Tutto a posto."; `npm run i18n:check`: 0 missing.
- Not checked: a real click on a toast (it needs a person or UI automation); it is wired to `show_window` with the floor.

### 2026-11-18 · T7 · Measurements

- Done: `docs/plans/tauri-measurements.md` with the Windows table and the method, and `shells/tauri/scripts/measure-win.ps1` (one run per call: temporary home, port 47830, `PLATYPUS_DATA_DIR`, demo; start-up time, then the memory of the whole process tree after 2 minutes; it stops what it started by PID). The architecture docs (both languages) now link the results.
- Results on `[win]` (medians of 3): size 4.8 MB (Tauri) against 369.3 MB (Electron); working set after 2 minutes 625.7 MB against 599.4 MB, private bytes 417.7 MB against 371.1 MB (WebView2 is about 510 MB of Tauri's, the Node engine about 80 MB); start-up to `/api/state` with the window visible 983 ms against 994 ms; first build debug 54 s, release 2 min 34 s.
- A change found by measuring: the shell waited for the engine with a 400 ms connect timeout and 200 ms pauses, and on Windows a closed local port is not refused at once, so Tauri started in a median 1.77 s. With 100 ms and 50 ms (`engine.rs`) it starts like Electron. The memory runs were made before this change; it does not touch memory.
- Doubts for Max: on Windows the numbers say that Tauri saves disk (and download) but not memory or time, because the office is drawn by Chromium in both shells. Linux (WebKitGTK) may tell a different story and is still to be measured on the Linux computer.
- Checked: three alternating runs per shell for each number; every run left port 47830 free; the repository script was run once per shell with its defaults. `npm test`: "Tutto a posto."; `npm run i18n:check`: 0 missing.
- **Open, for the Linux computer (`[linux]`)**: the same table on Linux.

### 2026-11-18 · T8 · GitHub Actions (written, not run: needs a push)

- Done:
  - `--smoke` in the shell: it starts (or attaches to) the engine, waits until the window has loaded the office, prints `[smoke] ok: …` and exits with 0; on any engine error it exits with 1 without dialogs, and after 120 s with no window it exits with 1. In `--smoke` and snapshot mode there are no dialogs, no toasts and no registration of the real toast ID.
  - **`.github/workflows/tauri.yml`, a separate workflow, not a job in `ci.yml`.** GitHub's `paths` filter applies to a whole workflow, not to one job, so "only when `shells/tauri/**` changes" needs its own file (or a path-filter action, which would add a third-party action). It also leaves `ci.yml` untouched, which the platform-tests loop edits too. Triggers: `workflow_dispatch`, and `push`/`pull_request` on `shells/tauri/**` and the workflow itself.
  - The job, on `ubuntu-latest`, `macos-15-intel` (as in `ci.yml`, for runner capacity) and `windows-latest`: checkout and setup-node pinned to the same commit hashes as `ci.yml`; Rust stable from the rustup already on the runners (no third-party action); on Linux the WebKitGTK packages from the prerequisites plus `xvfb` and `dbus`; `time npm run tauri:build`; the program started once with `--smoke --demo` (on Linux inside `dbus-run-session` and `xvfb-run`, because single-instance uses DBus there); a `size-<os>.txt` artifact with the program's size, `retention-days: 3`. The program itself is never uploaded. `permissions: contents: read`, `persist-credentials: false`, a 45-minute timeout.
- Checked, locally only:
  - `--smoke --demo` exactly as the workflow step runs it (Git Bash, release build, temporary home, port 47830): `[smoke] ok: started the engine on port 47830, the window loaded the office`, exit 0 after 2.2 s, port free afterwards. With `PLATYPUS_NODE` pointing to a missing file: exit 1, no dialog.
  - the workflow parses as YAML (Python `yaml.safe_load`): one job, the three triggers and the eight steps in order. Re-read by hand against `ci.yml` (pins, permissions, artifact settings). Fixed while re-reading: macOS runners have no GNU `timeout`, so outside Linux the step relies on `--smoke`'s own 120 s limit.
- Found and fixed during T8: the T6 launcher checks and the T7 measurements had started the shell without `PLATYPUS_AUMID`, so it had registered the real toast ID `com.platypus.desktop` under `HKCU\Software\Classes\AppUserModelId` (pointing to this worktree's icon). The key did not exist before T6 (checked then) and Electron does not use it; I removed it. Now the shell never registers the real ID in snapshot or `--smoke` mode, and `measure-win.ps1` uses a test ID and removes it.
- Also refreshed (as the T9 entry asked): the Tauri section of both architecture docs now says how to start it, that closing quits, the Windows toasts, the position rule, and the plugins actually used (no `window-state`).
- Not checked: the Actions themselves. On macOS they are the only proof possible; the logs must be read carefully. Possible issues to look for on Linux: WebKitGTK under Xvfb (if the window does not load, try `WEBKIT_DISABLE_COMPOSITING_MODE=1`), and the tray without a StatusNotifier host (warnings expected, not a failure).
- **Question for Max:** may I push the branch (`claude/sviluppo-tauri-66442e`) to GitHub so the "Tauri shell" workflow runs? Nothing else would be done there: no pull request, no merge.

