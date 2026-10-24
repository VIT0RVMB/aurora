//! Which CLIs the app knows how to run, and how each one reports status.
//!
//! Status comes from the agent's own hooks calling `aurora-sessiond notify`,
//! never from parsing terminal output. Agents without hooks fall back to the
//! process state (running until it exits).

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Hooks {
    None,
    /// Claude Code: `--settings` with hooks for prompt submit and tool use
    /// (running), questions and permission requests (waiting) and `Stop` (done).
    Claude,
    /// Codex: `-c notify=[...]`, called on `agent-turn-complete` only.
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub hooks: Hooks,
}

/// Agents offered in completion. Anything else runs as a plain command.
pub const KNOWN: &[&str] = &["claude", "codex", "opencode", "gemini", "shell"];

/// `extra` is passed to the CLI after the hook wiring.
pub fn resolve(agent: &str, extra: &[String]) -> Launch {
    let (program, mut args, hooks) = match agent {
        "claude" => ("claude".to_string(), vec![], Hooks::Claude),
        "codex" => ("codex".to_string(), vec![], Hooks::Codex),
        "shell" => (default_shell(), shell_args(), Hooks::None),
        other => (other.to_string(), vec![], Hooks::None),
    };
    args.extend(extra.iter().cloned());
    Launch { program, args, hooks }
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    }
}

fn shell_args() -> Vec<String> {
    if cfg!(windows) { vec!["-NoLogo".into()] } else { vec!["-l".into()] }
}

/// Final argv: program, hook wiring for this agent, then the user's args.
pub fn command_line(program: &str, args: &[String], hooks: Hooks, notify_exe: &Path) -> Vec<String> {
    let mut argv = vec![program.to_string()];
    match hooks {
        Hooks::None => {}
        Hooks::Claude => {
            argv.push("--settings".into());
            argv.push(claude_settings(notify_exe));
        }
        Hooks::Codex => {
            argv.push("-c".into());
            argv.push(codex_notify(notify_exe));
        }
    }
    argv.extend(args.iter().cloned());
    argv
}

/// Inline settings JSON. Claude merges hooks from `--settings` with the
/// user's own, so nothing in the worktree or in `~/.claude` changes.
pub fn claude_settings(notify_exe: &Path) -> String {
    let cmd = |event: &str| serde_json::json!([{ "hooks": [{ "type": "command", "command": format!("{} notify --event {event}", shell_quote(&notify_exe.to_string_lossy())) }] }]);
    let matching = |matcher: &str, event: &str| serde_json::json!([{ "matcher": matcher, "hooks": [{ "type": "command", "command": format!("{} notify --event {event}", shell_quote(&notify_exe.to_string_lossy())) }] }]);
    serde_json::json!({
        "hooks": {
            "UserPromptSubmit": cmd("running"),
            "PostToolUse": matching("*", "running"),
            // The agent asks you something, or wants a permission.
            "PreToolUse": matching("AskUserQuestion", "waiting"),
            "PermissionRequest": cmd("waiting"),
            // Only real questions; `idle_prompt` (60 s after a turn) would
            // turn every finished session into "waiting".
            "Notification": matching("permission_prompt|elicitation_dialog", "waiting"),
            "Stop": cmd("done"),
        }
    })
    .to_string()
}

/// `notify=[...]` as a TOML array; Codex appends its JSON payload as the last argument.
pub fn codex_notify(notify_exe: &Path) -> String {
    let items = [notify_exe.to_string_lossy().into_owned(), "notify".into(), "--event".into(), "done".into()];
    let list: Vec<String> = items.iter().map(|s| toml_string(s)).collect();
    format!("notify=[{}]", list.join(","))
}

fn toml_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Quotes a path for the shell that runs hook commands (sh on Unix, Git Bash
/// on Windows, which accepts the same single quotes).
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+:@".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_known_and_unknown() {
        let l = resolve("claude", &["--model".into(), "opus".into()]);
        assert_eq!((l.program.as_str(), l.hooks), ("claude", Hooks::Claude));
        assert_eq!(l.args, ["--model", "opus"]);
        assert_eq!(resolve("aider", &[]).hooks, Hooks::None);
        assert_eq!(resolve("aider", &[]).program, "aider");
    }

    #[test]
    fn claude_gets_inline_hooks() {
        let argv = command_line("claude", &["-c".into()], Hooks::Claude, Path::new("/opt/My App/sessiond"));
        assert_eq!(argv[1], "--settings");
        assert_eq!(argv[3], "-c");
        let v: serde_json::Value = serde_json::from_str(&argv[2]).unwrap();
        let stop = v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(stop, "'/opt/My App/sessiond' notify --event done");
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "*");
        assert_eq!(v["hooks"]["Notification"][0]["matcher"], "permission_prompt|elicitation_dialog");
    }

    #[test]
    fn codex_notify_is_valid_toml_array() {
        let s = codex_notify(Path::new(r#"C:\Program Files\a"b\sessiond.exe"#));
        assert_eq!(s, r#"notify=["C:\\Program Files\\a\"b\\sessiond.exe","notify","--event","done"]"#);
    }

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("/usr/bin/x"), "/usr/bin/x");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
