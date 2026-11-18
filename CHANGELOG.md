# What's new

Platypus releases (up to 2.7 it was called Agent Office), newest first.

*Versione italiana: [CHANGELOG.it.md](CHANGELOG.it.md).*

## 2.12.1: fixes

- **Model names**:
  - a model whose name ends in `[1m]` (for example `claude-opus-4-8[1m]`, as the Claude app writes it) now counts as a 1M-token context, both in the context bubble and in the engine's estimate of how full the context is; before, it counted as 200k until the context went past that. The agent's card says "· 1M";
  - a character's age is measured against the newest model of the same family: `claude-fable-5` is young (it used to look "mature", compared with Opus 5.5), and a family Platypus does not know yet is young when its version is recent and old when it is not (`claude-instant-1-2`). The rules live in one place, `src/core/models.js`, shared by the engine and the page.
- **Cowork**: from the metadata of a Cowork session Platypus keeps only an explicit list of fields (title, session ids, process name, model, effort, dates, archived, completed), each with its type. The first message, the system prompt, the account name and the e-mail address are never read into memory, nor is any field the app adds in the future.
- **launch.log**: the launcher no longer empties it at every start: the previous log becomes `launch.log.1` (if Windows won't let it rename the file, it appends instead).
- **Tests**: they refuse to start unless `PLATYPUS_DATA_DIR` points into a temporary folder, so they can never write into your real `~/.platypus`. See CONTRIBUTING for the command.
- **Neural embeddings**: a test now checks that the thresholds in the code are the measured ones, model by model; `qwen3-embedding:0.6b` stays the recommended model and the first one picked in automatic mode.
- **The optional ONNX model is now Qwen3-Embedding** (`onnx-community/Qwen3-Embedding-0.6B-ONNX`, about 585 MB): measured on the same set as the Ollama models, it beats the lexical engine (on synonyms 0.867 against 0.547; 96.7% of the drifts caught, with no false alarm), so it gets its own thresholds and automatic mode uses it when Ollama is not running. The previous model, e5-small, did not beat the lexical engine and is no longer used: if you installed it with 2.12, run `npm run embed:onnx:install` again.

## 2.12: meaning with neural embeddings, an experimental Tauri shell

The context bubble and the north star in the map of reality used to compare words: "fix the login" and "repair the authentication" looked like two different tasks. Now, if a local Ollama with an embedding model is running, they compare meanings, and the drift judgement no longer mistakes synonyms for a detour.

- **Automatic, and local only**: Platypus uses a local Ollama when it answers (only at `127.0.0.1`, `::1` or `localhost`; other hosts are refused), otherwise it stays lexical as before. It never downloads models: if one is missing, the options show the command (`ollama pull qwen3-embedding:0.6b`).
- **Measured, not assumed**: each model was measured on a set of 30 tasks in Italian and English (`scripts/embed-eval.js`, results in `docs/plans/embedding-calibration.md`). Six Ollama models beat the lexical engine (on synonyms the separation goes from close to chance to near perfect) and have their own drift thresholds; `qwen3-embedding:0.6b` is the best and is picked first. Automatic mode uses only measured models; any other source chosen by hand shows its picture, but says "not measurable" instead of guessing at drift.
- **Options → Meaning engine**: automatic, lexical only, Ollama or ONNX; the state of each source, the model in use, the cache and a button to clear it.
- **The bubble says where its meaning comes from** ("meaning: Ollama · qwen3-embedding:0.6b" or "lexical (TF-IDF): compares words, not concepts"); while the vectors arrive the lexical picture is shown at once, with "refining…".
- **Never in the way**: one queue, batches of 16 texts, 5 s per request (up to 60 s the first time a model is loaded); a source that keeps failing is set aside for 5 minutes.
- **Privacy**: snippets of the agents' text go only to the local model and are never written to disk; the cache in `~/.platypus/embed-cache/` (at most 50 MB per model) holds only vectors and hashes.
- **Optional ONNX model**: `npm run embed:onnx:install` installs a small multilingual model that runs without Ollama (about 320 MB, it asks first; the only download of this feature). It is weaker than the Ollama models at spotting drift, so automatic mode does not use it: choose ONNX in the options.
- **Demo**: a new "synonyms" scene, where an agent asked to fix the login works on authentication with other words: drifting for the lexical engine, on course for a meaning engine.
- **One drift rule**: the engine, the "back to the task" feedback and the map now use the same rule and the same thresholds, so they never disagree.

**A second desktop shell, experimental: Tauri.** Electron stays the default and gets no new dependency.

- **Tauri 2 shell** in `shells/tauri/`: the same window, title bar, full screen, mini mode, PIN, tray menu, notifications, start at login (the same entry as Electron, never two) and single instance. On Windows it is about 5 MB instead of about 370 MB, with the same memory and start-up time (`docs/plans/tauri-measurements.md`). Build it once with `npm run tauri:build` (it needs Rust and the system libraries, see the install guide) and start it with `node scripts/launch.js --shell tauri`; without a build the launcher explains what is needed and opens Electron.
- **Notifications decided by the engine**: an agent waiting, a new alert and the daily report are now decided in one place (`src/core/notify.js`) and only shown by the shell, so every shell notifies the same things. Electron behaves as before. The day of the last report notification now lives in `~/.platypus/notify.json`.
- **For shells**: `GET /api/shell/events`, an SSE stream with only counters, tray texts (in the language of the options) and notifications; and `--parent-stdin` for the engine, which saves and exits when the shell that started it closes, even if it crashes.
- **New workflow** `.github/workflows/tauri.yml` (by hand, or when `shells/tauri` changes): builds the Tauri shell on Windows, macOS and Linux, starts it once with `--smoke` and keeps only the program's size for 3 days. It has not run on GitHub yet, and the Linux checks of the shell are still to be done. `ci.yml` is unchanged.

**Tested on Windows, and Cowork on Windows.**

- **Cowork on Windows**: sessions of the Claude desktop app are found by their known path (`local-agent-mode-sessions\<account>\<org>\local_<uuid>`) instead of walking the whole app folder (on a real tree, 412 folders visited became 2, with the same 27 sessions); the card shows the title chosen in the app, and sessions archived in the app are no longer followed. The wide search stays as a fallback. The structure of the app's folders is described, anonymized, in `docs/plans/cowork-structure.md`.
- **Fixed**: the launcher no longer prints Node 24's `DEP0190` warning when it installs dependencies on Windows; turning *Start when I log in* on or off on Windows now also removes the start-up value that Agent Office wrote before the rename (`com.agentoffice.desktop`).
- **New checks**: `scripts/platform-test.js` (shortcuts, start at login, system integration, Cowork folders, in a temporary home) runs on Windows, macOS and Linux in the GitHub Actions; on macOS the CI also checks the mini mode and saves a screenshot of the map of reality. `npm test` gained checks for the launcher, the old start-up value, the mini-mode log and Cowork on a fake Windows tree.
- **Install guides**: a "Tested on" table and two new frequent problems (`.\start.cmd` in PowerShell, the shared start-up entry).
- **Feedback to the agents, checked on a real Windows session** (Claude Code 2.1.11): the hooks reach Platypus, the context reaches the model, failures fire, the `Stop` block works, and permissions from the balloon (YES, ALWAYS, NO, two at once, timeout, Platypus closed) behave as designed. `SessionStart` did not arrive in `claude -p` runs. Details in `docs/plans/2.11-real-check.md`.
- **Not tested yet**: a real interactive session on Windows (VS Code, Resume, Open folder), Windows 10 on arm64, WSL, a running Cowork session, and any hands-on run on macOS or Linux.

## 2.11: feedback to the agents

Until now Platypus only watched. From 2.11 it can also tell an agent what it sees, at the moment it matters: a lesson from the project's Workshop book, a loop on a command that keeps failing. It is all off until you turn it on, one feature at a time, and the less tested features only record what they would have said.

- **New hooks, installed apart**: OPT → *Feedback to the agents* → INSTALL THE FEEDBACK HOOKS… shows the exact lines before writing them to Claude Code's `settings.json`; or `npm run hooks:install -- --feedback`. They are separate from the observing hooks, and by themselves they say nothing. If Platypus is closed or slow, Claude Code goes on as usual.
- **Three modes for each feature**: *off* (the default), *shadow* (records what it would have said, without saying it) and *on*. Messages are rare (one every 2 minutes per agent, 6 an hour per session, never the same lesson twice to the same agent), short, signed "Platypus" and in English, since the model reads them. Subagents get them too. In a project's Book you can tick *Don't talk to this project's agents*.
- **What Platypus can say**:
  - **lessons at session start**: the project's strongest lessons, when a session starts, resumes or is compacted (not if the project's `CLAUDE.md` already has the Book's section);
  - **Grandpa talks to the agent**: right after a known trap (a flaky command that failed, an error already fixed elsewhere, a file that doesn't exist, a fragile file just edited, a slow command) the agent gets Grandpa's lesson, and his balloon says "✓ CLAUDE was told too";
  - **out of the loop**: when the same command fails a second time with the same error and nothing was edited in between, "change something before running it again, or stop and say what is blocking you";
  - **shadow only in this version**: an edit over a file another agent changed since this one read it; "the tests pass" or "I verified" at the end of a turn with no test or check run after the last edit; a reminder of the task when the north star says the agent has drifted.
- **Seeing it**: the agent's balloon shows "Platypus said: …" (or "would have said", for shadow); the Book has a new **FEEDBACK** tab with every message, sent or in shadow, in the office's language with the English text under it; the options show how many messages each feature sent in the last 7 days.
- **What happened next**: each message gets an outcome from the agent's next steps (likely helped, ignored, can't tell), and the FEEDBACK tab puts sent and shadow messages side by side, so you can see whether a feature helps before turning it on.
- **The demo** plays one scene per feature: within about 90 seconds every balloon has shown up and the FEEDBACK tab is full.
- **Not yet verified on real Claude Code sessions**: everything is built on documented hook events and tested with simulated hooks. The steps for a check on a real session are in `docs/plans/2.11-real-check.md`.
- The log of the messages lives in `~/.platypus/feedback`, one file per project; see [docs/INSTALL.md](docs/INSTALL.md#feedback-to-the-agents) for how to delete it.

## 2.10: workflows and teams, zoomable maps, a security pass

Platypus now shows Claude Code Workflows and agent teams, lets you zoom into the charts of the map of reality, fills the whiteboards in real use, and has had a security pass over the whole app.

- **Workflows and teams** (new **TEAMS** panel, **W** key or the button on the floor's notice board):
  - the agents of a Workflow now appear in the office, in a room for each run and phase, named by their label, and their tokens count in the cost, live, in the archive and in replays (before, they were missing);
  - the panel lists each run with its status, agents at work, elapsed time, cost, tokens and tool calls, and a progress bar, cost and duration for each phase; failed agents are listed by name, and when a run ends you get a short analysis (longest and most expensive phase, slowest agent, failures, redone tasks) plus Claude Code's own summary;
  - it also shows teams and departments (who is working, waiting, idle or done) and the messages agents send each other;
  - an "n WF" tag in the lobby and in the archive shows where workflows run or ran;
  - in the demo, floor 3 has a workflow that advances by itself and a finished one with its analysis.
- **Zoom on the map charts** (territory, context bubble, trajectory, seismograph):
  - the mouse wheel zooms around the cursor, up to 8x; dragging moves the view; a double-click or the "×2.0 · 1:1" chip goes back to the whole view;
  - on the territory the tiles are redrawn larger, so file names appear as you zoom in;
  - the two 3D charts still rotate when you drag, so they pan with Shift or the right button, and stop rotating by themselves while zoomed;
  - the seismograph zooms on time only, keeps the agent names and shows the visible time range.
- **Whiteboards**:
  - plans reach the board again: current Claude Code writes the plan to a file instead of passing it along, and Platypus now follows it, in the terminal and in the Claude desktop app;
  - task lists from the Claude desktop app fill the boss's whiteboard too, and get ticked off when the turn ends;
  - the whiteboards now sit right under the boss's office, so on busy floors you no longer scroll to find them, and the empty plan board says the plan will show up there in plan mode;
  - the board title is no longer clipped and long plan steps end with an ellipsis.
- **Grandpa shows up**:
  - he used to speak only when the command was identical to the lesson's; now `cd app && CI=1 npm test 2>&1 | tail -30` matches a lesson about `npm test`, and so does the same command with extra arguments;
  - the Workshop book reads a project's past sessions by itself, in the background, while the project has an open session (before, only the manual button did it).
- **Balloons**: they no longer cover the characters' faces, they no longer sit over an agent's card, and a Bash balloon without a description shows the real command instead of the `cd folder &&` in front of it.
- **Taskbar icon on Windows**: the 80s Platypus icon is back instead of Electron's atom and name.
- **Interface**:
  - **Top bar**: the numbers that call for action come first (waiting, alerts, cost, working, then agents, done, sessions, live), and what doesn't fit is hidden whole instead of cut mid-word; the "?" button stays visible in narrow windows;
  - **Options**: six sections instead of one long list, the SAVE bar always visible and saying when there are unsaved changes, and a warning before closing and losing them; "Windows notifications" is now "System notifications";
  - **Help**: it scrolls in small windows (half of it was out of reach) and covers the map and territory and surprise and causes views, the Workshop book and the TEAMS panel;
  - **Map of reality**: the four view tabs show their full names in small windows.
- **Security**:
  - Platypus now runs on Electron 44, a supported version (the old one no longer got security fixes);
  - another page open in your browser can no longer call the office's local server (for example a dev server on another port), nor load the office in a hidden frame to trick you into clicking YES on a permission balloon;
  - a malformed address can no longer crash the server;
  - the window stays on the office and sends only web links to the browser;
  - on Linux and macOS the `~/.platypus` folder (project names, commands, error excerpts) is readable by you only;
  - "Resume" on Windows with Windows Terminal no longer runs part of a folder name containing `;` as a command.
- **Small fixes**:
  - **Text**: accented characters are no longer garbled when Platypus reads a line while Claude Code is still writing it;
  - **Archive**: a session whose first message is very large (for example a pasted image) keeps its start time, length, title and folder;
  - **Statistics**: a Cowork session that gets its title later, or is renamed, is no longer counted as two projects;
  - **Waiting for you**: while Claude asks you a question or waits for you to approve a plan, the agent shows as waiting for you, with an alert, instead of "working";
  - **Map of reality**: `sed -i` marks the file as edited, `cp` and `mv` no longer mark the source file as edited, and sed expressions such as `s/old/new/` are no longer shown as folders;
  - **Workshop book on Windows**: the project name keeps its capital letters, also in the `CLAUDE.md` section;
  - **Shortcuts**: with the map of reality, the Workshop book or the TEAMS panel open, keyboard shortcuts no longer act on the office hidden behind;
  - **Whiteboards**: the labels under them no longer overlap the legs, and Grandpa's balloon stays near him.
- **Before you update**: Electron 44 no longer supports macOS 12, 32-bit Windows and Linux armv7l. The desktop window needs Node.js 22.12 or later; with Node.js 20, Platypus still works in the browser with `npm run web`.

## 2.9.1: fixes

Fixes for the bugs found by a debug pass over the whole app, each with an automated test.

- **The server no longer crashes** on a malformed address (such as `/%`), which any web page open in the browser could send.
- **Subagents**:
  - one that thinks for a while (for example while writing a long file) no longer leaves the office as finished and comes back as a new agent: its task is counted once;
  - one resumed after a long pause (with SendMessage or in a team) shows up in the office again, with its new tokens.
- **Archive**: the right length and title for sessions whose file is between 64 and 256 KB.
- **Map of reality on Windows**:
  - files reached by Git Bash commands (`cd /d/dev/...`) are now inside the project, the same places as with Read;
  - in a folder with a space in its name (such as `C:\Users\Mario Rossi\...`) the map follows the shell back to the right folder.
- **Workshop book**: a forgotten lesson no longer comes back by itself a minute later; only new cases start it again.
- **Windows**: a project folder with `&` in its name (such as `R&D`) no longer breaks reopening the IDE, and a specially crafted name can no longer run a command.
- **Window**: if it was last on a monitor that is no longer connected, it opens in the middle of the screen instead of off-screen.

## 2.9: map and territory, surprise and causes, the Workshop book

Platypus can't look inside the model's head, but it sees both the agent's map (what it read, said and did) and the territory (the disk, the outcomes of commands). This version measures the distance between the two. Everything is rebuilt from facts, stays on the computer, and uncertain verdicts are shown as such.

- **Map versus territory** (new view **MAP AND TERRITORY** in the map of reality):
  - **stale memories**: a file the agent read has changed since (by another agent, or outside the session, or it was deleted) and it hasn't read it again; **blind edits** when it edits it anyway, or Claude Code stops it;
  - **invented paths**: files it tries to open, that commands can't find or that its replies mention, and that don't exist; "created later" when they turn out to be an intention;
  - **claims** in its replies ("tests pass", "verified", "I fixed X", "I created X", "done", in Italian and English) checked against its own steps in the same turn: grounded, no evidence, or contradicted; the **grounding index** is the share of grounded claims;
  - in the office a clock next to the head of whoever has a stale memory, and a dashed balloon "no evidence: «…»"; optional **grounding alerts** in OPT.
- **Surprise and causes** (new view **SURPRISE AND CAUSES**):
  - every failure gets a **surprise** from 0 to 1, from the kind of failure (tests, commands, missing files, permissions, timeouts, syntax, failed edits, recognized for Jest, Vitest, pytest, Go, cargo, npm, tsc, Node, Python, PowerShell) and its history: more if it used to work, less on a first attempt or for a test just written;
  - what the agent does next: **corrects itself, insists or stops**, with the time to recover;
  - whether it **follows the trail**: the files and lines cited by the error against its first edits, and the **causal chain** error → cited file → fix → confirmation;
  - a **seismograph** with one row per agent; in the office a shaking "!?" for a strong surprise and a grey cloud for whoever insists.
- **Workshop book and Grandpa**:
  - every project gets a **book** of lessons deduced from its sessions: flaky commands, fragile files, known fixes, loop traps, contended files, invented paths, slow steps. The weight of a lesson grows with the cases and the sessions and halves every 30 days; a single case is only an observation;
  - the book learns live and, with **Learn from the archive**, from past sessions; it lives in `~/.platypus/bottega` and learning can be switched off in OPT;
  - **Grandpa**, an old man with a cardigan and the book under his arm, walks to the desk of an agent about to repeat a known mistake and tells the lesson, at most once every 3 minutes per floor;
  - the **Book** (BOOK on the floor's notice board, WORKSHOP in the lobby, or a click on Grandpa): lessons with evidence, pin/ignore/forget, replay from a piece of evidence, and **Propose for CLAUDE.md**: a short section for the project's `CLAUDE.md`, copied or written between Platypus's markers with a backup, only after you confirm (never for the demo, Cowork or read-only folders).
- **Demo**: floor 1 acts out all of it within the first minute and a half, with a fake book that never reaches the disk.

## 2.8: it's called Platypus

- **New name**: Agent Office becomes **Platypus**, in the app, the menus, the shortcuts and the docs.
- **Switch over without losing anything**:
  - options and statistics are copied once from `~/.agent-office` to `~/.platypus`, as are the window preferences;
  - hooks already installed in Claude Code are recognized and updated to the new address automatically;
  - the `AGENT_OFFICE_*` variables still work as `PLATYPUS_*`;
  - the old Start menu shortcut and the old start-at-login entries are removed.

## 2.7: everywhere, from source

- Runs on **Windows, macOS and Linux** from the same repository: clone and launch, with no prebuilt binaries and no signing.
- **One requirement**: Node.js 20 or newer. On first launch the launcher installs Electron by itself, the right build for the system and processor (x64 or arm64); after every `git pull` it updates it if needed.
- Double-click launchers: `start.cmd` (Windows), `start.command` (macOS), `start.sh` (Linux and macOS). If the desktop window can't start (no display, missing libraries) the office opens in the browser.
- `npm run shortcut` creates the Desktop icon (Windows), *Agent Office.app* in Applications (macOS) or the entry in the applications menu (Linux).
- **Start at login** on all three systems, from source too; on Windows the Start menu and notifications work without an installer.
- macOS: app menu with the standard shortcuts, Dock icon, bringing the right window forward by walking up the process tree (Terminal, iTerm, VS Code, Claude...).
- Linux: session window brought to the front with xdotool or wmctrl (X11), sessions resumed in the first available terminal (GNOME Terminal, Konsole, kitty, Alacritty, WezTerm, xterm...), automatic restart with `--no-sandbox` where the Electron sandbox is blocked.
- **WSL**: on Windows it also follows Claude Code installed in running WSL distributions; more `.claude` folders can be added in the options.
- Automated checks (`npm test`) and GitHub Actions that run them on Windows, macOS and Linux on every push.

## 2.6 (experimental): context bubble and north star

The map of reality has a second view, **BUBBLE AND NORTH STAR**.

- **Context bubble**: each dot is a piece of what the agent has in front of it (the task, the files it read, command output, search results, its own replies, subagent reports). Pieces about the same things sit close together, and their size shows how many tokens they take up. The bubble swells as the context fills up, green, then yellow, then red. When Claude compacts the context the bubble deflates: forgotten pieces drift out as grey dust and the summary stays inside. Next to it, **what the context is made of**: the main topics with their share, and what was lost in the last compaction.
- **North star**: the task (your request, or a subagent's prompt) is a star in the bubble. The chart shows how much each action talks about the same things as the task, compared with the first actions: **on course**, **drifting away**, **drifting** (below 35% for 6 actions in a row). Each new request moves the star; messages you send while it works count too. If the task's words never show up in the work, it says **can't tell** instead of making up a verdict. Below: the actions closest to the task and the furthest among the latest ones.
- **Lexical engine**: it compares the important words (TF-IDF, including inside file names and identifiers), with a small Italian → English software vocabulary, so "autenticazione" meets `auth/`. The goal "widens" with the first actions that resemble it most. It's fast, downloads nothing and sends nothing off the computer, but it doesn't understand synonyms the way a neural model does: that's why it's marked as experimental.
- Works live, in archive replay and with the timeline; the map now also reads the older part of the transcripts (outcomes, requests, compactions), not just the last chunk.

In the demo, the PLAN on floor 1 at some point gets lost among the UI components: you can see it drift away from its star.

## 2.5: the map of reality

From an agent's card (**MAP OF REALITY** button) or with the **G** key you open its map, in green vector graphics like old arcade cabinets. You can look at one agent at a time or at **the whole session** together, live or in archive replay.

- **Territory, with fog of war**: each small square is a project file (read from disk) or a place met outside (websites, terminal commands, subagents, files outside the folder). The fog is what the agent has never seen; dark blue is the **frontier** (files mentioned by an import, a link or a search, but never opened); light blue is what it read, lighter if it keeps going back; yellow what it changed, green what it created. A trail joins the last places visited and the blinking square is where it is now. At the top: how much of the project it knows, how many files are on the frontier, how many it has changed.
- **Trajectory through state space**: at every action the agent is a point in a **7-dimensional** space, computed over its last 8 actions: explores, builds, verifies, novelty, errors, repeats, context. The 3D view (drag it to rotate) uses three readable axes by default: explores ↔ builds, novelty, friction; they can be changed. The radar shows the 7 dimensions of the moment. A tightening trail means it is converging; a dense tangle means it is going in circles.
- **Work phase**: exploring, studying, building, verifying, struggling, in a loop, getting its bearings. The colored strip below is the history of the phases; with the bar and the ▶ key you can replay how its idea of the problem took shape.

The map is rebuilt from what the agent does (files, commands, searches, outcomes), not from what it thinks: its thoughts are not visible. Everything stays on the computer.

### Ideas in the works for the map

- **Maps side by side**: what the boss knows and what the subagent knows, how much is lost in the handover, which areas no reviewer has looked at.
- **Neural engine for the bubble and the star**: embeddings computed locally with a small multilingual model, instead of the lexical engine, to recognize synonyms too.

## 2.4

- **Model and effort of each agent**: the agent's card shows the model (e.g. Opus 5.5, Haiku 4.5) and the effort level. You can also tell at a glance:
  - **age shows how old the model is** compared with the newest one: young, mature (grey temples), elderly (grey hair and glasses), old-timer (white hair, moustache, walking stick and a slow pace);
  - **effort shows how super it is**: high = cape, very high = cape and chest emblem, max = full costume with mask and sparkles. Age stays the same: an old Haiku with max effort is an old-timer dressed as a superhero.
  Model and effort are read from the replies Claude Code writes in the transcripts; versions of Claude Code that don't write the effort leave agents in normal clothes.
- **Multilingual**: Italian and English. In **OPT** → Language pick Automatic (the Windows language), Italiano or English; the page reloads by itself. Translations live in `src/i18n/locales/<language>/*.json` and the key of each string is the Italian text. To add a language, copy the `en` folder, translate the values and add it in `src/i18n/index.js`; `npm run i18n:check` tells you what is missing. Text already written (log, releases, reports from past days) stays in the language it was created in.
- **Fixes**: the annoying coworker's balloon no longer floats around after he leaves or you change floor, and it's easier to read (yellow, black text, wraps instead of being cut off).

## 2.3

- **Permissions from the balloon**: when an agent asks for permission, its balloon has the buttons **YES**, **ALWAYS** (allow and don't ask again in this session) and **NO**. They are also in the mini mode strip. On first launch 2.3 updates the hooks already installed: the permissions hook becomes "synchronous" and waits for the office's answer. If the office is closed, or you don't answer within the time set in the options (default: 120 seconds), the terminal decides as usual. It can be turned off in **OPT**.
- **Outfits for holidays, seasons and weather**: Santa hats and reindeer antlers with the tree in the lobby, party hats on New Year's, masks and jester hats at Carnival, little hearts on Valentine's Day, mimosas on 8 March, the paper fish on the back on 1 April, bunny ears at Easter, the little flag on 25 April, 1 May and 2 June, flowery shirts on Ferragosto, witches, pumpkins and vampires at Halloween. When it's cold scarves and beanies, when it's hot sunglasses, with rain or snow umbrellas. The weather comes from Open-Meteo for the city chosen in the options (default: Rome; empty = no weather) and also shows through the windows: rain, snow, fog and thunderstorms.
- **Cowork sessions from the desktop app**: the office looks for Cowork session folders inside the Claude app folder (`%APPDATA%\Claude`, `%LOCALAPPDATA%\Claude` and the Microsoft Store install) and follows those used in the last 36 hours. In **OPT** you see what it found, you can scan again and add more folders. Cowork sessions started in the cloud (from the phone or the web) run on Anthropic's servers and leave no files on the computer: those can't be seen.
- **Fix**: if the rooms move (a new department arrives or you resize the window), whoever was walking to a desk or a whiteboard reappears in the right place instead of walking into a room that no longer exists. The same goes for the cat, the annoying coworker and the janitor.

To try the outfits without waiting for the holiday: browser mode with `?festa=natale` (or `halloween`, `carnevale`, `pasqua`, `pesce`...) and `&meteo=rain` (or `snow`, `hot`, `cold`, `fog`, `storm`).

## 2.2: office life

A bit The Office, a bit IT Crowd, but every gag is tied to something real:

- **The office cat** sleeps on the pouf in the creative room. When an agent stays stuck on a command for too long, the cat goes and lies down on its keyboard.
- **The annoying coworker** wanders the floors, stops by the desks and makes small talk ("did you see this morning's email?"). The name is changed in **OPT** → "Annoying coworker's name" (default: Ugo Pignolo). He can also be turned off.
- **End-of-work party**: for a commit, a PR opened or merged, a tag or a test suite that turns green, confetti goes off on the floor and the agents raise their arms. If you're on another floor a notice appears at the bottom. Green tests only throw a party if they were red before or if there hasn't been a party in 15 minutes.
- **Night at the office**: after 8 pm and before 7 am the windows show the city at night, only the lamps of those who are working stay on, and the janitor comes by.
- **Release board** hanging on the wall of every floor: the latest commits, pushes, PRs and green tests of that session.
- **Costs over time**: on the lobby board, **COSTS** tab, a chart of the last 14 days split by project.
- **Employee of the week**: **HONOURS** tab and a portrait hanging in the lobby. The winner is the agent type that closes the most tasks with the fewest errors; there are also the coffee award (the priciest), the workhorse and "butterfingers" (most errors).
- **Daily report**: **TODAY'S REPORT** button in the lobby or entry in the icon menu. Costs, tokens, sessions, projects, releases and honours of the day, with print/PDF, copy text and send by email. At the time chosen in the options (default: 6 pm) a Windows notification arrives, once a day and only if there was activity.
- **Search** (`/` or **SEARCH**): finds agents, tasks and projects on all floors and takes you there.
- **Mini mode** (`M` or **MINI**): the window becomes a small strip, always on top, in the corner of the screen, with counters, cost and pending requests. **OPEN** puts it back as it was.

Daily statistics are saved in `%USERPROFILE%\.agent-office\stats.json` and start from when the office is open.

## 2.1: the creative room

Every floor has a **CREATIVE ROOM** with two whiteboards on wheels:

- **The boss's whiteboard**: when Claude updates its to-do list (TodoWrite or Task), it walks to the whiteboard and rewrites it. What's done turns green and struck through, what's in progress orange.
- **The free whiteboard**: when Claude leaves plan mode, it draws the plan there in boxes and arrows. Whoever finishes a task often leaves a signed doodle before leaving (a cat, a rocket, "SHIP IT!", a rising chart...), and the boss scribbles on it while waiting for you.
- **Frustration**: an agent that gets the same tool wrong 3 times in a row, or the boss when you interrupt it, walks to the whiteboard and knocks it over with a nice "#@!%&!!". It stays there until it has calmed down, then someone comes by to put it back up.

## 2.0

- **Costs and tokens**: each floor shows on its board the session cost, the tokens used and a bar against your budget (green, orange above 80%, red above 100%). The cost comes from Claude Code itself: it writes the computed cost in the transcript (`cost-state`) and the office uses it as the reference. From there it splits the cost across each room and each agent based on their tokens, and updates it with the following tokens. Until Claude Code has written its cost, the value is an **estimate** (marked as such) based on a price you can change in the options. The lobby board has the COST column and the top bar the total.
- **Smart alerts**: an orange **!** on the agent, on the notice board, on the lobby board and on the elevator button when:
  - an agent has been waiting for your permission for more than 3 minutes;
  - a tool (e.g. a command) hasn't responded for more than 10 minutes;
  - the same tool fails 3 times in a row;
  - Claude has finished and has been waiting for you for more than 15 minutes;
  - the session goes over budget.
  The thresholds are changed in **OPT** (`O` key); with the app they also arrive as Windows notifications.
- **Archive and replay** (`A` key, floor **-1**): the list of past sessions, rebuilt from the transcripts. **REPLAY** stages the session again in the basement at 10×–600× speed, with the org chart forming minute by minute and long pauses skipped. There is a tape-recorder bar for pause, speed and position. **RESUME** opens a new terminal with `claude --resume` in the right folder (Windows Terminal if available, otherwise the command prompt). **FOLDER** opens it in File Explorer.
- **Answer from the office**: **WINDOW** (on the notice board or in an agent's card) brings that session's terminal, IDE or Claude app to the front. On Windows it walks up from the Claude Code process to its window; if it can't find it, it brings forward the most likely app (VS Code, Claude, Windows Terminal) and tells you so. With several tabs open in Windows Terminal the right window comes to the front, but you pick the tab.
