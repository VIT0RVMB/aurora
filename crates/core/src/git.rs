//! Git through the `git` CLI. `gix` cannot add worktrees yet and would pull in
//! dozens of crates; every machine that runs coding agents already has `git`.

use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

use serde::Serialize;

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
    /// False when an existing worktree for the branch was reused.
    pub created: bool,
}

fn git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run(cmd: &mut Command) -> Result<Output> {
    let out = cmd.output().map_err(|e| Error::Git(format!("could not run git: {e}")))?;
    Ok(out)
}

fn stdout_line(out: &Output) -> Option<String> {
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

/// Top-level folder of the repository containing `dir`, if any.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    let out = run(git(dir).args(["rev-parse", "--show-toplevel"])).ok()?;
    stdout_line(&out).map(PathBuf::from)
}

/// Branch checked out in `dir`, or the short commit when HEAD is detached.
pub fn current_branch(dir: &Path) -> Option<String> {
    let out = run(git(dir).args(["symbolic-ref", "--short", "-q", "HEAD"])).ok()?;
    stdout_line(&out).or_else(|| {
        let out = run(git(dir).args(["rev-parse", "--short", "HEAD"])).ok()?;
        stdout_line(&out)
    })
}

/// Whether `dir` has uncommitted or untracked changes.
pub fn is_dirty(dir: &Path) -> Result<bool> {
    let out = run(git(dir).args(["status", "--porcelain"]))?;
    if !out.status.success() {
        return Err(Error::Git(stderr(&out)));
    }
    Ok(!out.stdout.is_empty())
}

/// Worktree names become branch names and folder names: keep them boring.
pub fn validate_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['-', '.', '/'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with(".lock")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if ok { Ok(()) } else { Err(Error::BadName(name.to_string())) }
}

/// Where worktrees of `repo` live: a sibling `<repo>.worktrees/` folder, so
/// tools that search upwards for config (cargo, tsconfig) never see the parent.
pub fn worktrees_dir(repo: &Path) -> PathBuf {
    let name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    repo.with_file_name(format!("{name}.worktrees"))
}

/// Creates (or reuses) the worktree `name` on branch `name`, branching from HEAD.
pub fn worktree_add(repo: &Path, name: &str) -> Result<Worktree> {
    validate_name(name)?;
    let root = repo_root(repo).ok_or_else(|| Error::NotRepo(repo.display().to_string()))?;
    let path = worktrees_dir(&root).join(name);

    if let Some(existing) = worktree_list(&root)?.into_iter().find(|w| same_path(&w.path, &path)) {
        return Ok(Worktree { path: existing.path, branch: existing.branch, created: false });
    }
    if path.exists() {
        return Err(Error::Git(format!(
            "{} already exists and is not a worktree of this repository",
            path.display()
        )));
    }
    let branch_exists =
        run(git(&root).args(["show-ref", "--verify", "--quiet"]).arg(format!("refs/heads/{name}")))?
            .status
            .success();
    let mut cmd = git(&root);
    cmd.args(["worktree", "add"]);
    if branch_exists {
        cmd.arg(&path).arg(name);
    } else {
        cmd.arg("-b").arg(name).arg(&path);
    }
    let out = run(&mut cmd)?;
    if !out.status.success() {
        return Err(Error::Git(stderr(&out)));
    }
    let path = dunce(&path);
    Ok(Worktree { path, branch: name.to_string(), created: true })
}

/// Removes a worktree folder. The branch stays: deleting work is the user's call.
/// Without `force`, a worktree with uncommitted changes is refused.
pub fn worktree_remove(repo: &Path, path: &Path, force: bool) -> Result<()> {
    let root = repo_root(repo).ok_or_else(|| Error::NotRepo(repo.display().to_string()))?;
    if !force && path.exists() && is_dirty(path)? {
        return Err(Error::DirtyWorktree(path.display().to_string()));
    }
    let mut cmd = git(&root);
    cmd.args(["worktree", "remove"]);
    if force {
        cmd.arg("--force");
    }
    let out = run(cmd.arg(path))?;
    if !out.status.success() {
        let msg = stderr(&out);
        if msg.contains("modified or untracked") {
            return Err(Error::DirtyWorktree(path.display().to_string()));
        }
        return Err(Error::Git(msg));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ListedWorktree {
    pub path: PathBuf,
    pub branch: String,
}

pub fn worktree_list(repo: &Path) -> Result<Vec<ListedWorktree>> {
    let out = run(git(repo).args(["worktree", "list", "--porcelain"]))?;
    if !out.status.success() {
        return Err(Error::Git(stderr(&out)));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut list = Vec::new();
    for block in text.split("\n\n") {
        let mut path = None;
        let mut branch = String::new();
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            }
        }
        if let Some(path) = path {
            list.push(ListedWorktree { path, branch });
        }
    }
    Ok(list)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

fn dunce(p: &Path) -> PathBuf {
    match p.canonicalize() {
        #[cfg(windows)]
        Ok(c) => {
            let s = c.to_string_lossy();
            match s.strip_prefix(r"\\?\") {
                Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
                _ => c,
            }
        }
        #[cfg(not(windows))]
        Ok(c) => c,
        Err(_) => p.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir(&root).unwrap();
        let sh = |args: &[&str]| {
            let out = git(&root).args(args).output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", stderr(&out));
        };
        sh(&["init", "-q", "-b", "main"]);
        sh(&["config", "user.email", "t@example.com"]);
        sh(&["config", "user.name", "t"]);
        sh(&["config", "commit.gpgsign", "false"]);
        fs::write(root.join("a.txt"), "a\n").unwrap();
        sh(&["add", "."]);
        sh(&["commit", "-q", "-m", "init"]);
        (dir, root.canonicalize().unwrap())
    }

    #[test]
    fn names() {
        for ok in ["fix-login", "feat/x", "a_b.c", "v2"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-x", "../x", "a b", "x.lock", "a//b", "x/", ".hidden", "ç"] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn worktree_lifecycle() {
        let (_tmp, root) = repo();
        assert_eq!(current_branch(&root).as_deref(), Some("main"));

        let wt = worktree_add(&root, "feat-a").unwrap();
        assert!(wt.created);
        assert_eq!(wt.path, root.with_file_name("proj.worktrees").join("feat-a").canonicalize().unwrap());
        assert_eq!(current_branch(&wt.path).as_deref(), Some("feat-a"));
        assert_eq!(repo_root(&wt.path).unwrap(), wt.path);

        // Same name again reuses the worktree instead of failing.
        let again = worktree_add(&root, "feat-a").unwrap();
        assert!(!again.created);
        assert_eq!(again.path, wt.path);

        fs::write(wt.path.join("new.txt"), "x").unwrap();
        assert!(is_dirty(&wt.path).unwrap());
        assert!(matches!(worktree_remove(&root, &wt.path, false), Err(Error::DirtyWorktree(_))));
        assert!(wt.path.exists());

        worktree_remove(&root, &wt.path, true).unwrap();
        assert!(!wt.path.exists());
        // The branch survives removal.
        let out = git(&root).args(["branch", "--list", "feat-a"]).output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("feat-a"));

        // An existing branch is checked out rather than recreated.
        let back = worktree_add(&root, "feat-a").unwrap();
        assert!(back.created);
        assert_eq!(current_branch(&back.path).as_deref(), Some("feat-a"));
    }

    #[test]
    fn not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(repo_root(dir.path()).is_none());
        assert!(matches!(worktree_add(dir.path(), "x"), Err(Error::NotRepo(_))));
    }
}
