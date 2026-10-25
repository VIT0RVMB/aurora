//! End-to-end: a real daemon on a temp socket, real PTYs, real clients.
#![cfg(unix)]

use std::{
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread::JoinHandle,
    time::{Duration, Instant},
};

use aurora_core::session::{
    self, Client, ClientEvent, CreateSpec, SessionInfo, Stage, Status, agents::Hooks,
};
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

fn sh(name: &str, script: &str) -> CreateSpec {
    CreateSpec {
        name: name.into(),
        agent: "sh".into(),
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        workspace: "/w".into(),
        branch: None,
        worktree: None,
        env: vec![("HELPER".into(), HELPER.into())],
        hooks: Hooks::None,
        cols: 80,
        rows: 24,
    }
}

/// Attaches and returns the shared buffer the output lands in.
fn attach(c: &Client, id: &str) -> Arc<Mutex<Vec<u8>>> {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let b = buf.clone();
    c.attach(id, Box::new(move |bytes| b.lock().extend_from_slice(bytes))).unwrap();
    buf
}

fn wait_for(buf: &Mutex<Vec<u8>>, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
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
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let info = c.events.recv_timeout(left).expect("timed out waiting for session event");
        if info.id == id && pred(&info) {
            return info;
        }
    }
}

#[test]
fn io_exit_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = start(dir.path());
    let c = connect(dir.path());

    let info =
        c.client.create(sh("echo", "echo hello-$AURORA_SESSION_ID; read x; echo got-$x; exit 3")).unwrap();
    assert!(info.alive);
    assert_eq!(info.status, Status::Running);
    let out = attach(&c.client, &info.id);
    wait_for(&out, &format!("hello-{}", info.id));

    c.client.input(&info.id, b"abc\r").unwrap();
    wait_for(&out, "got-abc");
    let ended = wait_event(&c, &info.id, |i| !i.alive);
    assert_eq!(ended.exit_code, Some(3));
    assert_eq!(ended.status, Status::Error);

    // A fresh client gets the whole history back.
    drop(c);
    let c = connect(dir.path());
    let again = attach(&c.client, &info.id);
    wait_for(&again, "got-abc");
    assert!(String::from_utf8_lossy(&again.lock()).contains(&format!("hello-{}", info.id)));

    // Rename persists and pins the name; remove forgets.
    let renamed = c.client.rename(&info.id, "novo").unwrap();
    assert_eq!(renamed.name, "novo");
    assert!(renamed.renamed);
    c.client.remove(&info.id).unwrap();
    assert!(c.client.list().unwrap().is_empty());
    assert!(c.client.attach(&info.id, Box::new(|_| {})).is_err());

    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
}

#[test]
fn terminal_title_names_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = start(dir.path());
    let c = connect(dir.path());
    // Like Claude Code: a spinner glyph, then the topic; redrawn with a new glyph.
    let script = r"printf '\033]0;\342\240\202 Investigar login\007'; sleep 0.2; printf '\033]0;\342\234\263 Investigar login\007'; exec cat";
    let info = c.client.create(sh("t", script)).unwrap();
    let titled = wait_event(&c, &info.id, |i| i.title.is_some());
    assert_eq!(titled.title.as_deref(), Some("Investigar login"));
    std::thread::sleep(Duration::from_millis(400));
    // Same topic with another glyph is not a change.
    assert!(c.events.try_iter().all(|i| i.id != info.id || i.title.as_deref() == Some("Investigar login")));
    assert_eq!(c.client.list().unwrap()[0].title.as_deref(), Some("Investigar login"));
    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
}

#[test]
fn notify_and_kill() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = start(dir.path());
    let c = connect(dir.path());

    // The hook path: the agent's process runs `sessiond notify`, which finds
    // the session and daemon through the env the daemon set.
    let info =
        c.client.create(sh("hook", "\"$HELPER\" notify --event waiting; echo notified; exec cat")).unwrap();
    let out = attach(&c.client, &info.id);
    wait_for(&out, "notified");
    assert_eq!(wait_event(&c, &info.id, |i| i.status != Status::Running).status, Status::Waiting);

    c.client.notify(&info.id, session::AgentEvent::Done).unwrap();
    assert_eq!(wait_event(&c, &info.id, |i| i.status == Status::Done).status, Status::Done);

    c.client.kill(&info.id).unwrap();
    let dead = wait_event(&c, &info.id, |i| !i.alive);
    // A kill you asked for is not an error.
    assert_eq!(dead.status, Status::Done);

    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
}

/// Phase 2 acceptance: five sessions, the "app" goes away and comes back,
/// every session is there with its history. Then the daemon itself restarts
/// and the history survives on disk.
#[test]
fn five_sessions_survive_reconnect_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = start(dir.path());
    let c = connect(dir.path());

    let mut ids = Vec::new();
    for n in 0..5 {
        let info = c
            .client
            .create(sh(&format!("s{n}"), &format!("for i in 1 2 3; do echo s{n}-line$i; done; exec cat")))
            .unwrap();
        let out = attach(&c.client, &info.id);
        wait_for(&out, &format!("s{n}-line3"));
        ids.push(info.id);
    }
    drop(c);

    let c = connect(dir.path());
    let list = c.client.list().unwrap();
    assert_eq!(list.len(), 5);
    assert!(list.iter().all(|s| s.alive));
    for (n, id) in ids.iter().enumerate() {
        let out = attach(&c.client, id);
        wait_for(&out, &format!("s{n}-line1"));
        wait_for(&out, &format!("s{n}-line3"));
        // Still interactive after the reattach.
        c.client.input(id, format!("ping{n}\r").as_bytes()).unwrap();
        wait_for(&out, &format!("ping{n}"));
    }

    // The kanban stage is plain metadata: it survives the restart below and
    // does not count as agent activity.
    let before = c.client.list().unwrap().into_iter().find(|s| s.id == ids[1]).unwrap().updated_ms;
    let staged = c.client.set_stage(&ids[1], Stage::Validating).unwrap();
    assert_eq!(staged.stage, Stage::Validating);
    assert_eq!(staged.updated_ms, before);

    // A second daemon for the same folder refuses to start.
    assert!(matches!(start(dir.path()).join().unwrap(), Err(ServeError::AlreadyRunning)));

    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
    drop(c);

    let daemon = start(dir.path());
    let c = connect(dir.path());
    let list = c.client.list().unwrap();
    assert_eq!(list.len(), 5);
    assert!(list.iter().all(|s| !s.alive && s.status == Status::Done));
    let stages: Vec<_> = ids.iter().map(|id| list.iter().find(|s| &s.id == id).unwrap().stage).collect();
    assert_eq!(stages, [Stage::Inbox, Stage::Validating, Stage::Inbox, Stage::Inbox, Stage::Inbox]);
    let out = attach(&c.client, &ids[2]);
    wait_for(&out, "s2-line3");
    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
}

#[test]
fn spawn_failure_is_an_error_reply() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = start(dir.path());
    let c = connect(dir.path());
    let mut spec = sh("x", "");
    spec.program = "definitely-not-a-real-agent-cli".into();
    spec.args.clear();
    assert!(c.client.create(spec).is_err());
    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
}

/// Real Claude Code in a PTY: checks that the `--settings` hooks report
/// status through `notify`. Needs `claude` logged in; spends a few tokens.
/// `cargo test -p aurora-sessiond --test daemon real_claude -- --ignored --nocapture`
#[test]
#[ignore]
fn real_claude_hooks() {
    let dir = tempfile::tempdir().unwrap();
    // AURORA_REAL_CWD runs it in a real project instead (debugging).
    let repo = match std::env::var_os("AURORA_REAL_CWD") {
        Some(p) => PathBuf::from(p),
        None => {
            let r = dir.path().join("repo");
            std::fs::create_dir(&r).unwrap();
            r
        }
    };
    let cfg = Config {
        data_dir: dir.path().join("data"),
        helper_exe: PathBuf::from(HELPER),
        idle_exit: None,
        shell_env: true,
    };
    let data = cfg.data_dir.clone();
    let daemon = std::thread::spawn(move || aurora_sessiond::serve(cfg));
    let c = connect(&data);

    let launch = session::agents::resolve("claude", &[]);
    let spec = CreateSpec {
        name: "real".into(),
        agent: "claude".into(),
        program: launch.program,
        args: launch.args,
        cwd: repo.to_string_lossy().into_owned(),
        workspace: repo.to_string_lossy().into_owned(),
        branch: None,
        worktree: None,
        env: vec![],
        hooks: launch.hooks,
        cols: 120,
        rows: 40,
    };
    let info = c.client.create(spec).unwrap();
    let out = attach(&c.client, &info.id);
    let t0 = Instant::now();
    // New folder: Claude asks whether to trust it first.
    std::thread::sleep(Duration::from_secs(4));
    let screen = String::from_utf8_lossy(&out.lock()).to_lowercase();
    // Words are separated by cursor moves, not spaces.
    if screen.contains("trust") && screen.contains("folder") {
        // "No, exit" is preselected; move to "Yes" first.
        c.client.input(&info.id, b"\x1b[B").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        c.client.input(&info.id, b"\r").unwrap();
        std::thread::sleep(Duration::from_secs(2));
    }
    c.client.input(&info.id, b"Responda apenas com a palavra ok.").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    c.client.input(&info.id, b"\r").unwrap();

    let mut seen = vec![];
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if let Ok(i) = c.events.recv_timeout(Duration::from_secs(1))
            && i.id == info.id
        {
            println!("{:>6} ms  {:?}  title={:?}", t0.elapsed().as_millis(), i.status, i.title);
            seen.push(i.status);
            if i.status == Status::Done {
                break;
            }
        }
    }
    let tail = String::from_utf8_lossy(&out.lock())
        .chars()
        .rev()
        .take(600)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    println!("--- tail ---\n{tail}");
    assert!(seen.contains(&Status::Done), "no Stop hook seen; statuses: {seen:?}");

    // A question for the user must flag the session well before Claude's
    // 60 s idle notice (which is filtered out).
    c.client
        .input(&info.id, b"Use a ferramenta AskUserQuestion para me perguntar se prefiro A ou B. Nada mais.")
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    c.client.input(&info.id, b"\r").unwrap();
    let mut waited = false;
    let deadline = Instant::now() + Duration::from_secs(50);
    while Instant::now() < deadline {
        if let Ok(i) = c.events.recv_timeout(Duration::from_secs(1))
            && i.id == info.id
        {
            println!("{:>6} ms  {:?}", t0.elapsed().as_millis(), i.status);
            if i.status == Status::Waiting {
                waited = true;
                break;
            }
        }
    }
    assert!(waited, "no waiting hook seen");
    let title = c.client.list().unwrap().into_iter().find(|s| s.id == info.id).and_then(|s| s.title);
    println!("title: {title:?}");
    assert!(title.is_some(), "Claude Code set no terminal title");
    c.client.remove(&info.id).unwrap();
    c.client.shutdown().unwrap();
    daemon.join().unwrap().unwrap();
}
