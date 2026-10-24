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
}

/// Walker configured the same way everywhere: dotfiles shown, `.git` hidden,
/// `.gitignore`/`.ignore`/global excludes respected.
pub(crate) fn walker(dir: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(dir);
    b.hidden(false).follow_links(false).filter_entry(|e| !paths::is_git_dir(e.file_name()));
    b
}

/// Lists one directory level. Only metadata is read, never file contents.
pub fn list_dir(root: &Path, dir: &Path) -> Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for entry in walker(dir).max_depth(Some(1)).build() {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let Some(path) = paths::to_rel(root, entry.path()) else { continue };
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path,
            is_dir: entry.file_type().is_some_and(|t| t.is_dir()),
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
    fn lists_sorted_and_respects_gitignore() {
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

        let top: Vec<_> = list_dir(root, root).unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(top, vec!["src", ".gitignore", "README.md"]);

        let src = list_dir(root, &root.join("src")).unwrap();
        let names: Vec<_> = src.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(names, vec!["src/nested", "src/A.rs", "src/b.rs"]);
        assert!(src[0].is_dir);
    }
}
