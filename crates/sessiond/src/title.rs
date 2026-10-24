//! Window titles set by the program in the PTY (`ESC ] 0 ; text BEL`, or
//! `2` instead of `0`, or `ESC \` as terminator). Claude Code puts the topic
//! of the conversation there, like Ghostty's tab title shows.

/// Longest title kept; anything longer is cut.
const MAX_TITLE: usize = 120;
/// A sequence this long without a terminator is garbage, not a title.
const MAX_PENDING: usize = 4096;

#[derive(Default)]
pub struct TitleScanner {
    /// Bytes of a sequence split across reads.
    pending: Vec<u8>,
}

impl TitleScanner {
    /// Returns the last complete title in `chunk`, cleaned, if any.
    pub fn feed(&mut self, chunk: &[u8]) -> Option<String> {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(chunk);
        let mut found = None;
        let mut i = 0;
        while let Some(start) = find(&data[i..], b"\x1b]").map(|p| p + i) {
            let body = start + 2;
            // Need at least "0;" to know what kind of OSC this is.
            if data.len() < body + 2 {
                self.keep(&data[start..]);
                return found;
            }
            if !matches!(&data[body..body + 2], b"0;" | b"2;") {
                i = body;
                continue;
            }
            let text_start = body + 2;
            match terminator(&data[text_start..]) {
                Some((len, skip)) => {
                    found = Some(clean(&String::from_utf8_lossy(&data[text_start..text_start + len])));
                    i = text_start + len + skip;
                }
                None => {
                    self.keep(&data[start..]);
                    return found.filter(|t: &String| !t.is_empty());
                }
            }
        }
        // A read may end right after the ESC of the next sequence.
        if data.last() == Some(&0x1b) {
            self.pending = vec![0x1b];
        }
        found.filter(|t| !t.is_empty())
    }

    fn keep(&mut self, rest: &[u8]) {
        if rest.len() <= MAX_PENDING {
            self.pending = rest.to_vec();
        }
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Length of the text and of its terminator (BEL or ST).
fn terminator(s: &[u8]) -> Option<(usize, usize)> {
    s.iter().enumerate().find_map(|(i, &b)| match b {
        0x07 => Some((i, 1)),
        0x1b if s.get(i + 1) == Some(&b'\\') => Some((i, 2)),
        _ => None,
    })
}

/// Drops the spinner or status glyph agents put in front ("✳ Fix login",
/// "⠐ Fix login") and control characters.
pub fn clean(raw: &str) -> String {
    let text: String = raw.chars().filter(|c| !c.is_control()).collect();
    let start = text.find(|c: char| c.is_alphanumeric()).unwrap_or(text.len());
    let t = text[start..].trim();
    match t.char_indices().nth(MAX_TITLE) {
        Some((cut, _)) => t[..cut].trim_end().to_string(),
        None => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_titles_with_both_terminators() {
        let mut s = TitleScanner::default();
        assert_eq!(
            s.feed(b"hello\x1b]0;\xe2\x9c\xb3 Fix login bug\x07more").as_deref(),
            Some("Fix login bug")
        );
        assert_eq!(s.feed(b"\x1b]2;Refactor\x1b\\").as_deref(), Some("Refactor"));
        // The last one wins.
        assert_eq!(s.feed(b"\x1b]0;a1\x07\x1b]0;b2\x07").as_deref(), Some("b2"));
    }

    #[test]
    fn joins_sequences_split_across_reads() {
        let mut s = TitleScanner::default();
        assert_eq!(s.feed(b"x\x1b]0;Split ti"), None);
        assert_eq!(s.feed(b"tle\x07").as_deref(), Some("Split title"));
        assert_eq!(s.feed(b"\x1b"), None);
        assert_eq!(s.feed(b"]"), None);
        assert_eq!(s.feed(b"2;ok\x07").as_deref(), Some("ok"));
    }

    #[test]
    fn ignores_other_osc_and_empty_titles() {
        let mut s = TitleScanner::default();
        // OSC 11 is a color query, OSC 7 a cwd report.
        assert_eq!(s.feed(b"\x1b]11;?\x07\x1b]7;file:///tmp\x07"), None);
        assert_eq!(s.feed(b"\x1b]0;\xe2\xa0\x90 \x07"), None);
    }

    #[test]
    fn cleans() {
        assert_eq!(clean("⠂  Investigar travamento "), "Investigar travamento");
        assert_eq!(clean("Claude Code"), "Claude Code");
        assert_eq!(clean(&"x".repeat(300)).len(), 120);
    }
}
