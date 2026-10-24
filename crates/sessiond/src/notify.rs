//! `aurora-sessiond notify`: what agent hooks call to report status.
//!
//! Always exits 0 and prints nothing: a hook failing must never disturb the
//! agent. Outside an Aurora session (no `AURORA_SESSION_ID`) it is a no-op.

use std::time::Duration;

use aurora_core::session::{self, AgentEvent, Client};

/// `notify [--session ID] [--event EVENT] [PAYLOAD...]`. Without `--event`,
/// a trailing JSON payload with a `type` field (Codex) names the event.
pub fn parse(args: &[String]) -> (Option<String>, Option<AgentEvent>) {
    let mut session = None;
    let mut event = None;
    let mut rest = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--session" => session = it.next().cloned(),
            "--event" => event = it.next().and_then(|e| AgentEvent::parse(e)),
            _ => rest.push(a),
        }
    }
    if event.is_none()
        && let Some(last) = rest.last()
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(last)
    {
        event = v.get("type").and_then(|t| t.as_str()).and_then(AgentEvent::parse);
    }
    let session = session.or_else(|| std::env::var(session::ENV_SESSION).ok()).filter(|s| !s.is_empty());
    (session, event)
}

pub fn run(args: &[String]) {
    let (Some(id), Some(event)) = parse(args) else { return };
    let endpoint = std::env::var(session::ENV_ENDPOINT)
        .ok()
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| session::endpoint(&session::data_dir()));
    if let Ok(client) = Client::connect_with_timeout(&endpoint, Duration::from_secs(2), |_| {}) {
        let _ = client.notify(&id, event);
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
        assert_eq!(
            parse(&args(&["--session", "s1", "--event", "stop"])),
            (Some("s1".into()), Some(AgentEvent::Done))
        );
        let codex = r#"{"type":"agent-turn-complete","turn-id":"1"}"#;
        assert_eq!(parse(&args(&["--session", "s1", codex])).1, Some(AgentEvent::Done));
        assert_eq!(parse(&args(&["--session", "s1", "--event", "bogus"])).1, None);
    }
}
