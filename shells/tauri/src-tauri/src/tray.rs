//! The tray icon, its menu and the notifications, like `buildTrayMenu()`, `trayImage()` and `showNotice()` in
//! src/main.js. The texts come already translated from the engine (`menu` and `counts` events of
//! /api/shell/events), so the menu follows the language chosen in the options. The actions go through the
//! engine's API (demo, Cowork) or `src/hooks-cli.js` (connect to Claude Code), never through the page.

use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::engine;
use crate::office::{self, Shell};

pub const TRAY_ID: &str = "platypus";
const ICON: &[u8] = include_bytes!("../../../../build/tray@2x.png");

/// The state of the menu items that the engine knows, with its texts.
#[derive(Default, Clone)]
pub struct MenuState {
    pub texts: Value,
    pub hooks: bool,
    pub demo: bool,
    pub cowork: bool,
    pub base: String,
    pub label: String,
    pub tooltip: String,
    pub waiting: u32,
    pub received: bool,
}

fn text(m: &MenuState, key: &str, fallback: &str) -> String {
    // "&" marks a mnemonic in menu texts: write it twice to show it
    m.texts.get(key).and_then(|v| v.as_str()).unwrap_or(fallback).replace('&', "&&")
}
fn plain(m: &MenuState, key: &str, fallback: &str) -> String {
    m.texts.get(key).and_then(|v| v.as_str()).unwrap_or(fallback).to_string()
}

/// Automatic checks (snapshot mode or `--smoke`): no dialogs, no toasts, no real registrations.
pub fn snapshot_mode() -> bool {
    std::env::var_os("PLATYPUS_SNAPSHOT").is_some()
        || std::env::var_os("PLATYPUS_SNAPSHOT_JS").is_some()
        || crate::office::SMOKE.load(std::sync::atomic::Ordering::SeqCst)
}

/// The icon: the usual one, or with a red dot while someone waits for you.
fn icon(waiting: bool) -> Image<'static> {
    let base = Image::from_bytes(ICON).expect("tray icon");
    let (w, h) = (base.width(), base.height());
    let mut px = base.rgba().to_vec();
    if waiting {
        let r = (w.min(h) as f32) * 0.24;
        let (cx, cy) = (w as f32 - r - 0.5, h as f32 - r - 0.5);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                if d <= r + 1.0 {
                    let i = ((y * w + x) * 4) as usize;
                    let c: [u8; 4] = if d <= r { [0xe8, 0x2e, 0x4a, 0xff] } else { [0x0b, 0x0a, 0x12, 0xff] };
                    px[i..i + 4].copy_from_slice(&c);
                }
            }
        }
    }
    Image::new_owned(px, w, h)
}

pub fn create(app: &AppHandle) -> tauri::Result<TrayIcon> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(false))
        .tooltip("Platypus")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        // click on the icon: hide the window if it is in front, otherwise show it (not on Linux: no click event there)
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window(office::LABEL) {
                    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                        let _ = w.minimize();
                        return;
                    }
                }
                office::show_window(app);
            }
        })
        .build(app)
}

/// (Re)build the menu from the engine's state and the shell's options.
pub fn rebuild(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let m = shell.menu.lock().unwrap().clone();
    let cfg = shell.cfg.lock().unwrap().clone();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let label = if m.label.is_empty() { "Platypus".to_string() } else { m.label.replace('&', "&&") };
        let counts = MenuItem::with_id(app, "counts", label, false, None::<&str>)?;
        let show = MenuItem::with_id(app, "show", text(&m, "show", "Show the office"), true, None::<&str>)?;
        let pin = CheckMenuItem::with_id(app, "pin", text(&m, "pin", "Always on top"), true, crate::office::pin_state(&cfg), None::<&str>)?;
        let demo = CheckMenuItem::with_id(app, "demo", text(&m, "demo", "Demo mode"), true, m.demo, None::<&str>)?;
        let notify = CheckMenuItem::with_id(app, "notify", text(&m, "notify", "Notifications"), true, cfg.notify, None::<&str>)?;
        let cowork = CheckMenuItem::with_id(app, "cowork", text(&m, "cowork", "Show Cowork sessions"), true, m.cowork, None::<&str>)?;
        let hooks = MenuItem::with_id(
            app,
            "hooks",
            if m.hooks { text(&m, "hooksOff", "Disconnect from Claude Code") } else { text(&m, "hooksOn", "Connect to Claude Code…") },
            true,
            None::<&str>,
        )?;
        let report = MenuItem::with_id(app, "report", text(&m, "report", "Today's report"), true, None::<&str>)?;
        let browser = MenuItem::with_id(app, "browser", text(&m, "browser", "Open in the browser"), true, None::<&str>)?;
        let folder = MenuItem::with_id(app, "folder", text(&m, "folder", "Open the Claude Code folder"), !m.base.is_empty(), None::<&str>)?;
        let login = CheckMenuItem::with_id(app, "login", text(&m, "login", "Start at login"), true, crate::startup::login_enabled(app), None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", text(&m, "quit", "Quit"), true, None::<&str>)?;
        let (s1, s2, s3) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
        Menu::with_items(app, &[&counts, &s1, &show, &pin, &demo, &notify, &cowork, &s2, &hooks, &report, &browser, &folder, &s3, &login, &quit])
    };
    match build() {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => eprintln!("[platypus] tray menu: {e}"),
    }
    if !m.tooltip.is_empty() {
        let _ = tray.set_tooltip(Some(&m.tooltip));
    }
    if snapshot_mode() {
        println!(
            "[tray] {}",
            serde_json::json!({ "label": m.label, "tooltip": m.tooltip, "hooks": m.hooks, "demo": m.demo, "cowork": m.cowork,
                "pin": crate::office::pin_state(&cfg), "login": crate::startup::login_enabled(app), "notify": cfg.notify, "show": plain(&m, "show", ""), "quit": plain(&m, "quit", "") })
        );
    }
}

/// One event of /api/shell/events.
pub fn on_event(app: &AppHandle, ev: &str, data: Value) {
    let shell = app.state::<Shell>();
    match ev {
        "counts" => {
            let waiting = data.get("waiting").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let changed_icon = {
                let mut m = shell.menu.lock().unwrap();
                m.label = data.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
                m.tooltip = data.get("tooltip").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let was = m.waiting > 0;
                m.waiting = waiting;
                was != (waiting > 0)
            };
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if changed_icon {
                    let _ = tray.set_icon(Some(icon(waiting > 0)));
                }
            }
            rebuild(app);
        }
        "menu" => {
            let first = {
                let mut m = shell.menu.lock().unwrap();
                m.texts = data.get("texts").cloned().unwrap_or(Value::Null);
                m.hooks = data.get("hooks").and_then(|v| v.as_bool()).unwrap_or(false);
                m.demo = data.get("demo").and_then(|v| v.as_bool()).unwrap_or(false);
                m.cowork = data.get("cowork").and_then(|v| v.as_bool()).unwrap_or(true);
                m.base = data.get("base").and_then(|v| v.as_str()).unwrap_or("").to_string();
                !std::mem::replace(&mut m.received, true)
            };
            rebuild(app);
            if first {
                ask_hooks_once(app);
            }
        }
        "notify" => notify(app, &data),
        _ => {}
    }
}

/// Show a notification decided by the engine, with Electron's rules: the shell's option, and no wait or alert
/// toast while the window is already in front. On Windows a click on the toast opens the office on that floor
/// (winnotify.rs). On macOS and Linux tauri-plugin-notification cannot report the click: the floor is
/// remembered and shown the next time the window is opened.
fn notify(app: &AppHandle, ev: &Value) {
    let shell = app.state::<Shell>();
    let kind = ev.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let title = ev.get("title").and_then(|v| v.as_str()).unwrap_or("Platypus");
    let body = ev.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let sid = ev.get("sid").and_then(|v| v.as_str()).unwrap_or("");
    let test = std::env::var_os("PLATYPUS_NOTIFY_TEST").is_some();
    let win = app.get_webview_window(office::LABEL);
    let in_front = win.as_ref().map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false);
    let skip = if !shell.cfg.lock().unwrap().notify {
        Some("option off")
    } else if kind != "report" && in_front && !test {
        Some("window in front")
    } else if snapshot_mode() && !test {
        Some("automatic check")
    } else {
        None
    };
    if snapshot_mode() {
        println!("[notify] {} | {} | {} | {}", kind, title, body.replace('\n', " / "), skip.unwrap_or("shown"));
    }
    if skip.is_some() {
        return;
    }
    if kind != "report" && !sid.is_empty() {
        *shell.pending_goto.lock().unwrap() = Some((sid.to_string(), Instant::now()));
    }
    // Windows: our own toast, with our name and a click that works also from source (winnotify.rs)
    #[cfg(windows)]
    let shown = crate::winnotify::show(app, title, body, sid);
    #[cfg(not(windows))]
    let shown = app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string());
    if let Err(e) = shown {
        eprintln!("[platypus] notification: {e}");
    }
    if kind == "wait" {
        if let Some(w) = win {
            if !w.is_focused().unwrap_or(false) {
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }
    }
}

/// A menu item was chosen (also from `PLATYPUS_SNAPSHOT_MENU`, for the checks).
pub fn on_menu(app: &AppHandle, id: &str) {
    let shell = app.state::<Shell>();
    let port = shell.port();
    match id {
        "show" => office::show_window(app),
        "pin" => {
            if let Some(w) = app.get_webview_window(office::LABEL) {
                office::toggle_pin_window(&w, &shell);
            }
            rebuild(app);
        }
        "demo" => {
            let on = !shell.menu.lock().unwrap().demo;
            let _ = engine::post(port, "/api/demo", &format!("{{\"on\":{on}}}"));
        }
        "notify" => {
            {
                let mut c = shell.cfg.lock().unwrap();
                c.notify = !c.notify;
            }
            shell.save_cfg();
            rebuild(app);
        }
        "cowork" => {
            let on = !shell.menu.lock().unwrap().cowork;
            {
                shell.cfg.lock().unwrap().show_cowork = on;
            }
            shell.save_cfg();
            let _ = engine::post(port, "/api/cowork", &format!("{{\"on\":{on}}}"));
        }
        "hooks" => hooks(app),
        "report" => {
            let _ = app.opener().open_url(format!("{}/report", shell.origin()), None::<&str>);
        }
        "browser" => {
            let _ = app.opener().open_url(format!("{}/", shell.origin()), None::<&str>);
        }
        "folder" => {
            let base = shell.menu.lock().unwrap().base.clone();
            if !base.is_empty() {
                let _ = app.opener().open_path(base, None::<&str>);
            }
        }
        "login" => {
            let on = !crate::startup::login_enabled(app);
            crate::startup::set_login(app, on);
            if snapshot_mode() {
                println!("[login] {}", crate::startup::login_enabled(app));
            }
            rebuild(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Connect to / disconnect from Claude Code with `node src/hooks-cli.js`, after a confirmation for connecting.
/// In the automatic checks only `status` runs: nothing is really installed.
fn hooks(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let shell = app.state::<Shell>();
        let port = shell.port();
        let m = shell.menu.lock().unwrap().clone();
        let (Some(node), Some(root)) = (engine::find_node(), engine::repo_root()) else { return };
        if snapshot_mode() {
            let (ok, out) = engine::hooks_cli(&node, &root, port, "status");
            println!("[hooks] status ok={ok} | {}", out.replace('\n', " / "));
            return;
        }
        if m.hooks {
            let (ok, out) = engine::hooks_cli(&node, &root, port, "uninstall");
            if !ok {
                app.dialog().message(out).title("Platypus").kind(MessageDialogKind::Error).blocking_show();
            }
        } else {
            let yes = app
                .dialog()
                .message(plain(&m, "askDetail", ""))
                .title(plain(&m, "askTitle", "Platypus"))
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom(plain(&m, "askYes", "Connect"), plain(&m, "askLater", "Later")))
                .blocking_show();
            if !yes {
                return;
            }
            let (ok, out) = engine::hooks_cli(&node, &root, port, "install");
            if ok {
                app.dialog()
                    .message(format!("{out}\n\n{}", plain(&m, "doneDetail", "")))
                    .title(plain(&m, "done", "Platypus"))
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
            } else {
                app.dialog()
                    .message(plain(&m, "failed", "{error}").replace("{error}", &out))
                    .title("Platypus")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
        }
        // the engine caches the hooks state for 5 s: show the new one at once
        let (_, out) = engine::hooks_cli(&node, &root, port, "status");
        let installed = out.lines().next().map(|l| l.contains("INSTALL")).unwrap_or(false);
        shell.menu.lock().unwrap().hooks = installed;
        rebuild(&app);
    });
}

/// The first time (in this shell), ask whether to connect to Claude Code, like `askHooksOnce` in Electron.
fn ask_hooks_once(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if snapshot_mode() || shell.cfg.lock().unwrap().asked_hooks || shell.menu.lock().unwrap().hooks {
        return;
    }
    shell.cfg.lock().unwrap().asked_hooks = true;
    shell.save_cfg();
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        hooks(&app);
    });
}

/// Start reading the engine's shell stream (in its own thread, for the whole life of the app).
pub fn listen(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let shell = app.state::<Shell>();
        let port = shell.port();
        engine::shell_events(port, &shell.alive, |ev, data| on_event(&app, ev, data));
    });
}

/// The snapshot checks: choose menu items by id after the delay (`PLATYPUS_SNAPSHOT_MENU=demo,cowork,...`).
pub fn snapshot_menu(app: &AppHandle) {
    let Ok(list) = std::env::var("PLATYPUS_SNAPSHOT_MENU") else { return };
    let delay = std::env::var("PLATYPUS_SNAPSHOT_DELAY").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(8000);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay / 2));
        for id in list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty() && *s != "quit" && *s != "folder") {
            println!("[menu] {id}");
            on_menu(&app, id);
            std::thread::sleep(Duration::from_millis(600));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::icon;

    fn px(img: &tauri::image::Image<'_>, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * img.width() + x) * 4) as usize;
        img.rgba()[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn waiting_icon_has_a_red_dot_in_the_corner() {
        let (a, b) = (icon(false), icon(true));
        assert_eq!((a.width(), a.height()), (b.width(), b.height()));
        let (x, y) = (b.width() - 5, b.height() - 5);
        assert_eq!(px(&b, x, y), [0xe8, 0x2e, 0x4a, 0xff]);
        assert_ne!(px(&a, x, y), [0xe8, 0x2e, 0x4a, 0xff]);
        // the rest of the icon is untouched
        assert_eq!(px(&a, 2, 2), px(&b, 2, 2));
    }
}
