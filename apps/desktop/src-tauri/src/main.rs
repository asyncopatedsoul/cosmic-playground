// Desktop shell: the playground's own build in a native window.
// The MIDI/serial bridge (docs/DESKTOP-MIDI.md §3.3) will live beside this.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::PageLoadEvent;

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

/// `--room <link>` joins a room on launch (docs/MULTIPLAYER.md §6.3): the page
/// reads `?join=<link>`, since a release build has no address bar to paste into.
fn room_arg() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--room" {
            return args.next();
        }
        if let Some(v) = a.strip_prefix("--room=") {
            return Some(v.to_string());
        }
    }
    None
}

fn main() {
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            // After the first load, reload once with ?join=<link> (navigating during
            // setup is too early: the initial load replaces it).
            if payload.event() != PageLoadEvent::Finished || payload.url().query_pairs().any(|(k, _)| k == "join") {
                return;
            }
            if let Some(link) = room_arg() {
                let mut url = payload.url().clone();
                url.query_pairs_mut().append_pair("join", &link);
                let _ = webview.navigate(url);
            }
        })
        .invoke_handler(tauri::generate_handler![shell_info])
        .run(tauri::generate_context!())
        .expect("error while running Cosmic Playground");
}
