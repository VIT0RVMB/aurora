//! Handing things to the system: links to the browser or mail, files to their
//! default app, folders to the file manager.

use std::{
    path::Path,
    process::{Command, Stdio},
};

use crate::{Error, Result};

/// Only web and mail links, without spaces or control characters, so the
/// URL can't turn into a file path or an option for the opener.
pub fn is_openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub fn open_url(url: &str) -> Result<()> {
    if !is_openable(url) {
        return Err(Error::BadName(url.to_string()));
    }
    let mut cmd = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(windows) {
        // `start` would read `&` in a URL as a command separator.
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        Command::new("xdg-open")
    };
    cmd.arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    Ok(())
}

fn spawn(mut cmd: Command) -> Result<()> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    Ok(())
}

/// Opens a file (or folder) in whatever the system opens it with.
pub fn open_path(path: &Path) -> Result<()> {
    std::fs::symlink_metadata(path)?;
    let mut cmd = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(windows) {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        Command::new("xdg-open")
    };
    cmd.arg(path);
    spawn(cmd)
}

/// Shows a file in the file manager, selected where the platform allows it.
pub fn reveal(path: &Path) -> Result<()> {
    std::fs::symlink_metadata(path)?;
    if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg("-R").arg(path);
        spawn(c)
    } else if cfg!(windows) {
        let mut c = Command::new("explorer");
        c.arg(format!("/select,{}", path.display()));
        spawn(c)
    } else {
        // No portable "select this file": open its folder.
        let mut c = Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(path));
        spawn(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_mail() {
        assert!(is_openable("https://example.com/a?b=1&c=2"));
        assert!(is_openable("mailto:a@b.c"));
        assert!(!is_openable("file:///etc/passwd"));
        assert!(!is_openable("javascript:alert(1)"));
        assert!(!is_openable("https://x.com -a Calculator"));
        assert!(!is_openable("/Applications/Calculator.app"));
    }
}
