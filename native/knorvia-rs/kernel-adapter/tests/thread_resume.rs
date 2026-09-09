//! Evidence: a Kernel thread survives a Kernel process restart.
//!
//! Turn 1 runs on kernel process A; the session is dropped (simulating a
//! daemon restart); process B resumes the SAME thread id via
//! `thread/resume` and runs another turn. The resumed thread's history must
//! contain the prior turn (the Kernel reloads the rollout), proving context
//! continuity across daemon restarts.

use knorvia_kernel_adapter::{
    KernelSession, KernelThreadSettings, PROVIDER_API_KEY_ENV, PROVIDER_BASE_URL_ENV,
    PROVIDER_MODEL_ENV, ProviderEnv, TurnRunOptions, ensure_kernel_config, resolve_kernel_bin,
};
use knorvia_platform_paths::layout;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MODEL: &str = "gpt-5.2";

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

fn message_sse(text: &str) -> String {
    sse(&[
        json!({"type": "response.created", "response": {"id": "resp_knorvia"}}),
        json!({
            "type": "response.output_item.done",
            "item": {"type": "message", "role": "assistant", "id": "msg_1", "content": [
                {"type": "output_text", "text": text}
            ]}
        }),
        json!({
            "type": "response.completed",
            "response": {"id": "resp_knorvia", "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}
        }),
    ])
}

#[test]
fn kernel_thread_survives_process_restart_via_resume() {
    let Some(bin) = resolve_kernel_bin().ok() else {
        panic!("kernel binary missing");
    };
    let (port, hits) = spawn_scripted_mock(vec![
        message_sse("first turn answer"),
        message_sse("second turn answer after resume"),
        message_sse("third turn answer on fork"),
    ]);

    let home = std::env::temp_dir().join(format!(
        "knorvia-kernel-resume-{}",
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

    // SAFETY: single-threaded test binary; env keys are test-local.
    unsafe {
        std::env::set_var(PROVIDER_MODEL_ENV, MODEL);
        std::env::set_var(PROVIDER_BASE_URL_ENV, format!("http://127.0.0.1:{port}/v1"));
        std::env::set_var(PROVIDER_API_KEY_ENV, "test-key-knorvia");
    }

    let kernel_thread;
    {
        // "Daemon run 1": spawn kernel process A, create thread, run a turn.
        let session = KernelSession::spawn(&paths, &bin).expect("spawn kernel A");
        kernel_thread = session.create_thread().expect("create kernel thread");
        let result = session
            .run_turn(&kernel_thread, "First message", TurnRunOptions::read_only())
            .expect("turn 1");
        assert_eq!(result.status, "completed", "{result:?}");
        // Session dropped here: the kernel process dies (daemon restart).
    }

    {
        // "Daemon run 2": a fresh kernel process resumes the SAME thread.
        let session = KernelSession::spawn(&paths, &bin).expect("spawn kernel B");
        let resumed = session
            .resume_thread(&kernel_thread)
            .expect("thread/resume must load the persisted rollout");
        assert_eq!(resumed, kernel_thread, "resume must keep the thread id");
        let result = session
            .run_turn(&resumed, "Second message", TurnRunOptions::read_only())
            .expect("turn 2 on resumed thread");
        assert_eq!(result.status, "completed", "{result:?}");
        assert!(
            result.items.iter().any(|i| i.kind == "agentMessage"),
            "resumed turn produced no agent message: {result:?}"
        );

        // The adapter must ask the App Server to fork its durable rollout,
        // rather than locally manufacturing a second product identity with
        // no model-visible history. The fork accepts its own next turn.
        let forked = session
            .fork_thread(&resumed, &KernelThreadSettings::default())
            .expect("thread/fork must preserve Kernel history");
        assert_ne!(forked, resumed, "fork must create a distinct Kernel thread");
        let fork_result = session
            .run_turn(
                &forked,
                "Third message on fork",
                TurnRunOptions::read_only(),
            )
            .expect("turn on forked thread");
        assert_eq!(fork_result.status, "completed", "{fork_result:?}");
        assert!(
            fork_result.items.iter().any(|i| i.kind == "agentMessage"),
            "forked turn produced no agent message: {fork_result:?}"
        );
    }

    assert!(
        hits.load(Ordering::SeqCst) >= 3,
        "source, resumed, and forked turns must reach the provider"
    );

    unsafe {
        std::env::remove_var(PROVIDER_MODEL_ENV);
        std::env::remove_var(PROVIDER_BASE_URL_ENV);
        std::env::remove_var(PROVIDER_API_KEY_ENV);
    }
    let _ = std::fs::remove_dir_all(home);
}
