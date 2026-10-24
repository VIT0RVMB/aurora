use std::path::Path;

use ignore::WalkState;
use nucleo_matcher::{
    Config, Matcher, Utf32Str,
    pattern::{CaseMatching, Normalization, Pattern},
};
use parking_lot::Mutex;
use serde::Serialize;

use crate::{paths, tree::walker};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyMatch {
    pub path: String,
    pub score: u32,
    /// Matched positions as UTF-16 offsets into `path`, ascending.
    pub indices: Vec<u32>,
}

/// Collects every non-ignored file under `root`, sorted, using a parallel walk.
pub fn build(root: &Path) -> Vec<String> {
    let files = Mutex::new(Vec::new());
    walker(root).build_parallel().run(|| {
        let files = &files;
        Box::new(move |entry| {
            if let Ok(entry) = entry
                && entry.file_type().is_some_and(|t| t.is_file())
                && let Some(rel) = paths::to_rel(root, entry.path())
            {
                files.lock().push(rel);
            }
            WalkState::Continue
        })
    });
    let mut files = files.into_inner();
    files.sort_unstable();
    files
}

/// Ranks `files` against an fzf-style `query` (smart case, `'exact`, `^prefix`,
/// `suffix$`, `!negation`). Only the top `limit` get match indices computed.
pub fn fuzzy(files: &[String], query: &str, limit: usize) -> Vec<FuzzyMatch> {
    if query.trim().is_empty() {
        return files
            .iter()
            .take(limit)
            .map(|p| FuzzyMatch { path: p.clone(), score: 0, indices: Vec::new() })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();

    let mut scored: Vec<(u32, &String)> = files
        .iter()
        .filter_map(|p| pattern.score(Utf32Str::new(p, &mut buf), &mut matcher).map(|s| (s, p)))
        .collect();
    let by_rank = |a: &(u32, &String), b: &(u32, &String)| {
        b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(b.1))
    };
    if scored.len() > limit {
        scored.select_nth_unstable_by(limit, by_rank);
        scored.truncate(limit);
    }
    scored.sort_unstable_by(by_rank);

    let mut idx = Vec::new();
    scored
        .into_iter()
        .map(|(score, p)| {
            idx.clear();
            pattern.indices(Utf32Str::new(p, &mut buf), &mut matcher, &mut idx);
            idx.sort_unstable();
            idx.dedup();
            FuzzyMatch { path: p.clone(), score, indices: char_to_utf16(p, &idx) }
        })
        .collect()
}

fn char_to_utf16(s: &str, char_idx: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(char_idx.len());
    let mut want = char_idx.iter().peekable();
    let mut u16_off = 0u32;
    for (ci, ch) in s.chars().enumerate() {
        let Some(&&next) = want.peek() else { break };
        if next as usize == ci {
            out.push(u16_off);
            want.next();
        }
        u16_off += ch.len_utf16() as u32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ranks_filename_matches_first() {
        let f = files(&["docs/main_notes.md", "src/main.rs", "src/domain/manifest.rs"]);
        let r = fuzzy(&f, "main.rs", 10);
        assert_eq!(r[0].path, "src/main.rs");
        assert!(r.iter().all(|m| m.path != "docs/main_notes.md" || m.score < r[0].score));
    }

    #[test]
    fn indices_are_utf16_offsets() {
        let f = files(&["ação/😀x.rs"]);
        let r = fuzzy(&f, "x", 10);
        // "ação/" is 5 UTF-16 units, the emoji takes 2 more.
        assert_eq!(r[0].indices, vec![7]);
    }

    #[test]
    fn empty_query_and_limit() {
        let f = files(&["a", "b", "c"]);
        assert_eq!(fuzzy(&f, "", 2).len(), 2);
        let many: Vec<String> = (0..1000).map(|i| format!("dir/file{i}.txt")).collect();
        let r = fuzzy(&many, "file9", 5);
        assert_eq!(r.len(), 5);
        assert!(r.windows(2).all(|w| w[0].score >= w[1].score));
    }

    #[test]
    fn build_skips_ignored_and_git() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::write(root.join(".git/HEAD"), "").unwrap();
        fs::write(root.join(".gitignore"), "out/\n").unwrap();
        fs::create_dir_all(root.join("out")).unwrap();
        fs::write(root.join("out/x.js"), "").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "").unwrap();
        assert_eq!(build(root), vec![".gitignore", "src/lib.rs"]);
    }
}
