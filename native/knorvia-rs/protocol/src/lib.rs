//! Knorvia Protocol v1: JSON-RPC 2.0 over LSP-style Content-Length frames.
//!
//! stdout carries protocol frames only. Logs belong on stderr.

mod error;
mod framing;
mod handshake;
mod ids;
mod sanitize;
mod types;

pub use error::*;
pub use framing::*;
pub use handshake::*;
pub use ids::*;
pub use sanitize::*;
pub use types::*;

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;
pub const JSONRPC_VERSION: &str = "2.0";
pub const SERVER_NAME: &str = "knorvia-daemon";
pub const PRODUCT_NAME: &str = "Knorvia";
pub const USER_AGENT: &str = "knorvia-daemon/0.1.0-dev";
pub const TELEMETRY_NAMESPACE: &str = "knorvia";
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
