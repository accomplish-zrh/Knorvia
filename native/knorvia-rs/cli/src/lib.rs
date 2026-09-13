use knorvia_control::ControlPlane;
use knorvia_daemon::SharedClient;
use knorvia_protocol::{PRODUCT_NAME, ProtocolError};
use serde_json::{Value, json};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

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

/// Retry an explicitly idempotent mutation once after a transport failure.
/// The new client attaches to the same Home owner and reuses the exact method,
/// key, and fingerprint, so the control ledger returns the original admission
/// rather than creating a second Turn.
pub fn rpc_idempotent_once(
    plane: &mut SharedClient,
    home: Option<&Path>,
    id: &str,
    method: &str,
    params: Value,
) -> Result<Value, ProtocolError> {
    match rpc(plane, id, method, params.clone()) {
        Ok(value) => Ok(value),
        Err(error) if error.category == knorvia_protocol::ErrorCategory::Transient => {
            let mut reattached = open_control(home)?;
            ready_session(&mut reattached, "knorvia_cli_retry")?;
            let result = rpc(&mut reattached, id, method, params);
            *plane = reattached;
            result
        }
        Err(error) => Err(error),
    }
}

/// Stable machine states emitted by the native Turn CLI. A pending approval or
/// user-input request is surfaced as attention instead of being answered by the
/// CLI; this keeps non-interactive use fail closed.
pub fn turn_machine_status(snapshot: &Value) -> &'static str {
    let durable = snapshot["status"].as_str().unwrap_or("unknown");
    if durable == "running"
        && (snapshot["pendingApprovals"]
            .as_array()
            .is_some_and(|values| !values.is_empty())
            || snapshot["pendingUserInputs"]
                .as_array()
                .is_some_and(|values| !values.is_empty()))
    {
        "needs_attention"
    } else {
        match durable {
            "running" => "running",
            "completed" => "completed",
            "failed" => "failed",
            "interrupted" => "interrupted",
            "cancelled" => "cancelled",
            _ => "unknown",
        }
    }
}

pub fn turn_output(command: &str, snapshot: Value, wait_timed_out: bool) -> Value {
    let status = if wait_timed_out {
        "timed_out"
    } else {
        turn_machine_status(&snapshot)
    };
    json!({
        "schemaVersion": 1,
        "command": command,
        "accepted": true,
        "status": status,
        "turn": snapshot,
    })
}

/// Poll one durable Turn until it is terminal, needs human attention, or the
/// caller's monotonic deadline expires. Expiry is observational: it never sends
/// `turn/interrupt`, so a script can attach again with the same Turn id.
pub fn wait_turn(
    plane: &mut impl ProtocolConnection,
    turn_id: &str,
    timeout: Duration,
    mut observed: impl FnMut(&Value),
) -> Result<(Value, bool), ProtocolError> {
    let deadline = Instant::now() + timeout;
    loop {
        let snapshot = rpc(plane, "turn-wait-read", "turn/read", json!({"id": turn_id}))?;
        observed(&snapshot);
        match turn_machine_status(&snapshot) {
            "completed" | "failed" | "interrupted" | "cancelled" | "needs_attention" => {
                return Ok((snapshot, false));
            }
            _ if Instant::now() >= deadline => return Ok((snapshot, true)),
            _ => thread::sleep(Duration::from_millis(100)),
        }
    }
}

pub fn turn_exit_code(status: &str) -> u8 {
    match status {
        "completed" | "running" => 0,
        "needs_attention" | "timed_out" => 2,
        "failed" | "unknown" => 3,
        "interrupted" | "cancelled" => 4,
        _ => 3,
    }
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

    #[test]
    fn turn_status_never_treats_an_approval_as_success() {
        let waiting = json!({
            "status": "running",
            "pendingApprovals": [{"id": "approval_1"}],
            "pendingUserInputs": []
        });
        assert_eq!(turn_machine_status(&waiting), "needs_attention");
        assert_eq!(turn_exit_code(turn_machine_status(&waiting)), 2);
        assert_eq!(
            turn_machine_status(&json!({"status":"completed"})),
            "completed"
        );
        assert_eq!(turn_exit_code("failed"), 3);
        assert_eq!(turn_exit_code("interrupted"), 4);
    }
}
