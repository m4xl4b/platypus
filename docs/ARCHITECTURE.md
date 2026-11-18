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
| `notify.js` | when there is something to notify (an agent waiting, a new alert, the daily report), the same for every shell; the `/api/shell/events` stream |
| `worldmap.js` | map of reality: territory, frontier, 7-dimensional trajectory |
| `semantic.js` | context bubble and north star (TF-IDF, PCA, clusters, alignment), with vectors of any length from any source ("meaning spaces") |
| `drift-rule.js` | the drift rule of the north star and its thresholds per source, written once: used by the engine, by the "back to the task" feedback and, as `/drift-rule.js`, by the map |
| `embed/` | neural meaning (optional): `index.js` (provider chain, cache, queue), `ollama.js` (local Ollama, loopback only), `onnx.js` (loads the optional ONNX module), `fake.js` (synonyms provider for the demo only) |
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
| `GET /api/shell/events` | SSE stream for a desktop shell that runs the engine as a separate process: only `counts` (sessions, agents, busy, waiting) and `notify` (`{kind, title, body, sid, key}`); it does not count as an open office window |
| `GET /api/state`, `/api/settings` | state and options |
| `POST /api/settings` | saves the options |
| `POST /platypus-hook` | hook events (asynchronous) |
| `POST /platypus-hook/permission` | synchronous permissions hook: waits for the office's answer |
| `POST /api/approve` | answer to a permission: `allow`, `always`, `deny` |
| `GET /api/agentmap`, `/api/agentmind` | map of reality, bubble and north star (`/api/agentmind` also says the vector source `src`, its thresholds `th`, `pending`, `refining` and `fallback`) |
| `GET /api/embed`, `POST /api/embed` | the meaning engine: source in use, state of each source, cache; `{action: 'probe'}` checks the sources, `{action: 'clear'}` clears the cache |
| `GET /drift-rule.js` | the drift rule for the page (the engine's own file) |
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

### Meaning (embeddings)

The bubble and the north star measure what an agent is talking about with vectors. The lexical source (TF-IDF, always there) compares words; a neural source also understands synonyms ("login" and "authentication"). The option `embedEngine` chooses: `auto` (the default: Ollama if it answers, then ONNX if installed, otherwise TF-IDF; only calibrated sources, see below), `tfidf` (lexical only), `ollama` or `onnx` (that one, or TF-IDF saying why). With `auto` and no Ollama, the engine looks again at most once a minute, and only while a bubble or the drift rule asks for vectors.

- **Sources.** Ollama is called with Node's `http`, only on `127.0.0.1`, `::1` or `localhost` (`ollamaUrl`); the model is `embedModel` or the first embedding model found, the best measured ones first (`qwen3-embedding:0.6b` leads); Platypus never runs `ollama pull`, it shows the command. The ONNX provider lives in `optional/embed-onnx/` with its own `package.json` and runs `Xenova/multilingual-e5-small` in a `worker_thread`; the engine loads it with `require` only if `npm run embed:onnx:install` has installed it (that command asks first and is the only one that downloads a model).
- **Never blocking.** One queue for the engine, batches of at most 16 texts, 5 s per request (up to 60 s while a model that is not loaded yet is loading; Ollama is then asked to keep it loaded for 10 minutes), the agents being looked at first; 3 failures in a row suspend a source for 5 minutes. A vector that is not there yet is simply missing: the TF-IDF picture is shown at once ("refining…") and replaced when the neural vectors of every goal and action have arrived. Vectors of different sources are never mixed in one calculation.
- **Text and cache.** The pieces of an agent's context keep a short snippet of their text in memory (at most 320 characters, 480 for an action with its result), never on disk. The cache keeps vectors and sha1 hashes only: 5000 vectors in memory, and `embed-cache/<source>.bin` on disk, at most 50 MB per source.
- **Thresholds per source.** Neural vectors have much higher background similarities than TF-IDF, so the drift rule has a row per source in `drift-rule.js` (background, widening, `rel`, `run`, `weak`), measured with `scripts/embed-eval.js` on a labelled set (results in `docs/plans/embedding-calibration.md`). A neural source without a row is "not calibrated": `auto` skips it; chosen by hand, its geometry is shown, but the drift rule says "not measurable". Measured so far: six Ollama models have a row; `nomic-embed-text:v1.5` and the ONNX model `multilingual-e5-small` do not beat TF-IDF.

## Interface (`renderer/`)

Static page: `index.html`, `style.css`, `game.js` (building, floors, balloons), `worldmap.js` (map of reality), `bottega.js` (Workshop book), `teams.js` (TEAMS panel: workflows, teams, messages), `embed-ui.js` (the "Meaning engine" options), `report.html`, `i18n-runtime.js`, plus `/drift-rule.js` served by the engine. It talks to the engine only over HTTP and SSE. The only point of contact with the shell is the optional `window.officeApp` object (if it's missing, you're in the browser).

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
- notifications (permissions, alerts, report): the engine decides when (`core.notify`, from `notify.js`), the shell decides whether to show them (its "notifications" option, window already in focus);
- mini mode;
- start at login (`src/autostart.js`);
- on Windows, the Start menu entry with the AppUserModelID for notifications;
- on macOS, the app menu and the Dock icon;
- on Linux, the app_id/`desktopName` `platypus` (matches `platypus.desktop`) and Wayland: natively there is no always-on-top or window position, so `getPin()` returns `false` and `PIN` offers to restart with `--ozone-platform=x11` (XWayland). The choice is `x11` in the app's `config.json`, also read by `scripts/launch.js`.

## Tauri shell (experimental)

Electron stays the default. A second shell in Tauri 2 is being built next to it, in `shells/tauri/`, to measure size, memory and start-up time and then decide with numbers. The plan, with its Journal, is [`plans/tauri-shell.md`](plans/tauri-shell.md); this section describes the design decided there and is updated as its tasks close.

**How it is made**

- **Its own folder:** `shells/tauri/` has its own `package.json` (only `@tauri-apps/cli`) and its own `Cargo.toml`. The main `package.json` gets no new dependencies: whoever uses Electron downloads nothing new.
- **The engine stays Node:** the shell finds `node` in the `PATH` and starts `node src/standalone.js --no-open` as a child process on the chosen port (`PLATYPUS_PORT`, or 47800). If a Platypus already answers on that port (`GET /api/state`), it attaches to it instead. It ends the engine on exit only if it started it.
- **The window** is a Tauri webview on `http://127.0.0.1:<port>/`, without decorations (the page draws its own title bar), like Electron's. Navigation stays on the engine's own pages; external `http`/`https` links open in the browser.
- **`window.officeApp`** has the same functions as in Electron (table above). An initialisation script, built with the real port, defines it on top of Tauri's `invoke`, and only on the engine's own origin. Only the shell's own commands are allowed to that page (one permission each, no `core:default`, no plugin permissions); the full `window.__TAURI__` API is not exposed. No command takes a path, a URL or a command line. Messages from the shell to the page (`onMaximized`, `onGoto`) are plain calls into the page.
- **Notifications and counters** come from the engine's `/api/shell/events` stream (`notify.js`), so both shells notify the same things. The tray menu has the same items as Electron's; its actions go through the engine's API (demo, Cowork, settings), and "connect to Claude Code" runs `node src/hooks-cli.js` after a confirmation.
- **Plugins:** `single-instance`, `autostart` (the same entry name as Electron's, so the two are never both active), `notification` (macOS and Linux), `opener`, `dialog`. They are called from Rust only, never from the page. The window position is remembered with the same rule as Electron (`src/bounds.js`); closing the window quits, as in Electron.
- **Starting it:** `npm run tauri:build` once, then `node scripts/launch.js --shell tauri` (with no build, the launcher explains how to make one and opens Electron). `npm run tauri:dev` runs it from source with the demo.

**Limits** (from the Tauri 2 documentation; to be confirmed by the measurements and the tests):

- Building from source needs Rust 1.90+ and the system libraries: on Windows the Microsoft C++ Build Tools (WebView2 is already part of Windows 10 1803+ and 11), on Linux `webkit2gtk-4.1` and `libayatana-appindicator`, on macOS the Xcode Command Line Tools. Node.js is still needed for the engine.
- On Windows the shell shows its own toasts, with the ID `com.platypus.desktop` registered for the current user, so they say "Platypus" and a click opens the floor, also from source. On macOS and Linux the notification plugin cannot report a click: the floor of the last notification is shown the next time the window is opened.
- On Linux the tray icon has no click event and no tooltip: everything is in its menu.
- On Wayland, WebKitGTK has the same limits as Electron (no always on top, no window position).

**Measurements** ([`plans/tauri-measurements.md`](plans/tauri-measurements.md), with the method to repeat them): on Windows the Tauri shell is about 5 MB on disk instead of about 370 MB, while memory (about 600 MB with the demo, mostly the Chromium that draws the office in both) and start-up time (about 1 s) are the same. Linux is still to be measured.

## Data on disk

| Path | Contents |
|---|---|
| `~/.claude/` | Claude Code's: read, never changed, except the hooks in `settings.json` if you install them |
| `~/.platypus/settings.json` | office options |
| `~/.platypus/stats.json` | daily and weekly statistics |
| `~/.platypus/notify.json` | the day of the last daily report notification, shared by the shells |
| `~/.platypus/bottega/<key>.json` | the Workshop book of each project (one file per project folder) |
| `~/.platypus/feedback/<key>.jsonl` | the messages to the agents of each project, sent and in shadow, with their outcomes (rotated at 5 MB into `<key>.1.jsonl`) |
| `~/.platypus/launch.log` | messages from the last window launch |
| `~/.platypus/embed-cache/<source>.bin` | the vectors of the neural meaning sources, with the sha1 of their text (never the text), at most 50 MB per source |
| `~/.platypus/models/` | the optional ONNX model, only after `npm run embed:onnx:install` |
| `$PLATYPUS_DATA_DIR` | if set, used instead of `~/.platypus` (created empty, nothing copied from the old Agent Office folder), and the Electron data go in its `electron/` subfolder: for tests and for development loops running next to your own Platypus |
| Electron data folder (`Platypus`) | window position and shell preferences |
