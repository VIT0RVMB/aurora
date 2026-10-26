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
    git, index, paths, search,
    session::changes::FileDiff,
    tree,
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

    /// An image in the workspace as a `data:` URL; `None` if it is not one.
    pub fn read_image(&self, rel: &str) -> Result<Option<String>> {
        fs::read_image(&paths::resolve(&self.root, rel)?)
    }

    /// Creates an empty file (and any missing folders on the way); refuses to overwrite.
    pub fn create_file(&self, rel: &str) -> Result<FileStat> {
        let path = paths::resolve(&self.root, rel)?;
        if rel.trim_matches('/').is_empty() {
            return Err(Error::BadName(rel.to_string()));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => fs::stat(&path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(Error::Exists(rel.to_string())),
            Err(e) => Err(e.into()),
        }
    }

    /// Renames or moves a file or folder inside the workspace; refuses to overwrite.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let src = paths::resolve(&self.root, from)?;
        let dst = paths::resolve(&self.root, to)?;
        if from.trim_matches('/').is_empty() || to.trim_matches('/').is_empty() {
            return Err(Error::BadName(to.to_string()));
        }
        std::fs::symlink_metadata(&src)?;
        // A case-only rename on a case-insensitive disk sees the target "exist".
        let same_file = from.eq_ignore_ascii_case(to) && from != to;
        if !same_file && std::fs::symlink_metadata(&dst).is_ok() {
            return Err(Error::Exists(to.to_string()));
        }
        if let Some(dir) = dst.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(&src, &dst)?;
        Ok(())
    }

    /// Moves a file or folder to the system trash, where it can be restored.
    pub fn trash(&self, rel: &str) -> Result<()> {
        if rel.trim_matches('/').is_empty() {
            return Err(Error::BadName(rel.to_string()));
        }
        let path = paths::resolve(&self.root, rel)?;
        std::fs::symlink_metadata(&path)?;
        trash::delete(&path).map_err(|e| Error::Io(std::io::Error::other(e.to_string())))
    }

    /// The absolute path of a workspace path, for the system's own tools.
    pub fn absolute(&self, rel: &str) -> Result<PathBuf> {
        paths::resolve(&self.root, rel)
    }

    /// The repository holding the workspace, and `rel` relative to it.
    fn in_repo(&self, rel: &str) -> Result<(PathBuf, String)> {
        paths::resolve(&self.root, rel)?;
        let repo =
            git::repo_root(&self.root).ok_or_else(|| Error::NotRepo(self.root.display().to_string()))?;
        let repo = repo.canonicalize().unwrap_or(repo);
        let root = self.root.canonicalize().unwrap_or_else(|_| self.root.clone());
        let prefix = paths::to_rel(&repo, &root).unwrap_or_default();
        let path = if prefix.is_empty() { rel.to_string() } else { format!("{prefix}/{rel}") };
        Ok((repo, path))
    }

    /// The repository's worktrees and how many files each has changed.
    pub fn worktrees(&self) -> Result<Vec<git::WorktreeStatus>> {
        git::worktree_statuses(&self.root)
    }

    /// Commits that changed a file, newest first.
    pub fn history(&self, rel: &str) -> Result<Vec<git::Commit>> {
        let (repo, path) = self.in_repo(rel)?;
        git::file_history(&repo, &path, 200)
    }

    /// What one commit did to a file: its parent's version and its own.
    /// `path` is the file's repo-relative path in that commit (`Commit::path`).
    pub fn commit_diff(&self, hash: &str, path: &str) -> Result<FileDiff> {
        if !hash.chars().all(|c| c.is_ascii_hexdigit()) || hash.is_empty() {
            return Err(Error::BadName(hash.to_string()));
        }
        let (repo, _) = self.in_repo("")?;
        let old = git::show(&repo, &format!("{hash}^"), path)?;
        let new = git::show(&repo, hash, path)?;
        Ok(FileDiff { old, new })
    }

    /// A link to the file on the repository's web host.
    pub fn share_link(&self, rel: &str) -> Result<String> {
        let (repo, path) = self.in_repo(rel)?;
        git::share_link(&repo, &path)
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
    fn create_and_rename() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        ws.create_file("notes/new.md").unwrap();
        assert!(dir.path().join("notes/new.md").is_file());
        assert!(matches!(ws.create_file("notes/new.md"), Err(Error::Exists(_))));
        assert!(matches!(ws.create_file("../x.md"), Err(Error::OutsideRoot(_))));

        ws.write_file("notes/other.md", "x").unwrap();
        assert!(matches!(ws.rename("notes/new.md", "notes/other.md"), Err(Error::Exists(_))));
        ws.rename("notes/new.md", "docs/moved.md").unwrap();
        assert!(dir.path().join("docs/moved.md").is_file());
        ws.rename("docs/moved.md", "docs/Moved.md").unwrap();
        assert!(ws.list_dir("docs").unwrap().iter().any(|e| e.name == "Moved.md"));
        ws.rename("docs", "papers").unwrap();
        assert!(dir.path().join("papers/Moved.md").is_file());
        assert!(ws.rename("nope.md", "x.md").is_err());
        assert!(matches!(ws.rename("papers", "../out"), Err(Error::OutsideRoot(_))));
        // Not exercised for real: it would fill the user's trash on every run.
        assert!(matches!(ws.trash(""), Err(Error::BadName(_))));
        assert!(matches!(ws.trash("../x"), Err(Error::OutsideRoot(_))));
        assert!(ws.trash("nope.md").is_err());
    }

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
