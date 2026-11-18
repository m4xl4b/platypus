# Platypus · Electron and Tauri, measured

Task T7 of [`tauri-shell.md`](tauri-shell.md). The same office, the same engine (`src/core`, Node), the demo on; only the desktop shell changes. Each number below says how it was taken, so it can be repeated.

## Windows (`[win]`)

Computer: Windows 11 Pro (build 26200), screen 2560×1600 at 125 %, Node.js 24.13.0, Electron 44.9.3, Tauri 2.12.7 with WebView2 157.0.4341.60, Rust 1.100.0. Measured on 2026-11-18, while other programs were running (a normal working day, not a clean machine).

| | Electron | Tauri | Notes |
|---|---|---|---|
| **Size on disk** of the shell | 369.3 MB (`node_modules/electron`, 387,218,578 bytes) | **4.8 MB** (`platypus.exe`, 5,063,680 bytes) | both also need the repository (3.5 MB of tracked files) and Node.js; Tauri uses the WebView2 already in Windows |
| Needed only to **build** it | – | 16.1 MB (`shells/tauri/node_modules`, the Tauri CLI), Rust and the C++ Build Tools, and `target/` (about 2 GB after a debug and a release build) | `target/` can be deleted after the build |
| **Memory** after 2 minutes, working set (median of 3) | 599.4 MB (593.4 · 599.4 · 746.1) | 625.7 MB (618.3 · 625.7 · 629.2) | sum of every process of the shell, the engine included |
| **Memory** after 2 minutes, private bytes (median of 3) | 371.1 MB (368.3 · 371.1 · 453.9) | 417.7 MB (417.5 · 417.7 · 424.8) | as above |
| Processes | 4–5 `electron` | 1 `platypus` (25 MB), 1 `node` (78 MB), 1 `conhost` (8 MB), 6 `msedgewebview2` (about 510 MB) | working set per group, from the second and third runs |
| **Start-up**: from start to the first answer of `/api/state` with the window visible (median of 3) | 994 ms (990 · 994 · 1111) | 983 ms (963 · 983 · 1145) | the engine answered after about 550 ms in both |
| **First build** of Tauri | – | debug 54 s, release 2 min 34 s | crates already downloaded (`cargo fetch`, about a minute here, not timed); an incremental release build takes about 1 min 10 s |

What it says:

- **Size** is where Tauri wins by far: about 5 MB instead of about 370 MB, because WebView2 is part of Windows.
- **Memory** is the same order of magnitude, slightly higher for Tauri. The office is a canvas animation drawn by Chromium in both cases (WebView2 *is* Chromium), and that is most of the memory; Tauri adds a separate Node process (about 80 MB) that Electron does not need, because Electron runs the engine inside its main process.
- **Start-up** is the same. The first measurement of Tauri was slower (median 1.77 s) because the shell waited for the engine with a 400 ms connect timeout: on Windows a closed local port is not refused at once. With 100 ms and a 50 ms pause (in `engine.rs`, part of T7) Tauri starts like Electron.

### Method (Windows)

The script is [`shells/tauri/scripts/measure-win.ps1`](../../shells/tauri/scripts/measure-win.ps1). One run:

```powershell
# start-up only
.\shells\tauri\scripts\measure-win.ps1 -Shell tauri -MemoryAfter 0
.\shells\tauri\scripts\measure-win.ps1 -Shell electron -MemoryAfter 0
# start-up and memory after 2 minutes
.\shells\tauri\scripts\measure-win.ps1 -Shell tauri
.\shells\tauri\scripts\measure-win.ps1 -Shell electron -ElectronExe <path to electron.exe>
```

- Each run uses a new, empty temporary home (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CLAUDE_CONFIG_DIR`), `PLATYPUS_PORT=47830` and `PLATYPUS_DATA_DIR=<repository>/.platypus-dev`, and the demo (`--demo`): no real Claude Code session is read, and the numbers do not depend on your sessions.
- Tauri: `shells/tauri/src-tauri/target/release/platypus.exe` (`npm run tauri:build`). Electron: `electron.exe <repository> --demo`, the way the launcher starts it from source.
- **Start-up**: a stopwatch from the process start; every 50 ms it asks `GET /api/state` and looks for a visible window larger than 300×200 belonging to the process tree. The result is the later of the two moments.
- **Memory**: after 120 s from the start, the sum of `WorkingSet64` and of `PrivateMemorySize64` (`Get-Process`) over the whole process tree (children found through `Win32_Process.ParentProcessId`), so the WebView2 or Chromium processes and the Node engine are counted.
- The script then stops the whole tree it started, by PID, and checks that the port is free.
- The runs alternated Electron and Tauri; three runs for each number, the median is reported.
- **Size**: `du -sb` of `node_modules/electron`; the size of `platypus.exe`; `git ls-files` for the repository.
- **Build time**: the time of `cargo build` (debug, first build in T3) and of `npm run tauri:build` (release, first build in T6), as printed by Cargo.

## Linux (`[linux]`)

Not measured yet: it needs the Linux computer (WebKitGTK instead of WebView2, so the numbers can be very different). The same quantities should be taken there with `ps`/`smem` instead of `Get-Process`.

## macOS

No Mac: the GitHub Actions workflow (T8) builds the shell there and records only the program's size.
