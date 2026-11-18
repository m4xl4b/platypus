//! The Platypus engine as a child process: find `node`, choose the port, attach to a Platypus that is
//! already running or start `node src/standalone.js --no-open`, and stop it on exit (only if we started it).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 47800;

/// The repository folder (the one with `src/standalone.js`): `PLATYPUS_ROOT`, or the first parent of the
/// program that has it (the build lives in `shells/tauri/src-tauri/target/<profile>/`), or the source tree.
pub fn repo_root() -> Option<PathBuf> {
    let has = |p: &Path| p.join("src").join("standalone.js").is_file();
    if let Some(v) = std::env::var_os("PLATYPUS_ROOT") {
        let p = PathBuf::from(v);
        return if has(&p) { Some(p) } else { None };
    }
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors().skip(1) {
            if has(dir) {
                return Some(dir.to_path_buf());
            }
        }
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
    if has(&src) {
        return Some(src.canonicalize().unwrap_or(src));
    }
    None
}

/// `node` from `PLATYPUS_NODE` or the `PATH`.
pub fn find_node() -> Option<PathBuf> {
    if let Some(v) = std::env::var_os("PLATYPUS_NODE") {
        let p = PathBuf::from(v);
        return if p.is_file() { Some(p) } else { None };
    }
    let names: &[&str] = if cfg!(windows) { &["node.exe"] } else { &["node"] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for n in names {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// The port: `PLATYPUS_PORT`, or 47800.
pub fn choose_port() -> u16 {
    std::env::var("PLATYPUS_PORT").ok().and_then(|v| v.trim().parse::<u16>().ok()).filter(|p| *p > 0).unwrap_or(DEFAULT_PORT)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// nobody listens on the port
    Free,
    /// a Platypus answers `GET /api/state`
    Platypus,
    /// something else listens there
    Other,
}

/// Who answers on 127.0.0.1:<port>? A plain HTTP/1.0 request, no dependencies.
pub fn probe(port: u16) -> Probe {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return Probe::Free,
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET /api/state HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return Probe::Other;
    }
    // the state can be large: read only until the first key shows up
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    while buf.len() < 1 << 20 {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        let text = String::from_utf8_lossy(&buf);
        if text.contains("\"sessions\"") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    if (text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")) && text.contains("\"sessions\"") {
        Probe::Platypus
    } else {
        Probe::Other
    }
}

/// The engine started by this shell.
pub struct Engine {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl Engine {
    /// `node <root>/src/standalone.js --no-open --parent-stdin [--demo] [--no-cowork]` on the given port.
    /// `--parent-stdin`: the engine stops cleanly when our end of its stdin closes, also if the shell crashes.
    pub fn start(node: &Path, root: &Path, port: u16, demo: bool, cowork: bool) -> std::io::Result<Engine> {
        let mut cmd = Command::new(node);
        cmd.arg(root.join("src").join("standalone.js"))
            .arg("--no-open")
            .arg("--parent-stdin")
            .env("PLATYPUS_PORT", port.to_string())
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        if demo {
            cmd.arg("--demo");
        }
        if !cowork {
            cmd.arg("--no-cowork"); // the tray option "Show Cowork sessions", off
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        Ok(Engine { child, stdin })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Wait until the engine answers, at most `timeout`. Err with the reason if it exits or takes too long.
    pub fn wait_ready(&mut self, port: u16, timeout: Duration) -> Result<(), WaitError> {
        let t0 = Instant::now();
        loop {
            if let Ok(Some(st)) = self.child.try_wait() {
                return Err(WaitError::Exited(st.code()));
            }
            if probe(port) == Probe::Platypus {
                return Ok(());
            }
            if t0.elapsed() > timeout {
                return Err(WaitError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Close its stdin (the engine saves and exits), wait up to 3 s, then kill it.
    pub fn stop(mut self) {
        drop(self.stdin.take());
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug)]
pub enum WaitError {
    Exited(Option<i32>),
    Timeout,
}

/// `POST <path>` with a JSON body to the engine, the way a local program does (no Origin). The answer's body.
pub fn post(port: u16, path: &str, body: &str) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let req = format!(
        "POST {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.split_once("\r\n\r\n").map(|(_, b)| b.to_string())
}

/// Read `GET /api/shell/events` (counters, menu, notifications) and call `on(event, data)` for each event,
/// reconnecting after 1.5 s if the stream ends, until `alive` becomes false. HTTP/1.0: no chunked encoding.
pub fn shell_events<F: FnMut(&str, serde_json::Value)>(port: u16, alive: &std::sync::atomic::AtomicBool, mut on: F) {
    use std::io::BufRead;
    use std::sync::atomic::Ordering;
    while alive.load(Ordering::SeqCst) {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(1)) {
            let _ = s.set_read_timeout(Some(Duration::from_secs(60))); // the engine pings every 20 s
            let req = format!("GET /api/shell/events HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\n\r\n");
            if s.write_all(req.as_bytes()).is_ok() {
                let mut r = std::io::BufReader::new(s);
                let mut line = String::new();
                let mut ok = false;
                // status line and headers
                loop {
                    line.clear();
                    match r.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if line.starts_with("HTTP/") {
                        ok = line.contains(" 200 ");
                    }
                    if line == "\r\n" || line == "\n" {
                        break;
                    }
                }
                let (mut ev, mut data) = (String::new(), String::new());
                while ok && alive.load(Ordering::SeqCst) {
                    line.clear();
                    match r.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let l = line.trim_end_matches(['\r', '\n']);
                    if l.is_empty() {
                        if !ev.is_empty() && !data.is_empty() {
                            if let Ok(v) = serde_json::from_str(&data) {
                                on(&ev, v);
                            }
                        }
                        ev.clear();
                        data.clear();
                    } else if let Some(x) = l.strip_prefix("event: ") {
                        ev = x.to_string();
                    } else if let Some(x) = l.strip_prefix("data: ") {
                        data.push_str(x);
                    }
                }
            }
        }
        if alive.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1500));
        }
    }
}

/// `node src/hooks-cli.js <cmd>` (install, uninstall, status) for the engine's port: (ok, what it printed).
pub fn hooks_cli(node: &Path, root: &Path, port: u16, cmd: &str) -> (bool, String) {
    let mut c = Command::new(node);
    c.arg(root.join("src").join("hooks-cli.js")).arg(cmd).env("PLATYPUS_PORT", port.to_string()).current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    match c.output() {
        Ok(o) => {
            let mut text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if !err.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&err);
            }
            (o.status.success(), text)
        }
        Err(e) => (false, e.to_string()),
    }
}
