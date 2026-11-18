# Platypus · Real tests on Windows and Linux, macOS through Actions, the structure of Cowork

This is the English version of Max's `PIANO-PIATTAFORME.md`, adapted to the code after 2.11.

Plan to carry out step by step, one task at a time. It lives in the repository at `docs/plans/platform-tests.md`.

Checkboxes:
- `[ ]` to do;
- `[~]` in progress;
- `[x]` done;
- `[!]` blocked, with the reason below it.

**The labels say where a task is done:**
- `[win]` on the Windows PC (the development computer, Windows 11), branch `prove-windows`;
- `[linux]` on the Linux computer, branch `prove-linux`;
- `[ci]` anywhere, because it only uses GitHub Actions.

Each loop takes **only the tasks with its own label**, and the `[ci]` tasks nobody has taken yet.

Each computer writes only in its own Journal (Journal (Windows) or Journal (Linux)), to avoid conflicts.

## The goal

So far Platypus has only been tested for real on Linux, in a container with no screen. On Windows and macOS there are only the GitHub Actions. This plan:

1. tests it the way a person would use it, on a real Windows PC and a real Linux desktop;
2. strengthens the automatic checks for macOS, where there is no Mac;
3. studies how the Claude desktop app really stores Cowork sessions, and adapts the search.

## Rules on top of `docs/plans/parallel.md`

- **Test like a user:** every test starts from a clean clone, in a separate folder, and uses the launchers (`start.cmd`, `start.sh`, `start.command`, which call `scripts/launch.js`), not developer shortcuts.
- **Tests that touch the system** (registry, Start menu, autostart, shortcuts) are undone at the end. The Journal says what was created and how it was removed.
- **Before starting**, make a backup of `~/.platypus` and, if needed, of `~/.claude/settings.json`; at the end, put them back.
- **Claude Code hooks:** installing them is needed for the permissions test (W4). **Ask Max** before doing it; after the test, remove them and check that `settings.json` is identical to the backup. This covers both the observing hooks (`npm run hooks:install`) and the feedback hooks (`npm run hooks:install -- --feedback`).
- **Never run `claude`** (a real Claude Code session on Max's account) unless Max says so at that moment. An earlier yes does not cover the next run.
- **Max's real data** (transcripts, project names, Cowork folders): look at them only with his permission, and only the **anonymized structure** goes into the repository:
  - folder names with identifiers replaced by `<uuid>` and `<user>`;
  - number and type of files;
  - names of JSON fields, never the values.
- **Every bug found:**
  - gets a row in the "Bugs found" table;
  - is fixed in its own commit;
  - when possible, gets an automatic test that would have caught it.
- **New strings in the interface** go through `tr`/`trn` with Italian keys, and the English translation goes in `src/i18n/locales/en/platform.json`.
- **Bringing commits over from the other computer:** the other computer's branch reaches the main repository only with `git push origin <branch>`, and **only** if Max allows it at that moment. Never push to main. Pushing a branch to run GitHub Actions is the same: **stop and ask**.

### Rules for the Windows PC (it is also Max's own computer)

The `[win]` tasks run on the development computer, next to Max's own Platypus, which is usually running: port 47800, data in `~/.platypus`, Electron data in `%APPDATA%\Platypus`, and possibly "Start when I log in" turned on.

- **Never connect to, stop or reconfigure Max's running Platypus.** Test copies use another port and a temporary home (`USERPROFILE`, `HOME`, `CLAUDE_CONFIG_DIR` on an empty folder), as in `scripts/feedback-check.js`.
- **Before any system test** (Start menu entry, `HKCU\...\Run` key, desktop shortcut, autostart), record exactly what exists already (Max's own entries). At the end, **restore exactly that state**, and write the before and after in the Journal (Windows).
- **If a test would overwrite one of Max's existing entries with the same name, stop and ask.**

---

## W · Windows

### W1 · Install from scratch  [x] [win]

- Note down:
  - the Windows version;
  - the architecture (x64 or arm64);
  - the Node and Git versions;
  - whether the user folder has spaces or accents or lives in OneDrive.
- **The path of a new user:** clone into a folder with a space in its name (for example `C:\Platypus Tests\platypus`), then double-click `start.cmd` or, from the terminal, `cmd /c start.cmd`. Use another port than Max's (see the rules above).
- **Check:**
  - the Electron install;
  - the window that opens;
  - the terminal that is freed;
  - `launch.log`.
- **Second start:** it must not run `npm ci` again. Also try with the repository updated after a simulated `git pull` (change `package-lock.json` in a test branch).
- **Without Electron:** `npm run web` must work even if Electron was never installed.

### W2 · System  [x] [win]

Follow the rules for the Windows PC above: record Max's entries first, restore them at the end.

- **Start menu:** the entry is created, with the AppUserModelID (`com.platypus.desktop`).
- **Notifications:** a test notification appears from the demo, and the click leads to the right plan.
- **Tray icon:**
  - every menu item works;
  - the icon changes with the waits.
- **Start when I log in:**
  - on: there is a key in `HKCU\...\Run` with the right path;
  - off: the key disappears;
  - no entry is left with the old name "Agent Office".
- **`npm run shortcut`** (it runs `scripts/launch.js --shortcut`, which calls `scripts/shortcut.js`): the shortcut on the Desktop works and has the right icon.
- **Mini mode:** with two screens, if there are any.
- **At the end** remove everything you created, and check that Max's own entries are as they were.

### W3 · Real windows and sessions  [ ] [win]

At least one real Claude Code session is needed: ask Max to open one, or open it yourself in a test folder, if he agrees (and see the rule: never run `claude` without Max saying so at that moment).

- **GO TO THE WINDOW:** try with Windows Terminal, PowerShell, cmd and VS Code.
- **Resume the session** and **open the folder**.
- **Agents and subagents:** they show up with the right model, age and effort.
- **WSL**, if there is a distribution:
  - sessions launched inside WSL show up;
  - with the normal network the hooks inside WSL do not arrive; with the mirrored network they do, if Max wants to try it.

### W4 · Permissions from the balloon, and feedback hooks  [ ] [win]

- **With Max's permission:**
  1. install the hooks;
  2. open a test Claude Code session that asks for a permission;
  3. answer YES, ALWAYS and NO from the balloon, and check that Claude Code gets the answer.
- **Edge cases:**
  - Platypus closed while Claude Code is waiting: Claude Code must go on with its normal question within the `curl -m` time;
  - a wait longer than `approveWaitSec`;
  - two permissions at once.
- **`curl.exe`:** check that it is the Windows one, because some installations put a PowerShell alias in its place.
- **Feedback hooks (new in 2.11):** with Max's permission, also run the 2.11 real-session check in `docs/plans/2.11-real-check.md` (`node scripts/feedback-check.js`, on a temporary `CLAUDE_CONFIG_DIR`, in a test Platypus on port 47811). It needs the same real Claude Code session, so do it in the same sitting. It covers the `http` hooks to `/platypus-hook/feedback` (installed apart with `npm run hooks:install -- --feedback`), and, if Max wants, the `--curl` variant. Report its results in the Journal (Windows) and, if that document has a results section, in `docs/plans/2.11-real-check.md` too.
- **At the end:** remove the hooks (both kinds) and compare `settings.json` with the backup.

## L · Linux

### L1 · Install from scratch  [ ] [linux]

- Note down:
  - the distribution and version;
  - the desktop (GNOME, KDE, …);
  - whether the session is X11 or Wayland;
  - the Node and Git versions.
- Do the same path as W1 with `./start.sh`. Check:
  - the sandbox (whether it restarts by itself with `--no-sandbox`);
  - missing libraries;
  - that `start.sh` finds a `node` installed with nvm or Volta.
- **Without Electron:** `npm run web` must work.

### L2 · System  [ ] [linux]

- **Tray icon:** with and without the AppIndicator extension on GNOME.
- **Notifications.**
- **`.desktop` and start at login:** `~/.local/share/applications`, `~/.config/autostart`.
- **GO TO THE WINDOW:**
  - on X11 with `xdotool` or `wmctrl`;
  - on Wayland the message must be clear.
- **At the end** remove everything you created.

### L3 · Real sessions and permissions  [ ] [linux]

Like W3 and W4, with the Linux terminals (GNOME Terminal, Konsole, the one in VS Code). The same rules apply for the hooks: ask first, remove after. This includes the 2.11 feedback-hooks check (`docs/plans/2.11-real-check.md`), with Max's permission and only when he says to run `claude`; report its results in the Journal (Linux).

## M · macOS without a Mac

### M1 · System tests that run anywhere  [x] [ci]

- New `scripts/platform-test.js`, called by the Actions and runnable by hand. It works in a temporary `HOME` and does not touch the real system.
- **For each system it tests:**
  - the shortcuts (`scripts/shortcut.js`);
  - autostart, created and removed (`src/autostart.js`; on macOS the LaunchAgent file, on Linux the `.desktop` file in `autostart`; on Windows the registry test is separate, on a test `HKCU` branch);
  - `src/core/osint.js`, at least reading the processes and the tools present;
  - the search for Cowork folders (`coworkRoots()` and `findCoworkBases()` in `src/core/sources.js`) on a fake tree.
- **On macOS**, in addition:
  - `Platypus.app` created with `sips` and `iconutil` has a valid `Info.plist` (`plutil -lint`) and the icon;
  - `start.command` is executable.

### M2 · A richer macOS job  [!] [ci]

Blocked: the workflow is written and its steps were checked on Windows, but following the run needs the branch pushed to GitHub, which needs Max's permission (see the Journal (Windows)).

- **`.github/workflows/ci.yml`** (it already has the "Engine" and "Window" jobs on the three systems, macOS on `macos-15-intel`):
  - runs `platform-test.js` on all three systems;
  - on macOS adds the mini mode check and a screenshot after `PLATYPUS_SNAPSHOT_JS`, which opens the reality map.
- **Check:** follow the run with `gh run watch` (reading only, no push needed if Max has already published the branch; otherwise **stop and ask**).
- **Use:** the macOS screenshots are looked at and commented on in the Journal.

## K · Cowork

### K1 · Study of the structure  [ ] [win]

- **First ask Max** for permission to look at the Claude app folder and to open a local test Cowork session (and do not run `claude` unless he says so then).
- **List the tree** under `%APPDATA%\Claude` (and the other roots from `coworkRoots()` in `src/core/sources.js`, which on Windows also lists `%LOCALAPPDATA%\Claude`, `AnthropicClaude`, `Claude-3p` and the Microsoft Store package folders), with:
  - names and depth;
  - number and size of files;
  - dates.
- **Without reading the contents.** For JSON and JSONL files, only the field names of the first line.
- **What to find out:**
  - where the transcripts end up;
  - whether there is a file with the title and state of the session;
  - how to tell a Cowork session from a Code session of the desktop app;
  - how to recognize an active session;
  - where the virtual machine lives.
- **Use:** write `docs/plans/cowork-structure.md`, **anonymized**.
- **Also note** the version of the Claude app: the structure may change.

### K2 · Targeted search  [ ] [win]

- **Update `findCoworkBases`** (`src/core/sources.js`, called from `scanCowork` in `src/core/index.js` with the `coworkDirs` setting):
  - first try the known paths found in K1;
  - the wide search stays as a fallback, because the structure may change.
- **If K1 found a title and a state:** the title goes on the session's card, the state is used to tell whether it is active.
- **Tests:** a fake tree in `scripts/fixtures/cowork-win/`, the same as the anonymized structure, in the automatic tests (`npm test`, `scripts/smoke-test.js`).
- **Check by hand:** the test Cowork session shows up in the office's Cowork wing.

### K3 · Cowork on macOS and Linux  [ ] [ci]

- **macOS:** carry the K1 structure over to `~/Library/Application Support/Claude`, marking as **to verify** whatever is not confirmed.
- **Linux:** check whether an official Claude desktop app exists (today `coworkRoots()` looks in `~/.config/Claude`, or `$XDG_CONFIG_HOME/Claude`). If there is none, the Cowork section says so in the options instead of searching in vain.

## X · Wrap-up

### X1 · Bugs found  [ ]

| # | System | Problem | Commit | Automatic test |
|---|---|---|---|---|
| 1 | Windows | With Node 24 the launcher printed the `DEP0190` deprecation warning ("Passing args to a child process with shell option true") every time it ran `npm ci` | `7b8ac9f` | `scripts/smoke-test.js`: "avvio: nessun argomento separato con shell" |
| 2 | Windows | Turning "Start when I log in" on or off never removed the start-up value that Agent Office wrote before the rename (`com.agentoffice.desktop` in `HKCU\...\Run`); only the macOS and Linux old entries were cleaned | `39f1831` | `scripts/smoke-test.js`: "Windows: la vecchia voce di avvio «com.agentoffice.desktop» viene tolta" |

### X2 · Documents  [ ]

- **Install guides:** a "Tested on" table, with system, version, date, what works and the limits.
- **Frequent problems:** update the table with what came up.
- **Notes for the changelog:** in the section below.

---

## For the CHANGELOG

(to fill in at the end)

## Journal (Windows)

Conventions of this loop (Windows PC, Max's own computer, port 47850): every run goes through a small wrapper that sets `PLATYPUS_PORT=47850`, `PLATYPUS_DATA_DIR=C:\Platypus Tests\.platypus-dev` and a fresh temporary home (`USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `CLAUDE_CONFIG_DIR`); processes are stopped by the PID found under `C:\Platypus Tests` (never by name). Test clones live in `C:\Platypus Tests\` (outside the repository).

### 2026-11-18 · W1 · Install from scratch

- **Machine:** Windows 11 Pro 10.0.26200 (build 26200), x64 (`AMD64`), Node 24.13.0, npm 11.6.2, Git 2.56.0.windows.4, `curl.exe` is `C:\Windows\system32\curl.exe`. The user folder is `C:\Users\massi` (no space, no accent, not inside OneDrive; OneDrive exists next to it).
- **Path of a new user:** clone of the repository into `C:\Platypus Tests\platypus` (a space in the name), then `.\start.cmd` with the temporary home (so the npm cache and the Electron cache were empty, as for a new user).
  - `npm ci` + Electron download: about 4 minutes on this connection. `node_modules` is 381 MB; the Electron zip is 158 MB (the "~120 MB" in the launcher message is a bit low; harmless).
  - The Electron window opened ("Platypus", 1245x786), the engine listened on 47850 only, `/api/state` answered 200 with zero sessions (so the empty temporary home was honoured: Max's real sessions were not read). Screenshot looked at: the lobby with "INSERT COIN", top bar, floors.
  - The data of the run went into `C:\Platypus Tests\.platypus-dev` (`launch.log`, `electron\...`), nothing in `~\.platypus`.
  - The terminal is freed: with `--background` the second start returned in 5.4 s with exit 0 and the line "Platypus è partito. Puoi chiudere questo terminale.". `launch.log` stays empty when all is well.
- **Second start:** with the same `package-lock.json` it does not run `npm ci` (marker `node_modules\.platypus-deps` matches).
- **Simulated `git pull`:** on a test branch of the clone, `package-lock.json` changed and committed: the next `start.cmd` ran `npm ci` again (1 s, from cache) and started. Done twice (the second time with the fix below).
- **Without Electron:** in a second clone with no `node_modules` at all, `npm run web -- --no-open` printed "Platypus listening on http://127.0.0.1:47850/", `/api/state` answered 200 and the page was served; no `node_modules` was created. (`--no-open` is only to avoid opening Max's browser.)
- **Bug found and fixed** (X1 row 1): the launcher ran `npm ci` with `spawnSync(npm, [args], { shell: true })` and Node 24 printed `DeprecationWarning: [DEP0190]` to the user at every install. Now on Windows it passes one command line; there is a source check in `npm test`.
- **Not a bug, noted:** in this harness `cmd /c start.cmd` says "'start.cmd' is not recognized" because `NoDefaultCurrentDirectoryInExePath=1` is set in the process environment (cmd then does not look in the current folder). Double-click and `.\start.cmd` work. The install guides could say `.\start.cmd` for PowerShell users (see X2).
- **Incident, no damage:** my first `start.cmd` attempt ran without the wrapper's environment (the shell does not keep variables between commands). The launcher reached `startElectron` with Max's real environment, so it **emptied `~\.platypus\launch.log`** (it opens it with `w`) and its Electron exited at once because of the single-instance lock. Max's Platypus (PID 56192, port 47800) kept running; his `settings.json` and data were not touched (timestamps checked). The log held only launcher messages. From then on every command sets the environment itself.
- **State before the system tests (for W2):** `HKCU\...\Run` has `OneDrive`, `OpenVPN-GUI`, `Adobe Acrobat Synchronizer` and `Docker Desktop`; **no Platypus / Agent Office key**. Start menu: Max already has `Programs\Platypus.lnk`. Desktop: no `Platypus.lnk`. A system test that writes the Start menu entry **would overwrite Max's `Platypus.lnk`** (same name): W2 must be done with `APPDATA` on the temporary home, or ask Max.

### 2026-11-18 · W2 · System

How it was run: the window was started from the test clone with the temporary home, port 47850, `PLATYPUS_DEBUG=1` and `PLATYPUS_NOTIFY_TEST=1`, plus `--inspect=9250` so that a small script could talk to the main process (to click the tray menu items and read window bounds). The "session that waits" was a fake transcript written into the temporary home's `.claude\projects` (an unanswered `AskUserQuestion`), because demo sessions never notify (`checkWaiting` skips `s.demo`).

- **Before (Max's entries, recorded and exported):**
  - `HKCU\...\Run`: `OneDrive`, `OpenVPN-GUI`, `Adobe Acrobat Synchronizer`, `Docker Desktop` (no Platypus / Agent Office value);
  - `...\Explorer\StartupApproved\Run`: four values (Edge, OneDrive, OpenVPN-GUI, Docker Desktop);
  - Start menu `Programs`: 29 files, including Max's own `Platypus.lnk` (target `D:\dev\platypus`); Desktop: no Platypus shortcut.
- **Start menu entry:** the window creates `Programs\Platypus.lnk` under the `APPDATA` of the test (the temporary home, so Max's `Platypus.lnk` was never overwritten). Checked with the shell properties: `System.AppUserModel.ID = com.platypus.desktop`, the toast activator CLSID is set, target is the test clone's `electron.exe` with the clone folder as argument, icon `build\icon.ico`.
- **Notifications:** a fake waiting session produced a real Windows toast ("Platypus · CLAUDE is waiting for you / Floor 3 · progetto-finto / Waiting for your answer", with the Platypus icon; screenshot of the corner looked at). Windows registered it under `com.platypus.desktop` (`LastNotificationAddedTime` moved). Clicking the toast with the mouse brought the window to the right floor, twice (floor 4, then floor 5 after going back to the lobby). Note: the toast uses the AppUserModelID of Max's own Platypus too (same ID), so it shows as "Platypus"; it is shown by the test process because the process stays alive and handles the click itself.
- **Tray icon:**
  - every menu item was run through its click handler (menu captured from `Tray.setContextMenu`, `shell.openExternal`/`openPath` replaced by a recorder so that Max's browser and Explorer were not opened): Show the office (restores a minimized window and focuses it), Always on top (on/off/on, `isAlwaysOnTop` follows), Demo mode (4 demo floors appear and go away), Notifications (the checkbox flips off and back on; `config.json` ended with `notify: true`), Show Cowork sessions (`includeCowork` true/false/true), Today's report (`/report` on port 47850), Open in browser (`/`), Open the Claude Code folder (the temporary `.claude`), Start when I log in (see below), Quit (the whole process tree is gone within 4 s, port 47850 free);
  - **not run:** "Connect to Claude Code (install hooks)": it writes hooks, so it waits for Max's permission (W4); and a real right-click on the native tray icon (the menu was checked through its handlers, the native popup was not driven);
  - **the icon does not change with the waits:** the image is fixed (`build\tray.png`). What changes is the tooltip ("Platypus — 5 agents, 0 working, 5 waiting for you"), the first menu line ("Sessions: 5 · Agents: 5 · 5 waiting") and the taskbar button flashing. The plan sentence "the icon changes with the waits" describes a feature that does not exist; I left the code as it is. Decision for Max: do you want a tray icon with a badge?
- **Start when I log in:** on → value `com.platypus.desktop` = `"<clone>\node_modules\electron\dist\electron.exe" "<clone>"` in `HKCU\...\Run` (Electron names the value after the AppUserModelID); off → the value disappears and `StartupApproved\Run` is as before. **Bug found:** a value with the old Agent Office name was never removed on Windows (the old app's value was `com.agentoffice.desktop`, found from the rename commit). Fixed in `src/autostart.js` (a `setLoginItemSettings` call with the old `name`), checked by hand with a fake `com.agentoffice.desktop` value of my own (removed after on/off) and by a new automatic test. Concern for Max: because the value name is the AppUserModelID, every Platypus on the PC (a test clone, the packaged app) shares one start-up entry; switching it on in one and off in another overwrites it. Not changed.
- **`npm run shortcut`:** in the temporary home (whose Desktop was a new empty folder) it created `Desktop\Platypus.lnk`: target the clone's `electron.exe`, argument the clone folder, working directory the clone, icon `build\icon.ico,0` (the file exists), description "Platypus". Double-clicking it (Start-Process on the .lnk) opened the window, engine on 47850 only. Max's real Desktop was not touched.
- **Mini mode, three screens** (2048x1280 at 125 %, 1920x1080 right, 1920x1080 left): with the window on each screen in turn, MINI put the strip (about 380x150) in the bottom-right corner of the work area of the same screen, always on top; leaving mini mode restored the previous bounds. (After `setBounds` between screens with different scaling Electron resized the window itself; that is Electron, not Platypus.)
- **After (everything restored):** `Run.reg` and `StartupApproved\Run` exports are byte-identical to the "before" exports; the Start menu hashes (29 files, including Max's `Platypus.lnk`) and the Desktop listing are identical; no process under `C:\Platypus Tests` is left, ports 47850 free; Max's Platypus (PID 56192, since 15:11) and his `~\.platypus` files were not touched.
- **Doubts for Max:** tray badge (above); the first-run question "Connect Platypus to Claude Code?" appears at every first start of a new data folder and it was left unanswered (the test process was stopped); the shared start-up value name (above).

### 2026-11-18 · M1 · System tests that run anywhere (taken by the Windows loop)

- New `scripts/platform-test.js` (run by hand with `node scripts/platform-test.js`; M2 puts it in the Actions). It makes a temporary folder and points `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `CLAUDE_CONFIG_DIR` into it **before** loading any module, then deletes it. Nothing of the real system is touched. Output uses the same "ok / FAIL / Tutto a posto." style as `npm test`.
- What it checks, per system:
  - **Shortcuts** (`scripts/shortcut.js`): Windows `Desktop\Platypus.lnk` (target, argument, working directory, icon file exists, read back with the shell COM object); macOS `Platypus.app` (`Info.plist` with `plutil -lint`, executable launcher, `icon.icns`); Linux `platypus.desktop` (Exec, Path, icon, executable). On every system: `start.sh` and `start.command` have mode 100755 in git and `start.cmd` has CRLF.
  - **Autostart** (`src/autostart.js`, with a fake Electron `app`): macOS LaunchAgent created, `plutil -lint`, removed, old Agent Office plist removed; Linux `autostart\platypus.desktop` created and removed, old `agent-office.desktop` removed; Windows the arguments given to `setLoginItemSettings` (Electron path, repository folder), the removal of the old `com.agentoffice.desktop` value, and a write/read/delete round trip with `reg.exe` on a test branch `HKCU\Software\PlatypusPlatformTest` (so the real Run key is never touched).
  - **osint** (`src/core/osint.js`): `cmdArgs` and `resumeWin` on a folder with spaces and with `%`, and which tools exist (printed as info: PowerShell/cmd/wt/code on Windows, osascript/ps/code on macOS, xdotool/wmctrl/ps/code on Linux) with the base ones required. `focusSession` on the real process is run only with `CI=true` or `--focus`, because on a real desktop it would raise a window.
  - **Cowork search** (`coworkRoots()` and `findCoworkBases()` in `src/core/sources.js`) on a fake tree under each system's root: the right roots are listed, only the folder with transcripts is found (decoys inside `Cache`, `vm_bundles`, and an empty `projects` are ignored), `exclude` works, an extra root with `~` and quotes works, a root that does not exist is reported; on Windows also the Microsoft Store `Packages\Claude_...\LocalCache\Roaming\Claude` path.
- **Run on Windows 11 (this PC):** 23 checks ok, "Tutto a posto."; the temporary folder and the registry branch are gone afterwards.
- **Not run:** the macOS and Linux branches (no Mac here; WSL has a `rocky` distribution but no Node, and I did not install anything). They are written from the code and will be exercised by the Actions (M2) and by the Linux loop. `wt.exe` and `code` are not in the PATH on this PC (printed as info).

### 2026-11-18 · M2 · A richer macOS job (taken by the Windows loop; blocked at the check)

- `.github/workflows/ci.yml`, job "Window" (already on the three systems):
  - new step on all three systems: `node scripts/platform-test.js` with `CI=true` (so `focusSession` is also tried on the runner), before the window is opened;
  - new macOS-only step "Mini mode": `PLATYPUS_SNAPSHOT_JS="document.getElementById('btn-mini').click()"` with `PLATYPUS_DEBUG=1`; the log line that `src/main.js` prints before the screenshot (`[snapshot] bounds {...} onTop true`) is checked by the new `scripts/check-mini-log.js` (strip at most 420x200 and always on top, else the job fails), and the screenshot `snapshot-mini-macOS.png` is saved;
  - new macOS-only step "Reality map screenshot": the snapshot JS takes the first demo session and calls `window.openWorldMap(id, 'main')`; the screenshot is `snapshot-map-macOS.png`. Both new PNGs go out with the existing `snapshot-*.png` artifact upload.
- **Checked on Windows** (same Electron variables, temporary home, port 47850): the mini step gives `{"width":382,"height":151} onTop true` and `check-mini-log.js` says ok; the map step gives a screenshot of the "MAP OF REALITY" panel (territory treemap, trajectory cube, radar), which I looked at. The new checks in `npm test` cover `check-mini-log.js`.
- **Not done:** the real run on GitHub and looking at the macOS screenshots. Following the run (`gh run watch`) needs the branch pushed. **Waiting for Max's permission to `git push origin <this branch>`** (never main). I did not touch the YAML pins of the actions.

## Journal (Linux)
