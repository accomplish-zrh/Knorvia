//! Probe + evidence: a REAL Kernel write turn surfaces approval server
//! requests through the adapter's decision callback, and the decision is
//! forwarded onto the Kernel wire.

use knorvia_kernel_adapter::{
    KernelSession, PROVIDER_API_KEY_ENV, PROVIDER_BASE_URL_ENV, PROVIDER_MODEL_ENV, ProviderEnv,
    TurnDecision, TurnRunOptions, ensure_kernel_config, resolve_kernel_bin,
};
use knorvia_platform_paths::layout;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MODEL: &str = "gpt-5.2";
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Scripted mock: each POST gets the next SSE body in the queue.
fn spawn_scripted_mock(bodies: Vec<String>) -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock");
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = Arc::clone(&hits);
    std::thread::spawn(move || {
        let queue = Mutex::new(std::collections::VecDeque::from(bodies));
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Some(body) = queue.lock().unwrap().pop_front() else {
                break;
            };
            let hits2 = Arc::clone(&hits2);
            std::thread::spawn(move || {
                let _ = handle(&mut stream, &body, hits2);
            });
        }
    });
    (port, hits)
}

fn handle(stream: &mut TcpStream, body: &str, hits: Arc<AtomicUsize>) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            return Ok(());
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let head_str = String::from_utf8_lossy(&head).to_string();
    let mut length = 0usize;
    for line in head_str.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            length = rest.trim().parse().unwrap_or(0);
        }
    }
    if length > 0 {
        let mut buf = vec![0u8; length];
        stream.read_exact(&mut buf)?;
    }
    hits.fetch_add(1, Ordering::SeqCst);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn sse(events: &[Value]) -> String {
    let mut body = String::new();
    for ev in events {
        body.push_str(&format!(
            "event: {}\ndata: {ev}\n\n",
            ev["type"].as_str().unwrap_or("message")
        ));
    }
    body
}

fn fn_call_sse(command: &str) -> String {
    sse(&[
        json!({"type": "response.created", "response": {"id": "r1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_1",
                "arguments": json!({"cmd": command}).to_string()
            }
        }),
        json!({
            "type": "response.completed",
            "response": {"id": "r1", "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}
        }),
    ])
}

fn message_sse(text: &str) -> String {
    sse(&[
        json!({"type": "response.created", "response": {"id": "r2"}}),
        json!({
            "type": "response.output_item.done",
            "item": {"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": text}
            ]}
        }),
        json!({
            "type": "response.completed",
            "response": {"id": "r2", "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}
        }),
    ])
}

fn user_input_sse() -> String {
    sse(&[
        json!({"type": "response.created", "response": {"id": "input-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "name": "request_user_input",
                "call_id": "input-call-1",
                "arguments": json!({
                    "questions": [{
                        "id": "mode",
                        "header": "Mode",
                        "question": "Choose a mode.",
                        "options": [
                            {"label": "Safe (Recommended)", "description": "Inspect before changing files."},
                            {"label": "Fast", "description": "Proceed immediately."}
                        ]
                    }]
                })
                .to_string(),
            }
        }),
        json!({"type": "response.completed", "response": {"id": "input-1", "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}}),
    ])
}

#[test]
fn write_turn_surfaces_kernel_approval_and_forwards_decision() {
    let Some(bin) = resolve_kernel_bin().ok() else {
        panic!("kernel binary missing; build codex-rs/target/debug/codex-app-server first");
    };
    // First model call: ask the model to touch the network (blocked by the
    // workspace-write sandbox with networkAccess=false) → Kernel must surface
    // an approval request instead of silently running or failing.
    let bodies = vec![
        fn_call_sse(
            "Invoke-WebRequest -Uri https://example.invalid/knorvia-probe -UseBasicParsing",
        ),
        message_sse("Declined by the reviewer; stopping here."),
    ];
    let (port, hits) = spawn_scripted_mock(bodies);

    // SAFETY: single-threaded test binary; env keys are test-local.
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var(PROVIDER_MODEL_ENV, MODEL);
        std::env::set_var(PROVIDER_BASE_URL_ENV, format!("http://127.0.0.1:{port}/v1"));
        std::env::set_var(PROVIDER_API_KEY_ENV, "test-key-knorvia");
    }

    let home = std::env::temp_dir().join(format!(
        "knorvia-kernel-approval-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    let paths = layout(home.clone());
    ensure_kernel_config(
        &paths,
        &ProviderEnv {
            model: MODEL.into(),
            base_url: Some(format!("http://127.0.0.1:{port}/v1")),
            api_key_env: PROVIDER_API_KEY_ENV.into(),
        },
    )
    .unwrap();

    let session = KernelSession::spawn(&paths, &bin).expect("spawn kernel session");
    let thread_id = session.create_thread().expect("kernel thread");

    let approvals: Arc<Mutex<Vec<knorvia_kernel_adapter::KernelApprovalRequest>>> =
        Arc::new(Mutex::new(Vec::new()));
    let approvals2 = Arc::clone(&approvals);

    let result = session
        .run_turn(
            &thread_id,
            "Probe: fetch https://example.invalid/knorvia-probe",
            TurnRunOptions {
                sandbox: json!({"type": "workspaceWrite", "networkAccess": false}),
                approval_policy: "on-request",
                settings: Default::default(),
                on_approval: Some(Box::new(move |req| {
                    approvals2.lock().unwrap().push(req.clone());
                    TurnDecision::Decline
                })),
                on_item: None,
                on_delta: None,
                on_progress: None,
                on_turn_started: None,
                on_user_input: None,
            },
        )
        .expect("kernel write turn");

    let seen = approvals.lock().unwrap();
    assert!(
        !seen.is_empty(),
        "kernel surfaced no approval request; items={:?} status={} error={:?}",
        result.items,
        result.status,
        result.error
    );
    assert_eq!(seen[0].kind, "commandExecution");
    assert_eq!(seen[0].action, "kernel.commandExecution");
    // The declined flow continues; the turn must terminate honestly.
    assert!(
        matches!(result.status.as_str(), "completed" | "failed"),
        "unexpected terminal status {result:?}"
    );
    assert!(
        hits.load(Ordering::SeqCst) >= 2,
        "provider called once only"
    );

    unsafe {
        std::env::remove_var(PROVIDER_MODEL_ENV);
        std::env::remove_var(PROVIDER_BASE_URL_ENV);
        std::env::remove_var(PROVIDER_API_KEY_ENV);
    }
    drop(session);
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn user_input_surfaces_a_real_kernel_server_request_and_forwards_answers() {
    let Some(bin) = resolve_kernel_bin().ok() else {
        panic!("kernel binary missing; build codex-rs/target/debug/codex-app-server first");
    };
    let (port, hits) = spawn_scripted_mock(vec![
        user_input_sse(),
        message_sse("User input arrived through the native bridge."),
    ]);
    let _guard = ENV_LOCK.lock().unwrap();
    // SAFETY: serialized by ENV_LOCK; values target this loopback-only mock.
    unsafe {
        std::env::set_var(PROVIDER_MODEL_ENV, MODEL);
        std::env::set_var(PROVIDER_BASE_URL_ENV, format!("http://127.0.0.1:{port}/v1"));
        std::env::set_var(PROVIDER_API_KEY_ENV, "test-key-knorvia");
    }
    let home = std::env::temp_dir().join(format!(
        "knorvia-kernel-user-input-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    let paths = layout(home.clone());
    ensure_kernel_config(
        &paths,
        &ProviderEnv {
            model: MODEL.into(),
            base_url: Some(format!("http://127.0.0.1:{port}/v1")),
            api_key_env: PROVIDER_API_KEY_ENV.into(),
        },
    )
    .unwrap();
    let session = KernelSession::spawn(&paths, &bin).expect("spawn kernel session");
    let thread_id = session.create_thread().expect("kernel thread");
    let requests: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let requests2 = Arc::clone(&requests);
    let result = session
        .run_turn(
            &thread_id,
            "Ask the user to choose a mode.",
            TurnRunOptions {
                sandbox: json!({"type": "readOnly"}),
                approval_policy: "never",
                settings: Default::default(),
                on_approval: None,
                on_item: None,
                on_delta: None,
                on_progress: None,
                on_turn_started: None,
                on_user_input: Some(Box::new(move |request| {
                    requests2.lock().unwrap().push(request.payload.clone());
                    json!({"answers": {"mode": {"answers": ["Safe (Recommended)"]}}})
                })),
            },
        )
        .expect("kernel user input turn");
    let seen = requests.lock().unwrap();
    assert_eq!(seen.len(), 1, "expected one native user-input request");
    assert_eq!(seen[0]["questions"][0]["id"], "mode");
    assert_eq!(seen[0]["questions"][0]["isOther"], true);
    assert_eq!(result.status, "completed", "{result:?}");
    assert!(
        result.items.iter().any(|item| {
            item.kind == "agentMessage"
                && item.payload["text"] == "User input arrived through the native bridge."
        }),
        "user input did not continue to the scripted response: {result:?}"
    );
    assert!(
        hits.load(Ordering::SeqCst) >= 2,
        "the Kernel did not submit the answered tool output to the local provider"
    );
    unsafe {
        std::env::remove_var(PROVIDER_MODEL_ENV);
        std::env::remove_var(PROVIDER_BASE_URL_ENV);
        std::env::remove_var(PROVIDER_API_KEY_ENV);
    }
    drop(session);
    let _ = std::fs::remove_dir_all(home);
}
