//! Windows toasts with our own AppUserModelID, also when started from source.
//!
//! tauri-plugin-notification uses the app's identifier only for an installed program: from
//! `target\release` its toasts say "Windows PowerShell" and a click does nothing. Here the toast is shown with
//! tauri-winrt-notification and the ID `com.platypus.desktop` (Electron's), registered for the current user
//! under HKCU\Software\Classes\AppUserModelId with a display name and an icon. That registration is what Windows
//! needs for an app that is not installed, instead of a Start menu shortcut. A click on the toast brings the
//! office to the front on the floor of the notification, as in Electron.

use std::path::Path;

use tauri::{AppHandle, Manager};
use tauri_winrt_notification::Toast;

use crate::office::{self, Shell};

/// The AppUserModelID. `PLATYPUS_AUMID` exists only for the checks, so that they never touch the real one.
pub fn aumid() -> String {
    match std::env::var("PLATYPUS_AUMID") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => "com.platypus.desktop".into(),
    }
}

/// Register the ID for the current user (name and icon of the toasts). Idempotent; errors are only logged.
pub fn register(root: Option<&Path>) {
    let key = format!(r"Software\Classes\AppUserModelId\{}", aumid());
    match windows_registry::CURRENT_USER.create(&key) {
        Ok(k) => {
            let _ = k.set_string("DisplayName", "Platypus");
            if let Some(icon) = root.map(|r| r.join("build").join("icon.png")).filter(|p| p.is_file()) {
                let _ = k.set_string("IconUri", icon.display().to_string());
            }
        }
        Err(e) => eprintln!("[platypus] notifications: cannot register {key}: {e}"),
    }
}

/// Show a toast; a click shows the office on the floor `sid` (if any).
pub fn show(app: &AppHandle, title: &str, body: &str, sid: &str) -> Result<(), String> {
    let (line1, line2) = body.split_once('\n').unwrap_or((body, ""));
    let handle = app.clone();
    let sid = sid.to_string();
    let mut toast = Toast::new(&aumid()).title(title).text1(line1);
    if !line2.is_empty() {
        toast = toast.text2(line2);
    }
    toast
        .on_activated(move |_action| {
            if !sid.is_empty() {
                *handle.state::<Shell>().pending_goto.lock().unwrap() = Some((sid.clone(), std::time::Instant::now()));
            }
            office::show_window(&handle);
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}
