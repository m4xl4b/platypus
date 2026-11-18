# Working in parallel on the Platypus plans

This file lives in the repository as `docs/plans/parallel.md`. It applies to **all** the loops that run together. The rules of each plan come on top of these; if two rules contradict each other, the more cautious one wins.

The Italian original was Max's `PARALLELO.md`. This English version is the one that counts.

## Who works where

| Loop | Plan | Branch | Folder | Port | Computer |
|---|---|---|---|---|---|
| Tauri | `docs/plans/tauri-shell.md` | `sviluppo-tauri` | its own git worktree | 47830 | development computer (this Windows PC) |
| Embedding | `docs/plans/neural-embeddings.md` | `sviluppo-embedding` | its own git worktree | 47840 | development computer |
| Windows tests | `docs/plans/platform-tests.md`, tasks `[win]` and `[ci]` | `prove-windows` | its own git worktree | 47850 | this Windows PC |
| Linux tests | `docs/plans/platform-tests.md`, tasks `[linux]` and `[ci]` | `prove-linux` | worktree or separate clone | 47860 | the Linux computer |

The app that starts the sessions may add a prefix or suffix to the branch names. The branch is whatever the loop's worktree is on, and a loop never switches branch.

The main folder of the repository (`platypus`) stays on `main`. It is only for preparation and integration: no loop runs there.

## Rules for working in parallel

**Don't step on each other:**

- **Environment variables:** in every command that starts the engine or the window, set `PLATYPUS_PORT=<the loop's port>` and `PLATYPUS_DATA_DIR=<loop folder>/.platypus-dev`.
  - This way no loop touches Max's real Platypus or the other loops' ones.
  - The only exception is the "as a user" tests of the platform-tests plan, which follow their own rules: backup first, restore after.
- **A temporary home, always:** the engine reads Claude Code's sessions from the home folder, and Max's real sessions must never be read. So `npm test`, the engine, the window and every check run with `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `CLAUDE_CONFIG_DIR` pointing into an empty temporary folder, created fresh and deleted after, on top of `PLATYPUS_DATA_DIR`. `PLATYPUS_DATA_DIR` alone is not enough: it moves Platypus's own data, not what it reads. For example, in Git Bash: `H="$TEMP/<loop>-home" && rm -rf "$H" && mkdir -p "$H" && USERPROFILE="$H" HOME="$H" APPDATA="$H/AppData/Roaming" LOCALAPPDATA="$H/AppData/Local" CLAUDE_CONFIG_DIR="$H/.claude" npm test`. Fake sessions for a check are written into that temporary home. The only exceptions are the platform-tests tasks that look at real data, and only with Max's permission given at that moment.
- **Max's own Platypus:** it usually runs on this computer (port 47800, data in `~/.platypus`, Electron data in `%APPDATA%\Platypus`). Never connect to it, never stop it, never change its settings.
- **Processes:** always stop the processes you started. To find them, use the PID saved when you started them, never `pkill` with a name: you could stop Max's Platypus or another loop's. Stop only processes you started.
- **Translations:** each plan has its own file of English translations, in `src/i18n/locales/en/`:
  - Tauri: `tauri.json`;
  - Embedding: `embed.json`;
  - Tests: `platform.json`.
  - The keys are the Italian UI text (the code uses Italian strings as keys); the values are English.
  - Do not add keys to the other files.
- **Shared files:**
  - `README*.md`, `CHANGELOG*.md`, the version in `package.json` and `docs/INSTALL.md` / `docs/INSTALLAZIONE.md` are changed **only** at integration;
  - the plans write their notes in the "For the CHANGELOG" section of their own plan and, if needed, a draft text for the guides in the Journal;
  - exception: the platform-tests plan updates the install guides in its X2 task, because that is its job.
- **Hot files:** in `src/core/index.js`, `src/core/state.js`, `src/core/feedback*.js`, `renderer/game.js`, `renderer/bottega.js` and the `scripts` of `package.json`, make small, local changes. Put most of the code in new modules and add only the hooks there. Do not reorder and do not reformat.
- **Main and history:**
  - do not merge `main` into your branch, unless integration asks for it;
  - never merge your branch into `main`;
  - never `git push`, except in the platform-tests plan with Max's permission;
  - never rewrite commits already made.
- **Electron:** the first start in a new folder installs it (about 300 MB) with `node scripts/launch.js --setup`. Do it only when a task really needs the window.

## Instructions for each iteration

They apply to the Tauri, Embedding and Tests loops.

The state of the work is not in your memory, which can be compacted. It is in the plan's checkboxes, in the Journal and in `git log`: always reread them. In the platform-tests plan the Journal sections are "Journal (Windows)" and "Journal (Linux)".

### 1. Get your bearings

- Check that you are in the folder and on the branch of your loop (table above).
- If the tree is not clean, an iteration was interrupted:
  - find the `[~]` task and the last Journal entry;
  - finish the work or, if it is a mess, put it aside with `git stash`;
  - write the choice down.
- Reread the rules of your plan.
- Take the **first** `[ ]` task of your plan, in the order it is written. In the platform-tests plan, only the ones with your label and the free `[ci]` ones.
- If a task depends on one from another loop that is not finished, skip to the next one and write it in the Journal.

### 2. Prepare

- Mark the task `[~]`.
- Read the task description, the code it points to and the Journal entries of the earlier tasks.
- If the task is big, split it into sub-steps written in the Journal, with one commit each ("T3 (1/3): ...").

### 3. Implement

Follow the rules of the plan and of this file.

### 4. Verify

- **Always:**
  - `npm test` must end with "Tutto a posto." (that is the literal Italian line the test prints);
  - `npm run i18n:check` must report 0 missing.
- **When needed:** the checks the task asks for. Tests and app runs always use your loop's `PLATYPUS_PORT` and `PLATYPUS_DATA_DIR=<loop folder>/.platypus-dev`. This is a new override that makes `~/.platypus` replaceable; it also keeps Electron's preferences apart.
- **Interface:** if the task touches it and the computer has a screen, take a screenshot and look at it. Use `PLATYPUS_SNAPSHOT`, `PLATYPUS_SNAPSHOT_JS` and `PLATYPUS_SNAPSHOT_DELAY` (see `src/main.js`). Looking at it is part of the check.
- **If you cannot make something work:**
  - after three attempts on the same problem, mark the task `[!]` with the reason;
  - move on to the next task, if it does not depend on this one.

### 5. Close

- Mark the task `[x]` or `[!]`.
- Add the Journal entry: date, task, what you did, how you checked it, the decisions taken and any doubts for Max.
- Make one commit per task: an English imperative message with the task id (for example "T3 (1/3): ..."). The author email must be the GitHub noreply address already configured, never an @decisyon.com one. End each commit with the attribution line the session normally uses.

### 6. Continue or stop

- If there is no reason to stop, go straight on to the next task, in the same session (with `/loop`, minimum delay).
- Every five closed tasks, write Max three lines of summary, without stopping: what is done, what is blocked, what comes next.
- Messages to Max are in Italian. Everything written to files is in English.

## Stop conditions

Stop and write to Max, in Italian and briefly, when:

1. **The plan is finished**, that is, all your tasks are `[x]` or `[!]`. Fill in the "For the CHANGELOG" section and make the last commit.
2. **You need his permission**, for example to:
   - install programs on the computer (Rust, Ollama, system libraries);
   - download models;
   - install the hooks;
   - look at real data (transcripts, Cowork folders);
   - push a branch.
3. **You need a decision from him** that the plan does not settle and that would change the work a lot.
4. **`npm test` does not go green.**

## Never

- Push to `main`, merge into `main`, pull requests, rewrite commits already made.
- `npm run hooks:install` without Max's explicit permission given at that moment.
- Write a `CLAUDE.md` in a real project.
- npm dependencies in the engine (`src/core`); new network calls not foreseen by the plan.
- Max's real data in the repository.
- The @decisyon.com email as the author of the commits.
