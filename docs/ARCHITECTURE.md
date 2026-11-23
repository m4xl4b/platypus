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
| `stats.js` | daily and weekly statistics, report; kept in the store's `daily` collection |
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
| `feedbacklog.js` | the log of the messages, in the store's `feedback` collection, outcomes patched on the message; the demo uses an in-memory version with the same interface |
| `store/` | the document store (see *History* below): `index.js` (`openStore`, `openStoreSafe`, the `Store` and `Collection` classes), `common.js` (filter language, ULIDs), `memory.js` and `sqlite.js` (the two backends), `migrations.js`, `privacy.js` (declared fields, `relPath`, `scrub`), `collections.js` (the eight collections), `project-key.js`, `legacy.js` (import of the 2.12 files), `sqlite-load.js` |
| `history.js` | the engine's side of the store: opens it, imports the 2.12 files once, the write queue of steps and session summaries, retention, size limit, forget, compact, export |
| `retention.js`, `history-query.js`, `search.js`, `experiments.js` | retention and size limit; metrics per day or week and their trend; search over the stored steps; experiment groups and their statistics |
| `demo-history.js` | three months of fake history for the demo, in a memory store of its own |
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
| `POST /api/bottega`, `/api/bottega/learn` | pin/ignore/unignore/forget a lesson; `mute`/`unmute`; the project's guard (`action: guard`, `mode`: `off`, `on`, `auto`) and its rules accepted as normal (`accept`/`unaccept`, `rule`); learn from the project's archive in the background |
| `GET`/`POST /api/bottega/claudemd` | preview of the `CLAUDE.md` section; write it (only with `confirm: true`) |
| `POST /platypus-hook/feedback` | synchronous feedback hook: the answer for Claude Code, or an empty `204` |
| `GET`/`POST /api/feedback/hooks` | whether the feedback hooks are installed and the exact lines; install or remove them (only with `confirm: true`) |
| `GET /api/feedback/log`, `/api/feedback/counts` | a project's messages to agents with their outcomes (`sid`, `cwd` or `key`); how many per feature in the last 7 days |
| `GET /api/feedback/experiment` | the modes of the feedback features and the experiment results per group, for a project (`sid`, `cwd` or `key`) and for all |
| `GET /api/history` | metrics per day or week (`metric`, `from`, `to`, `bucket`, project by `sid`, `cwd` or `key`), each with its trend; `metric=all` for all of them |
| `GET /api/history/search` | the stored steps by `file`, `command` or `error` (and `outcome`, `from`, `to`, `limit`), with a 150 ms budget |
| `GET /api/risks` | the stored risky actions (2.14), for a project (`sid`, `cwd`, `key` or `project`) or all; `session`, `from`, `to`, `missed=1`, `limit`; each with its reasons and how to undo, in the office's language |
| `GET /api/fear` | the Book's FEARS tab: the last 90 days of a project by level and rule, and the latest events; with a project, also its guard mode, its accepted rules and whether the feedback hooks are installed and up to date |
| `GET`/`POST /api/store` | the store's state (backend, size, retention, notice); `compact`, `export`, `forget` (only with `confirm: true`), retention and size limit |

The server rejects requests whose `Host` or `Origin` is not `127.0.0.1`/`localhost` (protection against DNS rebinding and websites).

### Feedback to the agents

`POST /platypus-hook/feedback` answers within 300 ms, using only what is already in memory (the state, the books, the log). A later answer, or any error, becomes an empty `204` and Claude Code goes on as if Platypus were not there. The answers use only these hook formats:

| Event | Answer |
|---|---|
| `SessionStart`, `PreToolUse` (from 2.14, the fear), `PostToolUse`, `PostToolUseFailure` | `{"hookSpecificOutput": {"hookEventName": …, "additionalContext": "Platypus: …"}}` |
| `Stop`, `SubagentStop` | `{"decision": "block", "reason": "Platypus: …"}`, never while `stop_hook_active` is true; in 2.11 the only feature that would use it (claims) stops at shadow, so it is never sent |

Never `updatedInput` or `updatedToolOutput`, and `permissionDecision` only as the guard's `ask` (see *Fear*), never `deny`: Platypus adds context, it does not decide for you. Each feature is `off`, `shadow` or `on` (`fbSessionLessons`, `fbElder`, `fbLoop`, `fbStale`, `fbClaims`, `fbDrift`, `fbFear` in the options; `fbStale`, `fbClaims` and `fbDrift` are `shadow` at most, and `fbFear`, from 2.14, starts in `shadow`). Limits: one message per agent every 2 minutes, 6 per session per hour, the same lesson once per agent; shadow messages count like sent ones. The demo calls the same function without the network, with its own modes and an in-memory log.

### Meaning (embeddings)

The bubble and the north star measure what an agent is talking about with vectors. The lexical source (TF-IDF, always there) compares words; a neural source also understands synonyms ("login" and "authentication"). The option `embedEngine` chooses: `auto` (the default: Ollama if it answers, then ONNX if installed, otherwise TF-IDF; only calibrated sources, see below), `tfidf` (lexical only), `ollama` or `onnx` (that one, or TF-IDF saying why). With `auto` and no Ollama, the engine looks again at most once a minute, and only while a bubble or the drift rule asks for vectors.

- **Sources.** Ollama is called with Node's `http`, only on `127.0.0.1`, `::1` or `localhost` (`ollamaUrl`); the model is `embedModel` or the first embedding model found, the best measured ones first (`qwen3-embedding:0.6b` leads); Platypus never runs `ollama pull`, it shows the command. The ONNX provider lives in `optional/embed-onnx/` with its own `package.json` and runs `onnx-community/Qwen3-Embedding-0.6B-ONNX` (q8, last-token pooling) in a `worker_thread`; the engine loads it with `require` only if `npm run embed:onnx:install` has installed it (that command asks first and is the only one that downloads a model).
- **Never blocking.** One queue for the engine, batches of at most 16 texts, 5 s per request (up to 60 s while a model that is not loaded yet is loading; Ollama is then asked to keep it loaded for 10 minutes), the agents being looked at first; 3 failures in a row suspend a source for 5 minutes. A vector that is not there yet is simply missing: the TF-IDF picture is shown at once ("refining…") and replaced when the neural vectors of every goal and action have arrived. Vectors of different sources are never mixed in one calculation.
- **Text and cache.** The pieces of an agent's context keep a short snippet of their text in memory (at most 320 characters, 480 for an action with its result), never on disk. The cache keeps vectors and sha1 hashes only: 5000 vectors in memory, and `embed-cache/<source>.bin` on disk, at most 50 MB per source.
- **Thresholds per source.** Neural vectors have much higher background similarities than TF-IDF, so the drift rule has a row per source in `drift-rule.js` (background, widening, `rel`, `run`, `weak`), measured with `scripts/embed-eval.js` on a labelled set (results in `docs/plans/embedding-calibration.md`). A neural source without a row is "not calibrated": `auto` skips it; chosen by hand, its geometry is shown, but the drift rule says "not measurable". Measured so far: six Ollama models and the ONNX Qwen3-Embedding have a row; `nomic-embed-text:v1.5` and the old ONNX model `multilingual-e5-small` (replaced in 2.12.1) do not beat TF-IDF.

## History (`src/core/store`, `src/core/history.js`)

From 2.13 the engine keeps its data in a document store with one interface and two backends: `sqlite` (Node's built-in `node:sqlite`, file `platypus.db` in the data folder; this needs Node.js 22.13) and `memory` (tests, the demo, and the fallback when the database cannot be used). A MongoDB backend for the 3.0 server can be added with `registerBackend` without the engine depending on it; `scripts/store-conformance.js` is the suite every backend must pass.

- **The interface.** `store.collection(name)` with `get`, `put`, `patch`, `delete`, `find(filter, {sort, limit, skip, fields})`, `count`, `deleteMany`, `append`; `store.transaction`, `declare`, `forgetProject`, `export`/`import`, `getMeta`/`setMeta`, `info`, `flush`, `close`. Filters are a strict subset of MongoDB's (equality, `$in`, `$gt`/`$gte`/`$lt`/`$lte`, `$exists`, `$or`, dotted paths): anything else is an error, never ignored. `_id` is a string (a ULID unless given), times are milliseconds. On this computer the calls are synchronous.
- **SQLite.** One table per collection (`_id`, `project`, `t`, `doc` as JSON), indexes declared per collection, filters translated to SQL with parameters only; `busy_timeout` 3 s, WAL, `synchronous=NORMAL`. Appends wait in a queue and are written in one transaction every 2 s or at 500 documents; every read flushes it first. A `meta` table holds the schema version: migrations run in one `BEGIN IMMEDIATE` transaction after a `VACUUM INTO platypus.db.bak-<version>` copy (the last two kept). At start `quick_check` runs at once on a database up to 64 MB, in a worker thread otherwise. A damaged, newer or unwritable database makes `openStoreSafe` fall back to `memory`, set the file aside as `platypus.db.broken-<date>` when damaged, and the office shows "history not available: <reason>".
- **Collections** (`collections.js`), each with its declared fields, indexes and default retention: `projects` (key, aliases, remote without credentials, folder name; forever), `lessons` (the Book; low weight and older than 180 days), `steps` (one per finished action; 90 days), `sessions` (one summary per session; 365 days), `feedback` (messages to the agents and their outcomes; 365 days), `risks` (the risky actions of 2.14, with their prudence and outcome; like the sessions, 365 days), `experiments` (the group of a session for a feature; 365 days), `daily` (daily and weekly statistics; forever). Retention runs at start and every 6 hours in small batches; over the size limit (200 MB by default) the oldest steps go first.
- **Project key** (`project-key.js`): the first 16 hex characters of the sha1 of the `origin` remote, normalised (host in lower case, no credentials, no port, no `.git`, ssh and https equal); without a remote, the key of the folder, as the 2.12 Book had. Old keys stay as aliases. `git` is read once per folder, never in the event path.
- **Privacy by construction** (`privacy.js`): a collection accepts only its declared fields, each with a type; a free string is one line of at most 300 characters, so a prompt, a reply or an output cannot fit. Paths are relative to the project; outside it they become `ext:<hash>/<file name>`. Excerpts (error signatures, evidence lines, commit titles, the messages to the agents) pass through `scrub` (tokens, keys, passwords, connection strings, e-mail addresses, IBANs). A command keeps only its first simple words (`cmdShape`: `mysql -u root -p…` → `mysql`). Undeclared fields are dropped and reported once by name, or refused with `PLATYPUS_STORE_GUARD=reject` (the tests).
- **The engine side** (`history.js`): `state.js` emits `step` when an action finishes; steps and session summaries go through the write queue, which keeps a batch when the database is busy. The Book, the statistics and the feedback log read and write through the store. The first start imports the 2.12 files once (`legacy.js`), leaving them in place and copying them to `legacy-<date>/`. Forgetting a project removes its key and aliases from every collection, its name from the statistics, the backups and its 2.12 files, then runs `VACUUM`. Export writes one JSONL file per collection. The demo never writes to the store: it has its own memory store (`demo-history.js`).
- **Reading it** (`history-query.js`, `search.js`, `experiments.js`): metrics per day or week from `sessions`, `steps` and `feedback`, the trend of the last 4 weeks against the 4 before (at least 5 sessions on each side, otherwise "not enough data"); search over `steps`; and the experiment mode of the feedback, where each session is assigned to `on` or `shadow` from the sha1 of its id and the feature, with a 95% Newcombe interval for shares and Welch for errors per 100 actions. None of it runs in the SSE path.

## Fear (`src/core/risk.js`, `prudence.js`, `fear.js`)

From 2.14 Platypus notices the actions that are hard to undo. Platypus is not a protection: it recognises known patterns and can miss what it does not know, and every judgement is labelled "probable".

- **Classifier** (`risk.js`, rules in `risk-rules.js`). `classify({ tool, input, cwd, root, … })` returns the level (0 none, 1 attention, 2 danger, 3 irreversible), the rules that fired, the category, the reach, how to undo it if one can, and which kinds of prudence count. A small lexer splits bash, PowerShell and cmd lines without expanding anything, and enters `sudo`, `env`, `xargs`, `bash -c`, `cmd /c`, `powershell -Command`, `eval`, `ssh host …`, `find -exec` and `$(…)`. It follows `cd` and `git -C`, and reads heredoc bodies only where a shell or a SQL client runs them. It is pure functions: no command, no file, no network; p99 well under a millisecond. Not seen: a command hidden in a variable, a script file (`npm run deploy`, `psql -f`) or a language one-liner.
- **Prudence** (`prudence.js`). In the agent's last 12 actions, it looks for: looked first (by category: `git status`, `ls` of the target, `terraform plan`, a `SELECT` on the same table…), a backup (commit, stash, branch, a copy, a dump), a dry run, a clean tree (the last `git status`), the user asking for it (lexical, "probable"). Only the kinds the rule declares count. A **missed fear** is level 2 or more with a score under 0.5; looking alone is 0.3.
- **Events** (`fear.js`, collection `risks`). The engine classifies every action when it starts, from the transcript, so with or without hooks. A risky one becomes a document with the same `_id` as its step: rule, level, prudence, the rule's fixed shape (`git reset --hard <ref>`), the target relative to the project, the agent's name, never the command. Retention follows the sessions (365 days).
- **Scars.** After a level 2+ action, the next 8 actions and the user's next message are checked for damage: a new error on the target, a file that was there and is gone, a recovery attempt (`git reflog`, a reset to `HEAD@{1}`, a restore), or "you deleted…" (lexical). The event gets `outcome: damage` with the steps as evidence, and the Book gets a `scar` lesson: a lesson from the first case if one sign is in the facts, otherwise only from the second; it decays in 90 days instead of 30. The Nonno tells scars first.
- **Office** (option `fearEnabled`, on, it only observes): a prudent risky action makes the character sweat; a missed fear brings the Nonno with a hand on the shoulder and a DANGER or IRREVERSIBLE stamp on the desk; a scar stays on the character for the session. The permission balloon and notification add the level, the reasons, the missing prudence and how to undo; ALWAYS on level 3 asks once more.
- **The fear message** (feedback feature `fear`, option `fbFear`, shadow by default): at `PreToolUse`, for level 2 or more without prudence, one line of context for the agent, once per rule per session. Only `additionalContext`: the action still runs.
- **Report, Book, history:** missed fears per agent and the day's scars in the daily report; the Book's FEARS tab (`/api/fear`); the session metrics `risky_actions`, `missed_fears`, `scars`.
- **The guard** (`guard.js`, R8): at `PreToolUse`, for a level 3 action without prudence, the feedback route answers `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": …}}` (plus the fear's `additionalContext` if there is one). Per project in the Book (`guard`: `off` by default, `on`, `auto`) with the rules accepted as normal (`accepted`, which also silence the fear message), both in the project document. `auto` asks only when `attended()` estimates that someone can answer: an interactive session kind (`cli`, `desktop`, `ide`, `cowork`, from the transcript's `entrypoint`), not a background subagent, a user message in the last 30 minutes; otherwise it logs a `guard` entry in shadow. R0 found that `ask` prompts in every permission mode, even over `allow` rules, and becomes an automatic refusal where nobody can answer; the hook cannot tell those sessions apart, hence the estimate. Fail open: a late or failed answer is no answer.

## Interface (`renderer/`)

Static page: `index.html`, `style.css`, `game.js` (building, floors, balloons), `worldmap.js` (map of reality), `bottega.js` (Workshop book, with its HISTORY and FEEDBACK tabs), `store-ui.js` (the ARCHIVE options), `teams.js` (TEAMS panel: workflows, teams, messages), `embed-ui.js` (the "Meaning engine" options), `report.html`, `i18n-runtime.js`, plus `/drift-rule.js` served by the engine. It talks to the engine only over HTTP and SSE. The only point of contact with the shell is the optional `window.officeApp` object (if it's missing, you're in the browser).

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
| `~/.platypus/platypus.db` | the history (from 2.13): Workshop book, statistics, messages to the agents, steps, session summaries, experiment groups, and small markers such as the day of the last report notification; with `platypus.db-wal` and `platypus.db-shm` while it is open |
| `~/.platypus/platypus.db.bak-<version>`, `platypus.db.broken-<date>` | the copy made before a schema migration (the last two); a damaged database set aside |
| `~/.platypus/legacy-<date>/` | a copy of the 2.12 files made by the first import |
| `~/.platypus/stats.json`, `bottega/`, `feedback/`, `notify.json` | the 2.12 files: read once by the first 2.13 start, then left as they are (for going back to 2.12) |
| `~/.platypus/launch.log` | messages from the last window launch |
| `~/.platypus/embed-cache/<source>.bin` | the vectors of the neural meaning sources, with the sha1 of their text (never the text), at most 50 MB per source |
| `~/.platypus/models/` | the optional ONNX model, only after `npm run embed:onnx:install` |
| `$PLATYPUS_DATA_DIR` | if set, used instead of `~/.platypus` (created empty, nothing copied from the old Agent Office folder), and the Electron data go in its `electron/` subfolder: for tests and for development loops running next to your own Platypus |
| Electron data folder (`Platypus`) | window position and shell preferences |
