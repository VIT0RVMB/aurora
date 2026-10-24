//! Agent sessions. PTYs live in a separate `sessiond` process so closing the
//! app never kills an agent; this module holds what both sides share: the
//! protocol, the client, where the socket lives and how a session is prepared.

pub mod agents;
pub mod client;
pub mod proto;
pub mod transport;

use std::{
    io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde::Deserialize;

pub use client::{Client, ClientEvent, OutputSink};
pub use proto::{AgentEvent, CreateSpec, SessionInfo, Status};

use crate::{Error, Result, git};

/// Env var telling a session (and its hooks) which session it is.
pub const ENV_SESSION: &str = "AURORA_SESSION_ID";
/// Env var with the daemon endpoint, so `notify` reaches the right daemon.
pub const ENV_ENDPOINT: &str = "AURORA_ENDPOINT";
/// Overrides the data folder (tests, portable installs).
pub const ENV_DATA_DIR: &str = "AURORA_DATA_DIR";

/// Per-user folder for the daemon's socket, database and history.
pub fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os(ENV_DATA_DIR).filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let home = || std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/dev.aurora.ide")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(home).join("aurora")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/share"))
            .join("aurora")
    }
}

/// Unix socket path, or named pipe name on Windows, for a data folder.
pub fn endpoint(data_dir: &Path) -> String {
    #[cfg(windows)]
    {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        data_dir.hash(&mut h);
        format!("aurora-sessiond-{:016x}", h.finish())
    }
    #[cfg(not(windows))]
    {
        let p = data_dir.join("sessiond.sock");
        // sun_path holds ~104 bytes; very long homes fall back to the temp dir.
        if p.as_os_str().len() < 100 {
            return p.to_string_lossy().into_owned();
        }
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        data_dir.hash(&mut h);
        std::env::temp_dir().join(format!("aurora-{:016x}.sock", h.finish())).to_string_lossy().into_owned()
    }
}

/// Connects to the daemon, starting it first if nothing answers.
pub fn connect_or_spawn(
    daemon_exe: &Path,
    data_dir: &Path,
    on_event: impl Fn(ClientEvent) + Send + Sync + Clone + 'static,
) -> Result<std::sync::Arc<Client>> {
    let ep = endpoint(data_dir);
    if let Ok(c) = Client::connect(&ep, on_event.clone()) {
        return Ok(c);
    }
    spawn_daemon(daemon_exe, data_dir)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match Client::connect(&ep, on_event.clone()) {
            Ok(c) => return Ok(c),
            Err(e) if Instant::now() > deadline => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(40)),
        }
    }
}

/// Starts `sessiond` detached from the app: its own process group (Unix) or
/// no console (Windows), so it outlives the app and terminal signals.
pub fn spawn_daemon(exe: &Path, data_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(data_dir.join("sessiond.log"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("serve")
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| Error::Daemon(format!("{}: {e}", exe.display())))?;
    Ok(())
}

/// Marker around the env dump so shell startup noise can be skipped.
pub const ENV_MARK: &str = "\x1eAURORA_ENV\x1e";

/// The environment of the user's interactive login shell. A GUI app on macOS
/// starts with a bare PATH; agents installed by npm, brew or mise would not
/// be found without this. `helper` is a binary that prints its env as JSON
/// between [`ENV_MARK`]s (`aurora-sessiond dump-env`).
pub fn shell_env(helper: &Path) -> Option<Vec<(String, String)>> {
    if cfg!(windows) {
        return None;
    }
    let shell = agents::default_shell();
    let script = format!("{} dump-env", agents::shell_quote(&helper.to_string_lossy()));
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .env("AURORA_RESOLVING_ENV", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = io::Read::read_to_end(&mut out, &mut buf);
        let _ = tx.send(buf);
    });
    let buf = rx.recv_timeout(Duration::from_secs(10));
    let _ = child.kill();
    let _ = child.wait();
    parse_env_dump(&String::from_utf8_lossy(&buf.ok()?))
}

pub fn parse_env_dump(out: &str) -> Option<Vec<(String, String)>> {
    let start = out.find(ENV_MARK)? + ENV_MARK.len();
    let end = start + out[start..].find(ENV_MARK)?;
    let map: std::collections::BTreeMap<String, String> = serde_json::from_str(&out[start..end]).ok()?;
    Some(map.into_iter().collect())
}

/// Short random-enough id: unique per daemon, readable in logs.
pub fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),
    );
    h.write_u32(std::process::id());
    format!("{:010x}", h.finish() & 0xff_ffff_ffff)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewSession {
    pub agent: String,
    pub name: Option<String>,
    /// Creates (or reuses) a worktree + branch with this name.
    pub worktree: Option<String>,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Turns a request into a spawnable spec: picks a free name, creates the
/// worktree if asked, and resolves the agent's program and hooks.
pub fn prepare(workspace: &Path, req: &NewSession, taken: &[String]) -> Result<CreateSpec> {
    let agent = req.agent.trim();
    if agent.is_empty() {
        return Err(Error::BadName("agente vazio".into()));
    }
    let name = match req.name.as_deref().or(req.worktree.as_deref()) {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => (1..).map(|i| format!("{agent}-{i}")).find(|n| !taken.contains(n)).expect("infinite range"),
    };
    let (cwd, branch, worktree) = match req.worktree.as_deref() {
        Some(wt) => {
            let w = git::worktree_add(workspace, wt)?;
            (w.path.clone(), Some(w.branch), Some(w.path.to_string_lossy().into_owned()))
        }
        None => (workspace.to_path_buf(), git::current_branch(workspace), None),
    };
    let launch = agents::resolve(agent, &req.args);
    Ok(CreateSpec {
        name,
        agent: agent.to_string(),
        program: launch.program,
        args: launch.args,
        cwd: cwd.to_string_lossy().into_owned(),
        workspace: workspace.to_string_lossy().into_owned(),
        branch,
        worktree,
        env: vec![],
        hooks: launch.hooks,
        cols: req.cols.clamp(2, 1000),
        rows: req.rows.clamp(2, 1000),
    })
}

/// Whether the session's worktree has uncommitted work (false without one).
pub fn worktree_dirty(info: &SessionInfo) -> Result<bool> {
    match info.worktree.as_deref().map(Path::new) {
        Some(p) if p.exists() => git::is_dirty(p),
        _ => Ok(false),
    }
}

/// Removes the worktree a session created. `force` discards uncommitted work.
pub fn remove_worktree(info: &SessionInfo, force: bool) -> Result<()> {
    let Some(wt) = info.worktree.as_deref() else { return Ok(()) };
    if !Path::new(wt).exists() {
        return Ok(());
    }
    git::worktree_remove(Path::new(&info.workspace), Path::new(wt), force)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_dump_skips_noise() {
        let out = format!("motd\x1b[0m\n{ENV_MARK}{{\"PATH\":\"/a:/b\",\"X\":\"1\"}}{ENV_MARK}\nbye");
        let env = parse_env_dump(&out).unwrap();
        assert_eq!(env, vec![("PATH".into(), "/a:/b".into()), ("X".into(), "1".into())]);
        assert!(parse_env_dump("nothing").is_none());
    }

    #[test]
    fn prepare_names_and_plain_folder() {
        let dir = tempfile::tempdir().unwrap();
        let req = NewSession { agent: "claude".into(), cols: 80, rows: 24, ..Default::default() };
        let spec = prepare(dir.path(), &req, &["claude-1".into()]).unwrap();
        assert_eq!(spec.name, "claude-2");
        assert_eq!(spec.branch, None);
        assert_eq!(spec.worktree, None);
        assert_eq!(spec.hooks, agents::Hooks::Claude);

        let wt = NewSession { worktree: Some("x".into()), ..req };
        assert!(matches!(prepare(dir.path(), &wt, &[]), Err(Error::NotRepo(_))));
    }

    #[test]
    fn ids_differ() {
        assert_ne!(new_id(), new_id());
        assert_eq!(new_id().len(), 10);
    }
}
