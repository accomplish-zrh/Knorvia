//! Full HTTP round trip: a scripted Chat Completions upstream behind the
//! Responses bridge. Proves request translation, SSE translation, tool-call
//! identity and usage propagation over real sockets — no agent loop involved.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

use knorvia_provider_gateway::{UpstreamProtocol, spawn_responses_bridge};
use serde_json::{Value, json};

const UPSTREAM_SSE: &[&str] = &[
    r#"{"id":"chatcmpl-t1","choices":[{"index":0,"delta":{"role":"assistant","content":"你好🌊 working"}}]}"#,
    r#"{"id":"chatcmpl-t1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_up1","function":{"name":"exec_command","arguments":"{\"cm"}}]}}]}"#,
    r#"{"id":"chatcmpl-t1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"d\":\"ls\"}"}}]}}]}"#,
    r#"{"id":"chatcmpl-t1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
    r#"{"id":"chatcmpl-t1","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":5}}"#,
    "data: [DONE]",
];

fn start_fake_chat_upstream() -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let _ = tx.send(format!(
                "PATH:{} BODY:{}",
                request_line.trim(),
                String::from_utf8_lossy(&body)
            ));
            let mut stream = stream;
            let mut sse = String::new();
            for line in UPSTREAM_SSE {
                let payload = if line.starts_with("data:") {
                    line.to_string()
                } else {
                    format!("data: {line}")
                };
                sse.push_str(&payload);
                sse.push_str("\n\n");
            }
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
            // Minimal chunked writer so ureq's streaming reader is exercised.
            for chunk in sse.as_bytes().chunks(1) {
                let _ = write!(stream, "{:x}\r\n", chunk.len());
                let _ = stream.write_all(chunk);
                let _ = stream.write_all(b"\r\n");
            }
            let _ = stream.write_all(b"0\r\n\r\n");
            let _ = stream.flush();
        }
    });
    (format!("http://{address}"), rx)
}

fn sse_events(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|frame| frame.strip_prefix("data: "))
        .map(|payload| serde_json::from_str::<Value>(payload.trim()).unwrap())
        .collect()
}

#[test]
fn bridge_round_trips_chat_upstream_into_responses_events() {
    let (upstream, received) = start_fake_chat_upstream();
    let mut bridge = spawn_responses_bridge(
        UpstreamProtocol::ChatCompletions,
        upstream,
        "fixture-key".to_string(),
        None,
    )
    .unwrap();
    let url = format!("http://{}/v1/responses", bridge.address);
    let response = ureq::post(&url)
        .set("authorization", &format!("Bearer {}", bridge.auth_token))
        .set("Content-Type", "application/json")
        .send_string(
            &json!({
                "model": "gpt-5.2",
                "instructions": "Be brief.",
                "input": [{"type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": "list files"}]}],
                "tools": [{"type": "function", "name": "exec_command",
                    "description": "run", "parameters": {"type": "object"}}]
            })
            .to_string(),
        )
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_string().unwrap();
    let events = sse_events(&body);
    let kinds: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap_or(""))
        .collect();
    assert!(kinds.contains(&"response.created"), "{kinds:?}");
    assert!(kinds.contains(&"response.completed"), "{kinds:?}");
    let delta = events
        .iter()
        .find(|event| event["type"] == "response.output_text.delta")
        .unwrap();
    assert_eq!(
        delta["delta"], "你好🌊 working",
        "UTF-8 must survive one-byte HTTP chunks"
    );
    let call = events
        .iter()
        .find(|event| event["item"]["type"] == "function_call")
        .expect("function_call event expected");
    assert_eq!(call["item"]["name"], "exec_command");
    assert_eq!(call["item"]["call_id"], "call_up1");
    assert_eq!(call["item"]["arguments"], "{\"cmd\":\"ls\"}");
    let completed = events
        .iter()
        .find(|e| e["type"] == "response.completed")
        .unwrap();
    assert_eq!(completed["response"]["usage"]["input_tokens"], 13);
    assert_eq!(completed["response"]["usage"]["total_tokens"], 18);

    // The upstream saw a translated Chat request, not a Responses body.
    let seen = received
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert!(seen.starts_with("PATH:POST /v1/chat/completions"), "{seen}");
    assert!(
        seen.contains("\"role\":\"system\""),
        "instructions became a system message: {seen}"
    );
    assert!(seen.contains("include_usage"), "{seen}");

    // A wrong bearer token is rejected before any upstream contact.
    let denied = ureq::post(&url)
        .set("Authorization", "Bearer wrong")
        .send_string("{}");
    match denied {
        Err(ureq::Error::Status(status, _)) => assert_eq!(status, 401),
        other => panic!("expected 401, got {other:?}"),
    }
    let missing = ureq::post(&url).send_string("{}");
    assert!(
        matches!(missing, Err(ureq::Error::Status(401, _))),
        "missing bearer must fail closed"
    );
    bridge.close();
}
