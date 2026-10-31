// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dev;
mod sessions;

use commands::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::initial_path,
            commands::open_workspace,
            commands::list_dir,
            commands::read_file,
            commands::write_file,
            commands::stat_file,
            commands::read_image,
            commands::create_file,
            commands::create_dir,
            commands::rename_path,
            commands::open_path,
            commands::reveal_path,
            commands::trash_path,
            commands::file_history,
            commands::commit_diff,
            commands::share_link,
            commands::worktrees,
            commands::open_url,
            commands::fuzzy_find,
            commands::search_text,
            commands::cancel_search,
            commands::quit,
            commands::list_themes,
            commands::load_theme,
            sessions::session_list,
            sessions::session_create,
            sessions::session_attach,
            sessions::session_detach,
            sessions::session_input,
            sessions::session_resize,
            sessions::session_kill,
            sessions::session_rename,
            sessions::session_set_stage,
            sessions::session_set_color,
            sessions::session_set_archived,
            sessions::session_worktree_dirty,
            sessions::session_remove,
            sessions::session_changes,
            sessions::session_file_diff,
            dev::dev_smoke,
            dev::dev_log,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run aurora");
}
