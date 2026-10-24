use std::collections::VecDeque;

/// Bounded output history. When full, the oldest bytes go first, and the cut
/// moves to the next line break so replay rarely starts mid escape sequence.
pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring { buf: VecDeque::new(), cap }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
        } else {
            self.buf.extend(data);
        }
        if self.buf.len() > self.cap {
            let mut cut = self.buf.len() - self.cap;
            let window = self.buf.range(cut..).take(4096);
            if let Some(nl) = window.into_iter().position(|&b| b == b'\n') {
                cut += nl + 1;
            }
            self.buf.drain(..cut);
        }
    }

    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        [a, b].concat()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_tail_and_cuts_at_newline() {
        let mut r = Ring::new(10);
        r.push(b"abc\n");
        r.push(b"defgh\nij");
        // Over by 2 bytes: the cut slides to after the first "\n".
        assert_eq!(r.snapshot(), b"defgh\nij");
    }

    #[test]
    fn huge_push_keeps_last_cap_bytes() {
        let mut r = Ring::new(4);
        r.push(b"0123456789");
        assert_eq!(r.snapshot(), b"6789");
    }
}
