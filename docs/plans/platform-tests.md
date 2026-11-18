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

### W1 · Install from scratch  [ ] [win]

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

### W2 · System  [ ] [win]

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

### M1 · System tests that run anywhere  [ ] [ci]

- New `scripts/platform-test.js`, called by the Actions and runnable by hand. It works in a temporary `HOME` and does not touch the real system.
- **For each system it tests:**
  - the shortcuts (`scripts/shortcut.js`);
  - autostart, created and removed (`src/autostart.js`; on macOS the LaunchAgent file, on Linux the `.desktop` file in `autostart`; on Windows the registry test is separate, on a test `HKCU` branch);
  - `src/core/osint.js`, at least reading the processes and the tools present;
  - the search for Cowork folders (`coworkRoots()` and `findCoworkBases()` in `src/core/sources.js`) on a fake tree.
- **On macOS**, in addition:
  - `Platypus.app` created with `sips` and `iconutil` has a valid `Info.plist` (`plutil -lint`) and the icon;
  - `start.command` is executable.

### M2 · A richer macOS job  [ ] [ci]

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

### X2 · Documents  [ ]

- **Install guides:** a "Tested on" table, with system, version, date, what works and the limits.
- **Frequent problems:** update the table with what came up.
- **Notes for the changelog:** in the section below.

---

## For the CHANGELOG

(to fill in at the end)

## Journal (Windows)

## Journal (Linux)
