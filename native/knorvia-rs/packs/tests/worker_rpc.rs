//! Integration test: the REAL `knorvia-pack-worker` binary renders packs over
//! the supervised RPC — template mode and model mode (via a mock gateway).
//! `PackWorkerClient::spawn` applies the environment allowlist itself, so the
//! worker never sees ambient variables beyond it.

use knorvia_capability_host::worker::{PackWorkerClient, WorkerError};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const WORKER: &str = env!("CARGO_BIN_EXE_knorvia-pack-worker");

/// Serializes provider env mutations across parallel tests (env is
/// process-global; the learning pack makes a real model call when the
/// provider env is present).
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn spawn_mock_gateway(bodies: Vec<String>) -> (u16, Arc<AtomicUsize>) {
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

fn message_sse(text: &str) -> String {
    let created = r#"{"type":"response.created","response":{"id":"r1"}}"#;
    let msg = json!({
        "type": "response.output_item.done",
        "item": {"type": "message", "role": "assistant", "content": [
            {"type": "output_text", "text": text}
        ]}
    })
    .to_string();
    let completed = r#"{"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}"#;
    format!(
        "event: response.created\ndata: {created}\n\nevent: response.output_item.done\ndata: {msg}\n\nevent: response.completed\ndata: {completed}\n\n"
    )
}

#[test]
fn worker_renders_template_pack_without_model_env() {
    let _env_lock = ENV_LOCK.lock().unwrap();
    // SAFETY: single-threaded test binary; env keys are test-local.
    unsafe {
        std::env::remove_var("KNORVIA_PROVIDER_MODEL");
        std::env::remove_var("KNORVIA_PROVIDER_BASE_URL");
    }
    let mut client = PackWorkerClient::spawn(std::path::Path::new(WORKER)).expect("spawn");
    client
        .initialize(&["learning.mastery"])
        .expect("initialize");
    let (mime, title, bytes) = client
        .render(
            "learning.mastery",
            &json!({"topic": "Bayes", "num_questions": 2}),
        )
        .expect("render via worker");
    assert_eq!(mime, "text/markdown");
    assert!(title.contains("quiz-"));
    let content = String::from_utf8(bytes).unwrap();
    assert!(content.starts_with("mode: template\n\n"), "{content}");
    assert!(content.contains("Bayes"));
}

#[test]
fn worker_renders_model_pack_through_allowlisted_gateway_env() {
    let _env_lock = ENV_LOCK.lock().unwrap();
    let (port, hits) = spawn_mock_gateway(vec![message_sse(
        "1. What is the Fourier transform?\nAnswer: a signal decomposed into sine/cosine basis.",
    )]);
    // SAFETY: single-threaded test binary; env keys are test-local.
    unsafe {
        std::env::set_var("KNORVIA_PROVIDER_MODEL", "gpt-5.2");
        std::env::set_var(
            "KNORVIA_PROVIDER_BASE_URL",
            format!("http://127.0.0.1:{port}/v1"),
        );
        std::env::set_var("KNORVIA_PROVIDER_API_KEY", "test-key-knorvia");
    }
    let mut client = PackWorkerClient::spawn(std::path::Path::new(WORKER)).expect("spawn");
    client
        .initialize(&["learning.mastery"])
        .expect("initialize");
    let (mime, _title, bytes) = client
        .render(
            "learning.mastery",
            &json!({"topic": "Fourier", "num_questions": 1}),
        )
        .expect("render via worker with model");
    assert_eq!(mime, "text/markdown");
    let content = String::from_utf8(bytes).unwrap();
    assert!(content.starts_with("mode: model\n\n"), "{content}");
    assert!(content.contains("Fourier transform"), "{content}");
    assert!(hits.load(Ordering::SeqCst) >= 1, "gateway never called");
    unsafe {
        std::env::remove_var("KNORVIA_PROVIDER_MODEL");
        std::env::remove_var("KNORVIA_PROVIDER_BASE_URL");
        std::env::remove_var("KNORVIA_PROVIDER_API_KEY");
    }
}

#[test]
fn worker_speaks_no_ambient_protocol_garbage() {
    let _env_lock = ENV_LOCK.lock().unwrap();
    // A process that is not the worker (spawns fine, speaks no framed JSON)
    // must surface a typed failure, never a fabricated render.
    let fake = if cfg!(windows) { "cmd.exe" } else { "false" };
    let mut client = match PackWorkerClient::spawn(std::path::Path::new(fake)) {
        Ok(c) => c,
        Err(err @ WorkerError::Transport(_)) => {
            // Spawn refused (e.g. sandboxed CI): the typed contract held.
            let _ = err;
            return;
        }
        Err(other) => panic!("unexpected spawn error: {other}"),
    };
    let err = client
        .initialize(&["learning.mastery"])
        .err()
        .expect("expected a typed failure for a non-worker process");
    assert!(
        matches!(
            err,
            WorkerError::Transport(_) | WorkerError::Failed(_) | WorkerError::Deadline(_)
        ),
        "{err}"
    );
}

#[test]
fn worker_cooperative_cancel_stops_render() {
    let _env_lock = ENV_LOCK.lock().unwrap();
    // SAFETY: single-threaded test binary; env keys are test-local.
    unsafe {
        std::env::remove_var("KNORVIA_PROVIDER_MODEL");
        std::env::remove_var("KNORVIA_PROVIDER_BASE_URL");
    }
    let mut client = PackWorkerClient::spawn(std::path::Path::new(WORKER)).expect("spawn");
    client
        .initialize(&["learning.mastery"])
        .expect("initialize");
    // Cancel BEFORE the render: the worker checks the flag at the render
    // checkpoint and refuses deterministically (Cancelled, not a render).
    client.cancel().expect("send cancel notification");
    let err = client
        .render(
            "learning.mastery",
            &json!({"topic": "Bayes", "num_questions": 1}),
        )
        .err()
        .expect("cancelled render must fail");
    match err {
        WorkerError::Failed(message) => {
            assert!(message.contains("cancelled"), "{message}");
        }
        other => panic!("expected a Failed(cancelled), got {other}"),
    }
    // The worker process stays alive and healthy afterwards (stateless
    // cancel; the supervisor may reuse or kill it).
    assert!(client.is_alive(), "worker died on cooperative cancel");
}
