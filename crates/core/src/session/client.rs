//! Blocking client for `sessiond`. One reader thread routes replies to their
//! callers, terminal output to the attached sinks and the rest to `on_event`.

use std::{
    collections::HashMap,
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

use parking_lot::Mutex;
use serde::de::DeserializeOwned;

use super::proto::{
    AgentEvent, ClientMsg, CreateSpec, Frame, Hello, PROTOCOL_VERSION, Request, ServerMsg, SessionInfo,
    read_frame,
};
use super::transport::{self, Stream};
use crate::{Error, Result};

const CALL_TIMEOUT: Duration = Duration::from_secs(10);

pub enum ClientEvent {
    Updated(SessionInfo),
    Removed(String),
    /// The daemon went away; every call fails from now on.
    Disconnected,
}

pub type OutputSink = Box<dyn FnMut(&[u8]) + Send>;
type Pending = Mutex<HashMap<u64, mpsc::Sender<std::result::Result<serde_json::Value, String>>>>;

pub struct Client {
    stream: Arc<Stream>,
    timeout: Duration,
    write_lock: Mutex<()>,
    pending: Arc<Pending>,
    sinks: Arc<Mutex<HashMap<String, OutputSink>>>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    pub daemon_pid: u32,
}

impl Client {
    /// Connects and checks the protocol version.
    pub fn connect(endpoint: &str, on_event: impl Fn(ClientEvent) + Send + 'static) -> Result<Arc<Client>> {
        Self::connect_with_timeout(endpoint, CALL_TIMEOUT, on_event)
    }

    /// `timeout` bounds every call; hooks use a short one so a stuck daemon
    /// never stalls the agent.
    pub fn connect_with_timeout(
        endpoint: &str,
        timeout: Duration,
        on_event: impl Fn(ClientEvent) + Send + 'static,
    ) -> Result<Arc<Client>> {
        let stream = transport::connect(endpoint).map_err(|e| Error::Daemon(e.to_string()))?;
        let stream = Arc::new(stream);
        let pending: Arc<Pending> = Arc::default();
        let sinks: Arc<Mutex<HashMap<String, OutputSink>>> = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));

        {
            let (stream, pending, sinks, alive) =
                (stream.clone(), pending.clone(), sinks.clone(), alive.clone());
            std::thread::Builder::new()
                .name("sessiond-client".into())
                .spawn(move || {
                    let mut r = &*stream;
                    while let Ok(Some(frame)) = read_frame(&mut r) {
                        match frame {
                            Frame::Data { session, bytes } => {
                                if let Some(sink) = sinks.lock().get_mut(&session) {
                                    sink(&bytes);
                                }
                            }
                            Frame::Json(body) => match serde_json::from_slice::<ServerMsg>(&body) {
                                Ok(ServerMsg::Reply { id, ok, error }) => {
                                    if let Some(tx) = pending.lock().remove(&id) {
                                        let _ = tx.send(match error {
                                            Some(e) => Err(e),
                                            None => Ok(ok.unwrap_or(serde_json::Value::Null)),
                                        });
                                    }
                                }
                                Ok(ServerMsg::Updated { session }) => on_event(ClientEvent::Updated(session)),
                                Ok(ServerMsg::Removed { session }) => on_event(ClientEvent::Removed(session)),
                                Err(_) => {}
                            },
                        }
                    }
                    alive.store(false, Ordering::Release);
                    // Dropping the senders fails every call still waiting.
                    pending.lock().clear();
                    on_event(ClientEvent::Disconnected);
                })
                .map_err(Error::Io)?;
        }

        let mut client = Client {
            stream,
            timeout,
            write_lock: Mutex::new(()),
            pending,
            sinks,
            next_id: AtomicU64::new(1),
            alive,
            daemon_pid: 0,
        };
        let hello: Hello = client.call(Request::Hello { version: PROTOCOL_VERSION })?;
        if hello.version != PROTOCOL_VERSION {
            return Err(Error::Daemon(format!(
                "protocol version {} (expected {PROTOCOL_VERSION}); stop the old sessiond (pid {})",
                hello.version, hello.pid
            )));
        }
        client.daemon_pid = hello.pid;
        Ok(Arc::new(client))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn send(&self, frame: &Frame) -> Result<()> {
        let bytes = frame.encode();
        let _g = self.write_lock.lock();
        let mut w = &*self.stream;
        w.write_all(&bytes).and_then(|_| w.flush()).map_err(|e| Error::Daemon(e.to_string()))
    }

    fn call<T: DeserializeOwned>(&self, req: Request) -> Result<T> {
        if !self.is_alive() {
            return Err(Error::Daemon("connection closed".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        if let Err(e) = self.send(&Frame::json(&ClientMsg { id, req })) {
            self.pending.lock().remove(&id);
            return Err(e);
        }
        let value = match rx.recv_timeout(self.timeout) {
            Ok(Ok(v)) => v,
            Ok(Err(msg)) => return Err(Error::Session(msg)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&id);
                return Err(Error::Daemon("sem resposta".into()));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Error::Daemon("connection closed".into()));
            }
        };
        serde_json::from_value(value).map_err(|e| Error::Session(format!("invalid reply: {e}")))
    }

    pub fn list(&self) -> Result<Vec<SessionInfo>> {
        self.call(Request::List)
    }

    pub fn create(&self, spec: CreateSpec) -> Result<SessionInfo> {
        self.call(Request::Create { spec })
    }

    /// Streams the session's output into `sink`, starting with its scrollback.
    /// Re-attaching replaces the previous sink.
    pub fn attach(&self, session: &str, sink: OutputSink) -> Result<()> {
        // Registered first: the scrollback frame may arrive before the reply.
        self.sinks.lock().insert(session.to_string(), sink);
        let res = self.call::<()>(Request::Attach { session: session.to_string() });
        if res.is_err() {
            self.sinks.lock().remove(session);
        }
        res
    }

    pub fn detach(&self, session: &str) -> Result<()> {
        self.sinks.lock().remove(session);
        self.call(Request::Detach { session: session.to_string() })
    }

    pub fn input(&self, session: &str, bytes: &[u8]) -> Result<()> {
        self.send(&Frame::Data { session: session.to_string(), bytes: bytes.to_vec() })
    }

    pub fn resize(&self, session: &str, cols: u16, rows: u16) -> Result<()> {
        self.call(Request::Resize { session: session.to_string(), cols, rows })
    }

    pub fn kill(&self, session: &str) -> Result<()> {
        self.call(Request::Kill { session: session.to_string() })
    }

    pub fn rename(&self, session: &str, name: &str) -> Result<SessionInfo> {
        self.call(Request::Rename { session: session.to_string(), name: name.to_string() })
    }

    pub fn remove(&self, session: &str) -> Result<()> {
        self.sinks.lock().remove(session);
        self.call(Request::Remove { session: session.to_string() })
    }

    pub fn notify(&self, session: &str, event: AgentEvent) -> Result<()> {
        self.call(Request::Notify { session: session.to_string(), event })
    }

    pub fn shutdown(&self) -> Result<()> {
        self.call(Request::Shutdown)
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        // The reader thread holds the stream too; shutting it down is what
        // ends that thread and tells the daemon we left.
        transport::shutdown(&self.stream);
    }
}
