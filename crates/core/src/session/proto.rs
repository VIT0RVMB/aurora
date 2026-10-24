//! Wire protocol between `sessiond` and its clients (the app, `notify`).
//!
//! Every frame is `len: u32 LE` + `kind: u8` + body. Control messages are JSON
//! (`kind = 0`); terminal bytes travel raw (`kind = 1`) as
//! `id_len: u8` + session id + data, so output never pays for JSON escaping.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
const MAX_FRAME: usize = 16 << 20;
const KIND_JSON: u8 = 0;
const KIND_DATA: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Json(Vec<u8>),
    Data { session: String, bytes: Vec<u8> },
}

impl Frame {
    pub fn json<T: Serialize>(msg: &T) -> Frame {
        Frame::Json(serde_json::to_vec(msg).expect("protocol messages always serialize"))
    }

    /// The whole frame, ready for a single `write_all`.
    pub fn encode(&self) -> Vec<u8> {
        let (kind, body_len) = match self {
            Frame::Json(b) => (KIND_JSON, b.len()),
            Frame::Data { session, bytes } => (KIND_DATA, 1 + session.len() + bytes.len()),
        };
        let mut out = Vec::with_capacity(5 + body_len);
        out.extend_from_slice(&((body_len + 1) as u32).to_le_bytes());
        out.push(kind);
        match self {
            Frame::Json(b) => out.extend_from_slice(b),
            Frame::Data { session, bytes } => {
                out.push(session.len() as u8);
                out.extend_from_slice(session.as_bytes());
                out.extend_from_slice(bytes);
            }
        }
        out
    }
}

pub fn write_frame(w: &mut impl Write, frame: &Frame) -> io::Result<()> {
    w.write_all(&frame.encode())?;
    w.flush()
}

/// Reads one frame; `Ok(None)` on a clean end of stream.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("bad frame length {len}")));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let body = buf.split_off(1);
    match buf[0] {
        KIND_JSON => Ok(Some(Frame::Json(body))),
        KIND_DATA => {
            let id_len = *body.first().ok_or_else(|| bad("empty data frame"))? as usize;
            if body.len() < 1 + id_len {
                return Err(bad("short data frame"));
            }
            let session =
                String::from_utf8(body[1..1 + id_len].to_vec()).map_err(|_| bad("bad session id"))?;
            Ok(Some(Frame::Data { session, bytes: body[1 + id_len..].to_vec() }))
        }
        k => Err(bad(&format!("unknown frame kind {k}"))),
    }
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Working, or the process is alive and nothing said otherwise.
    Running,
    /// The agent asked for you (permission, question, idle prompt).
    Waiting,
    /// Turn finished, or the process exited cleanly.
    Done,
    /// The process exited with a failure or could not start.
    Error,
}

/// What an agent hook reports through `notify`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentEvent {
    Running,
    Waiting,
    Done,
}

impl AgentEvent {
    /// Accepts our names and the agents' own (`stop`, `notification`,
    /// Codex's `agent-turn-complete`).
    pub fn parse(s: &str) -> Option<AgentEvent> {
        match s.to_ascii_lowercase().replace('_', "-").as_str() {
            "running" | "start" | "user-prompt-submit" | "post-tool-use" => Some(AgentEvent::Running),
            "waiting" | "notification" | "permission" => Some(AgentEvent::Waiting),
            "done" | "stop" | "agent-turn-complete" => Some(AgentEvent::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub cwd: String,
    /// Workspace folder the session was created from; the UI groups by it.
    pub workspace: String,
    pub branch: Option<String>,
    /// Set when the session owns a worktree (created for it).
    pub worktree: Option<String>,
    pub status: Status,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub created_ms: u64,
    pub updated_ms: u64,
    /// Title the program gave its terminal (Claude Code: the topic).
    #[serde(default)]
    pub title: Option<String>,
    /// Set by an explicit rename: the name then wins over the title.
    #[serde(default)]
    pub renamed: bool,
}

/// Everything `sessiond` needs to start a session. Built by the core from the
/// agent registry; the daemon only adds hook wiring it alone can resolve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpec {
    pub name: String,
    pub agent: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub workspace: String,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub hooks: super::agents::Hooks,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Hello {
        version: u32,
    },
    List,
    Create {
        spec: CreateSpec,
    },
    /// Replays the scrollback, then streams output until `Detach`.
    Attach {
        session: String,
    },
    Detach {
        session: String,
    },
    Resize {
        session: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        session: String,
    },
    Rename {
        session: String,
        name: String,
    },
    /// Kills if alive, then forgets the session and its history.
    Remove {
        session: String,
    },
    Notify {
        session: String,
        event: AgentEvent,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientMsg {
    pub id: u64,
    #[serde(flatten)]
    pub req: Request,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Reply {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ok: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Updated {
        session: SessionInfo,
    },
    Removed {
        session: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub version: u32,
    pub pid: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_roundtrip() {
        let frames = [
            Frame::json(&ClientMsg { id: 7, req: Request::Kill { session: "ab12".into() } }),
            Frame::Data { session: "ab12".into(), bytes: b"\x1b[31mhi\r\n".to_vec() },
            Frame::Data { session: "x".into(), bytes: vec![] },
        ];
        let mut buf = Vec::new();
        for f in &frames {
            write_frame(&mut buf, f).unwrap();
        }
        let mut r = &buf[..];
        for f in &frames {
            assert_eq!(read_frame(&mut r).unwrap().as_ref(), Some(f));
        }
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn rejects_garbage() {
        let mut r: &[u8] = &[0, 0, 0, 0];
        assert!(read_frame(&mut r).is_err());
        let mut r: &[u8] = &[2, 0, 0, 0, 9, 0];
        assert!(read_frame(&mut r).is_err());
    }

    #[test]
    fn messages_are_tagged() {
        let msg = ClientMsg { id: 1, req: Request::Resize { session: "s".into(), cols: 80, rows: 24 } };
        let v = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["op"], "resize");
        assert_eq!(serde_json::from_value::<ClientMsg>(v).unwrap(), msg);
    }

    #[test]
    fn agent_events() {
        assert_eq!(AgentEvent::parse("Stop"), Some(AgentEvent::Done));
        assert_eq!(AgentEvent::parse("agent-turn-complete"), Some(AgentEvent::Done));
        assert_eq!(AgentEvent::parse("Notification"), Some(AgentEvent::Waiting));
        assert_eq!(AgentEvent::parse("user_prompt_submit"), Some(AgentEvent::Running));
        assert_eq!(AgentEvent::parse("nope"), None);
    }
}
