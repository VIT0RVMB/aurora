use std::{fs, io::Read, path::Path, time::UNIX_EPOCH};

use serde::Serialize;

use crate::{Error, Result};

/// Larger files are refused: the editor is not meant for logs or dumps.
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub stat: FileStat,
}

pub fn stat(path: &Path) -> Result<FileStat> {
    let meta = fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat { mtime_ms, size: meta.len() })
}

pub fn read_text(path: &Path) -> Result<FileContent> {
    let st = stat(path)?;
    if st.size > MAX_FILE_BYTES {
        return Err(Error::TooLarge(st.size));
    }
    let mut bytes = Vec::with_capacity(st.size as usize);
    fs::File::open(path)?.read_to_end(&mut bytes)?;
    if bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) {
        return Err(Error::Binary);
    }
    let content = String::from_utf8(bytes).map_err(|_| Error::NotUtf8)?;
    Ok(FileContent { content, stat: st })
}

pub fn write_text(path: &Path, content: &str) -> Result<FileStat> {
    fs::write(path, content)?;
    stat(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_detection() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        let st = write_text(&p, "olá\r\nmundo").unwrap();
        let fc = read_text(&p).unwrap();
        assert_eq!(fc.content, "olá\r\nmundo");
        assert_eq!(fc.stat, st);

        let bin = dir.path().join("b.bin");
        fs::write(&bin, [1u8, 0, 2]).unwrap();
        assert!(matches!(read_text(&bin), Err(Error::Binary)));

        let latin = dir.path().join("c.txt");
        fs::write(&latin, [0xe9u8, b'a']).unwrap();
        assert!(matches!(read_text(&latin), Err(Error::NotUtf8)));
    }
}
