# Installing Platypus

Platypus runs straight from source: clone the repository and launch it. There are no installers and no prebuilt binaries to sign. The desktop window is [Electron](https://www.electronjs.org), which npm downloads, ready-made for your system, on first launch.

*Versione italiana: [INSTALLAZIONE.md](INSTALLAZIONE.md).*

## Requirements

| | |
|---|---|
| **Node.js** | 22.12 or newer (LTS recommended). With older versions (Node.js 20 no longer gets security updates) the launcher opens browser mode only. |
| **Git** | to clone and update. |
| **Claude Code** | what the office watches: terminal, VS Code/JetBrains, desktop app. |
| **Disk** | about 300 MB in `node_modules` (Electron). |
| **Systems** | Windows 10/11 (x64, arm64), macOS 12+ (Intel and Apple Silicon), Linux x64/arm64 with a graphical desktop. |

## Windows

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# reopen the terminal, then:
git clone https://github.com/m4xl4b/platypus.git $HOME\platypus
cd $HOME\platypus
```

Double-click **`start.cmd`** (or run `npm start`). `npm run shortcut` adds a Desktop icon. The app creates its own Start menu entry on first launch, which Windows also needs to show notifications.

## macOS

```sh
brew install node git
git clone https://github.com/m4xl4b/platypus.git ~/platypus
cd ~/platypus
```

Double-click **`start.command`** in Finder (or run `./start.sh`). `npm run shortcut` creates **Platypus.app** in `~/Applications`. When running from source, the Dock and notifications may show "Electron": that's the runtime, and it's expected.

## Linux

```sh
# Node.js via nvm (distribution packages are often too old)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts
git clone https://github.com/m4xl4b/platypus.git ~/platypus
cd ~/platypus
./start.sh
```

`npm run shortcut` adds Platypus to the applications menu. If Electron's libraries are missing (Debian/Ubuntu):

```sh
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1 libnotify4
```

### Wayland

On a Wayland session (GNOME, KDE Plasma, Hyprland, Sway…) the window runs as a **native Wayland** app: sharp at any scaling, with the right icon in the taskbar. Wayland does not let apps stay above other windows or choose their own position, so:

| Feature | Native Wayland | XWayland compatibility |
|---|---|---|
| Always on top (`PIN`, mini mode) | not available | yes |
| Remembered position, mini strip in the corner | the compositor places the window | yes |
| Remembered size | yes | yes |
| "GO TO WINDOW" | KDE Plasma, Hyprland, Sway (GNOME: no) | KDE Plasma, Hyprland, Sway (GNOME: X11 windows with `xdotool`/`wmctrl`) |

To get always-on-top back, press `PIN` (Platypus offers to restart) or tick *XWayland compatibility* in the tray icon menu. The choice is remembered; to force it for one launch: `PLATYPUS_X11=1 ./start.sh` (or `PLATYPUS_X11=0` for native Wayland).

## First launch

The launcher (`scripts/launch.js`, used by `start.cmd`, `start.command` and `start.sh`) does four things:

1. Checks Node.js.
2. Runs `npm ci`, but only the first time or after an update changes dependencies. Electron is the only dependency.
3. Opens the window and gives you back the terminal.
4. Falls back to the browser if the window can't start.

`npm run start:demo` opens with the demo on.

## Connecting Claude Code

```sh
npm run hooks:install     # or: tray menu → Connect to Claude Code
npm run hooks:uninstall
```

The hooks are `curl` commands to `127.0.0.1:47800`, added to `~/.claude/settings.json`. Your settings stay intact, and a backup is saved in `settings.json.platypus-backup`. Without hooks the office still works from the transcripts, with a few seconds of delay and without answering permissions from the balloons.

### Feedback to the agents

These are other hooks, installed and removed on their own: they let Platypus add a short message to what an agent reads after a tool, at the start of a session or at the end of a turn.

```sh
npm run hooks:install -- --feedback      # or: OPT → Feedback to the agents → INSTALL THE FEEDBACK HOOKS…
npm run hooks:status -- --feedback
npm run hooks:uninstall -- --feedback
```

- They are `http` hooks to `http://127.0.0.1:47800/platypus-hook/feedback` on `SessionStart`, `PostToolUse`, `PostToolUseFailure`, `Stop` and `SubagentStop`, with a 3-second timeout. If your Claude Code is too old for `http` hooks, add `--curl` to install them as `curl` commands instead.
- Installing them changes nothing by itself: every feature in OPT → *Feedback to the agents* starts *off*. *Shadow* records what Platypus would have said without saying it; *on* says it. In this version three features stop at shadow.
- If Platypus is closed, or takes more than 300 ms to answer, Claude Code goes on as usual. Platypus never answers for you on a permission and never changes a tool's input or output.
- To keep a project out of it: in its Book tick *Don't talk to this project's agents*.

Every message, sent or in shadow, goes to a log: `~/.platypus/feedback/<key>.jsonl`, one file per project folder (the same key as the Workshop book), with what was said, to which agent, and what the agent did next. Past 5 MB the file becomes `<key>.1.jsonl` and a new one starts, so at most two files per project. Nothing leaves your computer. To delete it, close Platypus and delete the file or the whole `~/.platypus/feedback` folder. The Book's FEEDBACK tab shows the same log.

## Browser mode

```sh
npm run web      # or: node scripts/launch.js --web
```

Browser mode needs only Node.js: no Electron, no `npm install`. Open `http://127.0.0.1:47800/`. You only lose the tray icon and OS notifications.

## Updating and uninstalling

To update, run `git pull` and launch again. Dependencies re-sync automatically.

To uninstall:

1. Run `npm run hooks:uninstall`, and `npm run hooks:uninstall -- --feedback` if you installed the feedback hooks.
2. Untick *Start when I log in* in the tray menu.
3. Delete the repository folder.
4. Optionally, also delete:
   - `~/.platypus`, the settings, the stats, the Workshop book and the log of the messages to the agents;
   - the window preferences folder `Platypus` under AppData (Windows), Application Support (macOS) or `~/.config` (Linux).

### The Workshop book

The lessons Platypus deduces from your sessions live in `~/.platypus/bottega`, one JSON file per project folder (the file name is a key computed from the folder). Nothing leaves your computer.

The book learns from the open sessions once a minute and, when a project has an open session, rereads that project's past sessions by itself in the background (every 6 hours at most; a session already read and unchanged is skipped).

- To forget a single lesson: open the Book (BOOK on the floor's notice board, or WORKSHOP in the lobby) and press FORGET.
- To forget a project's book, or all of them: close Platypus and delete its file, or the whole `~/.platypus/bottega` folder.
- To stop learning: OPT → *The Workshop book learns from sessions*. Grandpa has his own switch next to it.
- If you added the book's section to a project's `CLAUDE.md`, it sits between `<!-- platypus:bottega:start -->` and `<!-- platypus:bottega:end -->`: delete those lines to remove it. The previous version of the file is in `CLAUDE.md.platypus-backup`.

## Special cases

- **WSL**: on Windows the office also follows Claude Code inside *running* WSL distributions. Hooks inside WSL can't reach Windows' `127.0.0.1` unless WSL mirrored networking is on; without it, the office works from the transcripts. You can also run Platypus inside WSL (`./start.sh`, with WSLg).
- **More `.claude` folders**: OPT → *Other Claude Code folders*, or the `PLATYPUS_CLAUDE_DIRS` variable (separated by `;`).
- **Cowork**: desktop-app Cowork sessions are found in the Claude app folder (on Windows `%APPDATA%\Claude\local-agent-mode-sessions`; the card shows the title chosen in the app, and sessions archived in the app are not followed). Cloud Cowork sessions (from phone or web) leave no files on your computer and can't be shown.
- **Corporate proxy**: `npm config set proxy …` / `https-proxy …`, or `ELECTRON_MIRROR=<internal mirror> npm ci`. Browser mode downloads nothing.
- **Private repository**: `gh auth login`, then `gh repo clone <owner>/platypus`, or use SSH keys.

## Tested on

What was tried on real systems, and what was not. Dates are when the test was run; the structure of other apps (Claude Code, the Claude desktop app) can change after that.

| System | Version | Date | What works | Limits |
|---|---|---|---|---|
| Windows 11 Pro (x64) | build 26200, Node.js 24, Windows Terminal | 2026-11-18 | clean clone in a folder with a space, `start.cmd`, update after a `git pull`, browser mode without Electron, Start menu entry, notifications (a click opens the right floor), tray menu, *Start when I log in*, `npm run shortcut`, mini mode on three screens, permissions from the speech bubble (YES / ALWAYS / NO, two at once, timeout, Platypus closed) with Claude Code 2.1.11, feedback hooks, finding the Cowork sessions of the Claude app (Microsoft Store version 6.6395; checked on its folders and on a fake copy, not on a session running at that moment) | not tried: Windows 10, arm64, VS Code, JetBrains, WSL, a Cowork session running right now. *GO TO WINDOW* picks the terminal window by name and title, so with several Windows Terminal windows it may pick the wrong one |
| macOS (Intel) | macOS 15 runner on GitHub Actions, Node.js 22 | 2026-11-18 | all engine tests, the window with the demo, mini mode, the map of reality, the shortcut app (`Platypus.app`, valid `Info.plist`, icon), the start-at-login file | tried only by the automatic checks, not by a person: no notifications, tray, permissions or Cowork. Apple Silicon not tried |
| Linux (Ubuntu) | Ubuntu runner on GitHub Actions, Node.js 22 and 24, X virtual display | 2026-11-18 | engine tests, the window with the demo, the menu entry and the start-at-login file | tried only by the automatic checks: no tray, notifications, *GO TO WINDOW*, Wayland or Cowork (the official Claude desktop app for Linux is in beta, its folder layout is not confirmed) |

## Troubleshooting

| Problem | Fix |
|---|---|
| `node` not found | Install Node.js and reopen the terminal (`start.sh` loads nvm by itself). |
| Windows: `start.cmd` "is not recognized" in PowerShell | PowerShell does not run files from the current folder by name: type `.\start.cmd`, or double-click it. |
| Windows: *Start when I log in* switches itself off or on | Windows keeps one start-up entry named `com.platypus.desktop` for every copy of Platypus on the computer (a clone, a packaged build). Turn it on from the copy you want to keep. |
| `npm ci` hangs on first launch | Network or proxy (see above). Meanwhile, use `npm run web`. |
| Linux: "SUID sandbox helper binary … not configured correctly" | Some distributions (e.g. Ubuntu 24.04) block Electron's sandbox. The launcher retries with `--no-sandbox` automatically. To always use it: `PLATYPUS_NO_SANDBOX=1 ./start.sh`. |
| Linux: no tray icon | GNOME needs the *AppIndicator and KStatusNotifierItem Support* extension. |
| Linux: "GO TO WINDOW" does nothing | On X11, install `xdotool` or `wmctrl`. On Wayland it works on KDE Plasma (via KWin, needs `gdbus`), Hyprland and Sway; GNOME does not allow it. |
| Linux (Wayland): `PIN` does not stay on top / the window does not reopen where it was | Wayland does not allow it: use *XWayland compatibility* (see [Wayland](#wayland)). |
| "Port 47800 is already in use" | The office is already open, or another app uses the port. Run `PLATYPUS_PORT=47810 npm start`, then reinstall the hooks. |
| Windows: no notifications | Launch once so the Start menu entry exists, and check *Settings → System → Notifications*. |

Desktop window messages are logged to `~/.platypus/launch.log`.
