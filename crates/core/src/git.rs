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

/// How many files have uncommitted or untracked changes in `dir`.
pub fn changed_count(dir: &Path) -> Result<usize> {
    let out = run(git(dir).args(["status", "--porcelain", "-z"]))?;
    if !out.status.success() {
        return Err(Error::Git(stderr(&out)));
    }
    // `-z` ends each entry with NUL; a rename adds its old path as one more field.
    let mut n = 0;
    let mut fields = out.stdout.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(f) = fields.next() {
        n += 1;
        if matches!(f.first(), Some(b'R' | b'C')) {
            fields.next();
        }
    }
    Ok(n)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub path: PathBuf,
    /// Empty when HEAD is detached.
    pub branch: String,
    /// The repository's own checkout, as opposed to an added worktree.
    pub main: bool,
    /// Files with uncommitted or untracked changes; none when git could not
    /// read it (a worktree whose folder is gone).
    pub changed: Option<usize>,
}

/// Every worktree of the repository holding `dir`, the main checkout first,
/// with how many files each has changed (by anyone: agents or you).
pub fn worktree_statuses(dir: &Path) -> Result<Vec<WorktreeStatus>> {
    let root = repo_root(dir).ok_or_else(|| Error::NotRepo(dir.display().to_string()))?;
    Ok(worktree_list(&root)?
        .into_iter()
        .enumerate()
        .map(|(i, w)| WorktreeStatus {
            changed: w.path.is_dir().then(|| changed_count(&w.path).ok()).flatten(),
            path: w.path,
            branch: w.branch,
            main: i == 0,
        })
        .collect())
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    /// Relative to the repository root, `/`-separated.
    pub path: String,
    pub kind: ChangeKind,
}

/// The commit `rev` names in `dir` (`HEAD`, a branch), as a full hash.
pub fn rev(dir: &Path, rev: &str) -> Option<String> {
    let out =
        run(git(dir).args(["rev-parse", "--verify", "--quiet"]).arg(format!("{rev}^{{commit}}"))).ok()?;
    stdout_line(&out)
}

/// Where `a` and `b` forked: what a branch's work is compared against.
pub fn merge_base(dir: &Path, a: &str, b: &str) -> Option<String> {
    let out = run(git(dir).args(["merge-base", a, b])).ok()?;
    stdout_line(&out)
}

/// Files that differ between commit `base` and the working tree of the repo
/// at `root` (committed, staged or not), untracked files included.
pub fn changes(root: &Path, base: &str) -> Result<Vec<Change>> {
    let out = run(git(root).args([
        "-c",
        "core.quotepath=off",
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        base,
        "--",
    ]))?;
    if !out.status.success() {
        return Err(Error::Git(stderr(&out)));
    }
    let mut list = Vec::new();
    let mut fields = out.stdout.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        let kind = match status.first() {
            Some(b'A') => ChangeKind::Added,
            Some(b'D') => ChangeKind::Deleted,
            _ => ChangeKind::Modified,
        };
        list.push(Change { path: String::from_utf8_lossy(path).into_owned(), kind });
    }
    let out = run(git(root).args(["ls-files", "--others", "--exclude-standard", "-z"]))?;
    if out.status.success() {
        for path in out.stdout.split(|b| *b == 0).filter(|f| !f.is_empty()) {
            list.push(Change { path: String::from_utf8_lossy(path).into_owned(), kind: ChangeKind::Added });
        }
    }
    list.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(list)
}

/// A file's text at commit `rev`; `None` when it did not exist there.
pub fn show(root: &Path, rev: &str, path: &str) -> Result<Option<String>> {
    let out = run(git(root).arg("show").arg(format!("{rev}:{path}")))?;
    if !out.status.success() {
        return Ok(None);
    }
    if out.stdout.len() as u64 > crate::MAX_FILE_BYTES {
        return Err(Error::TooLarge(out.stdout.len() as u64));
    }
    if out.stdout[..out.stdout.len().min(8192)].contains(&0) {
        return Err(Error::Binary);
    }
    String::from_utf8(out.stdout).map(Some).map_err(|_| Error::NotUtf8)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub time_ms: u64,
    pub subject: String,
    /// The file's path in that commit (it may have been renamed since), repo-relative.
    pub path: String,
}

/// Commits that touched `path` (repo-relative), newest first, following renames.
pub fn file_history(root: &Path, path: &str, limit: usize) -> Result<Vec<Commit>> {
    let out = run(git(root)
        .args(["-c", "core.quotepath=off", "log", "--follow", "--name-only", "-z"])
        .arg(format!("-n{limit}"))
        .arg("--format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s")
        .args(["--", path]))?;
    if !out.status.success() {
        return Err(Error::Git(stderr(&out)));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut list = Vec::new();
    for rec in text.split('\x1e').filter(|r| !r.trim().is_empty()) {
        // The header line (ended by NUL under `-z`), then the file's name.
        let end = rec.find(['\0', '\n']).unwrap_or(rec.len());
        let (head, names) = rec.split_at(end);
        let f: Vec<&str> = head.split('\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        let name = names.trim_matches(|c| c == '\0' || c == '\n').split('\0').next().unwrap_or(path);
        list.push(Commit {
            hash: f[0].to_string(),
            short: f[1].to_string(),
            author: f[2].to_string(),
            time_ms: f[3].parse::<u64>().unwrap_or(0) * 1000,
            subject: f[4].to_string(),
            path: if name.is_empty() { path.to_string() } else { name.to_string() },
        });
    }
    Ok(list)
}

/// The web page of `path` (repo-relative) on the repository's host, for
/// sharing: the branch when it is pushed upstream, else the commit.
pub fn share_link(root: &Path, path: &str) -> Result<String> {
    let remote = run(git(root).args(["remote", "get-url", "origin"]))
        .ok()
        .and_then(|o| stdout_line(&o))
        .or_else(|| {
            let o = run(git(root).arg("remote")).ok()?;
            let first = stdout_line(&o)?.lines().next()?.to_string();
            stdout_line(&run(git(root).args(["remote", "get-url", &first])).ok()?)
        })
        .ok_or_else(|| Error::Git("no remote".into()))?;
    let base = web_base(&remote).ok_or_else(|| Error::Git(format!("not a web host: {remote}")))?;
    let pushed = run(git(root).args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]))
        .map(|o| o.status.success())
        .unwrap_or(false);
    let reference = match (pushed, current_branch(root)) {
        (true, Some(b)) => b,
        _ => rev(root, "HEAD").ok_or_else(|| Error::Git("no commits".into()))?,
    };
    let encoded: Vec<String> = path.split('/').map(encode_segment).collect();
    let page = if base.contains("gitlab") {
        "-/blob"
    } else if base.contains("bitbucket") {
        "src"
    } else {
        "blob"
    };
    Ok(format!("{base}/{page}/{}/{}", encode_segment(&reference), encoded.join("/")))
}

/// `git@host:o/r.git`, `ssh://git@host/o/r`, `https://host/o/r.git` → `https://host/o/r`.
pub fn web_base(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let (host, repo) = if let Some(rest) = r.strip_prefix("https://").or_else(|| r.strip_prefix("http://")) {
        let rest = rest.rsplit_once('@').map_or(rest, |(_, h)| h);
        rest.split_once('/')?
    } else if let Some(rest) = r.strip_prefix("ssh://") {
        let rest = rest.rsplit_once('@').map_or(rest, |(_, h)| h);
        let (host, repo) = rest.split_once('/')?;
        (host.split(':').next()?, repo)
    } else {
        let rest = r.rsplit_once('@').map_or(r, |(_, h)| h);
        rest.split_once(':')?
    };
    (!host.is_empty() && !repo.is_empty()).then(|| format!("https://{host}/{repo}"))
}

fn encode_segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
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
        (dir, dunce(&root))
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
        assert_eq!(wt.path, dunce(&root.with_file_name("proj.worktrees").join("feat-a")));
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
    fn changes_against_a_base() {
        let (_tmp, root) = repo();
        let base = rev(&root, "HEAD").unwrap();
        fs::write(root.join("a.txt"), "changed\n").unwrap();
        fs::write(root.join("ç novo.txt"), "x").unwrap();
        fs::create_dir(root.join("d")).unwrap();
        fs::write(root.join("d/b.txt"), "b").unwrap();
        git(&root).args(["add", "d/b.txt"]).output().unwrap();
        git(&root).args(["commit", "-q", "-m", "b"]).output().unwrap();
        let kinds: Vec<_> = changes(&root, &base).unwrap().into_iter().map(|c| (c.path, c.kind)).collect();
        assert_eq!(
            kinds,
            [
                ("a.txt".to_string(), ChangeKind::Modified),
                ("d/b.txt".to_string(), ChangeKind::Added),
                ("ç novo.txt".to_string(), ChangeKind::Added),
            ]
        );
        assert_eq!(show(&root, &base, "a.txt").unwrap().as_deref(), Some("a\n"));
        assert_eq!(show(&root, &base, "d/b.txt").unwrap(), None);
        let head = rev(&root, "HEAD").unwrap();
        assert_eq!(merge_base(&root, &head, &base).as_deref(), Some(base.as_str()));
    }

    #[test]
    fn history_follows_renames() {
        let (_tmp, root) = repo();
        fs::write(root.join("a.txt"), "a2\n").unwrap();
        git(&root).args(["commit", "-qam", "second"]).output().unwrap();
        git(&root).args(["mv", "a.txt", "b c.txt"]).output().unwrap();
        git(&root).args(["commit", "-qm", "rename"]).output().unwrap();
        let h = file_history(&root, "b c.txt", 50).unwrap();
        let got: Vec<_> = h.iter().map(|c| (c.subject.as_str(), c.path.as_str())).collect();
        assert_eq!(got, [("rename", "b c.txt"), ("second", "a.txt"), ("init", "a.txt")]);
        assert_eq!(show(&root, &format!("{}^", h[1].hash), &h[1].path).unwrap().as_deref(), Some("a\n"));
        assert!(h[0].time_ms > 0);
    }

    #[test]
    fn web_links() {
        for (remote, base) in [
            ("git@github.com:me/aurora.git", "https://github.com/me/aurora"),
            ("https://github.com/me/aurora.git", "https://github.com/me/aurora"),
            ("https://token@github.com/me/aurora", "https://github.com/me/aurora"),
            ("ssh://git@gitlab.com:2222/g/sub/r.git", "https://gitlab.com/g/sub/r"),
        ] {
            assert_eq!(web_base(remote).as_deref(), Some(base), "{remote}");
        }
        assert_eq!(web_base("/local/path"), None);
        let (_tmp, root) = repo();
        git(&root).args(["remote", "add", "origin", "git@github.com:me/aurora.git"]).output().unwrap();
        let sha = rev(&root, "HEAD").unwrap();
        // Not pushed: the commit, so the link points at something that exists.
        assert_eq!(
            share_link(&root, "a b.txt").unwrap(),
            format!("https://github.com/me/aurora/blob/{sha}/a%20b.txt")
        );
    }

    #[test]
    fn worktrees_with_their_changes() {
        let (_tmp, root) = repo();
        let wt = worktree_add(&root, "feat").unwrap().path;
        fs::write(root.join("mine.txt"), "x").unwrap();
        fs::write(root.join("a.txt"), "edited by hand\n").unwrap();
        git(&root).args(["mv", "a.txt", "moved.txt"]).output().unwrap();
        let list = worktree_statuses(&wt).unwrap();
        let got: Vec<_> = list.iter().map(|w| (w.branch.as_str(), w.main, w.changed)).collect();
        // Main: the rename (one entry) and the untracked file; the new worktree is clean.
        assert_eq!(got, [("main", true, Some(2)), ("feat", false, Some(0))]);
        fs::remove_dir_all(&wt).unwrap();
        assert_eq!(worktree_statuses(&root).unwrap()[1].changed, None);
    }

    #[test]
    fn not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(repo_root(dir.path()).is_none());
        assert!(matches!(worktree_add(dir.path(), "x"), Err(Error::NotRepo(_))));
    }
}
