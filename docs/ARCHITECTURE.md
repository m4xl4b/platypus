# Architecture

*Versione italiana: [ARCHITETTURA.md](ARCHITETTURA.md).*

Platypus is split into three independent layers. That is what lets it run the same way on Windows, macOS and Linux, and one day swap the shell (for example for Tauri) without rewriting the engine or the graphics.

```
┌────────────────────────────────────────────────────────────┐
│ Desktop shell         src/main.js + src/preload.js         │  Electron: window, tray icon,
│ (replaceable)         src/autostart.js                     │  notifications, start at login
├────────────────────────────────────────────────────────────┤
│ Interface             renderer/  (HTML, CSS, JS, canvas)    │  the same page in the window
│                                                            │  and in the browser
├────────────────────────────────────────────────────────────┤
│ Engine                src/core/  (Node.js, no external     │  reads Claude Code's data, keeps the
│                       dependencies)                        │  state, serves page and API over HTTP
└────────────────────────────────────────────────────────────┘
        ▲ transcripts and registry (~/.claude)    ▲ hooks (curl → 127.0.0.1:47800)
                                                  ▲▼ feedback hooks (http → /platypus-hook/feedback, optional)
```

## Engine (`src/core`)

Node.js modules only, no npm packages: that's why browser mode starts without `npm install`.

| File | Role |
|---|---|
| `index.js` | startup, HTTP server on 127.0.0.1 only, SSE, API, pending permissions |
| `sources.js` | reading the transcripts (`projects/**/*.jsonl`, including Workflow agents in `<session>/subagents/workflows/<runId>/` with their `journal.jsonl`, and run summaries in `<session>/workflows/<runId>.json`) and the session registry, finding Cowork folders |
| `state.js` | state of sessions, agents and subagents, costs, alerts, whiteboards, releases, Workflow runs (phases, per-agent cost and times) and messages between agents |
| `hooks.js` | installing and removing the hooks in `settings.json`; the feedback hooks apart, with their own marker |
| `archive.js` | archive and replay with a virtual clock |
| `osint.js` | system integration: bring window to front, resume session, open folder (Windows / macOS / Linux) |
| `stats.js` | daily and weekly statistics, report |
| `worldmap.js` | map of reality: territory, frontier, 7-dimensional trajectory |
| `semantic.js` | context bubble and north star (TF-IDF, PCA, clusters, alignment) |
| `grounding.js` | map versus territory: stale memories (disk mtimes with a 10 s cache, and other agents' edits), blind edits, invented paths, claims in replies and their evidence |
| `surprise.js` | failure classifier (Jest, pytest, go, cargo, npm, tsc, Node, Python, PowerShell…), error excerpts and the files they cite, surprise score, reactions (corrects/insists/stops) and causal chains |
| `bottega.js` | Workshop book: lessons per project deduced from the facts above, weight with a 30-day half-life, live learning and learning from the archive, Grandpa's hints, the section for `CLAUDE.md` |
| `claudemd.js` | safe writer for the section in a project's `CLAUDE.md`: between markers, backup first, the rest byte for byte, atomic write |
| `feedback.js` | feedback to the agents: from a hook's input to the answer for Claude Code, as pure functions; the three modes of each feature, the rate limits (`Gate`), the muted projects |
| `feedback-rules.js` | what Platypus says: one rule per feature (lessons at session start, Grandpa, loop, edit over another agent's change, claims without evidence, back to the task), each text built in English for the agent and in the office language for the log |
| `outcomes.js` | what an agent did after a message: likely helped, ignored or can't tell, from its next steps |
| `feedbacklog.js` | the log of the messages, one append-only file per project; the demo uses an in-memory version with the same interface |
| `weather.js`, `releases.js`, `describe.js`, `demo.js`, `demoworld.js` | weather, git/gh releases, tool descriptions, demo |
| `../i18n` | translations (key = Italian text, `locales/<language>/*.json`) |

Everything that depends on the operating system lives in three places: `osint.js`, `sources.js` (Cowork and WSL paths) and `hooks.js` (`curl` / `curl.exe`).

### API (all on `http://127.0.0.1:<port>`)

| Method and path | What it does |
|---|---|
| `GET /events` | SSE stream of the state (and of the replay frames) |
| `GET /api/state`, `/api/settings` | state and options |
| `POST /api/settings` | saves the options |
| `POST /platypus-hook` | hook events (asynchronous) |
| `POST /platypus-hook/permission` | synchronous permissions hook: waits for the office's answer |
| `POST /api/approve` | answer to a permission: `allow`, `always`, `deny` |
| `GET /api/agentmap`, `/api/agentmind` | map of reality, bubble and north star |
| `GET /api/archive`, `POST /api/replay` | archive and replay |
| `POST /api/focus`, `/api/resume`, `/api/open-folder` | window, resume, folder |
| `GET /api/stats/costs`, `/api/stats/honors`, `/api/report` | statistics and report |
| `POST /api/demo`, `/api/cowork`, `/api/cowork-scan` | demo, Cowork wing, Cowork scan |
| `GET /i18n.js` | translations for the page |
| `GET /api/grounding` | map versus territory and surprises of an agent or session (`sid`, `aid`, `replay`) |
| `GET /api/bottega`, `/api/bottega/list`, `/api/bottega/hints` | a project's book (`sid`, `cwd` or `key`), the projects with a book, what Grandpa would say now |
| `POST /api/bottega`, `/api/bottega/learn` | pin/ignore/unignore/forget a lesson; learn from the project's archive in the background |
| `GET`/`POST /api/bottega/claudemd` | preview of the `CLAUDE.md` section; write it (only with `confirm: true`) |
| `POST /platypus-hook/feedback` | synchronous feedback hook: the answer for Claude Code, or an empty `204` |
| `GET`/`POST /api/feedback/hooks` | whether the feedback hooks are installed and the exact lines; install or remove them (only with `confirm: true`) |
| `GET /api/feedback/log`, `/api/feedback/counts` | a project's messages to agents with their outcomes (`sid`, `cwd` or `key`); how many per feature in the last 7 days |

The server rejects requests whose `Host` or `Origin` is not `127.0.0.1`/`localhost` (protection against DNS rebinding and websites).

### Feedback to the agents

`POST /platypus-hook/feedback` answers within 300 ms, using only what is already in memory (the state, the books, the log). A later answer, or any error, becomes an empty `204` and Claude Code goes on as if Platypus were not there. The answers use only these hook formats:

| Event | Answer |
|---|---|
| `SessionStart`, `PostToolUse`, `PostToolUseFailure` | `{"hookSpecificOutput": {"hookEventName": …, "additionalContext": "Platypus: …"}}` |
| `Stop`, `SubagentStop` | `{"decision": "block", "reason": "Platypus: …"}`, never while `stop_hook_active` is true; in 2.11 the only feature that would use it (claims) stops at shadow, so it is never sent |

Never `permissionDecision`, `updatedInput` or `updatedToolOutput`: Platypus adds context, it does not decide for you. Each feature is `off`, `shadow` or `on` (`fbSessionLessons`, `fbElder`, `fbLoop`, `fbStale`, `fbClaims`, `fbDrift` in the options; the last three are `shadow` at most in 2.11). Limits: one message per agent every 2 minutes, 6 per session per hour, the same lesson once per agent; shadow messages count like sent ones. The demo calls the same function without the network, with its own modes and an in-memory log.

## Interface (`renderer/`)

Static page: `index.html`, `style.css`, `game.js` (building, floors, balloons), `worldmap.js` (map of reality), `bottega.js` (Workshop book), `teams.js` (TEAMS panel: workflows, teams, messages), `report.html`, `i18n-runtime.js`. It talks to the engine only over HTTP and SSE. The only point of contact with the shell is the optional `window.officeApp` object (if it's missing, you're in the browser).

### The `window.officeApp` contract (from `src/preload.js`)

| Function | Use |
|---|---|
| `minimize()`, `close()` | title bar buttons |
| `toggleMaximize()`, `isMaximized()`, `onMaximized(cb)` | full screen: the button also follows maximizing done outside the page |
| `togglePin()`, `getPin()` | always on top |
| `setCounts({sessions, agents, busy, waiting})` | updates the tray icon and flashes the window |
| `setWidget(on)` | mini mode (small window, always on top) |
| `onGoto(cb)` | click on a notification → go to the session's floor |

## Desktop shell (`src/main.js`)

Starts the engine in the same process, opens a frameless window on `http://127.0.0.1:<port>/`, and handles:
- the system tray icon and menu;
- notifications (permissions, alerts, report);
- mini mode;
- start at login (`src/autostart.js`);
- on Windows, the Start menu entry with the AppUserModelID for notifications;
- on macOS, the app menu and the Dock icon;
- on Linux, the app_id/`desktopName` `platypus` (matches `platypus.desktop`) and Wayland: natively there is no always-on-top or window position, so `getPin()` returns `false` and `PIN` offers to restart with `--ozone-platform=x11` (XWayland). The choice is `x11` in the app's `config.json`, also read by `scripts/launch.js`.

## Moving to Tauri (or another shell)

The engine and the interface don't change. A Tauri shell would need to:

1. **start the engine**, in one of two ways:
   - as an external Node.js process (`node src/standalone.js --no-open`), or compiled into a single executable (`node --experimental-sea-config`, Bun or Deno);
   - alternatively, port it to Rust one module at a time, keeping the same HTTP API;
2. **open a webview** on `http://127.0.0.1:<port>/`;
3. **provide `window.officeApp`** with the same functions as the table above, implemented as Tauri commands (`invoke`);
4. **rewrite the shell parts in Rust**: tray icon (`tray`), notifications (`tauri-plugin-notification`), start at login (`tauri-plugin-autostart`), bring window to front and mini mode.

The benefit would be much smaller binaries (about 10 MB instead of 150) and less memory. The cost: anyone starting from source has to install Rust and the system libraries to build it. That's why, as long as distribution is "clone and launch", the shell stays Electron.

## Data on disk

| Path | Contents |
|---|---|
| `~/.claude/` | Claude Code's: read, never changed, except the hooks in `settings.json` if you install them |
| `~/.platypus/settings.json` | office options |
| `~/.platypus/stats.json` | daily and weekly statistics |
| `~/.platypus/bottega/<key>.json` | the Workshop book of each project (one file per project folder) |
| `~/.platypus/feedback/<key>.jsonl` | the messages to the agents of each project, sent and in shadow, with their outcomes (rotated at 5 MB into `<key>.1.jsonl`) |
| `~/.platypus/launch.log` | messages from the last window launch |
| Electron data folder (`Platypus`) | window position and shell preferences |
