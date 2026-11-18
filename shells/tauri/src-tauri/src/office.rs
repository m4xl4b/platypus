//! The office window and the `window.officeApp` contract, the same as Electron's (src/preload.js, src/main.js).
//!
//! Security (decided in T1, see the plan's Journal): the page is served by the engine on http://127.0.0.1:<port>.
//! It gets `window.officeApp` from an initialisation script that checks the origin, and its `invoke` reaches only
//! the commands below, through a capability built here with the exact origin. No `window.__TAURI__`, no core or
//! plugin permissions, and no command takes a path, a URL or a command line.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Size, State, Url, UserAttentionType, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::engine::Engine;

pub const LABEL: &str = "main";
/// The commands the page may call: one `allow-<command>` permission each (see build.rs).
const PAGE_COMMANDS: &[&str] = &[
    "minimize",
    "close",
    "toggle_maximize",
    "is_maximized",
    "toggle_pin",
    "get_pin",
    "set_counts",
    "set_widget",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    /// always on top
    pub pin: bool,
    /// the tray option "Notifications for permission requests" (per shell, like Electron's `cfg.notify`)
    pub notify: bool,
    /// the tray option "Show Cowork sessions": passed to the engine when this shell starts it
    pub show_cowork: bool,
    /// already asked once whether to connect to Claude Code
    pub asked_hooks: bool,
}
impl Default for Config {
    fn default() -> Self {
        Config { pin: true, notify: true, show_cowork: true, asked_hooks: false }
    }
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub sessions: u32,
    pub agents: u32,
    pub busy: u32,
    pub waiting: u32,
}

pub struct Shell {
    port: AtomicU16,
    pub engine: Mutex<Option<Engine>>,
    data: PathBuf,
    pub cfg: Mutex<Config>,
    /// position and size before mini mode; Some while the window is the small strip
    widget: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    maximized: AtomicBool,
    shown: AtomicBool,
    pub counts: Mutex<Counts>,
    /// the tray menu's state and texts, from the engine
    pub menu: Mutex<crate::tray::MenuState>,
    /// the floor of the last notification: shown the next time the window is opened (a click on a toast
    /// cannot be intercepted)
    pub pending_goto: Mutex<Option<(String, Instant)>>,
    /// false once the app is quitting: the stream reader stops
    pub alive: AtomicBool,
}

impl Shell {
    pub fn new(data: PathBuf) -> Shell {
        let cfg = std::fs::read_to_string(data.join("config.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Config>(&s).ok())
            .unwrap_or_default();
        Shell {
            port: AtomicU16::new(0),
            engine: Mutex::new(None),
            data,
            cfg: Mutex::new(cfg),
            widget: Mutex::new(None),
            maximized: AtomicBool::new(false),
            shown: AtomicBool::new(false),
            counts: Mutex::new(Counts::default()),
            menu: Mutex::new(Default::default()),
            pending_goto: Mutex::new(None),
            alive: AtomicBool::new(true),
        }
    }
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }
    pub fn set_port(&self, p: u16) {
        self.port.store(p, Ordering::SeqCst)
    }
    pub fn save_cfg(&self) {
        let cfg = self.cfg.lock().unwrap().clone();
        let _ = std::fs::create_dir_all(&self.data);
        if let Ok(s) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(self.data.join("config.json"), s);
        }
    }
    pub fn pin(&self) -> bool {
        self.cfg.lock().unwrap().pin
    }
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port())
    }
}

/// The language of the few messages the shell writes by itself before the engine runs: the office option
/// (`lang` in the engine's settings.json), else the system's. Like `resolveLang` in src/i18n/index.js.
pub fn italian() -> bool {
    let dir = match std::env::var("PLATYPUS_DATA_DIR") {
        Ok(v) if !v.trim().is_empty() => Some(PathBuf::from(v.trim())),
        _ => home_dir().map(|h| h.join(".platypus")),
    };
    if let Some(lang) = dir
        .and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("lang").and_then(|l| l.as_str()).map(|s| s.to_string()))
    {
        if lang == "it" || lang == "en" {
            return lang == "it";
        }
    }
    sys_locale::get_locale().map(|l| l.to_lowercase().starts_with("it")).unwrap_or(false)
}
fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// A page of the office itself (the engine on its port): the same rule as `isOwnUrl` in src/urls.js.
pub fn is_own_url(u: &Url, port: u16) -> bool {
    u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1") | Some("localhost")) && u.port() == Some(port)
}
/// An address that may go to the browser: the same rule as `isExternalUrl` in src/urls.js.
pub fn is_external_url(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https") && u.host_str().map(|h| !h.is_empty()).unwrap_or(false) && u.username().is_empty() && u.password().is_none()
}

/// The script that gives the page `window.officeApp`, before the page's own scripts, on every navigation.
fn init_script(origin: &str) -> String {
    format!(
        r#"(function () {{
  if (location.origin !== {origin}) return; // only the office's own pages
  var cbs = {{ maximized: [], goto: [] }};
  var call = function (cmd, args) {{
    var t = window.__TAURI_INTERNALS__;
    return t && t.invoke ? t.invoke(cmd, args || {{}}) : Promise.reject(new Error('no ipc'));
  }};
  var num = function (v) {{ v = Number(v); return v >= 0 && v < 1e6 ? Math.floor(v) : 0; }};
  Object.defineProperty(window, '__platypusShell', {{ value: Object.freeze({{
    emit: function (kind, value) {{ (cbs[kind] || []).forEach(function (f) {{ try {{ f(value); }} catch (e) {{}} }}); }}
  }}) }});
  Object.defineProperty(window, 'officeApp', {{ value: Object.freeze({{
    minimize: function () {{ call('minimize'); }},
    close: function () {{ call('close'); }},
    toggleMaximize: function () {{ return call('toggle_maximize'); }},
    isMaximized: function () {{ return call('is_maximized'); }},
    onMaximized: function (cb) {{ cbs.maximized.push(function (on) {{ cb(!!on); }}); }},
    togglePin: function () {{ return call('toggle_pin'); }},
    getPin: function () {{ return call('get_pin'); }},
    setCounts: function (c) {{ c = c || {{}}; call('set_counts', {{ sessions: num(c.sessions), agents: num(c.agents), busy: num(c.busy), waiting: num(c.waiting) }}); }},
    setWidget: function (on) {{ call('set_widget', {{ on: !!on }}); }},
    onGoto: function (cb) {{ cbs.goto.push(function (sid) {{ cb(String(sid)); }}); }}
  }}) }});
}})();"#,
        origin = serde_json::to_string(origin).unwrap()
    )
}

/// Tell the page something (`maximized`, `goto`): a fixed call with JSON data, no event permissions needed.
pub fn emit(win: &WebviewWindow, kind: &str, value: serde_json::Value) {
    let js = format!(
        "window.__platypusShell && window.__platypusShell.emit({}, {})",
        serde_json::to_string(kind).unwrap(),
        value
    );
    let _ = win.eval(js);
}

pub fn open_window(app: &AppHandle) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let port = shell.port();
    let origin = shell.origin();
    // the capability: only our commands, only for this window, only from the engine's exact origin
    let mut cap = CapabilityBuilder::new("office").local(false).remote(format!("{origin}/*")).window(LABEL);
    for c in PAGE_COMMANDS {
        cap = cap.permission(format!("allow-{}", c.replace('_', "-")));
    }
    // automatic checks only (see `report`): the page may also send back what it found
    if std::env::var_os("PLATYPUS_SNAPSHOT_JS").is_some() {
        cap = cap.permission("allow-report");
    }
    app.add_capability(cap)?;

    let url: Url = format!("{origin}/").parse().expect("valid url");
    let opener = app.clone();
    let opener2 = app.clone();
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Platypus")
        .inner_size(980.0, 620.0)
        .min_inner_size(380.0, 260.0)
        .decorations(false)
        .always_on_top(shell.pin())
        .background_color(tauri::window::Color(11, 10, 18, 255))
        .visible(false)
        .initialization_script(init_script(&origin))
        // the window stays on the office's pages: another page must not get the commands
        .on_navigation(move |u| {
            if is_own_url(u, port) {
                return true;
            }
            if is_external_url(u) {
                let _ = opener.opener().open_url(u.as_str(), None::<&str>);
            }
            false
        })
        // window.open and target=_blank: external http(s) in the browser, never a new window here
        .on_new_window(move |u, _features| {
            if is_external_url(&u) && !is_own_url(&u, port) {
                let _ = opener2.opener().open_url(u.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|w, p| {
            if p.event() == PageLoadEvent::Finished {
                let shell = w.state::<Shell>();
                if !shell.shown.swap(true, Ordering::SeqCst) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    // tests and development loops: the webview's data next to the shell's, not in the user's profile
    if let Ok(v) = std::env::var("PLATYPUS_DATA_DIR") {
        if !v.trim().is_empty() {
            b = b.data_directory(PathBuf::from(v.trim()).join("tauri").join("webview"));
        }
    }
    let win = b.build()?;
    let w2 = win.clone();
    win.on_window_event(move |ev| match ev {
        // there is no "maximized" event: follow the real state on every resize, like Electron's maximize/unmaximize
        WindowEvent::Resized(_) => {
            let now = w2.is_maximized().unwrap_or(false);
            let shell = w2.state::<Shell>();
            if shell.maximized.swap(now, Ordering::SeqCst) != now {
                emit(&w2, "maximized", serde_json::Value::Bool(now));
            }
        }
        WindowEvent::Focused(true) => {
            let _ = w2.request_user_attention(None);
        }
        _ => {}
    });
    crate::office::snapshot(app);
    Ok(())
}

// ---------------------------------------------------------------- commands from the page

#[tauri::command]
pub fn minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

/// Like Electron: closing the window quits Platypus (and the engine, if this shell started it).
#[tauri::command]
pub fn close(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn toggle_maximize(window: WebviewWindow, shell: State<'_, Shell>) -> bool {
    if shell.widget.lock().unwrap().is_some() {
        widget(&window, &shell, false); // from the mini strip, first back to the normal size
    }
    let was = window.is_maximized().unwrap_or(false);
    let _ = if was { window.unmaximize() } else { window.maximize() };
    !was
}

#[tauri::command]
pub fn is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
pub fn toggle_pin(app: AppHandle, window: WebviewWindow, shell: State<'_, Shell>) -> bool {
    let on = toggle_pin_window(&window, &shell);
    crate::tray::rebuild(&app); // the tray's checkbox follows
    on
}

/// PIN from the page or from the tray menu: saved, and applied unless the window is the mini strip.
pub fn toggle_pin_window(window: &WebviewWindow, shell: &Shell) -> bool {
    let on = {
        let mut c = shell.cfg.lock().unwrap();
        c.pin = !c.pin;
        c.pin
    };
    shell.save_cfg();
    if shell.widget.lock().unwrap().is_none() {
        let _ = window.set_always_on_top(on);
    }
    on
}

/// Bring the office to the front (tray, second start). If a notification arrived in the last two minutes,
/// go to its floor, like a click on the toast in Electron.
pub fn show_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    let shell = app.state::<Shell>();
    let goto = shell.pending_goto.lock().unwrap().take();
    if let Some((sid, t)) = goto {
        if t.elapsed() < Duration::from_secs(120) {
            emit(&w, "goto", serde_json::Value::String(sid));
        }
    }
}

#[tauri::command]
pub fn get_pin(shell: State<'_, Shell>) -> bool {
    shell.pin()
}

#[tauri::command]
pub fn set_counts(window: WebviewWindow, shell: State<'_, Shell>, sessions: u32, agents: u32, busy: u32, waiting: u32) {
    let prev = {
        let mut c = shell.counts.lock().unwrap();
        let prev = *c;
        *c = Counts { sessions, agents, busy, waiting };
        prev
    };
    // someone waits for your OK: flash the window in the taskbar
    if waiting > prev.waiting && !window.is_focused().unwrap_or(false) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

#[tauri::command]
pub fn set_widget(window: WebviewWindow, shell: State<'_, Shell>, on: bool) {
    widget(&window, &shell, on);
}

/// Automatic checks only: the snapshot script sends back what it found (see `snapshot`). The page gets
/// the permission for it only when PLATYPUS_SNAPSHOT_JS is set.
#[tauri::command]
pub fn report(text: String) {
    if std::env::var_os("PLATYPUS_SNAPSHOT_JS").is_some() {
        println!("[report] {}", text.chars().take(4000).collect::<String>());
    }
}

/// Mini mode: a small strip in the bottom-right corner of the window's screen, always on top; back as before on exit.
pub fn widget(window: &WebviewWindow, shell: &Shell, on: bool) {
    let mut saved = shell.widget.lock().unwrap();
    if on == saved.is_some() {
        return;
    }
    if on {
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        }
        let pos = window.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
        let size = window.inner_size().unwrap_or(PhysicalSize::new(980, 620));
        *saved = Some((pos, size));
        let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(300.0, 120.0))));
        let mon = window.current_monitor().ok().flatten();
        let sf = mon.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
        let (w, h, m) = ((380.0 * sf) as i32, (150.0 * sf) as i32, (12.0 * sf) as i32);
        let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
        if let Some(mon) = mon {
            let wa = mon.work_area();
            let x = wa.position.x + wa.size.width as i32 - w - m;
            let y = wa.position.y + wa.size.height as i32 - h - m;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        let _ = window.set_always_on_top(true);
    } else {
        let (pos, size) = saved.take().unwrap();
        let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(380.0, 260.0))));
        let _ = window.set_size(size);
        let _ = window.set_position(pos);
        let _ = window.set_always_on_top(shell.pin());
    }
}

/// Automatic checks (like PLATYPUS_SNAPSHOT in Electron): after PLATYPUS_SNAPSHOT_DELAY ms run PLATYPUS_SNAPSHOT_JS in
/// the page, then print the window's state as one `[snapshot] {...}` line and, if PLATYPUS_SNAPSHOT is set, quit.
pub fn snapshot(app: &AppHandle) {
    let js = std::env::var("PLATYPUS_SNAPSHOT_JS").ok();
    let quit = std::env::var_os("PLATYPUS_SNAPSHOT").is_some();
    if js.is_none() && !quit {
        return;
    }
    let delay = std::env::var("PLATYPUS_SNAPSHOT_DELAY").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(8000);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay));
        let Some(win) = app.get_webview_window(LABEL) else { return };
        if let Some(js) = js {
            let _ = win.eval(js);
            std::thread::sleep(std::time::Duration::from_millis(2500));
        }
        let shell = app.state::<Shell>();
        let pos = win.outer_position().ok();
        let size = win.inner_size().ok();
        let state = serde_json::json!({
            "port": shell.port(),
            "attached": shell.engine.lock().unwrap().is_none(),
            "maximized": win.is_maximized().unwrap_or(false),
            "visible": win.is_visible().unwrap_or(false),
            "onTop": win.is_always_on_top().unwrap_or(false),
            "pin": shell.pin(),
            "widget": shell.widget.lock().unwrap().is_some(),
            "counts": *shell.counts.lock().unwrap(),
            "bounds": { "x": pos.map(|p| p.x), "y": pos.map(|p| p.y), "w": size.map(|s| s.width), "h": size.map(|s| s.height) },
        });
        println!("[snapshot] {state}");
        if quit {
            app.exit(0);
        }
    });
}
