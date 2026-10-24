//! Local socket: a Unix domain socket on Linux/macOS (std only), a named pipe
//! on Windows (`interprocess`). Both sides read and write through `&Stream`
//! from different threads.

use std::io;

#[cfg(unix)]
pub type Stream = std::os::unix::net::UnixStream;
#[cfg(windows)]
pub type Stream = interprocess::local_socket::Stream;

#[cfg(unix)]
pub fn connect(endpoint: &str) -> io::Result<Stream> {
    Stream::connect(endpoint)
}

#[cfg(windows)]
pub fn connect(endpoint: &str) -> io::Result<Stream> {
    use interprocess::local_socket::prelude::*;
    Stream::connect(name(endpoint)?)
}

/// Ends both directions so threads blocked on the stream wake up.
pub fn shutdown(_s: &Stream) {
    #[cfg(unix)]
    let _ = _s.shutdown(std::net::Shutdown::Both);
}

#[cfg(windows)]
fn name(endpoint: &str) -> io::Result<interprocess::local_socket::Name<'_>> {
    use interprocess::local_socket::{GenericNamespaced, prelude::*};
    endpoint.to_ns_name::<GenericNamespaced>()
}

pub struct Listener {
    #[cfg(unix)]
    inner: std::os::unix::net::UnixListener,
    #[cfg(windows)]
    inner: interprocess::local_socket::Listener,
}

impl Listener {
    /// The caller must hold the daemon lock: a stale socket file is replaced.
    pub fn bind(endpoint: &str) -> io::Result<Listener> {
        #[cfg(unix)]
        {
            match std::fs::remove_file(endpoint) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            let inner = std::os::unix::net::UnixListener::bind(endpoint)?;
            // Only this user may talk to the daemon.
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;
            Ok(Listener { inner })
        }
        #[cfg(windows)]
        {
            use interprocess::local_socket::ListenerOptions;
            let inner = ListenerOptions::new().name(name(endpoint)?).create_sync()?;
            Ok(Listener { inner })
        }
    }

    pub fn accept(&self) -> io::Result<Stream> {
        #[cfg(unix)]
        {
            self.inner.accept().map(|(s, _)| s)
        }
        #[cfg(windows)]
        {
            use interprocess::local_socket::traits::Listener as _;
            self.inner.accept()
        }
    }
}
