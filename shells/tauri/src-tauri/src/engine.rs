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
    /// `node <root>/src/standalone.js --no-open --parent-stdin [--demo]` on the given port.
    /// `--parent-stdin`: the engine stops cleanly when our end of its stdin closes, also if the shell crashes.
    pub fn start(node: &Path, root: &Path, port: u16, demo: bool) -> std::io::Result<Engine> {
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
