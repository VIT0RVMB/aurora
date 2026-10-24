use std::path::{Component, Path, PathBuf};

use crate::{Error, Result};

/// Joins a workspace-relative path onto `root`, rejecting anything that could
/// escape it (absolute paths, `..`, drive prefixes).
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel);
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(Error::OutsideRoot(rel.to_string())),
        }
    }
    Ok(root.join(p))
}

/// Converts an absolute path under `root` into the `/`-separated relative form.
pub fn to_rel(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let mut out = String::new();
    for c in rel.components() {
        if let Component::Normal(s) = c {
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(&s.to_string_lossy());
        }
    }
    Some(out)
}

pub fn is_git_dir(name: &std::ffi::OsStr) -> bool {
    name == ".git"
}

/// Number of UTF-16 code units in `s`; JS string offsets are in these units.
pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        let root = Path::new("/ws");
        assert!(resolve(root, "../etc/passwd").is_err());
        assert!(resolve(root, "a/../../b").is_err());
        assert!(resolve(root, "/etc/passwd").is_err());
        assert_eq!(resolve(root, "src/main.rs").unwrap(), root.join("src/main.rs"));
        assert_eq!(resolve(root, "").unwrap(), root.to_path_buf());
    }

    #[test]
    fn to_rel_uses_forward_slashes() {
        let root = Path::new("/ws");
        assert_eq!(to_rel(root, &root.join("a").join("b.txt")).unwrap(), "a/b.txt");
        assert_eq!(to_rel(root, root).unwrap(), "");
        assert!(to_rel(root, Path::new("/other")).is_none());
    }

    #[test]
    fn utf16_counts_surrogates() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("é"), 1);
        assert_eq!(utf16_len("😀"), 2);
    }
}
