# Fake Cowork tree (Windows)

The shape of `%APPDATA%\Claude\local-agent-mode-sessions` as described in `docs/plans/cowork-structure.md`, with made-up content.
Every `_claude` folder stands for the session's `.claude` config folder: `.claude/` is ignored by git, so the tests copy this tree
to a temporary folder and rename `_claude` to `.claude` (see "Cowork su un albero finto di Windows" in `scripts/smoke-test.js`).

- `local_1111...` is an active session with a title in its metadata (and a different one in the transcript);
- `local_2222...` is archived;
- `skills-plugin/` is a decoy that is not a session.
