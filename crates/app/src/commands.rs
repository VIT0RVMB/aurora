//! Thin Tauri bindings over `aurora_core`. No logic lives here: each command
//! resolves the open workspace and forwards the call.

use std::{path::PathBuf, sync::Arc};

use aurora_core::{
    DirEntry, Error, FileContent, FileStat, FuzzyMatch, SearchOptions, SearchResults, Workspace,
};
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub const FS_EVENT: &str = "fs-change";

#[derive(Default)]
pub struct AppState {
    ws: RwLock<Option<Arc<Workspace>>>,
    pub sessions: crate::sessions::Sessions,
}

impl AppState {
    pub fn ws(&self) -> Result<Arc<Workspace>, CmdError> {
        self.ws.read().clone().ok_or(CmdError::NoWorkspace)
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum CmdError {
    Core(Error),
    #[serde(serialize_with = "no_workspace")]
    NoWorkspace,
}

fn no_workspace<S: serde::Serializer>(s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeStruct;
    let mut st = s.serialize_struct("Error", 2)?;
    st.serialize_field("kind", "no_workspace")?;
    st.serialize_field("message", "no folder open")?;
    st.end()
}

impl From<Error> for CmdError {
    fn from(e: Error) -> Self {
        CmdError::Core(e)
    }
}

pub type CmdResult<T> = Result<T, CmdError>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    root: String,
    name: String,
}

/// Folder passed on the command line (`aurora ~/code/x`), if any.
#[tauri::command]
pub fn initial_path() -> Option<String> {
    // Skip flags such as the `-psn_*` process serial macOS may pass to bundles.
    std::env::args().skip(1).find(|a| !a.starts_with('-')).map(|a| expand_home(&a).display().to_string())
}

#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<WorkspaceInfo> {
    let path = expand_home(&path);
    let ws = tauri::async_runtime::spawn_blocking(move || Workspace::open(path))
        .await
        .expect("open task panicked")?;
    ws.watch(move |batch| {
        let _ = app.emit(FS_EVENT, batch);
    })?;
    let info = WorkspaceInfo { root: ws.root().display().to_string(), name: ws.name() };
    *state.ws.write() = Some(ws);
    Ok(info)
}

#[tauri::command]
pub fn list_dir(state: State<'_, AppState>, path: String) -> CmdResult<Vec<DirEntry>> {
    Ok(state.ws()?.list_dir(&path)?)
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> CmdResult<FileContent> {
    let ws = state.ws()?;
    blocking(move || ws.read_file(&path)).await
}

#[tauri::command]
pub async fn write_file(state: State<'_, AppState>, path: String, content: String) -> CmdResult<FileStat> {
    let ws = state.ws()?;
    blocking(move || ws.write_file(&path, &content)).await
}

#[tauri::command]
pub async fn read_image(state: State<'_, AppState>, path: String) -> CmdResult<Option<String>> {
    let ws = state.ws()?;
    blocking(move || ws.read_image(&path)).await
}

#[tauri::command]
pub fn open_url(url: String) -> CmdResult<()> {
    Ok(aurora_core::open::open_url(&url)?)
}

#[tauri::command]
pub fn create_file(state: State<'_, AppState>, path: String) -> CmdResult<FileStat> {
    Ok(state.ws()?.create_file(&path)?)
}

#[tauri::command]
pub fn create_dir(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    Ok(state.ws()?.create_dir(&path)?)
}

#[tauri::command]
pub fn rename_path(state: State<'_, AppState>, from: String, to: String) -> CmdResult<()> {
    Ok(state.ws()?.rename(&from, &to)?)
}

/// Opens a workspace file in the system's default app for it.
#[tauri::command]
pub fn open_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    Ok(aurora_core::open::open_path(&state.ws()?.absolute(&path)?)?)
}

/// Shows a workspace file in Finder / Explorer / the file manager.
#[tauri::command]
pub fn reveal_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    Ok(aurora_core::open::reveal(&state.ws()?.absolute(&path)?)?)
}

/// Moves a workspace file or folder to the system trash.
#[tauri::command]
pub async fn trash_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let ws = state.ws()?;
    blocking(move || ws.trash(&path)).await
}

#[tauri::command]
pub async fn file_history(
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<Vec<aurora_core::git::Commit>> {
    let ws = state.ws()?;
    blocking(move || ws.history(&path)).await
}

#[tauri::command]
pub async fn commit_diff(
    state: State<'_, AppState>,
    hash: String,
    path: String,
) -> CmdResult<aurora_core::session::changes::FileDiff> {
    let ws = state.ws()?;
    blocking(move || ws.commit_diff(&hash, &path)).await
}

/// The workspace repository's worktrees (main checkout first) and their changed-file counts.
#[tauri::command]
pub async fn worktrees(state: State<'_, AppState>) -> CmdResult<Vec<aurora_core::git::WorktreeStatus>> {
    let ws = state.ws()?;
    blocking(move || ws.worktrees()).await
}

/// A link to the file on its repository's web host (GitHub, GitLab…).
#[tauri::command]
pub async fn share_link(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    let ws = state.ws()?;
    blocking(move || ws.share_link(&path)).await
}

#[tauri::command]
pub fn stat_file(state: State<'_, AppState>, path: String) -> CmdResult<FileStat> {
    Ok(state.ws()?.stat(&path)?)
}

#[tauri::command]
pub async fn fuzzy_find(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<FuzzyMatch>> {
    let ws = state.ws()?;
    blocking(move || Ok(ws.fuzzy(&query, limit.unwrap_or(50)))).await
}

#[tauri::command]
pub async fn search_text(
    state: State<'_, AppState>,
    query: String,
    options: Option<SearchOptions>,
) -> CmdResult<SearchResults> {
    let ws = state.ws()?;
    blocking(move || ws.search(&query, &options.unwrap_or_default())).await
}

#[tauri::command]
pub fn cancel_search(state: State<'_, AppState>) -> CmdResult<()> {
    state.ws()?.cancel_search();
    Ok(())
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> aurora_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    Ok(tauri::async_runtime::spawn_blocking(f).await.expect("core task panicked")?)
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
            match home {
                Some(h) => PathBuf::from(h).join(rest.trim_start_matches(['/', '\\'])),
                None => PathBuf::from(p),
            }
        }
        _ => PathBuf::from(p),
    }
}
