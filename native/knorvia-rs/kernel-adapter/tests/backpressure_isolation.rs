//! R01 acceptance: one stalled turn consumer must not kill the shared
//! kernel. Task A's consumer pauses while the provider streams thousands of
//! events; task B still completes against the same kernel with a real
//! artifact, and A recovers its durable terminal afterwards.
//!
//! Run against the real pinned kernel with a local scripted Responses
//! fixture (no real provider, no user data):
//!   KNORVIA_KERNEL_BIN=<pinned codex-app-server.exe> \
//!   cargo test -p knorvia-kernel-adapter --test backpressure_isolation -- --ignored --nocapture

use knorvia_kernel_adapter::{
    KernelSession, KernelTurnItem, ProviderEnv, TurnRunOptions, ensure_kernel_config,
    resolve_kernel_bin,
};
use serde_json::json;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const DELTA_COUNT: usize = 2000;
const DELTA_CHUNK: &str = "0123456789";

fn temp_root() -> std::path::PathBuf {
    std::env::var_os("NIGHT_A_TEMP")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Scripted Responses provider: the request body picks the scenario.
/// `ISOLATE` streams `DELTA_COUNT` output_text deltas before completing;
/// anything else completes with a single short message.
fn spawn_fixture() -> (String, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = Arc::clone(&hits);
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Ok(body) = read_post_body(&mut stream) else {
                continue;
            };
            hits2.fetch_add(1, Ordering::SeqCst);
            let payload = if body.contains("ISOLATE") {
                isolate_response()
            } else {
                oneshot_response("B-done")
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (url, hits, handle)
}

fn read_post_body(stream: &mut std::net::TcpStream) -> std::io::Result<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "eof in head",
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

fn sse_created(id: &str) -> String {
    let data = json!({"type": "response.created", "response": {"id": id}});
    format!("event: response.created\ndata: {data}\n\n")
}

fn sse_completed(id: &str) -> String {
    let data = json!({
        "type": "response.completed",
        "response": {"id": id, "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
    });
    format!("event: response.completed\ndata: {data}\n\n")
}

fn isolate_response() -> String {
    let mut body = sse_created("rA");
    // The kernel requires an active streamed item before accepting deltas.
    let added = json!({
        "type": "response.output_item.added",
        "item": {"type": "message", "role": "assistant", "id": "msgA", "content": []}
    });
    body.push_str(&format!(
        "event: response.output_item.added\ndata: {added}\n\n"
    ));
    for index in 0..DELTA_COUNT {
        let data = json!({
            "type": "response.output_text.delta",
            "item_id": "msgA",
            "delta": format!("{DELTA_CHUNK}-{index};"),
        });
        body.push_str(&format!(
            "event: response.output_text.delta\ndata: {data}\n\n"
        ));
    }
    let item = json!({
        "type": "response.output_item.done",
        "item": {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "A-final"}]}
    });
    body.push_str(&format!(
        "event: response.output_item.done\ndata: {item}\n\n"
    ));
    body.push_str(&sse_completed("rA"));
    body
}

fn oneshot_response(text: &str) -> String {
    let mut body = sse_created("rB");
    let item = json!({
        "type": "response.output_item.done",
        "item": {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": text}]}
    });
    body.push_str(&format!(
        "event: response.output_item.done\ndata: {item}\n\n"
    ));
    body.push_str(&sse_completed("rB"));
    body
}

fn wait_until(deadline: Duration, condition: impl Fn() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

#[test]
#[ignore = "requires KNORVIA_KERNEL_BIN pointing at the pinned kernel"]
fn stalled_consumer_isolates_only_its_own_task_against_real_kernel() {
    let root = temp_root().join(format!(
        "knorvia-r01-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let paths = knorvia_platform_paths::layout(root.clone());
    paths.ensure_layout().unwrap();

    let (base_url, hits, _server) = spawn_fixture();
    let provider = ProviderEnv {
        model: "night-fixture-model".into(),
        base_url: Some(base_url),
        api_key_env: "KNORVIA_PROVIDER_API_KEY".into(),
    };
    // The kernel reads the key from its own process environment. This test
    // process owns its environment; no other thread reads this key.
    #[allow(static_mut_refs)]
    unsafe {
        std::env::set_var("KNORVIA_PROVIDER_API_KEY", "fixture-key-not-real");
    }
    ensure_kernel_config(&paths, &provider).unwrap();
    let bin = resolve_kernel_bin().expect("KNORVIA_KERNEL_BIN");
    let session = Arc::new(KernelSession::spawn(&paths, &bin).expect("spawn pinned kernel"));

    let thread_a = session.create_thread().unwrap();
    let thread_b = session.create_thread().unwrap();

    // A's consumer parks inside on_delta after the first event: everything
    // else must queue in the bounded per-task spill, never fail the reader.
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let a_text = Arc::new(Mutex::new(String::new()));
    let a_items = Arc::new(Mutex::new(Vec::new()));
    let a_gate = Arc::clone(&gate);
    let a_text_cb = Arc::clone(&a_text);
    let a_items_cb = Arc::clone(&a_items);
    let session_for_a = Arc::clone(&session);
    let thread_a_for_runner = thread_a.clone();
    let runner_a = std::thread::spawn(move || {
        let mut opts = TurnRunOptions::read_only();
        opts.on_delta = Some(Box::new(move |_item: &str, delta: &str| {
            a_text_cb.lock().unwrap().push_str(delta);
            let (lock, signal) = &*a_gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = signal.wait(released).unwrap();
            }
        }));
        opts.on_item = Some(Box::new(move |item: &KernelTurnItem| {
            a_items_cb.lock().unwrap().push(item.clone());
        }));
        session_for_a
            .run_turn(&thread_a_for_runner, "ISOLATE", opts)
            .unwrap()
    });

    // Wait until A's spill actually holds a backlog (consumer provably
    // stalled while events keep flowing).
    assert!(
        wait_until(Duration::from_secs(90), || session
            .task_lag(&thread_a)
            .queued
            > 100),
        "task A never accumulated a backlog; lag={:?}",
        session.task_lag(&thread_a)
    );

    // While A is stalled, B runs to real completion on the same kernel.
    let mut b_opts = TurnRunOptions::read_only();
    let b_message = Arc::new(Mutex::new(String::new()));
    let b_message_cb = Arc::clone(&b_message);
    b_opts.on_item = Some(Box::new(move |item: &KernelTurnItem| {
        if item.kind == "agentMessage" {
            *b_message_cb.lock().unwrap() = item.payload["text"]
                .as_str()
                .unwrap_or_default()
                .to_string();
        }
    }));
    let b_result = session.run_turn(&thread_b, "ONESHOT", b_opts).unwrap();
    assert_eq!(
        b_result.status, "completed",
        "B must complete while A is stalled"
    );
    assert_eq!(b_message.lock().unwrap().as_str(), "B-done");
    assert!(
        session.is_alive(),
        "shared kernel must survive a stalled consumer"
    );

    // Release A: it must drain its spill and reach a real durable terminal.
    {
        let (lock, signal) = &*gate;
        *lock.lock().unwrap() = true;
        signal.notify_all();
    }
    let a_result = runner_a.join().unwrap();
    assert_eq!(
        a_result.status, "completed",
        "A must recover after the backlog drains"
    );
    // The coalesced deltas must reassemble the exact streamed text:
    // "0123456789-<i>;" for every index, concatenated in order.
    let expected: String = (0..DELTA_COUNT)
        .map(|index| format!("{DELTA_CHUNK}-{index};"))
        .collect();
    assert_eq!(
        a_text.lock().unwrap().as_str(),
        expected,
        "delta text must survive coalescing byte-for-byte"
    );
    assert!(
        a_items
            .lock()
            .unwrap()
            .iter()
            .any(|item| item.kind == "agentMessage"),
        "A must record its real agentMessage artifact"
    );
    let lag = session.task_lag(&thread_a);
    assert_eq!(
        lag.isolated, None,
        "bounded coalescing must not isolate the task"
    );

    // The kernel remains reusable for further turns afterwards.
    let again = session
        .run_turn(&thread_b, "ONESHOT", TurnRunOptions::read_only())
        .unwrap();
    assert_eq!(again.status, "completed");
    assert!(
        hits.load(Ordering::SeqCst) >= 3,
        "fixture saw all provider requests"
    );

    drop(session);
    let _ = std::fs::remove_dir_all(root);
}
