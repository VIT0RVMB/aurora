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
    /// Rows saved when Codex got `-c notify=[...]`. Any `-c` drops Codex out
    /// of its shared background server (with a warning), so Codex now runs
    /// unwired; the variant stays so old rows still load.
    Codex,
    /// opencode: a plugin in a config folder of ours (`OPENCODE_CONFIG_DIR`),
    /// fed by its event bus (busy, idle, permission asked).
    Opencode,
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
        "opencode" => ("opencode".to_string(), vec![], Hooks::Opencode),
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
        // opencode is wired through its environment (`OPENCODE_CONFIG_DIR`).
        Hooks::None | Hooks::Codex | Hooks::Opencode => {}
        Hooks::Claude => {
            argv.push("--settings".into());
            argv.push(claude_settings(notify_exe));
        }
    }
    argv.extend(args.iter().cloned());
    argv
}

/// Inline settings JSON. Claude merges hooks from `--settings` with the
/// user's own, so nothing in the worktree or in `~/.claude` changes.
/// Status is best effort: a hook that can't reach Aurora stays silent and
/// never shows up as an error inside the agent.
pub fn claude_settings(notify_exe: &Path) -> String {
    let line = |event: &str| {
        format!(
            "{} notify --event {event} >/dev/null 2>&1 || true",
            shell_quote(&notify_exe.to_string_lossy())
        )
    };
    let cmd = |event: &str| serde_json::json!([{ "hooks": [{ "type": "command", "command": line(event) }] }]);
    let matching = |matcher: &str, event: &str| serde_json::json!([{ "matcher": matcher, "hooks": [{ "type": "command", "command": line(event) }] }]);
    serde_json::json!({
        "hooks": {
            "UserPromptSubmit": cmd("running"),
            // The payload names the file a writing tool touched (the tree marks).
            "PostToolUse": matching("*", "running --stdin"),
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

/// Env var opencode reads for an extra config folder, merged over the
/// user's own; its `plugins/` load like `.opencode/plugins/`.
pub const OPENCODE_CONFIG_DIR: &str = "OPENCODE_CONFIG_DIR";

/// The opencode plugin that reports status. A turn can run subagents in
/// child sessions, so it is done only when no session of the process is
/// busy. Notify failures are swallowed like the other agents' hooks.
pub fn opencode_plugin(notify_exe: &Path) -> String {
    let exe = serde_json::to_string(&notify_exe.to_string_lossy()).expect("string serializes");
    format!(
        r#"// Written by Aurora; rewritten whenever its daemon starts a session.
const EXE = {exe};

export const AuroraStatus = async ({{ $ }}) => {{
  const busy = new Set();
  const notify = (event) => $`${{EXE}} notify --event ${{event}}`.quiet().nothrow();
  return {{
    event: async ({{ event }}) => {{
      const p = event.properties ?? {{}};
      switch (event.type) {{
        case "session.status":
          if (p.status?.type === "busy") {{
            const was = busy.size;
            busy.add(p.sessionID);
            if (was === 0) await notify("running");
          }}
          break;
        case "session.idle":
          busy.delete(p.sessionID);
          if (busy.size === 0) await notify("done");
          break;
        case "permission.asked":
        case "permission.updated":
        case "question.asked":
          await notify("waiting");
          break;
        case "file.edited":
          if (p.file) await $`${{EXE}} notify --event running --file ${{p.file}}`.quiet().nothrow();
          break;
        case "permission.replied":
        case "question.replied":
          await notify("running");
          break;
      }}
    }},
  }};
}};
"#
    )
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
        assert_eq!(stop, "'/opt/My App/sessiond' notify --event done >/dev/null 2>&1 || true");
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "*");
        assert!(v["hooks"]["PostToolUse"][0]["hooks"][0]["command"].as_str().unwrap().contains("--stdin"));
        assert_eq!(v["hooks"]["Notification"][0]["matcher"], "permission_prompt|elicitation_dialog");
    }

    #[test]
    fn opencode_plugin_embeds_a_js_string() {
        assert_eq!(resolve("opencode", &[]).hooks, Hooks::Opencode);
        assert_eq!(command_line("opencode", &[], Hooks::Opencode, Path::new("/x")), ["opencode"]);
        let js = opencode_plugin(Path::new(r#"C:\a"b\sessiond.exe"#));
        assert!(js.contains(r#"const EXE = "C:\\a\"b\\sessiond.exe";"#), "{js}");
        assert!(js.contains("${EXE} notify --event ${event}"));
    }

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("/usr/bin/x"), "/usr/bin/x");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
