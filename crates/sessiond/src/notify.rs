//! `aurora-sessiond notify`: what agent hooks call to report status.
//!
//! Always exits 0 and prints nothing: a hook failing must never disturb the
//! agent. Outside an Aurora session (no `AURORA_SESSION_ID`) it is a no-op.

use std::{
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use aurora_core::session::{self, AgentEvent, Client};

/// Hook payloads with a written file's content can be large; past this the
/// payload is dropped (status still goes through).
const MAX_STDIN: u64 = 16 * 1024 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Args {
    pub session: Option<String>,
    pub event: Option<AgentEvent>,
    /// `--file PATH`, repeatable: files the agent wrote.
    pub files: Vec<String>,
    /// `--stdin`: a Claude Code hook payload arrives on stdin.
    pub stdin: bool,
}

/// `notify [--session ID] [--event EVENT] [--file PATH]... [--stdin] [PAYLOAD...]`.
/// Without `--event`, a trailing JSON payload with a `type` field (Codex) names the event.
pub fn parse(args: &[String]) -> Args {
    let mut out = Args::default();
    let mut rest = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--session" => out.session = it.next().cloned(),
            "--event" => out.event = it.next().and_then(|e| AgentEvent::parse(e)),
            "--file" => out.files.extend(it.next().cloned()),
            "--stdin" => out.stdin = true,
            _ => rest.push(a),
        }
    }
    if out.event.is_none()
        && let Some(last) = rest.last()
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(last)
    {
        out.event = v.get("type").and_then(|t| t.as_str()).and_then(AgentEvent::parse);
    }
    out.session = out.session.or_else(|| std::env::var(session::ENV_SESSION).ok()).filter(|s| !s.is_empty());
    out
}

/// The file a Claude Code tool call wrote (`Edit`, `Write`, `MultiEdit`,
/// `NotebookEdit`), from its `PostToolUse` payload.
pub fn payload_file(payload: &serde_json::Value) -> Option<String> {
    let input = payload.get("tool_input")?;
    let path = input.get("file_path").or_else(|| input.get("notebook_path"))?.as_str()?;
    Some(path.to_string())
}

/// Relative paths are taken against `cwd`, so the daemon only stores absolute ones.
fn absolute(path: &str, cwd: &Path) -> String {
    let p = Path::new(path);
    if p.is_absolute() { path.to_string() } else { cwd.join(p).to_string_lossy().into_owned() }
}

pub fn run(args: &[String]) {
    let mut a = parse(args);
    let Some(id) = a.session.take() else { return };
    let mut cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    if a.stdin {
        let mut buf = String::new();
        let read = std::io::stdin().take(MAX_STDIN).read_to_string(&mut buf);
        if read.is_ok()
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&buf)
        {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = PathBuf::from(c);
            }
            a.files.extend(payload_file(&v));
        }
    }
    let Some(event) = a.event else { return };
    let files = a.files.iter().map(|f| absolute(f, &cwd)).collect();
    let endpoint = std::env::var(session::ENV_ENDPOINT)
        .ok()
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| session::endpoint(&session::data_dir()));
    if let Ok(client) = Client::connect_with_timeout(&endpoint, Duration::from_secs(2), |_| {}) {
        let _ = client.notify_files(&id, event, files);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_and_codex_payload() {
        let a = parse(&args(&["--session", "s1", "--event", "stop"]));
        assert_eq!((a.session.as_deref(), a.event), (Some("s1"), Some(AgentEvent::Done)));
        let codex = r#"{"type":"agent-turn-complete","turn-id":"1"}"#;
        assert_eq!(parse(&args(&["--session", "s1", codex])).event, Some(AgentEvent::Done));
        assert_eq!(parse(&args(&["--session", "s1", "--event", "bogus"])).event, None);
        let a = parse(&args(&[
            "--session",
            "s",
            "--event",
            "running",
            "--file",
            "a.rs",
            "--file",
            "/b.rs",
            "--stdin",
        ]));
        assert_eq!(a.files, ["a.rs", "/b.rs"]);
        assert!(a.stdin);
    }

    #[test]
    fn files_from_claude_payloads() {
        let edit = serde_json::json!({ "tool_name": "Edit", "tool_input": { "file_path": "/w/src/a.rs" } });
        assert_eq!(payload_file(&edit).as_deref(), Some("/w/src/a.rs"));
        let nb = serde_json::json!({ "tool_input": { "notebook_path": "/w/n.ipynb" } });
        assert_eq!(payload_file(&nb).as_deref(), Some("/w/n.ipynb"));
        let bash = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } });
        assert_eq!(payload_file(&bash), None);
        assert_eq!(absolute("src/a.rs", Path::new("/w")), Path::new("/w").join("src/a.rs").to_string_lossy());
        assert_eq!(absolute("/x/a.rs", Path::new("/w")), "/x/a.rs");
    }
}
