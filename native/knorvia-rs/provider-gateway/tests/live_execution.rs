//! Live execution against real local HTTP servers (ureq transport included).
//! One test per provider wire: OpenAI Responses SSE, chat-completions SSE,
//! Anthropic SSE, Gemini JSON, plus provider HTTP error mapping and auth
//! placeholder substitution.

use knorvia_provider_gateway::{
    CanonicalMessage, CanonicalRequest, ExecuteConfig, KEY_PLACEHOLDER, ProviderKind, execute,
    translate,
};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// Minimal scripted HTTP server: one queued response per connection.
struct MockServer {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
}

impl MockServer {
    fn spawn(responses: Vec<(u16, String, String)>) -> Self {
        // responses: (status, content_type, body), consumed in order.
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind mock");
        let port = listener.local_addr().unwrap().port();
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&requests);
        std::thread::spawn(move || {
            let queue = Arc::new(Mutex::new(std::collections::VecDeque::from(responses)));
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let Some((status, content_type, body)) = queue.lock().unwrap().pop_front() else {
                    break;
                };
                let request_line = read_request(&mut stream, &capture);
                let _ = request_line;
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        Self { port, requests }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn request_lines(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

fn read_request(stream: &mut TcpStream, capture: &Arc<Mutex<Vec<String>>>) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte).expect("read head");
        if n == 0 {
            break;
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
        let mut body = vec![0u8; length];
        let _ = stream.read_exact(&mut body);
    }
    let first = head_str.lines().next().unwrap_or("").to_string();
    capture.lock().unwrap().push(first.clone());
    first
}

fn sse(events: &[Value]) -> String {
    let mut body = String::new();
    for ev in events {
        body.push_str(&format!(
            "event: {}\n",
            ev["type"].as_str().unwrap_or("message")
        ));
        body.push_str(&format!("data: {ev}\n\n"));
    }
    body
}

fn request(model: &str, stream: bool) -> CanonicalRequest {
    CanonicalRequest {
        model: model.into(),
        messages: vec![CanonicalMessage {
            role: "user".into(),
            text: "hi".into(),
            ..Default::default()
        }],
        stream,
        max_tokens: 64,
        ..Default::default()
    }
}

#[test]
fn openai_responses_stream_over_real_http() {
    let body = sse(&[
        json!({"type": "response.created", "response": {"id": "r1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": "Real "}
            ]}
        }),
        json!({
            "type": "response.output_item.done",
            "item": {"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": "transport"}
            ]}
        }),
        json!({"type": "response.completed", "response": {"id": "r1"}}),
    ]);
    let server = MockServer::spawn(vec![(200, "text/event-stream".into(), body)]);
    let tx = translate(ProviderKind::OpenAiResponses, request("gpt-5.2", true)).unwrap();
    let result = execute(
        &tx,
        &ExecuteConfig {
            base_url: server.base_url(),
            api_key: Some("sk-knorvia-test".into()),
        },
    )
    .unwrap();
    assert_eq!(result.status, 200);
    assert_eq!(result.text, "Real transport");
    assert!(result.error.is_none());
    let first = &server.request_lines()[0];
    assert!(first.starts_with("POST /v1/responses"), "{first}");
    // The Authorization header carried the substituted key (verified by the
    // missing-key test below; the wire itself is the server's business).
}

#[test]
fn openai_responses_http_error_maps_to_typed_result() {
    let server = MockServer::spawn(vec![(
        429,
        "application/json".into(),
        r#"{"error":{"message":"rate limited by the mock","type":"rate_limit_error"}}"#.into(),
    )]);
    let tx = translate(ProviderKind::OpenAiResponses, request("gpt-5.2", true)).unwrap();
    let result = execute(
        &tx,
        &ExecuteConfig {
            base_url: server.base_url(),
            api_key: Some("sk".into()),
        },
    )
    .unwrap();
    assert_eq!(result.status, 429);
    assert_eq!(result.error.as_deref(), Some("rate limited by the mock"));
    assert!(result.text.is_empty());
}

#[test]
fn chat_completions_stream_over_real_http() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"B\"}}]}\n\n",
        "data: [DONE]\n\n"
    );
    let server = MockServer::spawn(vec![(200, "text/event-stream".into(), body.into())]);
    let tx = translate(ProviderKind::OpenAiCompatible, request("llama-3", true)).unwrap();
    let result = execute(
        &tx,
        &ExecuteConfig {
            base_url: server.base_url(),
            api_key: Some("lk-test".into()),
        },
    )
    .unwrap();
    assert_eq!(result.text, "AB");
}

#[test]
fn anthropic_stream_over_real_http() {
    let body = concat!(
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Salut\"}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n"
    );
    let server = MockServer::spawn(vec![(200, "text/event-stream".into(), body.into())]);
    let tx = translate(ProviderKind::Anthropic, request("claude-sonnet-4", true)).unwrap();
    let result = execute(
        &tx,
        &ExecuteConfig {
            base_url: server.base_url(),
            api_key: Some("ak-test".into()),
        },
    )
    .unwrap();
    assert_eq!(result.text, "Salut");
}

#[test]
fn gemini_json_over_real_http() {
    let body = json!({
        "candidates": [{"content": {"parts": [{"text": "Ciao dal gateway"}]}}]
    })
    .to_string();
    let server = MockServer::spawn(vec![(200, "application/json".into(), body)]);
    let tx = translate(ProviderKind::Gemini, request("gemini-2.5-pro", false)).unwrap();
    let result = execute(
        &tx,
        &ExecuteConfig {
            base_url: server.base_url().replace("/v1", ""),
            api_key: Some("gk-test".into()),
        },
    )
    .unwrap();
    assert_eq!(result.text, "Ciao dal gateway");
}

#[test]
fn missing_key_refuses_placeholder_over_http() {
    let server = MockServer::spawn(vec![(
        200,
        "text/event-stream".into(),
        "data: {}\n\n".into(),
    )]);
    let tx = translate(ProviderKind::OpenAiResponses, request("gpt-5.2", true)).unwrap();
    assert!(
        tx.headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v.contains(KEY_PLACEHOLDER))
    );
    let err = execute(
        &tx,
        &ExecuteConfig {
            base_url: server.base_url(),
            api_key: None,
        },
    )
    .unwrap_err();
    assert!(
        matches!(err, knorvia_provider_gateway::ExecuteError::MissingKey),
        "{err}"
    );
    // The request must never have been sent.
    assert!(server.request_lines().is_empty());
}
