use std::{
    path::Path,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, SearcherBuilder, sinks::UTF8};
use ignore::WalkState;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::{Error, Result, paths, tree::walker};

/// Lines longer than this are cut to a window around the first match.
const MAX_LINE_BYTES: usize = 300;
const CONTEXT_BEFORE: usize = 40;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub regex: bool,
    /// When false, case is smart: insensitive unless the query has uppercase.
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub max_results: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self { regex: false, case_sensitive: false, whole_word: false, max_results: 2000 }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based.
    pub line: u64,
    pub text: String,
    /// `[start, end)` in UTF-16 units of `text`.
    pub ranges: Vec<[u32; 2]>,
    /// UTF-16 offset of the first match in the original, untrimmed line.
    pub column: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub lines: Vec<LineMatch>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<FileMatches>,
    pub total: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

/// Searches every non-ignored text file under `root`. `cancelled` is polled per
/// file and per line so a newer search can stop this one.
pub fn search(
    root: &Path,
    query: &str,
    opts: &SearchOptions,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<SearchResults> {
    if query.is_empty() {
        return Ok(SearchResults::default());
    }
    let matcher = RegexMatcherBuilder::new()
        .case_smart(!opts.case_sensitive)
        .word(opts.whole_word)
        .fixed_strings(!opts.regex)
        .line_terminator(Some(b'\n'))
        .build(query)
        .map_err(|e| Error::BadPattern(e.to_string()))?;

    let total = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let stop = AtomicBool::new(false);
    let found = Mutex::new(Vec::<FileMatches>::new());

    walker(root).build_parallel().run(|| {
        let matcher = matcher.clone();
        let (total, truncated, stop, found) = (&total, &truncated, &stop, &found);
        let mut searcher =
            SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).line_number(true).build();
        Box::new(move |entry| {
            if stop.load(Ordering::Relaxed) || cancelled() {
                stop.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let mut lines = Vec::new();
            let _ = searcher.search_path(
                &matcher,
                entry.path(),
                UTF8(|lnum, line| {
                    if total.fetch_add(1, Ordering::Relaxed) >= opts.max_results {
                        truncated.store(true, Ordering::Relaxed);
                        stop.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    let line = line.trim_end_matches(['\n', '\r']);
                    let mut spans = Vec::new();
                    matcher.find_iter(line.as_bytes(), |m| {
                        spans.push((m.start(), m.end()));
                        true
                    })?;
                    lines.push(line_match(lnum, line, &spans));
                    Ok(!cancelled())
                }),
            );
            if !lines.is_empty()
                && let Some(path) = paths::to_rel(root, entry.path())
            {
                found.lock().push(FileMatches { path, lines });
            }
            if stop.load(Ordering::Relaxed) { WalkState::Quit } else { WalkState::Continue }
        })
    });

    let mut files = found.into_inner();
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let truncated = truncated.load(Ordering::Relaxed);
    let total = files.iter().map(|f| f.lines.len()).sum();
    Ok(SearchResults { files, total, truncated, cancelled: cancelled() })
}

fn line_match(lnum: u64, line: &str, spans: &[(usize, usize)]) -> LineMatch {
    let first = spans.first().map_or(0, |s| s.0);
    let column = paths::utf16_len(&line[..first]);
    let (start, end, prefix) = if line.len() <= MAX_LINE_BYTES {
        (0, line.len(), "")
    } else {
        let s = floor_char(line, first.saturating_sub(CONTEXT_BEFORE));
        let e = floor_char(line, (s + MAX_LINE_BYTES).min(line.len()));
        (s, e, if s > 0 { "…" } else { "" })
    };
    let window = &line[start..end];
    let shift = paths::utf16_len(prefix);
    let ranges = spans
        .iter()
        .filter(|(s, e)| *s >= start && *e <= end)
        .map(|(s, e)| {
            let a = shift + paths::utf16_len(&line[start..*s]);
            [a, a + paths::utf16_len(&line[*s..*e])]
        })
        .collect();
    LineMatch { line: lnum, text: format!("{prefix}{window}"), ranges, column }
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn ws() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        fs::create_dir(r.join(".git")).unwrap();
        fs::write(r.join(".gitignore"), "dist/\n").unwrap();
        fs::create_dir_all(r.join("src")).unwrap();
        fs::create_dir_all(r.join("dist")).unwrap();
        fs::write(r.join("src/a.rs"), "fn main() {}\nlet Main = 1;\n").unwrap();
        fs::write(r.join("src/b.txt"), "domain\nmain main\n").unwrap();
        fs::write(r.join("dist/out.js"), "main").unwrap();
        fs::write(r.join("bin.dat"), b"main\0\x01").unwrap();
        dir
    }

    fn never() -> bool {
        false
    }

    #[test]
    fn smart_case_literal_and_ignored() {
        let d = ws();
        let r = search(d.path(), "main", &SearchOptions::default(), &never).unwrap();
        let paths: Vec<_> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["src/a.rs", "src/b.txt"]);
        assert_eq!(r.total, 4);
        let b = &r.files[1].lines[1];
        assert_eq!((b.line, b.ranges.clone()), (2, vec![[0, 4], [5, 9]]));

        let upper = search(d.path(), "Main", &SearchOptions::default(), &never).unwrap();
        assert_eq!(upper.total, 1);
    }

    #[test]
    fn word_regex_and_limit() {
        let d = ws();
        let word = SearchOptions { whole_word: true, ..Default::default() };
        let r = search(d.path(), "main", &word, &never).unwrap();
        assert_eq!(r.total, 3); // "domain" excluded

        let re = SearchOptions { regex: true, ..Default::default() };
        let r = search(d.path(), r"fn \w+", &re, &never).unwrap();
        assert_eq!(r.total, 1);
        assert!(search(d.path(), "(", &re, &never).is_err());

        let lim = SearchOptions { max_results: 2, ..Default::default() };
        let r = search(d.path(), "main", &lim, &never).unwrap();
        assert!(r.truncated && r.total <= 2);
    }

    #[test]
    fn cancellation_stops_early() {
        let d = ws();
        let r = search(d.path(), "main", &SearchOptions::default(), &|| true).unwrap();
        assert!(r.cancelled);
        assert_eq!(r.total, 0);
    }

    #[test]
    fn long_lines_are_windowed() {
        let line = format!("{}needle{}", "é".repeat(200), "x".repeat(400));
        let m = line_match(1, &line, &[(400, 406)]);
        assert!(m.text.starts_with('…'));
        let [a, b] = m.ranges[0];
        let text16: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&text16[a as usize..b as usize]).unwrap(), "needle");
        assert_eq!(m.column, 200);
    }
}
