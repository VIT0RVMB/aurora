use std::{collections::BTreeSet, path::Path, time::Duration};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify_debouncer_full::{
    DebounceEventResult, Debouncer, RecommendedCache, new_debouncer,
    notify::{EventKind, RecommendedWatcher, RecursiveMode, event::ModifyKind},
};
use serde::Serialize;

use crate::{Error, Result, paths};

const DEBOUNCE: Duration = Duration::from_millis(120);

/// One debounced batch of changes, in workspace-relative paths.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsBatch {
    /// Paths whose contents may have changed (open editors should re-check).
    pub changed: Vec<String>,
    /// Directories whose listing may have changed (trees should reload).
    pub dirs: Vec<String>,
    /// The OS dropped events; everything should be considered stale.
    pub rescan: bool,
}

impl FsBatch {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.dirs.is_empty() && !self.rescan
    }

    pub fn is_structural(&self) -> bool {
        self.rescan || !self.dirs.is_empty()
    }
}

pub struct WatchHandle {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

pub fn watch(root: &Path, on_batch: impl Fn(FsBatch) + Send + 'static) -> Result<WatchHandle> {
    let root_buf = root.to_path_buf();
    let mut ignore = root_ignore(root);
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
        let events = match res {
            Ok(events) => events,
            Err(_) => {
                on_batch(FsBatch { rescan: true, ..Default::default() });
                return;
            }
        };
        let mut changed = BTreeSet::new();
        let mut dirs = BTreeSet::new();
        let mut rescan = false;
        for ev in &events {
            rescan |= ev.need_rescan();
            let structural = matches!(
                ev.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(ModifyKind::Name(_))
                    | EventKind::Any
                    | EventKind::Other
            );
            for p in &ev.paths {
                let Some(rel) = paths::to_rel(&root_buf, p) else { continue };
                if rel == ".gitignore" {
                    ignore = root_ignore(&root_buf);
                }
                if is_hidden_from_tree(&rel) || is_ignored(&ignore, p) {
                    continue;
                }
                if structural {
                    dirs.insert(parent_of(&rel).to_string());
                }
                changed.insert(rel);
            }
        }
        let batch =
            FsBatch { changed: changed.into_iter().collect(), dirs: dirs.into_iter().collect(), rescan };
        if !batch.is_empty() {
            on_batch(batch);
        }
    })
    .map_err(|e| Error::Watch(e.to_string()))?;
    debouncer.watch(root, RecursiveMode::Recursive).map_err(|e| Error::Watch(e.to_string()))?;
    Ok(WatchHandle { _debouncer: debouncer })
}

/// Root-level ignore rules, used to drop noise such as `target/` rebuilds.
/// Nested `.gitignore` files are not consulted here; the tree and index still
/// honour them when they reload.
fn root_ignore(root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    b.add(root.join(".gitignore"));
    b.add(root.join(".git/info/exclude"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

fn is_ignored(ig: &Gitignore, abs: &Path) -> bool {
    // The path may already be gone, so treat it as a file; directory rules
    // still match through its parents.
    ig.matched_path_or_any_parents(abs, false).is_ignore()
}

fn is_hidden_from_tree(rel: &str) -> bool {
    rel == ".git" || rel.starts_with(".git/")
}

fn parent_of(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::mpsc, time::Instant};

    #[test]
    fn parent_and_hidden() {
        assert_eq!(parent_of("a/b/c.rs"), "a/b");
        assert_eq!(parent_of("c.rs"), "");
        assert!(is_hidden_from_tree(".git/index"));
        assert!(!is_hidden_from_tree(".github/ci.yml"));
    }

    #[test]
    fn reports_create_and_skips_ignored() {
        let dir = tempfile::tempdir().unwrap();
        // Canonical path: macOS reports /private/var for /var temp dirs.
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::create_dir(root.join("build")).unwrap();
        fs::create_dir(root.join("src")).unwrap();

        let (tx, rx) = mpsc::channel();
        let _h = watch(&root, move |b| {
            let _ = tx.send(b);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        fs::write(root.join("build/out.o"), "x").unwrap();
        fs::write(root.join("src/new.rs"), "x").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = FsBatch::default();
        while Instant::now() < deadline && !seen.changed.contains(&"src/new.rs".to_string()) {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.changed.extend(b.changed);
                seen.dirs.extend(b.dirs);
            }
        }
        assert!(seen.changed.contains(&"src/new.rs".to_string()), "{seen:?}");
        assert!(seen.dirs.contains(&"src".to_string()), "{seen:?}");
        assert!(seen.changed.iter().all(|p| !p.starts_with("build")), "{seen:?}");
    }
}
