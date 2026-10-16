// Desktop shell: the playground's own build in a native window.
// The MIDI/serial bridge (docs/DESKTOP-MIDI.md §3.3) will live beside this.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[derive(serde::Serialize)]
struct ShellInfo {
    version: &'static str,
    os: &'static str,
    arch: &'static str,
}

/// Proves the webview → Rust IPC path works. From devtools:
/// `await __TAURI_INTERNALS__.invoke("shell_info")`
#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![shell_info])
        .run(tauri::generate_context!())
        .expect("error while running Cosmic Playground");
}
