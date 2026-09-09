use knorvia_control::ControlPlane;
use knorvia_daemon::SharedClient;
use knorvia_protocol::{PRODUCT_NAME, ProtocolError};
use serde_json::{Value, json};
use std::path::Path;

pub const CLI_NAME: &str = "knorvia";
pub const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version_line() -> String {
    format!("{CLI_NAME} {CLI_VERSION} ({PRODUCT_NAME})")
}

pub fn open_control(home: Option<&Path>) -> Result<SharedClient, ProtocolError> {
    SharedClient::connect(home)
}

pub trait ProtocolConnection {
    fn handle_json(&mut self, body: &str) -> Result<Option<String>, ProtocolError>;
}

impl ProtocolConnection for SharedClient {
    fn handle_json(&mut self, body: &str) -> Result<Option<String>, ProtocolError> {
        SharedClient::handle_json(self, body)
    }
}

impl ProtocolConnection for ControlPlane {
    fn handle_json(&mut self, body: &str) -> Result<Option<String>, ProtocolError> {
        ControlPlane::handle_json(self, body)
    }
}

pub fn ready_session(
    plane: &mut impl ProtocolConnection,
    client_name: &str,
) -> Result<Value, ProtocolError> {
    let init = json!({
        "jsonrpc": "2.0",
        "id": "cli-init",
        "method": "initialize",
        "params": {
            "protocol": {"major": 1, "minor": 0},
            "client": {
                "name": client_name,
                "version": CLI_VERSION,
                "platform": std::env::consts::OS
            },
            "capabilities": ["thread", "artifact", "job", "approval", "reconnect", "workspace", "provider", "migration"]
        }
    });
    let resp = plane.handle_json(&init.to_string())?.ok_or_else(|| {
        ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, "no init result")
    })?;
    let v: Value = serde_json::from_str(&resp).map_err(|e| {
        ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, e.to_string())
    })?;
    if v.get("error").is_some() {
        return Err(ProtocolError::new(
            knorvia_protocol::ErrorCategory::Internal,
            v.to_string(),
        ));
    }
    let _ = plane.handle_json(&json!({"jsonrpc":"2.0","method":"initialized"}).to_string())?;
    Ok(v["result"].clone())
}

pub fn rpc(
    plane: &mut impl ProtocolConnection,
    id: &str,
    method: &str,
    params: Value,
) -> Result<Value, ProtocolError> {
    let req = json!({"jsonrpc":"2.0","id": id, "method": method, "params": params});
    let resp = plane.handle_json(&req.to_string())?.ok_or_else(|| {
        ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, "no result")
    })?;
    let v: Value = serde_json::from_str(&resp).map_err(|e| {
        ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, e.to_string())
    })?;
    if let Some(err) = v.get("error") {
        return Err(
            serde_json::from_value(err.get("data").unwrap_or(err).clone()).unwrap_or_else(|_| {
                ProtocolError::new(knorvia_protocol::ErrorCategory::Internal, err.to_string())
            }),
        );
    }
    Ok(v["result"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use knorvia_platform_paths::layout;

    #[test]
    fn version_is_knorvia_not_codex() {
        let v = version_line();
        assert!(v.starts_with("knorvia "));
        assert!(v.contains("Knorvia"));
        assert!(!v.to_lowercase().contains("codex"));
        assert!(!v.contains("OpenAI"));
    }

    #[test]
    fn cli_creates_workspace_under_knorvia_home_only() {
        let base = std::env::temp_dir().join(format!(
            "knorvia-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let mut plane = ControlPlane::open(layout(base.clone())).unwrap();
        ready_session(&mut plane, "knorvia_cli").unwrap();
        let ws = rpc(
            &mut plane,
            "1",
            "workspace/create",
            json!({"title": "from-cli"}),
        )
        .unwrap();
        assert!(ws["id"].as_str().unwrap().starts_with("ws_"));
        assert!(base.join("state").is_dir());
        let _ = std::fs::remove_dir_all(base);
    }
}
