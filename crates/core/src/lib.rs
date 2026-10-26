//! Aurora core: workspace logic with no Tauri dependency.
//!
//! Every path crossing this API is relative to the workspace root and uses `/`
//! as separator, so the UI never deals with platform paths.

mod error;
mod fs;
pub mod git;
mod index;
pub mod open;
mod paths;
mod search;
pub mod session;
mod tree;
mod watch;
mod workspace;

pub use error::{Error, Result};
pub use fs::{FileContent, FileStat, MAX_FILE_BYTES};
pub use index::FuzzyMatch;
pub use search::{FileMatches, LineMatch, SearchOptions, SearchResults};
pub use tree::DirEntry;
pub use watch::FsBatch;
pub use workspace::Workspace;
