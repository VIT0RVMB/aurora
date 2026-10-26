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

/// Images a markdown file may embed, by extension.
const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("svg", "image/svg+xml"),
];
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// An image as a `data:` URL, for `<img>` in the webview (an SVG shown that
/// way runs no scripts). `None` when the extension is not an image type.
pub fn read_image(path: &Path) -> Result<Option<String>> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let Some((_, mime)) = IMAGE_TYPES.iter().find(|(e, _)| *e == ext) else { return Ok(None) };
    let st = stat(path)?;
    if st.size > MAX_IMAGE_BYTES {
        return Err(Error::TooLarge(st.size));
    }
    let bytes = fs::read(path)?;
    Ok(Some(format!("data:{mime};base64,{}", base64(&bytes))))
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
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

    #[test]
    fn images_become_data_urls() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.PNG");
        fs::write(&png, b"foo").unwrap();
        assert_eq!(read_image(&png).unwrap().as_deref(), Some("data:image/png;base64,Zm9v"));
        assert_eq!(read_image(&dir.path().join("a.txt")).unwrap(), None);
    }
}
