//! The daemon: owns every PTY, keeps their history, and serves clients over
//! the local socket. One thread per connection, one reader and one waiter
//! thread per session; sessions are few, so threads stay simple.

use std::{
    collections::HashMap,
    ffi::OsString,
    fs::File,
    io::{self, Read, Write},
    path::PathBuf,
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use aurora_core::session::{
    self, AgentEvent, CreateSpec, SessionInfo, Status, agents,
    agents::Hooks,
    proto::{ClientMsg, Frame, Hello, PROTOCOL_VERSION, Request, ServerMsg, read_frame},
    transport::{self, Listener, Stream},
};
use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::{db::Db, ring::Ring, title::TitleScanner};

/// Raw output kept per session for reattach.
const HISTORY_BYTES: usize = 2 << 20;
/// Frames queued for a client before it counts as stuck and is dropped.
const CLIENT_QUEUE: usize = 4096;

pub struct Config {
    pub data_dir: PathBuf,
    /// This binary: hooks call `<helper> notify`, env comes from `<helper> dump-env`.
    pub helper_exe: PathBuf,
    /// Exit after this long with no clients and no live sessions.
    pub idle_exit: Option<Duration>,
    /// Spawn agents with the login shell's env (off in tests).
    pub shell_env: bool,
}

#[derive(Debug)]
pub enum ServeError {
    /// Another daemon holds the lock for this data folder.
    AlreadyRunning,
    Io(io::Error),
    Db(rusqlite::Error),
}

impl From<io::Error> for ServeError {
    fn from(e: io::Error) -> Self {
        ServeError::Io(e)
    }
}

impl From<rusqlite::Error> for ServeError {
    fn from(e: rusqlite::Error) -> Self {
        ServeError::Db(e)
    }
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeError::AlreadyRunning => write!(f, "another sessiond is running for this data dir"),
            ServeError::Io(e) => write!(f, "{e}"),
            ServeError::Db(e) => write!(f, "database: {e}"),
        }
    }
}

struct Conn {
    stream: Arc<Stream>,
    tx: SyncSender<Arc<Vec<u8>>>,
    closed: AtomicBool,
}

impl Conn {
    /// Queues a frame. A client that stops reading is cut off instead of
    /// blocking every session's output.
    fn send(&self, frame: Arc<Vec<u8>>) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        match self.tx.try_send(frame) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.close();
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    fn send_msg(&self, msg: &ServerMsg) -> bool {
        self.send(Arc::new(Frame::json(msg).encode()))
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        transport::shutdown(&self.stream);
    }
}

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

struct Output {
    ring: Ring,
    /// Dead sessions load their history file on first attach.
    loaded: bool,
    /// New output since the history file was last written.
    unsaved: bool,
    subs: Vec<Weak<Conn>>,
}

struct Session {
    info: Mutex<SessionInfo>,
    hooks: Hooks,
    pty: Mutex<Option<Pty>>,
    out: Mutex<Output>,
    killed: AtomicBool,
    removed: AtomicBool,
}

impl Session {
    fn snapshot(&self) -> SessionInfo {
        self.info.lock().clone()
    }

    fn id(&self) -> String {
        self.info.lock().id.clone()
    }
}

struct Server {
    cfg: Config,
    endpoint: String,
    db: Mutex<Db>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    next_conn: AtomicU64,
    shell_env: OnceLock<Option<Vec<(String, String)>>>,
    stopping: AtomicBool,
    last_active: Mutex<Instant>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Runs the daemon until `Shutdown` or idle exit. Returns `AlreadyRunning`
/// immediately when another daemon owns `data_dir`.
pub fn serve(cfg: Config) -> Result<(), ServeError> {
    std::fs::create_dir_all(cfg.data_dir.join("history"))?;
    let lock = File::create(cfg.data_dir.join("sessiond.lock"))?;
    if lock.try_lock().is_err() {
        return Err(ServeError::AlreadyRunning);
    }
    let endpoint = session::endpoint(&cfg.data_dir);
    let listener = Listener::bind(&endpoint)?;
    let db = Db::open(&cfg.data_dir.join("sessions.db"))?;

    // Sessions from a previous daemon are history now: their PTYs died with it.
    let mut sessions = HashMap::new();
    for row in db.load()? {
        let mut info = row.info;
        if info.alive {
            info.alive = false;
            if matches!(info.status, Status::Running | Status::Waiting) {
                info.status = Status::Done;
            }
            info.updated_ms = now_ms();
            db.save(&info, row.hooks)?;
        }
        let id = info.id.clone();
        sessions.insert(
            id,
            Arc::new(Session {
                info: Mutex::new(info),
                hooks: row.hooks,
                pty: Mutex::new(None),
                out: Mutex::new(Output {
                    ring: Ring::new(HISTORY_BYTES),
                    loaded: false,
                    unsaved: false,
                    subs: vec![],
                }),
                killed: AtomicBool::new(false),
                removed: AtomicBool::new(false),
            }),
        );
    }

    let server = Arc::new(Server {
        cfg,
        endpoint,
        db: Mutex::new(db),
        sessions: Mutex::new(sessions),
        conns: Mutex::default(),
        next_conn: AtomicU64::new(1),
        shell_env: OnceLock::new(),
        stopping: AtomicBool::new(false),
        last_active: Mutex::new(Instant::now()),
    });
    eprintln!("sessiond {} listening on {}", std::process::id(), server.endpoint);

    if server.cfg.shell_env {
        // Warm the env cache so the first session starts fast.
        let s = server.clone();
        std::thread::spawn(move || {
            s.shell_env();
        });
    }
    {
        let s = Arc::downgrade(&server);
        std::thread::spawn(move || history_flush(s));
    }
    if let Some(idle) = server.cfg.idle_exit {
        let s = Arc::downgrade(&server);
        std::thread::spawn(move || idle_watch(s, idle));
    }

    loop {
        let stream = listener.accept();
        if server.stopping.load(Ordering::Acquire) {
            break;
        }
        match stream {
            Ok(stream) => {
                let s = server.clone();
                std::thread::spawn(move || s.handle(stream));
            }
            Err(e) => eprintln!("accept: {e}"),
        }
    }

    // History first: the sessions die with this process.
    server.save_histories();
    for s in server.sessions.lock().values() {
        server.kill(s);
    }
    #[cfg(unix)]
    let _ = std::fs::remove_file(&server.endpoint);
    drop(lock);
    Ok(())
}

/// Writes live sessions' history now and then, so a crash or reboot loses
/// at most this much output.
const HISTORY_FLUSH: Duration = Duration::from_secs(20);

fn history_flush(server: Weak<Server>) {
    loop {
        std::thread::sleep(HISTORY_FLUSH);
        let Some(s) = server.upgrade() else { return };
        if s.stopping.load(Ordering::Acquire) {
            return;
        }
        s.save_histories();
    }
}

fn idle_watch(server: Weak<Server>, idle: Duration) {
    loop {
        std::thread::sleep(Duration::from_secs(15).min(idle));
        let Some(s) = server.upgrade() else { return };
        let busy = !s.conns.lock().is_empty() || s.sessions.lock().values().any(|x| x.info.lock().alive);
        if busy {
            *s.last_active.lock() = Instant::now();
        } else if s.last_active.lock().elapsed() >= idle {
            eprintln!("sessiond idle for {idle:?}, exiting");
            s.stop();
            return;
        }
    }
}

impl Server {
    fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        // Wake the accept loop.
        let _ = transport::connect(&self.endpoint);
    }

    fn shell_env(&self) -> Option<Vec<(String, String)>> {
        self.shell_env.get_or_init(|| session::shell_env(&self.cfg.helper_exe)).clone()
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions.lock().get(id).cloned().ok_or_else(|| format!("session not found: {id}"))
    }

    fn broadcast(&self, msg: &ServerMsg) {
        let frame = Arc::new(Frame::json(msg).encode());
        for c in self.conns.lock().values() {
            c.send(frame.clone());
        }
    }

    /// Persists and announces the session's current info.
    fn publish(&self, s: &Session) {
        let info = s.snapshot();
        if s.removed.load(Ordering::Acquire) {
            return;
        }
        if let Err(e) = self.db.lock().save(&info, s.hooks) {
            eprintln!("db save {}: {e}", info.id);
        }
        self.broadcast(&ServerMsg::Updated { session: info });
    }

    fn history_path(&self, id: &str) -> PathBuf {
        self.cfg.data_dir.join("history").join(format!("{id}.log"))
    }

    fn handle(self: Arc<Self>, stream: Stream) {
        let stream = Arc::new(stream);
        let (tx, rx) = mpsc::sync_channel::<Arc<Vec<u8>>>(CLIENT_QUEUE);
        let conn = Arc::new(Conn { stream: stream.clone(), tx, closed: AtomicBool::new(false) });
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().insert(id, conn.clone());

        let writer = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                let mut w = &*stream;
                for frame in rx {
                    if w.write_all(&frame).is_err() {
                        break;
                    }
                }
                transport::shutdown(&stream);
            })
        };

        let mut r = &*stream;
        while let Ok(Some(frame)) = read_frame(&mut r) {
            match frame {
                Frame::Data { session, bytes } => self.input(&session, &bytes),
                Frame::Json(body) => {
                    let Ok(msg) = serde_json::from_slice::<ClientMsg>(&body) else { continue };
                    let stop = matches!(msg.req, Request::Shutdown);
                    let result = self.request(&conn, msg.req);
                    let (ok, error) = match result {
                        Ok(v) => (Some(v), None),
                        Err(e) => (None, Some(e)),
                    };
                    conn.send_msg(&ServerMsg::Reply { id: msg.id, ok, error });
                    if stop {
                        self.stop();
                    }
                }
            }
        }

        self.conns.lock().remove(&id);
        conn.close();
        drop(conn);
        let _ = writer.join();
    }

    fn request(self: &Arc<Self>, conn: &Arc<Conn>, req: Request) -> Result<serde_json::Value, String> {
        let json = |v: serde_json::Value| Ok(v);
        match req {
            Request::Hello { .. } => json(
                serde_json::to_value(Hello { version: PROTOCOL_VERSION, pid: std::process::id() }).unwrap(),
            ),
            Request::List => {
                let mut list: Vec<SessionInfo> =
                    self.sessions.lock().values().map(|s| s.snapshot()).collect();
                list.sort_by_key(|s| s.created_ms);
                json(serde_json::to_value(list).unwrap())
            }
            Request::Create { spec } => {
                let info = self.create(spec)?;
                json(serde_json::to_value(info).unwrap())
            }
            Request::Attach { session } => {
                self.attach(conn, &session)?;
                json(serde_json::Value::Null)
            }
            Request::Detach { session } => {
                let s = self.get(&session)?;
                s.out.lock().subs.retain(|w| w.upgrade().is_some_and(|c| !Arc::ptr_eq(&c, conn)));
                json(serde_json::Value::Null)
            }
            Request::Resize { session, cols, rows } => {
                let s = self.get(&session)?;
                if let Some(pty) = s.pty.lock().as_ref() {
                    pty.master.resize(size(cols, rows)).map_err(|e| e.to_string())?;
                }
                json(serde_json::Value::Null)
            }
            Request::Kill { session } => {
                let s = self.get(&session)?;
                self.kill(&s);
                json(serde_json::Value::Null)
            }
            Request::Rename { session, name } => {
                let name = name.trim();
                if name.is_empty() {
                    return Err("nome vazio".into());
                }
                let s = self.get(&session)?;
                {
                    let mut info = s.info.lock();
                    info.name = name.to_string();
                    info.renamed = true;
                    info.updated_ms = now_ms();
                }
                self.publish(&s);
                json(serde_json::to_value(s.snapshot()).unwrap())
            }
            Request::Remove { session } => {
                let s = self.get(&session)?;
                s.removed.store(true, Ordering::Release);
                self.kill(&s);
                self.sessions.lock().remove(&session);
                if let Err(e) = self.db.lock().delete(&session) {
                    eprintln!("db delete {session}: {e}");
                }
                let _ = std::fs::remove_file(self.history_path(&session));
                self.broadcast(&ServerMsg::Removed { session });
                json(serde_json::Value::Null)
            }
            Request::Notify { session, event } => {
                let s = self.get(&session)?;
                self.set_status(&s, event);
                json(serde_json::Value::Null)
            }
            Request::Shutdown => json(serde_json::Value::Null),
        }
    }

    fn set_status(&self, s: &Session, event: AgentEvent) {
        let status = match event {
            AgentEvent::Running => Status::Running,
            AgentEvent::Waiting => Status::Waiting,
            AgentEvent::Done => Status::Done,
        };
        {
            let mut info = s.info.lock();
            if !info.alive || info.status == status {
                return;
            }
            info.status = status;
            info.updated_ms = now_ms();
        }
        self.publish(s);
    }

    /// Publishes only real changes: agents redraw the same title with a
    /// new spinner glyph many times a second.
    fn set_title(&self, s: &Session, title: String) {
        {
            let mut info = s.info.lock();
            if info.title.as_deref() == Some(title.as_str()) {
                return;
            }
            info.title = Some(title);
            info.updated_ms = now_ms();
        }
        self.publish(s);
    }

    fn input(&self, id: &str, bytes: &[u8]) {
        let Ok(s) = self.get(id) else { return };
        if let Some(pty) = s.pty.lock().as_mut() {
            let _ = pty.writer.write_all(bytes);
            let _ = pty.writer.flush();
        }
        // Codex only reports turn ends; Enter is the best sign a new turn began.
        if s.hooks == Hooks::Codex && bytes.contains(&b'\r') {
            self.set_status(&s, AgentEvent::Running);
        }
    }

    fn attach(&self, conn: &Arc<Conn>, id: &str) -> Result<(), String> {
        let s = self.get(id)?;
        let alive = s.info.lock().alive;
        let mut out = s.out.lock();
        if !alive && !out.loaded && out.ring.is_empty() {
            if let Ok(bytes) = std::fs::read(self.history_path(id)) {
                out.ring.push(&bytes);
            }
            out.loaded = true;
        }
        if !out.ring.is_empty() {
            let frame = Frame::Data { session: id.to_string(), bytes: out.ring.snapshot() };
            conn.send(Arc::new(frame.encode()));
        }
        out.subs.retain(|w| w.upgrade().is_some_and(|c| !Arc::ptr_eq(&c, conn)));
        out.subs.push(Arc::downgrade(conn));
        Ok(())
    }

    fn create(self: &Arc<Self>, spec: CreateSpec) -> Result<SessionInfo, String> {
        let id = loop {
            let id = session::new_id();
            if !self.sessions.lock().contains_key(&id) {
                break id;
            }
        };
        let argv = agents::command_line(&spec.program, &spec.args, spec.hooks, &self.cfg.helper_exe);

        let pair = native_pty_system().openpty(size(spec.cols, spec.rows)).map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::from_argv(argv.iter().map(OsString::from).collect());
        cmd.cwd(&spec.cwd);
        if self.cfg.shell_env
            && let Some(env) = self.shell_env()
        {
            cmd.env_clear();
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        cmd.env_remove("AURORA_RESOLVING_ENV");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "aurora");
        cmd.env(session::ENV_SESSION, &id);
        cmd.env(session::ENV_ENDPOINT, &self.endpoint);

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("{}: {e}", spec.program))?;
        // Our copy of the slave must close, or the reader never sees EOF.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let pid = child.process_id();
        let killer = child.clone_killer();

        let now = now_ms();
        let info = SessionInfo {
            id: id.clone(),
            name: spec.name,
            agent: spec.agent,
            cwd: spec.cwd,
            workspace: spec.workspace,
            branch: spec.branch,
            worktree: spec.worktree,
            status: Status::Running,
            alive: true,
            exit_code: None,
            created_ms: now,
            updated_ms: now,
            title: None,
            renamed: false,
        };
        let s = Arc::new(Session {
            info: Mutex::new(info.clone()),
            hooks: spec.hooks,
            pty: Mutex::new(Some(Pty { master: pair.master, writer, killer, pid })),
            out: Mutex::new(Output {
                ring: Ring::new(HISTORY_BYTES),
                loaded: true,
                unsaved: false,
                subs: vec![],
            }),
            killed: AtomicBool::new(false),
            removed: AtomicBool::new(false),
        });
        self.sessions.lock().insert(id.clone(), s.clone());
        self.publish(&s);

        let (done_tx, done_rx) = mpsc::channel::<()>();
        {
            let s = s.clone();
            let server = Arc::downgrade(self);
            std::thread::Builder::new()
                .name(format!("pty-read-{id}"))
                .spawn(move || pump(reader, &s, &server, done_tx))
                .map_err(|e| e.to_string())?;
        }
        {
            let s = Arc::downgrade(&s);
            let server = Arc::downgrade(self);
            std::thread::Builder::new()
                .name(format!("pty-wait-{id}"))
                .spawn(move || {
                    let status = child.wait();
                    // Let the reader drain the last output; a grandchild that
                    // keeps the tty open must not hold the exit forever.
                    let _ = done_rx.recv_timeout(Duration::from_millis(500));
                    if let (Some(server), Some(s)) = (server.upgrade(), s.upgrade()) {
                        server.finish(&s, status);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(info)
    }

    fn kill(&self, s: &Arc<Session>) {
        let guard = s.pty.lock();
        let Some(pty) = guard.as_ref() else { return };
        s.killed.store(true, Ordering::Release);
        hang_up(pty);
        let pid = pty.pid;
        drop(guard);
        // Escalate if the agent ignores the hangup.
        let weak = Arc::downgrade(s);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let Some(s) = weak.upgrade() else { return };
            if s.info.lock().alive {
                force_kill(pid, &s);
            }
        });
    }

    fn finish(&self, s: &Session, status: io::Result<portable_pty::ExitStatus>) {
        {
            let mut info = s.info.lock();
            info.alive = false;
            let (code, ok) = match &status {
                Ok(st) => (Some(st.exit_code() as i32), st.success()),
                Err(_) => (None, false),
            };
            info.exit_code = code;
            info.status = if ok || s.killed.load(Ordering::Acquire) { Status::Done } else { Status::Error };
            info.updated_ms = now_ms();
        }
        // Dropping the master closes the PTY.
        s.pty.lock().take();
        self.save_history(s);
        self.publish(s);
    }

    fn save_history(&self, s: &Session) {
        if s.removed.load(Ordering::Acquire) {
            return;
        }
        let id = s.id();
        let history = {
            let mut out = s.out.lock();
            if !out.unsaved {
                return;
            }
            out.unsaved = false;
            out.ring.snapshot()
        };
        if let Err(e) = std::fs::write(self.history_path(&id), history) {
            eprintln!("history {id}: {e}");
        }
    }

    fn save_histories(&self) {
        let list: Vec<Arc<Session>> = self.sessions.lock().values().cloned().collect();
        for s in list {
            self.save_history(&s);
        }
    }
}

/// SIGHUP to the child's process group (it leads its own session), like a
/// terminal closing. Windows has no hangup: terminate.
fn hang_up(pty: &Pty) {
    #[cfg(unix)]
    if let Some(pid) = pty.pid {
        unsafe { libc::kill(-(pid as i32), libc::SIGHUP) };
        return;
    }
    let _ = pty.killer.clone_killer().kill();
}

fn force_kill(_pid: Option<u32>, s: &Session) {
    #[cfg(unix)]
    if let Some(pid) = _pid {
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        return;
    }
    if let Some(pty) = s.pty.lock().as_ref() {
        let _ = pty.killer.clone_killer().kill();
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }
}

fn pump(mut reader: Box<dyn Read + Send>, s: &Session, server: &Weak<Server>, done: mpsc::Sender<()>) {
    let id = s.id();
    let mut buf = vec![0u8; 64 * 1024];
    let mut titles = TitleScanner::default();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if let Some(title) = titles.feed(&buf[..n])
            && let Some(server) = server.upgrade()
        {
            server.set_title(s, title);
        }
        let mut out = s.out.lock();
        out.ring.push(&buf[..n]);
        out.unsaved = true;
        let frame = Arc::new(Frame::Data { session: id.clone(), bytes: buf[..n].to_vec() }.encode());
        out.subs.retain(|w| match w.upgrade() {
            Some(c) => c.send(frame.clone()),
            None => false,
        });
    }
    let _ = done.send(());
}
