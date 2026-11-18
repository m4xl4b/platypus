# Platypus 2.11 development loop for Claude Code

This file makes Claude Code work through **parts A–D** (version 2.11, feedback to the agents) of the plan `docs/plans/2.11-3.0-feedback-storage-server.md`, one task at a time, until those parts are finished or until a decision of yours is needed. Parts E (2.12, storage) and F (3.0, server mode) are out of scope here: they get their own loop.

It follows the 2.9 loop (`docs/plans/LOOP-2.9.md`); what is different is marked **(2.11)**.

## How to start (for Max)

1. The setup is already done: the `sviluppo-2.11` branch exists, with the plan and this file (see the plan's Journal).
2. Start the loop with the command in the **Starting the loop** section.
3. To stop it at any time: `Esc`, or write "stop". The work done stays in the commits and in the plan's Journal. To resume, run the same command again.

---

## Starting the loop

If your version of Claude Code has the `/loop` command, use this line (no interval: it sets its own pace):

```
/loop Follow docs/plans/LOOP-2.11.md, section "Instructions for each iteration": run ONE iteration on parts A–D of the plan docs/plans/2.11-3.0-feedback-storage-server.md.
```

If there is no `/loop`, paste this text into a normal session:

```
Follow docs/plans/LOOP-2.11.md, section "Instructions for each iteration". Repeat the iterations one after another, without asking me for confirmation between tasks, until one of the stop conditions is met.
```

---

## Instructions for each iteration

The state of the work isn't in your memory, which can be compacted. It is in three places: the plan's checkboxes, the **Journal** at the bottom of the plan, and `git log`. Always reread them at the start.

### 1. Get your bearings

- `git status` and `git branch --show-current`: you must be on `sviluppo-2.11`.
- If the tree isn't clean, a previous iteration was interrupted:
  - look in the plan for the task marked `[~]` (in progress) and the last Journal entry;
  - review the diff and decide whether to finish it or, if it's a mess, start over with `git stash`;
  - write the choice in the Journal.
- Open `docs/plans/2.11-3.0-feedback-storage-server.md`:
  - reread the "Project rules", including the rules for anything that reaches an agent;
  - find the **first** task marked `[ ]` in the order A1 → A3, B1 → B6, C1 → C3, D1 → D2.
- If there are none left in A–D, go to the **Stop conditions**. **(2.11)** Do not start part E.

### 2. Prepare the task

- Mark the task's title with `[~]`.
- Read the task's description, the "Hook formats" section and the code listed in the "map of the existing code".
- Also read the Journal entries of the tasks it depends on.
- **(2.11)** B2–B4 use `PostToolUse` only. Their `PreToolUse` variants wait for Max's real-session check (see A1): do not build them before its result is in the Journal.
- If the task is too big for one iteration, split it:
  - write the sub-steps in the Journal;
  - make one commit per sub-step, with a message starting with the identifier, for example "A3 (1/2): …";
  - leave `[~]` until they are all done.

### 3. Implement

- Follow the Project rules, in particular:
  - no npm packages in the engine;
  - `tr()`/`trn()` for strings, with the English translations in `src/i18n/locales/en/` (the new file is `feedback.json`);
  - every analysis inside `try/catch`;
  - in the interface, honesty about what is measured and what is likely.
- **(2.11)** For anything that reaches an agent:
  - every feature is `off` by default and has the `shadow` mode;
  - the endpoint fails open: an error, a timeout or a closed Platypus must leave Claude Code unaffected;
  - never return `permissionDecision`, `updatedInput` or `updatedToolOutput`; the only blocking answer is the Stop check (B5), once per turn;
  - every message starts with "Platypus" and says where the lesson comes from.
- **(2.11)** The decisions live in `src/core/feedback.js` as pure functions (input + state + lessons → message or nothing), tested without a server.
- Every feature must be visible in the demo.
- New tests go in `scripts/unit-engine.js` or `scripts/unit-test.js` (both run by `npm test`); server checks in `scripts/smoke-test.js`.
- Don't touch files that aren't involved. Don't reformat existing code.
- On this Windows machine shell heredocs eat backslashes: edit code with the editing tools, not with `sed` or heredocs.

### 4. Verify

Always, **on a temporary home** (never the real `~/.claude`):

```
H="$TEMP/pl-home" && rm -rf "$H" && mkdir -p "$H" && USERPROFILE="$H" HOME="$H" APPDATA="$H/AppData/Roaming" LOCALAPPDATA="$H/AppData/Local" CLAUDE_CONFIG_DIR="$H/.claude" npm test
```

- `npm test` must end with exit code 0;
- `npm run i18n:check` must not report missing or unused strings.

When needed, also:

- **(2.11)** post hook inputs to the running server (`node src/standalone.js --demo --no-open` on a temporary home and a free `PLATYPUS_PORT`) and check the JSON answers, including with the server stopped;
- **(2.11)** hook installation is tested only on a temporary `settings.json` (a temporary `CLAUDE_CONFIG_DIR`);
- if the task touches the interface and the computer has a screen, take a screenshot with the Electron window on a temporary home, using the `PLATYPUS_SNAPSHOT`, `PLATYPUS_SNAPSHOT_JS` and `PLATYPUS_SNAPSHOT_DELAY` variables (see `src/main.js`).
  - Look at the screenshot to check there are no overlaps, cut-off text or empty areas.
  - Save it outside the repository, except the ones required by D1.
- If a check fails:
  - fix it and try again;
  - after three failed attempts on the same problem, mark the task `[!]` with the reason and move on to the next one, if it doesn't depend on this one.

### 5. Close

- Mark the task `[x]`, or `[!]` with a line "Blocked: …" below it.
- Add an entry to the Journal, in English:
  ```
  ### <date> · <ID> <title>
  - Done: …
  - Verified: … (commands and results)
  - Decisions: … (non-obvious choices, thresholds, things postponed)
  - Questions for Max: … (if any)
  ```
- Commit, one per task: message in English in the imperative mood with the identifier, for example "A1: answer feedback hooks within a time budget", plus the attribution lines you usually use.
- **Never `git push`.** Never merge into main.

### 6. Continue or stop

- If no stop condition has been met, move on to the next task:
  - with `/loop`: schedule the next iteration with the minimum delay;
  - without: carry on straight away.
- Every **five tasks closed**, write me a three-line summary, without stopping: what is done, what is blocked, what comes next.

---

## Stop conditions

Stop, end the loop and write me a short message, in Italian, when:

1. **Parts A–D are finished:** every task from A1 to D2 is `[x]` or `[!]`. Tell me:
   - what is blocked and why;
   - the known limits, taken from the Journal;
   - the command to try it: `npm run start:demo`.
2. **A decision or permission of mine is needed,** for example:
   - a product choice the plan doesn't settle and that would change the work a lot, starting with the plan's "Open questions" when a task depends on one;
   - **(2.11)** anything that needs a real Claude Code session: Max runs the real-session check himself (A1, D2), since it uses his account. Never run `claude` yourself; write the steps and stop;
   - reading my real Claude Code sessions in `~/.claude`;
   - any write outside the repository and `~/.platypus`.
3. **`npm test` was green and you can't get it green again** after the attempts in point 4.
4. **You are about to do something from the "Never" list** below.

## Never, under any circumstances

- `git push`, opening pull requests, merging into main, rewriting commits already made.
- `npm run hooks:install` (with or without `--feedback`) on the real configuration, or changing `~/.claude/settings.json`.
- **(2.11)** Turning a feedback feature `on` by default, or sending anything to a real agent without Max having turned it on.
- Writing a `CLAUDE.md` in a real project.
- Adding npm dependencies to the engine, or any new network call.
- Putting data from my real sessions into the repository: transcripts, paths, contents.
- Using the @decisyon.com address as the commit author.
