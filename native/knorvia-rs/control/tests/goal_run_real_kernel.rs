//! R02 real-kernel E2E: goal/run through the production KernelTurnExecutor
//! against the pinned codex-app-server binary and a local scripted Responses
//! fixture. Verifies multi-round advancement with durable batches, budget
//! pause without goal completion, and idempotent key replay across a reopen.
//!
//! Run with:
//!   KNORVIA_KERNEL_BIN=<pinned codex-app-server.exe> \
//!   cargo test -p knorvia-control --test goal_run_real_kernel -- --ignored --nocapture

use knorvia_control::ControlPlane;
use knorvia_platform_paths::layout;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn temp_home(label: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!(
        "knorvia-goal-e2e-{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    home
}

fn spawn_fixture() -> String {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Ok(body) = read_post_body(&mut stream) else {
                continue;
            };
            let text = if body.contains("E2E") {
                "E2E round output"
            } else {
                "fixture output"
            };
            let payload = format!(
                "event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"r1\"}}}}\n\n\
                 event: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"item\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"{text}\"}}]}}}}\n\n\
                 event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"r1\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}}}}\n\n"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://127.0.0.1:{port}/v1")
}

fn read_post_body(stream: &mut std::net::TcpStream) -> std::io::Result<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "eof",
            ));
        }
        head.push(byte[0]);
    }
    let head_str = String::from_utf8_lossy(&head).to_string();
    let mut length = 0usize;
    for line in head_str.lines() {
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = rest.trim().parse().unwrap_or(0);
        }
    }
    let mut buf = vec![0u8; length];
    stream.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn rpc(plane: &mut ControlPlane, id: &str, method: &str, params: Value) -> Value {
    let response = plane
        .handle_json(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
        )
        .unwrap()
        .unwrap();
    serde_json::from_str(&response).unwrap()
}

fn wait_terminal(plane: &mut ControlPlane, goal_id: &str, request_key: &str) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let snapshot = rpc(
            plane,
            "q",
            "goal/run/read",
            json!({"goalId": goal_id, "requestKey": request_key}),
        );
        assert!(snapshot.get("error").is_none(), "{snapshot}");
        let status = snapshot["result"]["execution"]["status"]
            .as_str()
            .unwrap()
            .to_string();
        if status != "running" {
            return snapshot["result"].clone();
        }
        if std::time::Instant::now() >= deadline {
            panic!("goal batch never left running: {snapshot}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "requires KNORVIA_KERNEL_BIN pointing at the pinned kernel"]
fn goal_run_advances_real_kernel_rounds_and_pauses_on_budget() {
    let home = temp_home("advance");
    let base_url = spawn_fixture();
    // SAFETY: the test process owns its environment; the provider settings
    // are read by the kernel spawn below.
    unsafe {
        std::env::set_var("KNORVIA_PROVIDER_MODEL", "night-fixture-model");
        std::env::set_var("KNORVIA_PROVIDER_BASE_URL", &base_url);
        std::env::set_var("KNORVIA_PROVIDER_API_KEY", "fixture-key-not-real");
    }

    let mut plane = ControlPlane::open(layout(home.clone())).unwrap();
    let init = rpc(
        &mut plane,
        "i",
        "initialize",
        json!({
            "protocol": {"major": 1, "minor": 0},
            "client": {"name": "goal-e2e", "version": "0", "platform": "windows"},
            "capabilities": ["thread"]
        }),
    );
    assert!(init.get("error").is_none(), "{init}");
    plane
        .handle_json(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
        .unwrap();

    let ws = rpc(
        &mut plane,
        "w",
        "workspace/create",
        json!({"title": "goal e2e"}),
    );
    let ws_id = ws["result"]["id"].as_str().unwrap().to_string();
    let goal = rpc(
        &mut plane,
        "g",
        "goal/create",
        json!({
            "workspaceId": ws_id,
            "title": "real kernel goal",
            "successCriteria": "two real kernel rounds recorded"
        }),
    );
    let goal_id = goal["result"]["id"].as_str().unwrap().to_string();

    let run = rpc(
        &mut plane,
        "r",
        "goal/run",
        json!({"id": goal_id, "revision": 1, "requestKey": "e2e-key",
               "input": "say E2E", "advance": {"maxRounds": 2}}),
    );
    assert!(run.get("error").is_none(), "{run}");

    let result = wait_terminal(&mut plane, &goal_id, "e2e-key");
    assert_eq!(result["execution"]["status"], "paused", "{result}");
    assert_eq!(result["execution"]["stopReason"], "roundsExhausted");
    let rounds = result["execution"]["rounds"].as_array().unwrap();
    assert_eq!(rounds.len(), 2, "exactly two real kernel rounds: {result}");
    for round in rounds {
        assert_eq!(round["status"], "completed");
    }

    // Real agent output reached the product store through the real kernel.
    let goal_read = rpc(&mut plane, "gr", "goal/read", json!({"id": goal_id}));
    assert_eq!(
        goal_read["result"]["status"], "active",
        "budget pause must not complete the goal"
    );
    assert_eq!(goal_read["result"]["execution"]["running"], 0);

    // Replay through a full reopen (restart attribution): same batch.
    drop(plane);
    let mut reopened = ControlPlane::open(layout(home.clone())).unwrap();
    let _ = rpc(
        &mut reopened,
        "i2",
        "initialize",
        json!({
            "protocol": {"major": 1, "minor": 0},
            "client": {"name": "goal-e2e", "version": "0", "platform": "windows"},
            "capabilities": ["thread"]
        }),
    );
    reopened
        .handle_json(r#"{"jsonrpc":"2.0","method":"initialized"}"#)
        .unwrap();
    let replay = rpc(
        &mut reopened,
        "q2",
        "goal/run/read",
        json!({"goalId": goal_id, "requestKey": "e2e-key"}),
    );
    assert_eq!(
        replay["result"]["execution"]["id"],
        result["execution"]["id"]
    );
    assert_eq!(
        replay["result"]["execution"]["rounds"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let _ = std::fs::remove_dir_all(home);
    let _ = Arc::new(AtomicUsize::new(0)); // keep Arc import used for fixture symmetry
}
