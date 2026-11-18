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

### W3 · Real windows and sessions  [!] [win]

Partly done: focus of cmd, PowerShell and Windows Terminal windows with simulated sessions. Still open: a real interactive session in a terminal (the trust dialog of a new folder needs a keystroke that I could not send safely to Max's desktop), VS Code, Resume, Open folder, agents with model/age/effort from a real transcript, WSL. See the Journal (Windows).

At least one real Claude Code session is needed: ask Max to open one, or open it yourself in a test folder, if he agrees (and see the rule: never run `claude` without Max saying so at that moment).

- **GO TO THE WINDOW:** try with Windows Terminal, PowerShell, cmd and VS Code.
- **Resume the session** and **open the folder**.
- **Agents and subagents:** they show up with the right model, age and effort.
- **WSL**, if there is a distribution:
  - sessions launched inside WSL show up;
  - with the normal network the hooks inside WSL do not arrive; with the mirrored network they do, if Max wants to try it.

### W4 · Permissions from the balloon, and feedback hooks  [x] [win]

Done with the real Claude Code CLI after Max logged in (non-interactive `claude -p`, see the second W4 entry in the Journal (Windows)); the earlier entry used a simulated hook client. Limit: `-p` has no terminal, so "Claude Code asks as usual in the terminal" was seen only as an automatic refusal.

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

### M2 · A richer macOS job  [x] [ci]

- **`.github/workflows/ci.yml`** (it already has the "Engine" and "Window" jobs on the three systems, macOS on `macos-15-intel`):
  - runs `platform-test.js` on all three systems;
  - on macOS adds the mini mode check and a screenshot after `PLATYPUS_SNAPSHOT_JS`, which opens the reality map.
- **Check:** follow the run with `gh run watch` (reading only, no push needed if Max has already published the branch; otherwise **stop and ask**).
- **Use:** the macOS screenshots are looked at and commented on in the Journal.

## K · Cowork

### K1 · Study of the structure  [x] [win]

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

### K2 · Targeted search  [x] [win]

- **Update `findCoworkBases`** (`src/core/sources.js`, called from `scanCowork` in `src/core/index.js` with the `coworkDirs` setting):
  - first try the known paths found in K1;
  - the wide search stays as a fallback, because the structure may change.
- **If K1 found a title and a state:** the title goes on the session's card, the state is used to tell whether it is active.
- **Tests:** a fake tree in `scripts/fixtures/cowork-win/`, the same as the anonymized structure, in the automatic tests (`npm test`, `scripts/smoke-test.js`).
- **Check by hand:** the test Cowork session shows up in the office's Cowork wing.

### K3 · Cowork on macOS and Linux  [x] [ci]

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

- **Machine:** Windows 11 Pro 10.0.26200 (build 26200), x64 (`AMD64`), Node 24.13.0, npm 11.6.2, Git 2.56.0.windows.4, `curl.exe` is `C:\Windows\system32\curl.exe`. The user folder is `C:\Users\<user>` (no space, no accent, not inside OneDrive; OneDrive exists next to it).
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
- **Real run on GitHub** (Max allowed the push of this branch, never main; run 44329407269 on commit `54d01de`): all 9 jobs green (Engine and Window on ubuntu, macos-15-intel, windows-latest).
  - `platform-test.js` passed on all three. macOS (darwin 24.6.0, Node 22): all the macOS checks ok, including `plutil -lint` on `Info.plist` and on the LaunchAgent, and the `icon.icns` made by `sips` + `iconutil`. Linux (Azure kernel 7.0): shortcut, autostart and Cowork checks ok; tools `xdotool`/`wmctrl` absent, so `focusSession` answers "install xdotool or wmctrl" (well formed). Windows runner passed too.
  - `focusSession` with `CI=true` on the macOS runner really activated Terminal (`{"ok":true,"how":"app","app":"Terminal"}`): harmless on a runner, which is why it is not run by default locally.
  - Mini mode on macOS: `380x150`, always on top, `check-mini-log.js` ok. Screenshots looked at: `snapshot-mini-macOS.png` is the strip with the two alerts (F1 stuck test runner, F2 cost over budget); `snapshot-map-macOS.png` is the "MAP OF REALITY" panel (territory treemap, trajectory cube, 7-dimension radar), same as on Windows.
  - Only annotation: GitHub says `ubuntu-latest` will move to Ubuntu 26 on 2026-10-19 (already past; no action). I did not touch the YAML pins of the actions.

### 2026-11-18 · W3 and W4 · Real session (Max allowed a real session and the hooks) · partly done, blocked on the CLI login

- **What stopped the real session:** `claude -p ...` (Claude Code 2.1.11, `%USERPROFILE%\.local\bin\claude.exe`) answers `Invalid API key · Please run /login`, also with every `CLAUDE_*` / `ANTHROPIC_*` variable of the desktop app removed from its environment: the CLI's own login is missing or expired (Max uses the desktop app's built-in Claude Code, whose authentication is not available to a child process). Three attempts, then I stopped, as the plan says. No model call was made, so nothing was spent. **Max has to run `claude` once in a terminal and `/login`**, or tell me to use another way (an API key is not something I may enter).
- **Precautions taken:**
  - hooks were installed only in the throwaway project `C:\Platypus Tests\w4-project\.claude\settings.json` (with `hooks.install({ port: 47850, base })`, the repository's own installer) and the CLI was started with `--setting-sources project`, because Max's real `~\.claude\settings.json` **already contains 17 Platypus hook lines** (port 47800): without this the test session would have shown up in Max's office. His `settings.json` hash was the same before and after (`291FEEC0...`); it was not read beyond counting the hook lines, and not modified;
  - the test Platypus ran with the temporary home, so no real session was read; `--no-session-persistence`, so no transcript went into `~\.claude\projects` (checked: no `Platypus-Tests` folder there).
- **What the real CLI did show:** even without authentication, the real Claude Code 2.1.11 on Windows fired the project's hooks and they reached Platypus through `curl.exe`: `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` (seen in the test Platypus's debug log). So the hook command (`curl.exe -s -m 2 -X POST ... --data-binary "@-"`) works from Claude Code on Windows.
- **`curl.exe`:** in PowerShell `curl` is the alias of `Invoke-WebRequest`, but the hooks call `curl.exe`, which resolves to `C:\Windows\system32\curl.exe` (8.22). Inside Git Bash `which curl.exe` gives `/ucrt64/bin/curl.exe` (MSYS2 8.23), which prints "WARNING: this libcurl is Debug-enabled" on stderr; harmless here (exit code 0), noted in case a user sees it.
- **W4, simulated client** (a script spawns `bash -c "<the PermissionRequest command from settings.json>"` with a `PermissionRequest` JSON on stdin, which is what Claude Code does on Windows, and answers from the real balloon: the Platypus window is moved to the session's floor and the real `SÌ/YES`, `SEMPRE/ALWAYS`, `NO` button is clicked in the page):
  - YES → `{"behavior":"allow"}`, 1.7 s; ALWAYS → `allow` plus `updatedPermissions` (the suggestion Claude Code sent), 1.7 s; NO → `deny` with the message "The user denied this request from the office (Platypus).", 1.7 s; the speech bubble then reads "Permission denied from th…" (screenshot looked at);
  - two permissions at once (two sessions): both balloons pending; answering B first (NO) and A second (YES) gave B `deny` and A `allow`: answers do not get crossed;
  - nobody answers, `approveWaitSec` set to 5: the hook gets an empty 204 after 5.1 s, so Claude Code asks in the terminal as usual (the setting was put back to 120);
  - Platypus closed **while** a hook waits: `curl` ends with exit code 56 after 0.9 s; Platypus already closed: exit code 7 after 84 ms. Both are non-zero but not 2, so Claude Code treats them as a non-blocking hook error and goes on with its own question (documented behaviour; not seen with the real model, which was not available).
  - **Not verified:** that the real Claude Code takes the `updatedPermissions` of ALWAYS and stops asking; that it prints the deny message; the 600 s `curl -m` limit with a real wait.
- **Feedback hooks / `2.11-real-check.md`:** not run. It needs the same real session (the model has to repeat the `PLATY-*` markers). `node scripts/feedback-check.js` uses a fixed folder `%TEMP%\platypus-feedback-check` that already exists on this PC (it deletes it at start), and port 47811, which is in use by another process: when it runs, use `TEMP`/`TMP` on an empty folder and `--port 47850`.
- **W3, simulated sessions** (fake `sessions\<pid>.json` in the temporary home plus a `SessionStart` hook, a real terminal window, then `POST /api/focus` from another window): `cmd`, `powershell` and `wt.exe` (Windows Terminal 1.25 is installed, it is Windows 11's default terminal, but `wt.exe` is not in the PATH of this shell) each ended with the right window in front, each answer was `{"ok":true,"how":"app","app":"WindowsTerminal","approx":true}`. `approx` means the window was chosen by process name and title, not by the process tree: in the test the shell's parent was my script, not Windows Terminal, so this is a limit of the test; with a real `claude` started in a tab the tree is different. **Doubt for Max:** with several Windows Terminal windows open the "approximate" pick could take the wrong one; to be confirmed with real sessions.
- **Not done for W3:** VS Code (not in the default path), Resume, Open folder, agents/subagents with model, age and effort (they need a real transcript), WSL (a `rocky` distribution exists but has no Node and no `claude`; I did not install anything). The terminals I opened were closed, the fake session files removed, the test Platypus stopped (no process under `C:\Platypus Tests`, port 47850 free).
- **Cost to keep in mind:** none of this spent tokens.

### 2026-11-18 · W4 · Real session, after Max logged in the CLI

- **Setup:** Claude Code 2.1.11 (`claude -p`, `--model haiku`, `--setting-sources project`, `--permission-mode default`, `--no-session-persistence`), in the throwaway project `C:\Platypus Tests\w4-project` whose own `.claude\settings.json` holds the hooks (port 47850). Test Platypus window on 47850 with the temporary home. The balloon was answered by moving the window to the session's floor and clicking the real button in the page. The CLI environment had no `CLAUDE_*` / `ANTHROPIC_*` variables. The model asked to run `touch <file>` with the Bash tool, so every run needs a permission.
- **Results (all runs end with exit code 0):**
  - **YES:** the balloon showed "Create empty file w4-yes"; after SÌ the file existed and Claude said DONE (8 s).
  - **ALWAYS:** asked to run two `touch` commands in a row; after the first answer SEMPRE both files were created, and **no second approval appeared** (checked 12 s later): Claude Code does take `updatedPermissions` and stops asking.
  - **NO:** the file was not created, Claude said DENIED (the deny message of the office reached it).
  - **Two at once** (two `claude -p` in parallel): two approvals pending; B answered NO first, A answered YES second: A created its file and said DONE, B did not and said DENIED. Answers are not crossed.
  - **Nobody answers, `approveWaitSec` = 5:** the hook returned 204 after 5 s, Claude Code fell back to its own rule; in `-p` that is a refusal ("DENIED", file not created), 9.5 s in all. The setting was restored to 120.
  - **Platypus closed while waiting:** the window was killed during the wait; Claude Code carried on 2.9 s later (refusal, `-p`). **Platypus already closed:** Claude Code finished in 4.8 s with the file not created and an explanation that the command "needs approval". It never hung.
  - **Not covered:** the real terminal question of an interactive session (the `-p` mode has no one to ask), and a wait of the full 600 s of `curl -m`.
- **2.11 feedback check (`scripts/feedback-check.js --port 47850`, with `TEMP`/`TMP` on `C:\Platypus Tests\fb-tmp` so that the existing `%TEMP%\platypus-feedback-check` was not touched; hooks `http`, so `--curl` was not needed).** Same prompt as in the document, run with `claude -p`:
  - the model answered about the three markers and said it saw "PLATY-PRE (PreToolUse), PLATY-FAIL (PostToolUseFailure), PLATY-POST (PostToolUse)"; the final message of the run was `PLATY-STOP`;
  - the transcript confirms where each marker lives: `hook_additional_context` attachments for PRE, FAIL and POST, and a `hook_blocking_error` + user message for the Stop block;
  - `[feedback-check]` lines, as printed:
    ```
    [feedback-check] PreToolUse Bash agent=main origin=- → context
    [feedback-check] PostToolUseFailure Bash agent=main origin=- → context
    [feedback-check] PreToolUse Read agent=main origin=- → context
    [feedback-check] PreToolUse Read agent=main origin=- → context
    [feedback-check] PostToolUseFailure Read agent=main origin=- → context
    [feedback-check] PostToolUse Read agent=main origin=- → context
    [feedback-check] Stop - agent=main origin=- → block
    [feedback-check] Stop - agent=main origin=- → 204
    ```
  - answers to the document's table: Claude Code 2.1.11; `http` hooks reach Platypus: **yes**; markers seen by the model: **PLATY-PRE, PLATY-POST, PLATY-FAIL, not PLATY-START**; `PreToolUse` context reaches the model: **yes** (this decides B2/B4 for Max); failing `npm test`: **`PostToolUseFailure`**; read of the missing file: **`PostToolUseFailure`** (the successful read of `notes.txt` gives `PostToolUse`); Stop block: **worked once** (PLATY-STOP, then the second `Stop` answered 204); `Origin` header: **none** (`origin=-`); Platypus closed (Ctrl+C on the check, then `claude -p --continue "read notes.txt again"`): worked as usual in 3 s, no error.
  - **`SessionStart` did not arrive** in this `-p` run (no line, no PLATY-START). Possibly `-p` does not fire it for `http` hooks, or the event is not sent without a terminal; to be confirmed in an interactive session (a question for Max: does Claude Code in the desktop app or a terminal show PLATY-START?).
  - The results are also copied, as a short table, to a new "Results (Windows)" section in `docs/plans/2.11-real-check.md`. I did **not** edit `docs/plans/2.11-3.0-feedback-storage-server.md`, where that document asks for a "Real-session check" entry: it belongs to the 2.11 plan, not to this loop.
- **W3 attempt with a real interactive session:** I opened `claude` in a `cmd` window on a new folder; it stopped at the "Do you trust this folder?" question. Sending a keystroke to it from a script is not safe on Max's desktop (it goes to whatever has the focus), and the first attempt did not reach the window, so I closed the window and its process (by PID) and left W3 as partly done.
- **Cleanup and side effects:** the transcripts of the test sessions in `~\.claude\projects` (`...Platypus-Tests...`) were deleted (they were mine); `~\.claude\settings.json` has the same hash as before; no entry about `Platypus Tests` in `~\.claude.json`; no `history.jsonl`. The test Platypus and the check were stopped (port 47850 free), `C:\Platypus Tests\fb-tmp` deleted. The clones and the two throwaway projects (`w3-project`, `w4-project`) stay in `C:\Platypus Tests\`.

### 2026-11-18 · K1 · Study of the structure (Max gave permission to look at the Claude app folders)

- **Method:** two throw-away scripts walked `%APPDATA%\Claude`, `%LOCALAPPDATA%\Claude` and the Store package folder, printing names, depth, number of files, sizes and dates; for JSON/JSONL files only the names of the top-level fields (of the first line for JSONL), and for status-like fields only short enum values such as the model names. No transcript, title, message, e-mail, credential or `audit.jsonl` content was read or kept; repeated sibling folders were described once (every identifier is `<uuid>` in the output).
- **Result:** `docs/plans/cowork-structure.md` (anonymized). Short version:
  - the Claude app is **6.6395.0.0** from the Microsoft Store; the data is in `%APPDATA%\Claude` (the package's virtual store holds only tool caches);
  - Cowork is `local-agent-mode-sessions\<uuid>\<uuid>\local_<uuid>.json` (metadata: `title`, `model`, `lastActivityAt`, `isArchived`, `isAgentCompleted`, `processName`, ...) next to `local_<uuid>\.claude\projects\-sessions-<processName>\<cliSessionId>.jsonl` (the transcripts, plus `subagents\*.jsonl`) and `audit.jsonl`;
  - there is no `status` field: "active" has to be read from `lastActivityAt`, which follows the newest transcript write within 4 minutes on all 27 sessions;
  - the app's Code tab (`claude-code-sessions\...\local_<uuid>.json`, 46 files) keeps only metadata (`title`, `model`, `effort`, `permissionMode`, `cliSessionId`, ...): its transcripts are in the normal `~\.claude`;
  - the Cowork virtual machine is `vm_bundles\claudevm.bundle` (11 GB), run by `cowork-svc`.
- **Not done / limits:** no Cowork session is active on this PC (newest transcript 2026-07-28), so "active" is deduced, not seen; I did not start a Cowork session (that is for Max to open, if he wants it checked). Only one app version, one PC, one account. Several expected roots do not exist here (`AnthropicClaude`, `Claude-3p`).
- **Side effects:** none; nothing was written outside the scratch folder and the new document. Max's real data is not in the repository (no title, path, project name, account or session id is reproduced).

### 2026-11-18 · K2 · Targeted search

- **Code:**
  - `src/core/sources.js`: `findCoworkBases` first tries the known path of K1 (`<root>/local-agent-mode-sessions/<account>/<org>/local_<uuid>/.claude`, two directory levels, no walk). For each root where it finds nothing, the old wide search runs as before (fallback: new app versions, hand-made roots). Each base found through the known path carries `meta` read from the sibling `local_<uuid>.json`: only `title`, `sessionId`, `cliSessionId`, `model`, `createdAt`, `lastActivityAt`, `isArchived`, `isAgentCompleted` (new `readCoworkMeta`; the e-mail, account name, prompts and messages in that file are never kept);
  - `src/core/index.js` (`scanCowork`): archived sessions are not watched; the app's titles are applied at once and again 6 s later (when the freshly opened transcripts have created the sessions);
  - `src/core/state.js`: small `applyCoworkMeta`; a title from the app is no longer overwritten by the `ai-title` / `custom-title` lines of the transcript.
- **Tests (`npm test`, new "Cowork (albero finto di Windows)" group, 6 checks):** the fake tree is `scripts/fixtures/cowork-win/` (the shape of K1 with made-up content; `_claude` stands for `.claude`, which git ignores, so the test copies the tree to a temporary folder and renames it). It checks: the known path finds the two sessions and not the `skills-plugin` decoy; the metadata fields; that e-mail, account name and prompts are not kept; the wide search still works on an unknown structure; in the running engine the card shows the metadata title (the transcript says another one); the archived session does not appear.
- **By hand:** a real window (temporary home, port 47850) with `coworkDirs` pointing at a copy of the fixture: the Cowork wing shows floor 1 "Prova Cowork dal metadato" (screenshot looked at), source COWORK, "New task: Ciao". A real Cowork session could not be tested (none is active on this PC, and starting one is for Max).
- **On the real tree (counts only):** the same 27 session folders as before are found, with metadata for all 27, and the number of folders visited drops from 412 to 2 (65 ms to 42 ms). Nothing from the real data was printed or kept.
- **State of "active":** nothing new is derived from `lastActivityAt` yet: a Cowork session is still "active" when its transcript is written, as before. K1 shows the two agree within a few minutes, so a later change can use the metadata if wanted.

### 2026-11-18 · K3 · Cowork on macOS and Linux (taken by the Windows loop; documentation and a test, no code)

- **macOS:** the K1 structure is carried over in `docs/plans/cowork-structure.md` for `~/Library/Application Support/Claude`, everything marked **to verify** (no Mac here). The K2 search does not depend on the operating system, so it applies as it is; the wide search stays as a fallback.
- **Linux:** an **official Claude desktop app for Linux exists now** (beta, announced at the end of June 2026; Ubuntu 22.04+ / Debian 12+, x86_64 and arm64, apt repository or `.deb`, with Chat, Cowork and Claude Code; Cowork runs in a QEMU/KVM virtual machine). Sources are in the document (Anthropic's docs and support article, read today). So the options do **not** need a "no Cowork on Linux" message, and I changed nothing in the interface. The docs do not say where the app keeps its data: `coworkRoots()` keeps looking in `$XDG_CONFIG_HOME/Claude` / `~/.config/Claude` (Electron's default), **to verify** on a Linux computer with the app.
- **Test added** (`scripts/platform-test.js`, so the Actions run it on macOS and Linux too): a fake Cowork tree in the known layout under a hand-given root; the search must find it with the title from the metadata, without keeping the e-mail field, and without the wide walk. 24 checks ok on Windows.
- **For the Linux loop / Max:** on a Linux computer with `claude-desktop` installed, look at `~/.config/Claude` with the K1 method (names, sizes, dates, field names) and confirm or correct the "to verify" lines.

## Journal (Linux)
