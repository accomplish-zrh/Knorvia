use knorvia_control::ControlPlane;
use knorvia_platform_paths::{KnorviaPaths, resolve};
use knorvia_protocol::ProtocolError;
use std::path::Path;

mod endpoint;
mod shared_client;
mod shared_server;
pub use shared_client::SharedClient;

pub fn open_plane(home: Option<&Path>) -> Result<(KnorviaPaths, ControlPlane), ProtocolError> {
    let paths = resolve_home(home)?;
    let plane = ControlPlane::open(paths.clone())?;
    Ok((paths, plane))
}

fn resolve_home(home: Option<&Path>) -> Result<KnorviaPaths, ProtocolError> {
    let paths = resolve(home).map_err(|e| {
        knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::Internal,
            e.to_string(),
        )
    })?;
    if knorvia_platform_paths::is_codex_path(&paths.home) {
        return Err(knorvia_protocol::ProtocolError::new(
            knorvia_protocol::ErrorCategory::Internal,
            "refusing to use a Codex path as Knorvia Home",
        ));
    }
    Ok(paths)
}

/// Each stdio process is a client proxy; disconnecting it cannot kill another
/// client's work. The separate owner retains the OS Home lock and scheduler.
pub fn run_stdio(home: Option<&Path>) -> Result<(), ProtocolError> {
    SharedClient::connect(home)?.proxy_stdio()
}

pub fn run_shared_owner(home: Option<&Path>) -> Result<(), ProtocolError> {
    shared_server::serve(resolve_home(home)?)
}
