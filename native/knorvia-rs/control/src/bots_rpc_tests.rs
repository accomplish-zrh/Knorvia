//! JSON-RPC acceptance for the social domain: bots, rooms, session bindings.
//! These go through `handle_json`, the exact production entry the daemon
//! exposes, so the contract tested here is what Desktop/CLI see.

use super::*;
use super::turn_exec::WriteTurnStream;
use knorvia_platform_paths::layout;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

/// Inert executor: no Kernel process, no turns — these tests exercise only
/// control-plane state, so every execution method is an explicit refusal.
struct NoopExecutor;

impl NoopExecutor {
    fn new() -> Self {
        Self
    }
}

impl TurnExecutor for NoopExecutor {
    fn run_turn(&mut self, _req: &TurnRequest) -> Result<TurnOutcome, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "no kernel in bots rpc tests",
        ))
    }

    fn start_write_turn(
        &mut self,
        _req: &TurnRequest,
        _store: Arc<ProductStore>,
        _sink: Option<EventSink>,
    ) -> Result<WriteTurnStream, ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "no kernel in bots rpc tests",
        ))
    }

    fn respond_approval(
        &mut self,
        _approval_id: &str,
        _decision: knorvia_kernel_adapter::TurnDecision,
    ) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    fn decline_pending(&mut self, _thread_id: &str) -> Result<usize, ProtocolError> {
        Ok(0)
    }

    fn interrupt(&mut self, _thread_id: &str) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    fn await_turn_done(&mut self, _thread_id: &str, _timeout: Duration) -> Result<(), ProtocolError> {
        Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "no kernel in bots rpc tests",
        ))
    }

    fn set_sink(&mut self, _sink: Option<EventSink>) {}
}

static HOME_SEQ: AtomicU64 = AtomicU64::new(0);

fn plane() -> (ControlPlane, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!(
        "knorvia-control-bots-{}-{}",
        std::process::id(),
        HOME_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&base).unwrap();
    let plane = ControlPlane::open_with_executor(layout(base.clone()), Box::new(NoopExecutor::new()))
        .unwrap();
    (plane, base)
}

fn rpc(plane: &mut ControlPlane, id: &str, method: &str, params: Value) -> Value {
    let response = plane
        .handle_json(
            &json!({"jsonrpc":"2.0", "id": id, "method": method, "params": params}).to_string(),
        )
        .unwrap()
        .unwrap();
    serde_json::from_str(&response).unwrap()
}

fn result_of(response: &Value) -> Value {
    response
        .get("result")
        .cloned()
        .unwrap_or_else(|| panic!("expected result, got {response}"))
}

fn error_of(response: &Value) -> String {
    response
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected error, got {response}"))
        .to_string()
}

fn init(plane: &mut ControlPlane) {
    let response = rpc(
        plane,
        "initialize",
        "initialize",
        json!({
            "protocol": {"major": 1, "minor": 0},
            "client": {"name": "knorvia_bots_rpc_tests", "version": "1"},
            "capabilities": ["thread"]
        }),
    );
    assert!(response.get("error").is_none(), "{response}");
    plane
        .handle_json(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
        .unwrap();
}

#[test]
fn default_bot_rpc_is_idempotent_and_unknown_methods_are_attributed() {
    let (mut plane, _home) = plane();
    init(&mut plane);

    let first = result_of(&rpc(&mut plane, "1", "bot/ensureDefault", json!({})));
    let second = result_of(&rpc(&mut plane, "2", "bot/ensureDefault", json!({})));
    assert_eq!(first["id"], second["id"]);
    assert_eq!(first["soulRevision"], 1);

    let list = result_of(&rpc(&mut plane, "3", "bot/list", json!({})));
    assert_eq!(list.as_array().unwrap().len(), 1);

    let response = rpc(&mut plane, "4", "bot/nope", json!({}));
    assert!(error_of(&response).contains("unknown method"));
}

#[test]
fn bot_create_rename_and_soul_revisions_via_rpc_persist() {
    let (mut plane, home) = plane();
    init(&mut plane);

    let bot = result_of(&rpc(
        &mut plane,
        "1",
        "bot/create",
        json!({"name": "Tutor", "soul": "v1 soul", "backendKind": "kernel"}),
    ));
    assert_eq!(bot["soulRevision"], 1);
    let bot_id = bot["id"].as_str().unwrap().to_string();

    let updated = result_of(&rpc(
        &mut plane,
        "2",
        "bot/updateSoul",
        json!({"botId": bot_id, "soul": "v2 soul", "expectedRevision": bot["revision"]}),
    ));
    assert_eq!(updated["soul"], "v2 soul");
    assert_eq!(updated["soulRevision"], 2);
    assert_eq!(updated["soulHistory"].as_array().unwrap().len(), 1);

    let renamed = result_of(&rpc(
        &mut plane,
        "3",
        "bot/rename",
        json!({"botId": bot_id, "name": "Renamed Tutor", "expectedRevision": updated["revision"]}),
    ));
    assert_eq!(renamed["name"], "Renamed Tutor");
    assert_eq!(renamed["soulRevision"], 2, "rename never bumps soul revision");

    // Reopen the whole control plane over the same Home and re-read.
    drop(plane);
    let mut reopened =
        ControlPlane::open_with_executor(layout(home), Box::new(NoopExecutor::new())).unwrap();
    init(&mut reopened);
    let reread = result_of(&rpc(&mut reopened, "4", "bot/read", json!({"botId": bot_id})));
    assert_eq!(reread["name"], "Renamed Tutor");
    assert_eq!(reread["soul"], "v2 soul");
    assert_eq!(reread["soulHistory"].as_array().unwrap().len(), 1);
}

#[test]
fn ten_rounds_one_group_keeps_one_session_across_rpc() {
    let (mut plane, _home) = plane();
    init(&mut plane);
    let bot = result_of(&rpc(&mut plane, "0", "bot/ensureDefault", json!({})));
    let room = result_of(&rpc(
        &mut plane,
        "1",
        "room/create",
        json!({"kind": "group", "title": "standup", "botIds": [bot["id"]]}),
    ));

    let mut binding_id = String::new();
    for round in 1..=10i64 {
        let resolved = result_of(&rpc(
            &mut plane,
            &format!("r{round}"),
            "sessionBinding/resolve",
            json!({
                "botId": bot["id"],
                "conversationId": room["id"],
                "backendBindingId": "kernel",
                "hostId": "hostA",
                "canonicalCwd": "D:/work"
            }),
        ));
        assert_eq!(resolved["action"], if round == 1 { "created" } else { "reused" });
        if round == 1 {
            binding_id = resolved["binding"]["id"].as_str().unwrap().to_string();
            let workspace_id = ensure_workspace(&mut plane);
            let attached = result_of(&rpc(
                &mut plane,
                "a1",
                "sessionBinding/attach",
                json!({
                    "bindingId": binding_id,
                    "createThread": true,
                    "workspaceId": workspace_id,
                }),
            ));
            assert!(attached["threadId"].as_str().unwrap().starts_with("thr_"));
            assert_eq!(attached["knorviaThreadId"], attached["threadId"]);
        } else {
            assert_eq!(resolved["binding"]["id"].as_str().unwrap(), binding_id);
            assert!(resolved["binding"]["knorviaThreadId"].is_string());
        }
    }

    // Rename the room — the anchor survives unchanged.
    let renamed = result_of(&rpc(
        &mut plane,
        "rn",
        "room/rename",
        json!({"conversationId": room["id"], "title": "renamed standup"}),
    ));
    assert_eq!(renamed["title"], "renamed standup");
    let after = result_of(&rpc(
        &mut plane,
        "after",
        "sessionBinding/resolve",
        json!({
            "botId": bot["id"],
            "conversationId": room["id"],
            "backendBindingId": "kernel",
            "hostId": "hostA",
            "canonicalCwd": "D:/work"
        }),
    ));
    assert_eq!(after["action"], "reused");
    assert_eq!(after["binding"]["id"].as_str().unwrap(), binding_id);
}

fn ensure_workspace(plane: &mut ControlPlane) -> String {
    let workspace = result_of(&rpc(
        plane,
        "ws",
        "workspace/create",
        json!({"title": "bots-rpc-tests"}),
    ));
    workspace["id"].as_str().unwrap().to_string()
}

#[test]
fn two_groups_and_dm_stay_separated_and_cwd_change_regenerates() {
    let (mut plane, _home) = plane();
    init(&mut plane);
    let bot = result_of(&rpc(&mut plane, "0", "bot/ensureDefault", json!({})));
    let bot_id = bot["id"].clone();
    let g1 = result_of(&rpc(
        &mut plane,
        "g1",
        "room/create",
        json!({"kind": "group", "title": "G1", "botIds": [bot_id]}),
    ));
    let g2 = result_of(&rpc(
        &mut plane,
        "g2",
        "room/create",
        json!({"kind": "group", "title": "G1", "botIds": [bot_id]}),
    ));
    let dm = result_of(&rpc(&mut plane, "dm", "room/ensureDm", json!({"botId": bot_id})));

    let mut thread_ids = Vec::new();
    for (tag, room) in [("g1", &g1), ("g2", &g2), ("dm", &dm)] {
        let resolved = result_of(&rpc(
            &mut plane,
            tag,
            "sessionBinding/resolve",
            json!({
                "botId": bot_id,
                "conversationId": room["id"],
                "backendBindingId": "kernel"
            }),
        ));
        let workspace_id = ensure_workspace(&mut plane);
        let attached = result_of(&rpc(
            &mut plane,
            &format!("{tag}-attach"),
            "sessionBinding/attach",
            json!({
                "bindingId": resolved["binding"]["id"],
                "createThread": true,
                "workspaceId": workspace_id,
            }),
        ));
        thread_ids.push(attached["threadId"].as_str().unwrap().to_string());
    }
    let mut sorted = thread_ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), 3, "G1/G2/DM must anchor to distinct sessions");

    // Same display title "G1" never merged the two groups.
    assert_ne!(g1["id"], g2["id"]);

    // A cwd change regenerates G1's binding without inheriting the session.
    let regenerated = result_of(&rpc(
        &mut plane,
        "regen",
        "sessionBinding/resolve",
        json!({
            "botId": bot_id,
            "conversationId": g1["id"],
            "backendBindingId": "kernel",
            "canonicalCwd": "D:/elsewhere"
        }),
    ));
    assert_eq!(regenerated["action"], "regenerated");
    assert!(regenerated["binding"]["knorviaThreadId"].is_null());

    // Delivery watermark flows through the protocol too.
    let delivered = result_of(&rpc(
        &mut plane,
        "wd",
        "sessionBinding/recordDelivery",
        json!({"bindingId": regenerated["binding"]["id"], "seq": 5}),
    ));
    assert_eq!(delivered["lastDeliveredSeq"], 5);
}
