use serde::{Serialize, Serializer, ser::SerializeStruct};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("path outside the workspace: {0}")]
    OutsideRoot(String),
    #[error("not a folder: {0}")]
    NotDir(String),
    #[error("binary file")]
    Binary,
    #[error("file is not UTF-8")]
    NotUtf8,
    #[error("file too large ({0} bytes)")]
    TooLarge(u64),
    #[error("invalid search pattern: {0}")]
    BadPattern(String),
    #[error("watcher: {0}")]
    Watch(String),
    #[error("git: {0}")]
    Git(String),
    #[error("not a git repository: {0}")]
    NotRepo(String),
    #[error("worktree has uncommitted changes: {0}")]
    DirtyWorktree(String),
    #[error("invalid name: {0}")]
    BadName(String),
    #[error("sessiond: {0}")]
    Session(String),
    #[error("sessiond unavailable: {0}")]
    Daemon(String),
    #[error("theme: {0}")]
    BadTheme(String),
    #[error("already exists: {0}")]
    Exists(String),
}

impl Error {
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Io(e) if e.kind() == std::io::ErrorKind::NotFound => "not_found",
            Error::Io(_) => "io",
            Error::OutsideRoot(_) => "outside_root",
            Error::NotDir(_) => "not_dir",
            Error::Binary => "binary",
            Error::NotUtf8 => "not_utf8",
            Error::TooLarge(_) => "too_large",
            Error::BadPattern(_) => "bad_pattern",
            Error::Watch(_) => "watch",
            Error::Git(_) => "git",
            Error::NotRepo(_) => "not_repo",
            Error::DirtyWorktree(_) => "dirty_worktree",
            Error::BadName(_) => "bad_name",
            Error::Session(_) => "session",
            Error::Daemon(_) => "daemon",
            Error::BadTheme(_) => "bad_theme",
            Error::Exists(_) => "exists",
        }
    }
}

impl Error {
    /// The variable part of the message, so the UI can translate the rest.
    pub fn detail(&self) -> Option<String> {
        match self {
            Error::Io(_) | Error::Binary | Error::NotUtf8 => None,
            Error::TooLarge(n) => Some(n.to_string()),
            Error::OutsideRoot(s)
            | Error::NotDir(s)
            | Error::BadPattern(s)
            | Error::Watch(s)
            | Error::Git(s)
            | Error::NotRepo(s)
            | Error::DirtyWorktree(s)
            | Error::BadName(s)
            | Error::Session(s)
            | Error::Daemon(s)
            | Error::BadTheme(s)
            | Error::Exists(s) => Some(s.clone()),
        }
    }
}

/// Serialized as `{ kind, message, detail }` so the UI can branch on `kind`
/// and show the message in its own language.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Error", 3)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("detail", &self.detail())?;
        st.end()
    }
}
