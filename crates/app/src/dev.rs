//! Debug-build helpers for the in-app smoke test (`AURORA_SMOKE=1 pnpm dev`):
//! the UI asks whether to run it and reports each step to stderr.

/// The smoke mode to run (`AURORA_SMOKE=1` or `AURORA_SMOKE=claude`), if any.
#[tauri::command]
pub fn dev_smoke() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("AURORA_SMOKE").ok().filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn dev_log(msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[smoke] {msg}");
    }
}
