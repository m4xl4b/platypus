# How the Claude desktop app stores Cowork sessions (Windows)

Anonymized structure, written by the Windows tests loop (task K1 of `docs/plans/platform-tests.md`) with Max's permission to look at the app's folders. It was made by walking the folders and reading **names, sizes, dates and, for JSON/JSONL files, only the names of the top-level fields** (never a value). In this file `<uuid>` replaces every identifier, `<user>` the user name, and project folder names are not reproduced.

## What was looked at

| | |
|---|---|
| System | Windows 11 Pro 10.0.26200, x64 |
| Claude desktop app | **6.6395.0.0**, installed from the Microsoft Store (package family `Claude_pzs8sxrjxfjjc`, folder under `C:\Program Files\WindowsApps\`) |
| Claude Code bundled with the app | `claude.exe` 2.1.326 (the previous one, 2.1.325, is still on disk) |
| Date | 2026-11-18 |
| Processes seen | the app's `claude.exe` processes (one per session), `cowork-svc` (one), `vmmem` (two: the Cowork virtual machine) |

The structure may change with the app's version: this is a snapshot of one version, one PC and one account.

## The roots, in the order of `coworkRoots()` (`src/core/sources.js`)

| Root | Exists? | What is in it |
|---|---|---|
| `%APPDATA%\Claude` (`C:\Users\<user>\AppData\Roaming\Claude`) | yes | **everything that matters** (below) |
| `%LOCALAPPDATA%\Claude` | yes | only `Logs\` (15 log files: `main*.log`, `cowork_vm_node.log`, `coworkd.log`, `chrome-native-host.log`, `ssh.log`, ...) |
| `%LOCALAPPDATA%\AnthropicClaude` | no | (old Squirrel installer folder) |
| `%APPDATA%\Claude-3p` | no | |
| `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc` | yes | MSIX virtual store. `LocalCache\Roaming\Claude` is **not** where the app keeps its data here (the data is in the real `%APPDATA%\Claude`): the virtual store only holds files of tools the app starts (GitHub CLI, Playwright, Electron caches) and the package settings |

## Tree of `%APPDATA%\Claude` (anonymized, sizes of this PC)

Chromium internals (`Cache`, `Code Cache`, `GPUCache`, `Dawn*`, `GrShaderCache`, `IndexedDB`, `Local Storage`, `Session Storage`, `Network`, `Partitions`, `Shared Dictionary`, `WebStorage`, `blob_storage`, `Crashpad`, `sentry`, ...) are left out: they are Electron's cache, about 0.9 GB.

```
Claude/
├─ claude-code/<version>/<12-hex>/claude.exe          # the Claude Code binary the app runs (360 MB per version)
├─ claude-code-vm/<version>/claude                    # the Linux build for the VM
├─ vm_bundles/claudevm.bundle/                        # the Cowork virtual machine image (11 GB)
│    ├─ rootfs.vhdx, rootfs.vhdx.zst, sessiondata.vhdx, smol-bin.vhdx, initrd, vmlinuz
│    └─ .cowork-adopted, .*.origin, .smol-bin.vhdx.sha256
├─ claude-code-sessions/<uuid>/<uuid>/                # sessions of the app's "Code" tab: METADATA ONLY (81 files, 5 MB)
│    ├─ local_<uuid>.json                 ×46          # one per session (fields below)
│    ├─ deleted_<uuid>                    ×31          # tombstones of deleted sessions
│    ├─ archived-sessions.idx, mod-commands.json, scheduled-tasks.json
│    ├─ backlog/tasks.json
│    └─ waiting-input/
├─ local-agent-mode-sessions/                         # COWORK (4315 files, 579 MB on this PC)
│    ├─ <uuid>/<uuid>/                                # two identifiers (account and organization, most likely)
│    │    ├─ local_<uuid>.json            ×27          # metadata of one Cowork session (fields below)
│    │    ├─ local_<uuid>/                ×30          # the working folder of that session
│    │    │    ├─ audit.jsonl (+ audit1.jsonl)        # audit log of the whole conversation (SDK messages)
│    │    │    ├─ .audit-key
│    │    │    ├─ outputs/                            # files made for the user (user content, never read)
│    │    │    └─ .claude/                            # <- a Claude Code "config" folder, like ~/.claude
│    │    │         ├─ projects/-sessions-<processName>/<cliSessionId>.jsonl     # THE TRANSCRIPTS
│    │    │         │                         └─ <cliSessionId>/subagents/*.jsonl  # subagent transcripts
│    │    │         ├─ .claude.json, .credentials.json, policy-limits.json, mcp-needs-auth-cache.json
│    │    │         ├─ backups/.claude.json.backup.<ms>   (up to ~100 per session)
│    │    │         ├─ debug/<uuid>.txt, plans/
│    │    ├─ cowork_plugins/, cowork_settings.json, cowork-*-cache.json
│    │    ├─ spaces.json, remote-session-spaces.json, scheduled-tasks.json, .claude.json
│    │    └─ debug/<uuid>.txt
│    └─ skills-plugin/<uuid>/<uuid>/skills/...         # the user's skills (not sessions)
├─ git-shadow/, git-worktrees.json                     # used by the Code tab (worktrees)
├─ plugin-list/, spaces-present/, pending-uploads/, rpm/, terminal-shell-integration/, logs/
├─ config.json, claude_desktop_config.json, ccd-session-presets.json, window-state.json, ...
└─ cowork-enabled-cli-ops.json, cowork-memory-resets.json, plan-usage-history.json, ...
```

Sizes on this PC: 27 Cowork transcript files in `projects/` (154 MB), 78 subagent transcripts (66 MB), 28 `audit.jsonl` files (225 MB).

## What we wanted to find out

**Where do the transcripts end up?** In the normal Claude Code format, under each session's own config folder:
`local-agent-mode-sessions\<uuid>\<uuid>\local_<uuid>\.claude\projects\-sessions-<processName>\<cliSessionId>.jsonl`, with the subagents in `...\<cliSessionId>\subagents\*.jsonl`. The project folder name is always `-sessions-<processName>`, where `<processName>` is a random three-word name that is also a field of the session's metadata. The first line of a transcript has the fields `type`, `aiTitle`, `sessionId` (or `type`, `operation`, `timestamp`, `sessionId`, `content` for queue entries). That is why the current wide search (`findCoworkBases`: "a `projects` folder with `.jsonl` files") works: every session's `.claude` is one base. A second record exists: `local_<uuid>\audit.jsonl`, with the fields `type`, `uuid`, `session_id`, `parent_tool_use_id`, `client_platform`, `timestamp`, `message`, `_audit_timestamp`, `_audit_hmac`; it is the audit trail, not needed by Platypus.

**Is there a file with the title and the state of the session?** Yes: `local-agent-mode-sessions\<uuid>\<uuid>\local_<uuid>.json` (next to the session's folder, same name plus `.json`). Fields of the 27 files (name: type; how many of the 27 have it):

| Field | Type | Of 27 | Use |
|---|---|---|---|
| `title` | string | 27 | the title to show on the card |
| `sessionId` | string | 27 | the id of the Cowork session (`local_<uuid>`) |
| `cliSessionId` | string | 27 | the id of the Claude Code session inside = the transcript file name |
| `processName` / `vmProcessName` | string | 27 | the random name = the `projects` folder name (`-sessions-<processName>`) |
| `model` | string | 27 | e.g. `claude-opus-4-8`, `claude-opus-4-8[1m]`, `claude-fable-5` |
| `effortOverride` | string | 7 | effort, when set |
| `createdAt`, `lastActivityAt` | number (ms) | 27 | creation and last activity |
| `isArchived` | boolean | 27 | archived by the user (all false here) |
| `isAgentCompleted` | boolean | 2 | the agent finished (present only sometimes) |
| `cwd` | string | 27 | the folder inside the VM |
| `userSelectedFolders`, `userApprovedFileAccessPaths` | arrays | 27 / 15 | the host folders the user shared |
| `initialMessage`, `systemPrompt` | string | 27 | user content / long, never to be read or stored |
| `accountName`, `emailAddress` | string | 27 | personal: never to be read or stored |
| `hostLoopMode`, `memoryEnabled`, `skillsEnabled`, `pluginsEnabled`, ... | boolean | some | options |
| `mcqAnswers`, `fsDetectedFiles`, `egressAllowedDomains`, `webFetchAllowedUrls`, `slashCommands`, `remoteMcpServersConfig`, ... | object/array | some | internals |

There is **no `status`/`state` field**. The state has to be deduced (next point).

**How to tell a Cowork session from a Code session of the desktop app?** By the root folder. Cowork is `local-agent-mode-sessions\...`; the Code tab is `claude-code-sessions\...`, which holds **metadata only**: its sessions run `claude.exe` on the host, so their transcripts are in the normal `~\.claude\projects` that Platypus already reads. The Code metadata files have the same kind of fields (`title`, `model`, `effort`, `permissionMode` (`auto`, `default`, `acceptEdits`), `cwd`, `originCwd`, `branch`, `worktreePath`, `completedTurns`, `lastActivityAt`, `lastFocusedAt`, `isArchived`, `cliSessionId` (the transcript id in `~\.claude`), `titleSource`, `forkedFromSessionId`, `prs`, ...). So the desktop app's `title` could also be used for Code sessions.

**How to recognize an active session?** On this PC no Cowork session was active (the newest transcript is from 2026-07-28), so this is deduced, not observed:
- `lastActivityAt` follows the newest transcript write very closely (difference between -4 and 0 minutes on all 27 sessions), so "active" can be read from the metadata without opening transcripts;
- the Cowork machine is up when the process `cowork-svc` and the `vmmem` processes exist (they do now, with no session running, so they only say the service is on);
- `isArchived = true` or `isAgentCompleted = true` means finished.
Proposal: active = not archived, not completed, `lastActivityAt` less than a few minutes ago (the same thresholds Platypus already uses for Code sessions).

**Where does the virtual machine live?** `vm_bundles\claudevm.bundle\` (the disk images `rootfs.vhdx` 7.8 GB and `sessiondata.vhdx` 2.1 GB, kernel and initrd), started by the service `cowork-svc` (Hyper-V `vmmem`); the Claude Code build it runs is `claude-code-vm\<version>\claude`. Its logs: `%LOCALAPPDATA%\Claude\Logs\cowork_vm_node.log` and `coworkd.log`.

## What this means for K2 (targeted search)

- The known path is **fixed depth**: `%APPDATA%\Claude\local-agent-mode-sessions\<uuid>\<uuid>\local_<uuid>\.claude` (config folder with `projects\`), and the metadata `...\<uuid>\<uuid>\local_<uuid>.json` next to it. A direct scan of these two levels replaces the breadth-first walk (the current walk visits thousands of folders: `visited` up to 8000).
- `skills-plugin\` is a sibling of the account folders, not a session folder, and has no `projects\`: a targeted scan never enters it (the wide walk does, and only avoids its `skills` subfolder).
- The card's title: `title` of the session metadata; state: from `lastActivityAt`, `isArchived`, `isAgentCompleted`.
- Keep the wide search as a fallback: the structure belongs to one version of the app.
- Never read or keep `accountName`, `emailAddress`, `systemPrompt`, `initialMessage`, `.credentials.json`, `audit.jsonl`, `.audit-key`.

## Not verified

- the structure with an **active** Cowork session (none on this PC; I did not start one: that needs Max to open it);
- other Claude app versions, a non-Store installation (`%LOCALAPPDATA%\AnthropicClaude`), another account type;
- whether `isAgentCompleted` is written at the end of a task (only 2 of 27 files have it, both false).
