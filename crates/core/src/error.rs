use serde::{Serialize, Serializer, ser::SerializeStruct};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("caminho fora do workspace: {0}")]
    OutsideRoot(String),
    #[error("não é uma pasta: {0}")]
    NotDir(String),
    #[error("arquivo binário")]
    Binary,
    #[error("arquivo não está em UTF-8")]
    NotUtf8,
    #[error("arquivo grande demais ({0} bytes)")]
    TooLarge(u64),
    #[error("padrão de busca inválido: {0}")]
    BadPattern(String),
    #[error("watcher: {0}")]
    Watch(String),
    #[error("git: {0}")]
    Git(String),
    #[error("não é um repositório git: {0}")]
    NotRepo(String),
    #[error("worktree tem mudanças não commitadas: {0}")]
    DirtyWorktree(String),
    #[error("nome inválido: {0}")]
    BadName(String),
    #[error("sessiond: {0}")]
    Session(String),
    #[error("sessiond indisponível: {0}")]
    Daemon(String),
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
        }
    }
}

/// Serialized as `{ kind, message }` so the UI can branch on `kind`.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}
