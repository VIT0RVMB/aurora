//! What a session changed, for review: the diff list and the tree marks.
//!
//! A session in its own worktree owns every change there, so git alone says
//! what it did (against where its branch forked from the workspace). A session
//! in the workspace shares the folder with you and other sessions; its share
//! is what its hooks reported writing, kept while git still shows it changed.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::SessionInfo;
use crate::{
    Result,
    fs::read_text,
    git::{self, ChangeKind},
    paths,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChange {
    /// Relative to the session's root; what `file_diff` takes.
    pub path: String,
    pub kind: ChangeKind,
    /// The same file as a workspace path, when it falls inside the workspace.
    pub ws_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanges {
    /// Folder the files live in: the worktree, or the repository root.
    pub root: String,
    /// Commit the changes are against; none outside a repository.
    pub base: Option<String>,
    pub files: Vec<SessionChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileDiff {
    /// The file at the base; none when the session created it.
    pub old: Option<String>,
    /// The file now; none when the session deleted it.
    pub new: Option<String>,
}

/// `path` with symlinks resolved (macOS `/var` is `/private/var`); a file that
/// is gone resolves through its folder.
fn canonical(path: &Path) -> PathBuf {
    if let Ok(p) = dunce(path) {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => canonical(dir).join(name),
        _ => path.to_path_buf(),
    }
}

fn dunce(path: &Path) -> std::io::Result<PathBuf> {
    let p = path.canonicalize()?;
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\")
            && !rest.starts_with("UNC")
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(p)
}

/// The folder a session's files live in and the commit to compare against.
fn root_and_base(info: &SessionInfo) -> (PathBuf, Option<String>) {
    let ws = Path::new(&info.workspace);
    if let Some(wt) = info.worktree.as_deref().map(Path::new) {
        let root = git::repo_root(wt).unwrap_or_else(|| wt.to_path_buf());
        // Where its branch left the workspace's; before any commit, HEAD is that.
        let base = git::rev(ws, "HEAD")
            .and_then(|ws_head| git::merge_base(&root, "HEAD", &ws_head))
            .or_else(|| git::rev(&root, "HEAD"));
        return (canonical(&root), base);
    }
    let cwd = Path::new(&info.cwd);
    match git::repo_root(cwd) {
        Some(root) => (canonical(&root), git::rev(&root, "HEAD")),
        None => (canonical(cwd), None),
    }
}

pub fn changes(info: &SessionInfo, touched: &[String]) -> Result<SessionChanges> {
    let (root, base) = root_and_base(info);
    let ws = canonical(Path::new(&info.workspace));
    // Workspace paths are relative to the workspace, which may be a subfolder
    // of the repository; a worktree mirrors the repository, not the workspace.
    let ws_prefix = git::repo_root(&ws).map(|r| canonical(&r)).and_then(|r| paths::to_rel(&r, &ws));
    let ws_path = |rel: &str| -> Option<String> {
        if info.worktree.is_some() {
            let prefix = ws_prefix.as_deref().unwrap_or("");
            if prefix.is_empty() {
                return Some(rel.to_string());
            }
            return rel.strip_prefix(prefix).and_then(|r| r.strip_prefix('/')).map(str::to_string);
        }
        paths::to_rel(&ws, &root.join(rel))
    };

    let files = match (&base, info.worktree.is_some()) {
        (Some(base), true) => git::changes(&root, base)?
            .into_iter()
            .map(|c| SessionChange { ws_path: ws_path(&c.path), path: c.path, kind: c.kind })
            .collect(),
        (Some(base), false) => {
            let changed: HashMap<String, ChangeKind> =
                git::changes(&root, base)?.into_iter().map(|c| (c.path, c.kind)).collect();
            let mut files: Vec<SessionChange> = touched
                .iter()
                .filter_map(|abs| paths::to_rel(&root, &canonical(Path::new(abs))))
                .filter_map(|rel| {
                    let kind = *changed.get(&rel)?;
                    Some(SessionChange { ws_path: ws_path(&rel), path: rel, kind })
                })
                .collect();
            files.dedup_by(|a, b| a.path == b.path);
            files
        }
        // No repository: every reported file still there counts as changed.
        (None, _) => touched
            .iter()
            .filter_map(|abs| {
                let abs = canonical(Path::new(abs));
                let rel = paths::to_rel(&root, &abs)?;
                abs.exists().then(|| SessionChange {
                    ws_path: ws_path(&rel),
                    path: rel,
                    kind: ChangeKind::Modified,
                })
            })
            .collect(),
    };
    Ok(SessionChanges { root: root.to_string_lossy().into_owned(), base, files })
}

/// Both sides of one changed file. `path` is a `SessionChange::path`.
pub fn file_diff(info: &SessionInfo, path: &str) -> Result<FileDiff> {
    let (root, base) = root_and_base(info);
    let abs = paths::resolve(&root, path)?;
    let old = match &base {
        Some(b) => git::show(&root, b, path)?,
        None => None,
    };
    let new = match read_text(&abs) {
        Ok(f) => Some(f.content),
        Err(crate::Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    Ok(FileDiff { old, new })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Stage, Status};
    use std::{fs, process::Command};

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir(&root).unwrap();
        sh(&root, &["init", "-q", "-b", "main"]);
        sh(&root, &["config", "user.email", "t@t"]);
        sh(&root, &["config", "user.name", "t"]);
        sh(&root, &["config", "commit.gpgsign", "false"]);
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/a.md"), "a\n").unwrap();
        fs::write(root.join("b.txt"), "b\n").unwrap();
        sh(&root, &["add", "."]);
        sh(&root, &["commit", "-q", "-m", "init"]);
        let root = canonical(&root);
        (dir, root)
    }

    fn info(cwd: &Path, workspace: &Path, worktree: Option<&Path>) -> SessionInfo {
        SessionInfo {
            id: "s".into(),
            name: "s".into(),
            agent: "claude".into(),
            cwd: cwd.to_string_lossy().into(),
            workspace: workspace.to_string_lossy().into(),
            branch: None,
            worktree: worktree.map(|w| w.to_string_lossy().into()),
            status: Status::Running,
            alive: true,
            exit_code: None,
            created_ms: 0,
            updated_ms: 0,
            title: None,
            renamed: false,
            stage: Stage::Inbox,
            color: None,
            archived: false,
        }
    }

    #[test]
    fn worktree_session_owns_its_changes() {
        let (_tmp, root) = repo();
        let wt = git::worktree_add(&root, "feat").unwrap().path;
        fs::write(wt.join("docs/a.md"), "a2\n").unwrap();
        fs::write(wt.join("new.rs"), "fn x() {}\n").unwrap();
        sh(&wt, &["add", "new.rs"]);
        sh(&wt, &["commit", "-q", "-m", "wip"]);
        fs::remove_file(wt.join("b.txt")).unwrap();
        // The workspace moving on does not show up as the session's work.
        fs::write(root.join("main-only.txt"), "m").unwrap();
        sh(&root, &["add", "."]);
        sh(&root, &["commit", "-q", "-m", "main"]);

        // Opened at the `docs` subfolder: workspace paths drop that prefix.
        let s = info(&wt, &root.join("docs"), Some(&wt));
        let ch = changes(&s, &[]).unwrap();
        let got: Vec<_> = ch.files.iter().map(|f| (f.path.as_str(), f.kind, f.ws_path.as_deref())).collect();
        assert_eq!(
            got,
            [
                ("b.txt", ChangeKind::Deleted, None),
                ("docs/a.md", ChangeKind::Modified, Some("a.md")),
                ("new.rs", ChangeKind::Added, None),
            ]
        );
        assert_eq!(
            file_diff(&s, "docs/a.md").unwrap(),
            FileDiff { old: Some("a\n".into()), new: Some("a2\n".into()) }
        );
        assert_eq!(file_diff(&s, "new.rs").unwrap().old, None);
        assert_eq!(file_diff(&s, "b.txt").unwrap(), FileDiff { old: Some("b\n".into()), new: None });
        assert!(file_diff(&s, "../x").is_err());
    }

    #[test]
    fn workspace_session_owns_what_it_touched() {
        let (_tmp, root) = repo();
        fs::write(root.join("docs/a.md"), "mine\n").unwrap();
        fs::write(root.join("b.txt"), "yours\n").unwrap();
        fs::write(root.join("c.txt"), "new\n").unwrap();
        let s = info(&root, &root, None);
        let touched = [
            root.join("docs/a.md").to_string_lossy().into_owned(),
            root.join("c.txt").to_string_lossy().into_owned(),
            // Reported, but git shows nothing there now.
            root.join("gone.txt").to_string_lossy().into_owned(),
        ];
        let ch = changes(&s, &touched).unwrap();
        let got: Vec<_> = ch.files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
        assert_eq!(got, [("docs/a.md", ChangeKind::Modified), ("c.txt", ChangeKind::Added)]);
        assert_eq!(ch.files[0].ws_path.as_deref(), Some("docs/a.md"));
    }
}
