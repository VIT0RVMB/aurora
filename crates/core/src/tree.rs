use std::collections::HashSet;
use std::path::Path;

use ignore::WalkBuilder;
use serde::Serialize;

use crate::{Result, paths};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Workspace-relative, `/`-separated.
    pub path: String,
    pub is_dir: bool,
    /// Ignored by git (`.gitignore`, `.ignore`, global excludes): listed, but
    /// left out of the fuzzy index and search.
    pub ignored: bool,
}

/// Never listed, like VS Code's default `files.exclude`.
const JUNK: [&str; 2] = [".DS_Store", "Thumbs.db"];

/// Walker configured the same way everywhere: dotfiles shown, `.git` hidden,
/// `.gitignore`/`.ignore`/global excludes respected.
pub(crate) fn walker(dir: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(dir);
    b.hidden(false).follow_links(false).filter_entry(|e| !paths::is_git_dir(e.file_name()));
    b
}

/// Lists one directory level, ignored entries included and marked (a `.env`
/// should still be openable). Only metadata is read, never file contents.
pub fn list_dir(root: &Path, dir: &Path) -> Result<Vec<DirEntry>> {
    let kept: HashSet<_> = walker(dir)
        .max_depth(Some(1))
        .build()
        .filter_map(|e| e.ok())
        .map(|e| e.into_path())
        .collect();
    let mut all = WalkBuilder::new(dir);
    all.standard_filters(false)
        .follow_links(false)
        .max_depth(Some(1))
        .filter_entry(|e| !paths::is_git_dir(e.file_name()) && !JUNK.iter().any(|j| e.file_name() == *j));
    let mut out = Vec::new();
    for entry in all.build() {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let Some(path) = paths::to_rel(root, entry.path()) else { continue };
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path,
            is_dir: entry.file_type().is_some_and(|t| t.is_dir()),
            ignored: !kept.contains(entry.path()),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_sorted_and_marks_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/b.rs"), "").unwrap();
        fs::write(root.join("src/A.rs"), "").unwrap();
        fs::write(root.join("src/debug.log"), "").unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::write(root.join(".DS_Store"), "").unwrap();

        let shown = |dir: &Path| -> Vec<String> {
            let list = list_dir(root, dir).unwrap();
            list.into_iter().map(|e| if e.ignored { format!("({})", e.path) } else { e.path }).collect()
        };
        assert_eq!(shown(root), vec!["src", "(target)", ".gitignore", "README.md"]);
        assert_eq!(shown(&root.join("src")), vec!["src/nested", "src/A.rs", "src/b.rs", "(src/debug.log)"]);
        assert!(list_dir(root, &root.join("src")).unwrap()[0].is_dir);
    }
}
