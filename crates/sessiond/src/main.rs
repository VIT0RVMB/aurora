use std::path::PathBuf;
use std::time::Duration;

use aurora_core::session;
use aurora_sessiond::{Config, ServeError};

const USAGE: &str = "usage: aurora-sessiond [serve [--data-dir DIR]] | notify [--session ID] --event EVENT";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("serve") => serve(args.get(1..).unwrap_or_default()),
        Some("notify") => aurora_sessiond::notify::run(&args[1..]),
        Some("dump-env") => dump_env(),
        Some("--version") => println!("aurora-sessiond {}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}

fn serve(args: &[String]) {
    let mut data_dir = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--data-dir" => data_dir = it.next().map(PathBuf::from),
            _ => {
                eprintln!("{USAGE}");
                std::process::exit(2);
            }
        }
    }
    let cfg = Config {
        data_dir: data_dir.unwrap_or_else(session::data_dir),
        helper_exe: std::env::current_exe().expect("current exe"),
        idle_exit: Some(Duration::from_secs(10 * 60)),
        shell_env: true,
    };
    match aurora_sessiond::serve(cfg) {
        Ok(()) => {}
        // Lost a start race with another daemon: it serves, we leave.
        Err(ServeError::AlreadyRunning) => {}
        Err(e) => {
            eprintln!("sessiond: {e}");
            std::process::exit(1);
        }
    }
}

/// Prints the env as JSON between markers; see `session::shell_env`.
fn dump_env() {
    let env: std::collections::BTreeMap<String, String> = std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .filter(|(k, _)| k != "AURORA_RESOLVING_ENV")
        .collect();
    print!("{m}{}{m}", serde_json::to_string(&env).unwrap(), m = session::ENV_MARK);
}
