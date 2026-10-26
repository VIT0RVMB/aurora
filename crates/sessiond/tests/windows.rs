//! The daemon on Windows: named pipe, ConPTY, `notify` from a hook, reattach
//! with scrollback. `daemon.rs` covers the same ground with `/bin/sh` on Unix.
#![cfg(windows)]

use std::{
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread::JoinHandle,
    time::{Duration, Instant},
};

use aurora_core::session::{self, Client, ClientEvent, CreateSpec, SessionInfo, Status, agents::Hooks};
use aurora_sessiond::{Config, ServeError};
use parking_lot::Mutex;

const HELPER: &str = env!("CARGO_BIN_EXE_aurora-sessiond");

fn start(dir: &Path) -> JoinHandle<Result<(), ServeError>> {
    let cfg = Config {
        data_dir: dir.to_path_buf(),
        helper_exe: PathBuf::from(HELPER),
        idle_exit: None,
        shell_env: false,
    };
    std::thread::spawn(move || aurora_sessiond::serve(cfg))
}

struct Conn {
    client: Arc<Client>,
    events: mpsc::Receiver<SessionInfo>,
}

fn connect(dir: &Path) -> Conn {
    let ep = session::endpoint(dir);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (tx, rx) = mpsc::channel();
        let res = Client::connect(&ep, move |e| {
            if let ClientEvent::Updated(info) = e {
                let _ = tx.send(info);
            }
        });
        match res {
            Ok(client) => return Conn { client, events: rx },
            Err(e) if Instant::now() > deadline => panic!("connect: {e}"),
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// An interactive `cmd.exe` that runs `line` first.
fn cmd(name: &str, line: &str) -> CreateSpec {
    CreateSpec {
        name: name.into(),
        agent: "cmd".into(),
        program: "cmd.exe".into(),
        args: vec!["/Q".into(), "/K".into(), line.into()],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        workspace: "C:\\w".into(),
        branch: None,
        worktree: None,
        env: vec![("HELPER".into(), HELPER.into())],
        hooks: Hooks::None,
        cols: 80,
        rows: 24,
    }
}

fn attach(c: &Client, id: &str) -> Arc<Mutex<Vec<u8>>> {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let b = buf.clone();
    c.attach(id, Box::new(move |bytes| b.lock().extend_from_slice(bytes))).unwrap();
    buf
}

fn wait_for(buf: &Mutex<Vec<u8>>, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !String::from_utf8_lossy(&buf.lock()).contains(needle) {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {needle:?}; got {:?}",
            String::from_utf8_lossy(&buf.lock())
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_event(c: &Conn, id: &str, pred: impl Fn(&SessionInfo) -> bool) -> SessionInfo {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let info = c.events.recv_timeout(left).expect("timed out waiting for session event");
        if info.id == id && pred(&info) {
            return info;
        }
    }
}

#[test]
fn conpty_session_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = start(dir.path());
    let c = connect(dir.path());

    let info = c.client.create(cmd("win", "echo hello-%AURORA_SESSION_ID%")).unwrap();
    let out = attach(&c.client, &info.id);
    wait_for(&out, &format!("hello-{}", info.id));

    // A hook inside the session reaches the daemon over the pipe.
    c.client.input(&info.id, b"\"%HELPER%\" notify --event waiting\r").unwrap();
    assert_eq!(wait_event(&c, &info.id, |i| i.status != Status::Running).status, Status::Waiting);

    // `^` keeps the typed line from matching: only cmd's output says "ping".
    c.client.input(&info.id, b"echo pi^ng\r").unwrap();
    wait_for(&out, "ping");

    // A new client gets the scrollback and can still type.
    drop(c);
    let c = connect(dir.path());
    let again = attach(&c.client, &info.id);
    wait_for(&again, &format!("hello-{}", info.id));
    c.client.input(&info.id, b"exit 3\r").unwrap();
    let ended = wait_event(&c, &info.id, |i| !i.alive);
    assert_eq!(ended.exit_code, Some(3));
    assert_eq!(ended.status, Status::Error);

    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
}
