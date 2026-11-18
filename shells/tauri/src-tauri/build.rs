// Only the shell's own commands exist for the page: each becomes an `allow-<command>` permission,
// and the capability built at start-up (src/main.rs) grants just those to the engine's origin.
const COMMANDS: &[&str] = &[
    "minimize",
    "close",
    "toggle_maximize",
    "is_maximized",
    "toggle_pin",
    "get_pin",
    "set_counts",
    "set_widget",
    "report",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
