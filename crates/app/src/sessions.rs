//! Tauri side of agent sessions: keeps one connection to `sessiond` (starting
//! it when needed), forwards its events to the UI and terminal output through
//! a per-session channel. Logic lives in `aurora_core::session`.

use std::{path::PathBuf, sync::Arc};

use aurora_core::{
    Error,
    session::{self, Client, ClientEvent, NewSession, SessionInfo},
};
use parking_lot::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, State,
    ipc::{Channel, InvokeResponseBody},
};

use crate::commands::{AppState, CmdResult, blocking};

pub const UPDATED: &str = "session-update";
pub const REMOVED: &str = "session-removed";
pub const DOWN: &str = "sessiond-down";

#[derive(Default)]
pub struct Sessions {
    client: Mutex<Option<Arc<Client>>>,
}

/// `aurora-sessiond` ships next to the app binary (bundled as a sidecar; in
/// dev, cargo puts both in `target/debug`).
fn daemon_exe() -> PathBuf {
    let name = if cfg!(windows) { "aurora-sessiond.exe" } else { "aurora-sessiond" };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

impl Sessions {
    fn client(&self, app: &AppHandle) -> aurora_core::Result<Arc<Client>> {
        let mut slot = self.client.lock();
        if let Some(c) = slot.as_ref().filter(|c| c.is_alive()) {
            return Ok(c.clone());
        }
        let handle = app.clone();
        let on_event = move |e: ClientEvent| {
            let _ = match e {
                ClientEvent::Updated(info) => handle.emit(UPDATED, info),
                ClientEvent::Removed(id) => handle.emit(REMOVED, id),
                ClientEvent::Disconnected => handle.emit(DOWN, ()),
            };
        };
        let c = session::connect_or_spawn(&daemon_exe(), &session::data_dir(), on_event)?;
        *slot = Some(c.clone());
        Ok(c)
    }
}

/// Runs `f` with a connected client on a blocking thread.
async fn with_client<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(Arc<Client>) -> aurora_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    blocking(move || {
        let c = app.state::<AppState>().sessions.client(&app)?;
        f(c)
    })
    .await
}

fn find(c: &Client, id: &str) -> aurora_core::Result<SessionInfo> {
    c.list()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| Error::Session(format!("session not found: {id}")))
}

#[tauri::command]
pub async fn session_list(app: AppHandle) -> CmdResult<Vec<SessionInfo>> {
    with_client(app, |c| c.list()).await
}

#[tauri::command]
pub async fn session_create(
    app: AppHandle,
    state: State<'_, AppState>,
    req: NewSession,
) -> CmdResult<SessionInfo> {
    let ws = state.ws()?;
    with_client(app, move |c| {
        let taken: Vec<String> = c.list()?.into_iter().map(|s| s.name).collect();
        let spec = session::prepare(ws.root(), &req, &taken)?;
        c.create(spec)
    })
    .await
}

#[tauri::command]
pub async fn session_attach(
    app: AppHandle,
    id: String,
    on_output: Channel<InvokeResponseBody>,
) -> CmdResult<()> {
    with_client(app, move |c| {
        c.attach(
            &id,
            Box::new(move |bytes| {
                let _ = on_output.send(InvokeResponseBody::Raw(bytes.to_vec()));
            }),
        )
    })
    .await
}

#[tauri::command]
pub async fn session_detach(app: AppHandle, id: String) -> CmdResult<()> {
    with_client(app, move |c| c.detach(&id)).await
}

#[tauri::command]
pub async fn session_input(app: AppHandle, id: String, data: String) -> CmdResult<()> {
    with_client(app, move |c| c.input(&id, data.as_bytes())).await
}

#[tauri::command]
pub async fn session_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    with_client(app, move |c| c.resize(&id, cols, rows)).await
}

#[tauri::command]
pub async fn session_kill(app: AppHandle, id: String) -> CmdResult<()> {
    with_client(app, move |c| c.kill(&id)).await
}

#[tauri::command]
pub async fn session_rename(app: AppHandle, id: String, name: String) -> CmdResult<SessionInfo> {
    with_client(app, move |c| c.rename(&id, &name)).await
}

/// Whether removing the session's worktree would discard uncommitted work.
#[tauri::command]
pub async fn session_worktree_dirty(app: AppHandle, id: String) -> CmdResult<bool> {
    with_client(app, move |c| session::worktree_dirty(&find(&c, &id)?)).await
}

/// Forgets the session (killing it if alive); optionally removes its worktree.
#[tauri::command]
pub async fn session_remove(app: AppHandle, id: String, remove_worktree: bool, force: bool) -> CmdResult<()> {
    with_client(app, move |c| {
        let info = find(&c, &id)?;
        if remove_worktree && !force && session::worktree_dirty(&info)? {
            // Checked before anything is touched, so a refusal leaves the session intact.
            return Err(Error::DirtyWorktree(info.worktree.clone().unwrap_or_default()));
        }
        c.remove(&id)?;
        if remove_worktree {
            session::remove_worktree(&info, force)?;
        }
        Ok(())
    })
    .await
}
