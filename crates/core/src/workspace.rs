use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use parking_lot::{Mutex, RwLock};

use crate::{
    DirEntry, Error, FileContent, FileStat, FsBatch, FuzzyMatch, Result, SearchOptions, SearchResults, fs,
    index, paths, search, tree,
    watch::{self, WatchHandle},
};

/// An open folder. Cheap to share behind an `Arc`; all methods take `&self`.
pub struct Workspace {
    root: PathBuf,
    index: RwLock<Arc<Vec<String>>>,
    index_dirty: AtomicBool,
    index_build: Mutex<()>,
    search_gen: AtomicU64,
    watcher: Mutex<Option<WatchHandle>>,
}

impl Workspace {
    /// Opens `path` and starts building the file index in the background.
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>> {
        let root = dunce_canonicalize(path.as_ref())?;
        if !root.is_dir() {
            return Err(Error::NotDir(root.display().to_string()));
        }
        let ws = Arc::new(Self {
            root,
            index: RwLock::new(Arc::new(Vec::new())),
            index_dirty: AtomicBool::new(true),
            index_build: Mutex::new(()),
            search_gen: AtomicU64::new(0),
            watcher: Mutex::new(None),
        });
        let warm = Arc::downgrade(&ws);
        std::thread::spawn(move || {
            if let Some(ws) = warm.upgrade() {
                ws.files();
            }
        });
        Ok(ws)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.display().to_string())
    }

    pub fn list_dir(&self, rel: &str) -> Result<Vec<DirEntry>> {
        tree::list_dir(&self.root, &paths::resolve(&self.root, rel)?)
    }

    pub fn read_file(&self, rel: &str) -> Result<FileContent> {
        fs::read_text(&paths::resolve(&self.root, rel)?)
    }

    pub fn write_file(&self, rel: &str, content: &str) -> Result<FileStat> {
        fs::write_text(&paths::resolve(&self.root, rel)?, content)
    }

    pub fn stat(&self, rel: &str) -> Result<FileStat> {
        fs::stat(&paths::resolve(&self.root, rel)?)
    }

    /// The current file index, rebuilt first if the tree changed since.
    pub fn files(&self) -> Arc<Vec<String>> {
        // Always taken, so a caller never reads the index while the warm-up
        // build is still running. Uncontended, it costs nanoseconds.
        let _guard = self.index_build.lock();
        if self.index_dirty.swap(false, Ordering::AcqRel) {
            *self.index.write() = Arc::new(index::build(&self.root));
        }
        self.index.read().clone()
    }

    pub fn fuzzy(&self, query: &str, limit: usize) -> Vec<FuzzyMatch> {
        index::fuzzy(&self.files(), query, limit)
    }

    /// Runs a text search. Starting a new search cancels any still running.
    pub fn search(&self, query: &str, opts: &SearchOptions) -> Result<SearchResults> {
        let generation = self.search_gen.fetch_add(1, Ordering::AcqRel) + 1;
        let cancelled = || self.search_gen.load(Ordering::Acquire) != generation;
        search::search(&self.root, query, opts, &cancelled)
    }

    pub fn cancel_search(&self) {
        self.search_gen.fetch_add(1, Ordering::AcqRel);
    }

    /// Watches the folder; structural changes mark the index stale (rebuilt
    /// lazily on the next query) before `on_batch` sees them.
    pub fn watch(self: &Arc<Self>, on_batch: impl Fn(FsBatch) + Send + 'static) -> Result<()> {
        let weak: Weak<Self> = Arc::downgrade(self);
        let handle = watch::watch(&self.root, move |batch| {
            if batch.is_structural()
                && let Some(ws) = weak.upgrade()
            {
                ws.index_dirty.store(true, Ordering::Release);
            }
            on_batch(batch);
        })?;
        *self.watcher.lock() = Some(handle);
        Ok(())
    }
}

/// `canonicalize` without the `\\?\` prefix Windows adds, which breaks
/// `strip_prefix` against paths reported by the watcher.
fn dunce_canonicalize(p: &Path) -> Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    #[cfg(windows)]
    {
        let s = c.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\")
            && !rest.starts_with("UNC")
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;

    #[test]
    fn end_to_end_without_ui() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        stdfs::create_dir_all(r.join("src")).unwrap();
        stdfs::write(r.join("src/lib.rs"), "pub fn hello() {}\n").unwrap();

        let ws = Workspace::open(r).unwrap();
        assert_eq!(ws.list_dir("").unwrap()[0].path, "src");
        assert_eq!(ws.fuzzy("lib", 5)[0].path, "src/lib.rs");
        assert!(ws.read_file("src/lib.rs").unwrap().content.contains("hello"));
        assert!(matches!(ws.read_file("../x"), Err(Error::OutsideRoot(_))));

        let st = ws.write_file("src/lib.rs", "pub fn bye() {}\n").unwrap();
        assert_eq!(ws.stat("src/lib.rs").unwrap(), st);
        let hits = ws.search("bye", &SearchOptions::default()).unwrap();
        assert_eq!(hits.files[0].path, "src/lib.rs");

        // Index goes stale only through the watcher; force it here.
        stdfs::write(r.join("src/new.rs"), "").unwrap();
        ws.index_dirty.store(true, Ordering::Release);
        assert_eq!(ws.fuzzy("new", 5)[0].path, "src/new.rs");
    }

    #[test]
    fn open_rejects_files() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        stdfs::write(&f, "").unwrap();
        assert!(matches!(Workspace::open(&f), Err(Error::NotDir(_))));
    }
}
