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

## Browser mode

```sh
npm run web      # or: node scripts/launch.js --web
```

Browser mode needs only Node.js: no Electron, no `npm install`. Open `http://127.0.0.1:47800/`. You only lose the tray icon and OS notifications.

## Updating and uninstalling

To update, run `git pull` and launch again. Dependencies re-sync automatically.

To uninstall:

1. Run `npm run hooks:uninstall`.
2. Untick *Start when I log in* in the tray menu.
3. Delete the repository folder.
4. Optionally, also delete:
   - `~/.platypus`, the settings, the stats and the Workshop book;
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
- **Cowork**: desktop-app Cowork sessions are found in the Claude app folder. Cloud Cowork sessions (from phone or web) leave no files on your computer and can't be shown.
- **Corporate proxy**: `npm config set proxy …` / `https-proxy …`, or `ELECTRON_MIRROR=<internal mirror> npm ci`. Browser mode downloads nothing.
- **Private repository**: `gh auth login`, then `gh repo clone <owner>/platypus`, or use SSH keys.

## Troubleshooting

| Problem | Fix |
|---|---|
| `node` not found | Install Node.js and reopen the terminal (`start.sh` loads nvm by itself). |
| `npm ci` hangs on first launch | Network or proxy (see above). Meanwhile, use `npm run web`. |
| Linux: "SUID sandbox helper binary … not configured correctly" | Some distributions (e.g. Ubuntu 24.04) block Electron's sandbox. The launcher retries with `--no-sandbox` automatically. To always use it: `PLATYPUS_NO_SANDBOX=1 ./start.sh`. |
| Linux: no tray icon | GNOME needs the *AppIndicator and KStatusNotifierItem Support* extension. |
| Linux: "GO TO WINDOW" does nothing | On X11, install `xdotool` or `wmctrl`. On Wayland it works on KDE Plasma (via KWin, needs `gdbus`), Hyprland and Sway; GNOME does not allow it. |
| Linux (Wayland): `PIN` does not stay on top / the window does not reopen where it was | Wayland does not allow it: use *XWayland compatibility* (see [Wayland](#wayland)). |
| "Port 47800 is already in use" | The office is already open, or another app uses the port. Run `PLATYPUS_PORT=47810 npm start`, then reinstall the hooks. |
| Windows: no notifications | Launch once so the Start menu entry exists, and check *Settings → System → Notifications*. |

Desktop window messages are logged to `~/.platypus/launch.log`.
