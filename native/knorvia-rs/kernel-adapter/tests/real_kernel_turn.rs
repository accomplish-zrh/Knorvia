//! Integration test: a REAL Kernel turn through the real `codex-app-server`
//! binary against a local mock Responses API. This is the evidence that the
//! daemon control plane executes genuine Kernel turns — not deterministic
//! echoes. Requires the pinned upstream build (`codex-rs/target/debug`);
//! skips (with a loud message) only when the binary is absent.

use knorvia_kernel_adapter::{
    KernelSession, PROVIDER_API_KEY_ENV, PROVIDER_BASE_URL_ENV, PROVIDER_MODEL_ENV, ProviderEnv,
    ensure_kernel_config, is_user_codex_shim, resolve_kernel_bin,
};
use knorvia_platform_paths::layout;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

static ENV_LOCK: Mutex<()> = Mutex::new(());

const MODEL: &str = "gpt-5.2";
const REPLY: &str = "Hello from the Knorvia Kernel";

fn sse_body() -> String {
    let created = json!({
        "type": "response.created",
        "response": {"id": "resp_knorvia"}
    });
    let message = json!({
        "type": "response.output_item.done",
        "item": {
            "type": "message",
            "role": "assistant",
            "id": "msg_1",
            "content": [{"type": "output_text", "text": REPLY}]
        }
    });
    let completed = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_knorvia",
            "usage": {
                "input_tokens": 160,
                "input_tokens_details": null,
                "output_tokens": 40,
                "output_tokens_details": null,
                "total_tokens": 200
            }
        }
    });
    let mut body = String::new();
    for ev in [created, message, completed] {
        let kind = ev["type"].as_str().unwrap().to_string();
        body.push_str(&format!("event: {kind}\n"));
        body.push_str(&format!("data: {ev}\n\n"));
    }
    body
}

/// Minimal HTTP server that answers any POST with a Responses-API SSE stream.
struct MockResponsesServer {
    port: u16,
    requests: Arc<AtomicUsize>,
}

impl MockResponsesServer {
    fn spawn() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock server");
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let counter = Arc::clone(&counter);
                std::thread::spawn(move || {
                    let _ = handle_conn(&mut stream, counter);
                });
            }
        });
        Self { port, requests }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

fn handle_conn(stream: &mut TcpStream, counter: Arc<AtomicUsize>) -> std::io::Result<()> {
    // Read the request head.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            return Ok(());
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") || head.ends_with(b"\n\n") {
            break;
        }
    }
    // Read the body per Content-Length (if present).
    let head_str = String::from_utf8_lossy(&head).to_string();
    let mut content_length = 0usize;
    for line in head_str.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        stream.read_exact(&mut body)?;
    }
    counter.fetch_add(1, Ordering::SeqCst);
    let payload = sse_body();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}

#[test]
fn real_kernel_turn_completes_with_agent_message() {
    let Some(bin) = resolve_kernel_bin().ok() else {
        panic!("kernel binary missing; build codex-rs/target/debug/codex-app-server first");
    };
    assert!(!is_user_codex_shim(&bin));

    let server = MockResponsesServer::spawn();
    let _lock = ENV_LOCK.lock().unwrap();
    // SAFETY: serialized by ENV_LOCK; single-threaded test binary usage here.
    unsafe { std::env::set_var(PROVIDER_MODEL_ENV, MODEL) };
    unsafe { std::env::set_var(PROVIDER_BASE_URL_ENV, server.base_url()) };
    unsafe { std::env::set_var(PROVIDER_API_KEY_ENV, "test-key-knorvia") };

    let home = std::env::temp_dir().join(format!(
        "knorvia-kernel-e2e-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    let paths = layout(home.clone());
    let provider = ProviderEnv {
        model: MODEL.into(),
        base_url: Some(server.base_url()),
        api_key_env: PROVIDER_API_KEY_ENV.into(),
    };
    ensure_kernel_config(&paths, &provider).unwrap();

    let session = KernelSession::spawn(&paths, &bin).expect("spawn kernel session");
    let thread_id = session.create_thread().expect("kernel thread");
    let result = session
        .run_turn(
            &thread_id,
            "Say hello to Knorvia",
            knorvia_kernel_adapter::TurnRunOptions::read_only(),
        )
        .expect("kernel turn");
    assert_eq!(result.status, "completed", "error: {:?}", result.error);
    assert_eq!(result.surfaced_approvals, 0);
    let agent = result
        .items
        .iter()
        .find(|i| i.kind == "agentMessage")
        .expect("expected an agentMessage item");
    assert_eq!(agent.payload["text"], REPLY);
    let usage = result
        .items
        .iter()
        .find(|item| item.kind == "tokenUsage")
        .expect("real Kernel must report usage");
    assert_eq!(usage.payload["tokenUsage"]["last"]["inputTokens"], 160);
    assert_eq!(
        usage.payload["tokenUsage"]["last"]["cacheFieldsReported"],
        json!({"cachedInput":false,"cacheWrite":false}),
        "input_tokens_details:null must not turn into a measured zero cache hit rate"
    );
    assert!(
        server.request_count() >= 1,
        "kernel never called the provider endpoint"
    );

    // Cleanup env so other tests in this binary are unaffected.
    unsafe { std::env::remove_var(PROVIDER_MODEL_ENV) };
    unsafe { std::env::remove_var(PROVIDER_BASE_URL_ENV) };
    unsafe { std::env::remove_var(PROVIDER_API_KEY_ENV) };
    drop(session);
    let _ = std::fs::remove_dir_all(home);
}
