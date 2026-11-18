//! "Start at login" with the autostart plugin, under the same entry name as Electron's (src/autostart.js):
//!   Windows: the value `com.platypus.desktop` of HKCU\Software\Microsoft\Windows\CurrentVersion\Run
//!            (Electron's default name is its AppUserModelID, `com.platypus.desktop`);
//!   macOS:   ~/Library/LaunchAgents/com.platypus.desktop.plist;
//!   Linux:   ~/.config/autostart/platypus.desktop.
//! One name for both shells means there can never be two entries. Turning it on in one shell replaces the other's,
//! and each shell shows the item as on only if the entry starts *its own* program, so neither removes the
//! other's entry by mistake.

#[cfg(unix)]
use std::path::PathBuf;

use tauri::plugin::TauriPlugin;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// The entry's name. `PLATYPUS_AUTOSTART_NAME` exists only for the checks, so that they never touch the real entry.
pub fn entry_name() -> String {
    if let Ok(v) = std::env::var("PLATYPUS_AUTOSTART_NAME") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    if cfg!(target_os = "linux") { "platypus".into() } else { "com.platypus.desktop".into() }
}

pub fn plugin<R: tauri::Runtime>() -> TauriPlugin<R> {
    tauri_plugin_autostart::Builder::new().app_name(entry_name()).build()
}

/// What the entry starts (command line or file contents), if there is one.
fn entry_text() -> Option<String> {
    let name = entry_name();
    #[cfg(windows)]
    {
        windows_registry::CURRENT_USER
            .open(r"Software\Microsoft\Windows\CurrentVersion\Run")
            .and_then(|k| k.get_string(&name))
            .ok()
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        std::fs::read_to_string(home.join("Library").join("LaunchAgents").join(format!("{name}.plist"))).ok()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        std::fs::read_to_string(dir.join("autostart").join(format!("{name}.desktop"))).ok()
    }
}

/// Does the entry start this program (and not Electron)?
fn entry_is_ours() -> bool {
    let Some(text) = entry_text() else { return false };
    let Ok(exe) = std::env::current_exe() else { return false };
    let exe = exe.display().to_string();
    if cfg!(windows) { text.to_lowercase().contains(&exe.to_lowercase()) } else { text.contains(&exe) }
}

pub fn login_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false) && entry_is_ours()
}

/// On: write the entry for this program (replacing Electron's, if any). Off: remove it, but only if it is ours.
pub fn set_login(app: &AppHandle, on: bool) {
    let r = if on {
        app.autolaunch().enable()
    } else if entry_is_ours() {
        app.autolaunch().disable()
    } else {
        Ok(())
    };
    if let Err(e) = r {
        eprintln!("[platypus] start at login: {e}");
    }
}
