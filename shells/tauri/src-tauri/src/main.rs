// Platypus — experimental Tauri 2 shell, next to Electron (docs/plans/tauri-shell.md).
// The engine stays Node (a child process, see engine.rs); this program is only the window and, later, the tray.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod office;
mod startup;
mod tray;
#[cfg(windows)]
mod winnotify;

use std::path::PathBuf;
use std::time::Duration;

use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::engine::{Engine, Probe, WaitError};
use crate::office::Shell;

fn main() {
    let demo = std::env::args().any(|a| a == "--demo");
    // --smoke (GitHub Actions, T8): start the engine, wait until the window has loaded the office, exit with 0;
    // exit with 1 on any error or after 120 s. No dialogs.
    let smoke = std::env::args().any(|a| a == "--smoke");
    office::SMOKE.store(smoke, std::sync::atomic::Ordering::SeqCst);
    // With PLATYPUS_DATA_DIR (tests, development loops) this copy is kept apart from the Platypus already open, as
    // Electron does (src/main.js): it does not take part in the single-instance lock, so it starts instead of
    // bringing the other window to the front.
    let separate = std::env::var("PLATYPUS_DATA_DIR").map(|v| !v.trim().is_empty()).unwrap_or(false);
    let mut builder = tauri::Builder::default();
    if !separate {
        // a second start brings the first window to the front (this plugin must come first)
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if tray::snapshot_mode() {
                println!("[second-instance]");
            }
            office::show_window(app);
        }));
    }
    let app = builder
        .plugin(startup::plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            office::minimize,
            office::close,
            office::toggle_maximize,
            office::is_maximized,
            office::toggle_pin,
            office::get_pin,
            office::set_counts,
            office::set_widget,
            office::report,
        ])
        .setup(move |app| {
            let data = shell_data_dir(app.handle());
            app.manage(Shell::new(data));
            let handle = app.handle().clone();
            if smoke {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(120));
                    eprintln!("[smoke] FAILED: the window did not load the office within 120 s");
                    h.exit(1);
                });
            }
            // the engine can take a few seconds: wait for it off the main thread, then open the window
            std::thread::spawn(move || {
                if let Err(msg) = start_engine(&handle, demo) {
                    eprintln!("[platypus] {msg}");
                    if smoke {
                        eprintln!("[smoke] FAILED: the engine did not start");
                        handle.exit(1);
                        return;
                    }
                    handle.dialog().message(msg).title("Platypus").kind(MessageDialogKind::Error).blocking_show();
                    handle.exit(1);
                    return;
                }
                if let Err(e) = office::open_window(&handle) {
                    eprintln!("[platypus] window: {e}");
                    handle.exit(1);
                    return;
                }
                if let Err(e) = tray::create(&handle) {
                    eprintln!("[platypus] tray: {e}");
                }
                // the real ID is registered only for real use: the checks use PLATYPUS_AUMID or nothing
                #[cfg(windows)]
                if !tray::snapshot_mode() || std::env::var_os("PLATYPUS_AUMID").is_some() {
                    winnotify::register(engine::repo_root().as_deref());
                }
                tray::listen(&handle);
                tray::snapshot_menu(&handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // the engine is stopped only if this shell started it
            if let Some(shell) = app.try_state::<Shell>() {
                shell.alive.store(false, std::sync::atomic::Ordering::SeqCst);
                if let Some(e) = shell.engine.lock().unwrap().take() {
                    e.stop();
                }
            }
        }
    });
}

/// The shell's own preferences: `$PLATYPUS_DATA_DIR/tauri` (tests and development loops), or the app's config folder.
fn shell_data_dir(app: &tauri::AppHandle) -> PathBuf {
    match std::env::var("PLATYPUS_DATA_DIR") {
        Ok(v) if !v.trim().is_empty() => PathBuf::from(v.trim()).join("tauri"),
        _ => app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("platypus-tauri")),
    }
}

/// Attach to a Platypus already on the port, or start one and wait for it (15 s at most).
fn start_engine(app: &tauri::AppHandle, demo: bool) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let port = engine::choose_port();
    let it = office::italian();
    match engine::probe(port) {
        Probe::Platypus => {
            eprintln!("[platypus] attached to the Platypus already running on port {port}");
            shell.set_port(port);
            return Ok(());
        }
        Probe::Other => {
            return Err(if it {
                format!("La porta {port} è occupata da un altro programma. Scegline un'altra con PLATYPUS_PORT.")
            } else {
                format!("Port {port} is used by another program. Choose another one with PLATYPUS_PORT.")
            })
        }
        Probe::Free => {}
    }
    let node = engine::find_node().ok_or_else(|| {
        if it {
            "Non trovo Node.js (node) nel PATH. Installalo da https://nodejs.org (versione 18 o più recente) e riprova.".to_string()
        } else {
            "Node.js (node) was not found in the PATH. Install it from https://nodejs.org (version 18 or newer) and try again.".to_string()
        }
    })?;
    let root = engine::repo_root().ok_or_else(|| {
        if it {
            "Non trovo la cartella di Platypus (src/standalone.js). Indicala con PLATYPUS_ROOT.".to_string()
        } else {
            "The Platypus folder (src/standalone.js) was not found. Set it with PLATYPUS_ROOT.".to_string()
        }
    })?;
    let cowork = shell.cfg.lock().unwrap().show_cowork;
    let mut e = Engine::start(&node, &root, port, demo, cowork).map_err(|err| {
        if it {
            format!("Non riesco ad avviare il motore ({}): {err}", node.display())
        } else {
            format!("Cannot start the engine ({}): {err}", node.display())
        }
    })?;
    eprintln!("[platypus] engine started, pid {}, port {port}", e.pid());
    match e.wait_ready(port, Duration::from_secs(15)) {
        Ok(()) => {
            shell.set_port(port);
            *shell.engine.lock().unwrap() = Some(e);
            Ok(())
        }
        Err(w) => {
            e.stop();
            Err(match (w, it) {
                (WaitError::Exited(code), true) => format!("Il motore si è chiuso subito (codice {}). La porta {port} è forse già occupata?", code.map(|c| c.to_string()).unwrap_or("?".into())),
                (WaitError::Exited(code), false) => format!("The engine exited at once (code {}). Is port {port} already in use?", code.map(|c| c.to_string()).unwrap_or("?".into())),
                (WaitError::Timeout, true) => format!("Il motore non ha risposto entro 15 secondi sulla porta {port}."),
                (WaitError::Timeout, false) => format!("The engine did not answer within 15 seconds on port {port}."),
            })
        }
    }
}
