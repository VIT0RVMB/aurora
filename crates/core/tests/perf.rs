//! Phase 1 acceptance numbers, measured on a synthetic 50k-file repo.
//! Run with: `cargo test -p aurora-core --release --test perf -- --ignored --nocapture`

use std::{fs, time::Instant};

use aurora_core::{SearchOptions, Workspace};

#[test]
#[ignore = "slow: creates 50k files"]
fn fifty_thousand_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let t = Instant::now();
    for a in 0..50 {
        for b in 0..20 {
            let d = root.join(format!("pkg{a}/mod{b}"));
            fs::create_dir_all(&d).unwrap();
            for c in 0..50 {
                fs::write(d.join(format!("file{c}.rs")), format!("fn f{c}() {{}}\n")).unwrap();
            }
        }
    }
    eprintln!("setup: {:?}", t.elapsed());

    let t = Instant::now();
    let ws = Workspace::open(root).unwrap();
    let top = ws.list_dir("").unwrap();
    let tree_ready = t.elapsed();
    eprintln!("open + root listing ({} entries): {tree_ready:?}", top.len());

    let t = Instant::now();
    let n = ws.files().len();
    eprintln!("full index ({n} files): {:?}", t.elapsed());
    assert_eq!(n, 50_000);

    let t = Instant::now();
    let hits = ws.fuzzy("pkg42mod7file3", 50);
    eprintln!("fuzzy query: {:?} (top: {})", t.elapsed(), hits[0].path);

    let t = Instant::now();
    let r = ws.search("fn f49", &SearchOptions::default()).unwrap();
    eprintln!("text search: {:?} ({} hits)", t.elapsed(), r.total);

    assert!(tree_ready.as_millis() < 1000, "tree took {tree_ready:?}");
}
