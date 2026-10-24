//! `aurora-sessiond`: owns the agents' PTYs so they outlive the app.

mod db;
pub mod notify;
mod ring;
mod server;
mod title;

pub use server::{Config, ServeError, serve};
