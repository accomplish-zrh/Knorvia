//! A13 acceptance: every provider read path is bounded by a declared budget,
//! and crossing one aborts only that request with a typed resource-limit
//! diagnosis. Each test drives a real local HTTP upstream over a socket — the
//! same transport the product uses — so the budgets are exercised at the byte
//! boundaries they exist for, not against a mocked reader.

use knorvia_provider_gateway::{
    BridgeServer, BudgetBreach, CanonicalMessage, CanonicalRequest, ExecuteConfig, ExecutionResult,
    ProviderKind, StreamBudget, UpstreamProtocol, execute_with_budget,
    spawn_responses_bridge_with_budget, translate,
};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// Scripted upstream: answers every request with `status` + `extra_headers`
/// and then the given raw byte chunks, flushing after each so chunk
/// boundaries are exactly what the test asks for.
fn scripted(status: u16, extra_headers: &str, chunks: Vec<Vec<u8>>) -> String {
    scripted_body(status, "text/event-stream", extra_headers, chunks)
}

/// Scripted upstream with an explicit content type, so both the SSE path and
/// the single-document path can be driven over a real socket.
fn scripted_body(
    status: u16,
    content_type: &str,
    extra_headers: &str,
    chunks: Vec<Vec<u8>>,
) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind scripted upstream");
    let addr = listener.local_addr().unwrap();
    let head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\n{extra_headers}connection: close\r\n\r\n"
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            drain_request(&mut stream);
            let _ = stream.write_all(head.as_bytes());
            for chunk in &chunks {
                let sent = stream.write_all(chunk).and_then(|_| stream.flush());
                if sent.is_err() {
                    break; // the reader aborted: stop writing at once
                }
            }
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    });
    format!("http://{addr}/v1")
}

fn drain_request(stream: &mut TcpStream) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while stream.read(&mut byte).unwrap_or(0) == 1 {
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&head).to_string();
    let length = text
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|rest| rest.trim().parse::<usize>().unwrap_or(0))
        })
        .unwrap_or(0);
    if length > 0 {
        let mut body = vec![0u8; length];
        let _ = stream.read_exact(&mut body);
    }
}

fn request(model: &str) -> CanonicalRequest {
    CanonicalRequest {
        model: model.into(),
        messages: vec![CanonicalMessage {
            role: "user".into(),
            text: "hi".into(),
            ..Default::default()
        }],
        stream: true,
        max_tokens: 64,
        ..Default::default()
    }
}

struct BudgetOutcome {
    elapsed: Duration,
    result: ExecutionResult,
}

impl BudgetOutcome {
    fn breach(&self) -> BudgetBreach {
        self.result
            .resource_limit
            .clone()
            .unwrap_or_else(|| panic!("expected a typed resource limit, got {:?}", self.result))
    }
}

fn run(base_url: &str, kind: ProviderKind, budget: StreamBudget) -> BudgetOutcome {
    run_request(base_url, kind, request("fixture-model"), budget)
}

fn run_request(
    base_url: &str,
    kind: ProviderKind,
    canonical: CanonicalRequest,
    budget: StreamBudget,
) -> BudgetOutcome {
    let tx = translate(kind, canonical).expect("translate");
    let started = Instant::now();
    let result = execute_with_budget(
        &tx,
        &ExecuteConfig {
            base_url: base_url.into(),
            api_key: Some("sk-knorvia-fixture".into()),
        },
        &budget,
    )
    .expect("the budget path reports a result, not a transport error");
    BudgetOutcome {
        elapsed: started.elapsed(),
        result,
    }
}

const DONE: &str = "data: [DONE]\n\n";

/// One Chat Completions delta line whose physical length (including the
/// trailing newline) is exactly `line_len` bytes; also returns how many
/// characters of assistant text it carries.
fn delta_line_of_len(line_len: usize) -> (String, usize) {
    let empty = r#"{"choices":[{"delta":{"content":""}}]}"#;
    let overhead = "data: ".len() + empty.len() + "\n".len();
    let pad = line_len - overhead;
    let payload = empty.replace(
        r#""content":"""#,
        &format!(r#""content":"{}""#, "p".repeat(pad)),
    );
    (format!("data: {payload}\n"), pad)
}

/// Frame one complete SSE event (blank-line terminated, as every real
/// provider does between events).
fn sse_event(payload: serde_json::Value) -> String {
    format!("data: {payload}\n\n")
}

/// First fragment of a tool call: carries the call id and function name.
fn chat_args_open(name: &str, piece: &str) -> String {
    sse_event(serde_json::json!({"choices": [{"delta": {"tool_calls": [
        {"index": 0, "id": "call_1", "function": {"name": name, "arguments": piece}}
    ]}}]}))
}

/// Continuation fragment: argument text only.
fn chat_args_piece(piece: &str) -> String {
    sse_event(serde_json::json!({"choices": [{"delta": {"tool_calls": [
        {"index": 0, "function": {"arguments": piece}}
    ]}}]}))
}

fn chat_finish_reason(reason: &str) -> String {
    sse_event(serde_json::json!({"choices": [{"delta": {}, "finish_reason": reason}]}))
}

/// Reads the whole SSE body a Kernel-side client gets back from the bridge.
fn bridge_events(bridge: &BridgeServer, body: serde_json::Value) -> Vec<serde_json::Value> {
    let response = ureq::post(&format!("http://{}/v1/responses", bridge.address))
        .set("authorization", &format!("Bearer {}", bridge.auth_token))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(60))
        .send_string(&body.to_string())
        .expect("bridge responds");
    assert_eq!(response.status(), 200);
    response
        .into_string()
        .unwrap()
        .split("\n\n")
        .filter_map(|frame| frame.strip_prefix("data: "))
        .map(|payload| serde_json::from_str(payload).expect("data frame is JSON"))
        .collect()
}

fn kernel_request() -> serde_json::Value {
    serde_json::json!({
        "model": "fixture-model",
        "instructions": "Be brief.",
        "input": [{"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "hi"}]}],
        "tools": [{"type": "function", "name": "exec_command",
            "description": "run", "parameters": {"type": "object"}}]
    })
}

fn kinds(events: &[serde_json::Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| event["type"].as_str().unwrap_or("?").to_string())
        .collect()
}

#[test]
fn a_line_with_no_newline_breaches_at_the_line_budget_and_stops_reading() {
    let upstream = scripted(200, "", vec![b"data: ".to_vec(), vec![b'a'; 1024 * 1024]]);
    let budget = StreamBudget {
        max_line_bytes: 8192,
        ..Default::default()
    };

    let outcome = run(&upstream, ProviderKind::OpenAiCompatible, budget);
    let breach = outcome.breach();
    assert_eq!(breach.budget, "line");
    assert_eq!(breach.limit, 8192);
    assert!(
        breach.received <= 64 * 1024,
        "the flood must be stopped near the cap, not buffered whole: {breach:?}"
    );
    assert!(
        outcome.elapsed < Duration::from_secs(30),
        "aborting is immediate, not after draining the flood: {:?}",
        outcome.elapsed
    );
    assert_eq!(outcome.result.status, 200, "the status fact survives");
    assert!(
        outcome.result.stream_incomplete,
        "a truncated response is never a completion"
    );
    assert!(outcome.result.tool_calls.is_empty());
    assert_eq!(outcome.result.retryable, Some(false));
    let message = outcome.result.error.clone().unwrap_or_default();
    assert!(
        message.contains("this request was aborted"),
        "the diagnosis must say the request was aborted: {message}"
    );
    assert_eq!(
        outcome.result.error_category.as_deref(),
        Some("RESOURCE_EXHAUSTED")
    );
}

#[test]
fn one_event_stitched_from_many_small_lines_breaches_the_event_budget() {
    let line = format!("data: {{\"pad\":\"{}\"}}\n", "x".repeat(3000));
    let body: String = (0..200).map(|_| line.clone()).collect();
    let upstream = scripted(200, "", vec![body.into_bytes()]);
    let budget = StreamBudget {
        max_event_bytes: 65_536,
        ..Default::default()
    };

    let outcome = run(&upstream, ProviderKind::OpenAiResponses, budget);
    let breach = outcome.breach();
    assert_eq!(
        breach.budget, "event",
        "small lines that join one oversized event are still capped: {breach:?}"
    );
    assert_eq!(breach.limit, 65_536);
    assert!(outcome.result.text.is_empty());
    assert!(outcome.result.stream_incomplete);
}

#[test]
fn growing_tool_arguments_are_capped_and_never_executed_truncated() {
    let mut body = String::new();
    body.push_str(&chat_args_open("write_file", "{\"content\":\""));
    for _ in 0..2000 {
        body.push_str(&chat_args_piece("aaaaaaaaaa"));
    }
    body.push_str(&chat_finish_reason("tool_calls"));
    body.push_str(DONE);
    let upstream = scripted(200, "", vec![body.into_bytes()]);
    let budget = StreamBudget {
        max_tool_args_bytes: 16 * 1024,
        ..Default::default()
    };

    let outcome = run(&upstream, ProviderKind::OpenAiCompatible, budget);
    let breach = outcome.breach();
    assert_eq!(breach.budget, "toolArguments");
    assert_eq!(breach.limit, 16 * 1024);
    assert!(
        outcome.result.tool_calls.is_empty(),
        "a truncated tool call must never reach the executor: {:?}",
        outcome.result.tool_calls
    );
    assert!(outcome.result.stream_incomplete);
    assert_eq!(
        outcome.result.error_category.as_deref(),
        Some("RESOURCE_EXHAUSTED")
    );
}

#[test]
fn a_giant_error_document_keeps_its_classification_and_says_it_was_cut() {
    let junk = "echo".repeat(100 * 1024);
    let body = format!(
        "{{\"error\":{{\"message\":\"slow down\",\"code\":\"rate_limit_exceeded\",\"blob\":\"{junk}\"}}}}"
    );
    let upstream = scripted(429, "retry-after: 7\r\n", vec![body.into_bytes()]);
    let budget = StreamBudget {
        max_error_body_bytes: 16 * 1024,
        ..Default::default()
    };

    let outcome = run(&upstream, ProviderKind::OpenAiResponses, budget);
    assert_eq!(outcome.result.status, 429);
    assert_eq!(
        outcome.result.error_category.as_deref(),
        Some("PROVIDER_RATE_LIMIT"),
        "the status classification stands beside the truncation note"
    );
    assert_eq!(outcome.result.retry_after, Some(7));
    assert_eq!(outcome.result.retryable, Some(true));
    let breach = outcome.breach();
    assert_eq!(breach.budget, "errorBody");
    let message = outcome.result.error.clone().unwrap_or_default();
    assert!(
        message.contains("errorBody budget of 16384 bytes exceeded"),
        "{message}"
    );
    assert!(
        message.len() < 4096 && !message.contains("echo"),
        "a raw upstream body never reaches the error text: {} bytes",
        message.len()
    );
}

#[test]
fn an_oversized_single_document_reports_a_resource_limit_not_a_parse_failure() {
    let pad = "y".repeat(200 * 1024);
    let document = format!(
        "{{\"id\":\"resp-1\",\"output\":[{{\"type\":\"message\",\"role\":\"assistant\",\
         \"content\":[{{\"type\":\"output_text\",\"text\":\"{pad}\"}}]}}]}}"
    );
    let upstream = scripted_body(200, "application/json", "", vec![document.into_bytes()]);
    let budget = StreamBudget {
        max_total_bytes: 64 * 1024,
        ..Default::default()
    };
    let mut canonical = request("fixture-model");
    canonical.stream = false;

    let outcome = run_request(&upstream, ProviderKind::OpenAiResponses, canonical, budget);
    let breach = outcome.breach();
    assert_eq!(breach.budget, "totalOutput");
    assert_eq!(breach.limit, 64 * 1024);
    assert!(
        !breach.partial_kept,
        "a cut single document holds no usable partial answer"
    );
    assert!(outcome.result.text.is_empty());
    assert!(outcome.result.stream_incomplete);
    assert_eq!(
        outcome.result.error_category.as_deref(),
        Some("RESOURCE_EXHAUSTED"),
        "an oversized body is a resource limit, not a parse failure"
    );
    assert!(
        !outcome
            .result
            .error
            .clone()
            .unwrap_or_default()
            .contains("non-JSON"),
        "{:?}",
        outcome.result.error
    );
    assert!(
        outcome.elapsed < Duration::from_secs(30),
        "reading stops at the cap, not after draining the document: {:?}",
        outcome.elapsed
    );
}

#[test]
fn the_line_cap_is_inclusive_just_below_and_breaches_one_byte_over() {
    let cap = 4096;
    let (fitting, pad) = delta_line_of_len(cap);
    let upstream = scripted(200, "", vec![format!("{}\n{DONE}", fitting).into_bytes()]);
    let budget = StreamBudget {
        max_line_bytes: cap,
        ..Default::default()
    };
    let outcome = run(&upstream, ProviderKind::OpenAiCompatible, budget.clone());
    assert!(
        outcome.result.resource_limit.is_none(),
        "a large-but-legal line at the cap must not be cut short: {:?}",
        outcome.result
    );
    assert_eq!(outcome.result.text.len(), pad);
    assert!(
        !outcome.result.stream_incomplete,
        "the same stream that reaches [DONE] is a completion"
    );

    let (over, _) = delta_line_of_len(cap + 1);
    let over_upstream = scripted(200, "", vec![format!("{}\n{DONE}", over).into_bytes()]);
    let outcome = run(&over_upstream, ProviderKind::OpenAiCompatible, budget);
    assert_eq!(outcome.breach().budget, "line");
    assert_eq!(outcome.breach().limit, cap as u64);
    assert!(outcome.result.stream_incomplete);
}

#[test]
fn multibyte_text_split_across_tiny_chunks_still_arrives_whole() {
    let text = "你好🌊 世界 – émoji";
    let payload = sse_event(serde_json::json!({"choices": [{"delta": {"content": text}}]}));
    let bytes = payload.as_bytes();
    let mut chunks: Vec<Vec<u8>> = bytes.chunks(1).map(|c| c.to_vec()).collect();
    chunks.push(DONE.as_bytes().to_vec());
    let upstream = scripted(200, "", chunks);
    let outcome = run(
        &upstream,
        ProviderKind::OpenAiCompatible,
        StreamBudget {
            max_line_bytes: 4096,
            ..Default::default()
        },
    );
    assert_eq!(outcome.result.text, "你好🌊 世界 – émoji");
    assert!(outcome.result.resource_limit.is_none());
    assert!(!outcome.result.stream_incomplete);
}

#[test]
fn a_breached_request_leaves_other_concurrent_requests_alone() {
    let flooding = scripted(200, "", vec![b"data: ".to_vec(), vec![b'z'; 512 * 1024]]);
    let calm_body =
        format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"untouched\"}}}}]}}\n\n{DONE}");
    let calm = scripted(200, "", vec![calm_body.into_bytes()]);

    let calm_for_thread = calm.clone();
    let other = std::thread::spawn(move || {
        run(
            &calm_for_thread,
            ProviderKind::OpenAiCompatible,
            StreamBudget::default(),
        )
    });
    let breaching = run(
        &flooding,
        ProviderKind::OpenAiCompatible,
        StreamBudget {
            max_line_bytes: 8192,
            ..Default::default()
        },
    );
    let untouched = other.join().expect("the other request finishes");

    assert_eq!(breaching.breach().budget, "line");
    assert_eq!(untouched.result.text, "untouched");
    assert!(
        untouched.result.resource_limit.is_none(),
        "another request's budget must not be affected: {:?}",
        untouched.result
    );
    assert!(!untouched.result.stream_incomplete);

    // And a later request in the same process still behaves normally.
    let again = run(
        &calm,
        ProviderKind::OpenAiCompatible,
        StreamBudget::default(),
    );
    assert_eq!(again.result.text, "untouched");
    assert!(again.result.resource_limit.is_none());
}

#[test]
fn the_bridge_aborts_a_line_flood_with_a_typed_resource_limit_event() {
    let upstream = scripted(200, "", vec![b"data: ".to_vec(), vec![b'q'; 256 * 1024]]);
    let mut bridge = spawn_responses_bridge_with_budget(
        UpstreamProtocol::ChatCompletions,
        upstream,
        "fixture-key".into(),
        None,
        StreamBudget {
            max_line_bytes: 8192,
            ..Default::default()
        },
    )
    .unwrap();
    let events = bridge_events(&bridge, kernel_request());
    bridge.close();

    let kinds = kinds(&events);
    assert!(
        !kinds.contains(&"response.completed".to_string()),
        "a truncated upstream stream can never look completed: {kinds:?}"
    );
    let failed = events
        .iter()
        .find(|event| event["type"] == "response.failed")
        .expect("the bridge must end with an explicit failure");
    assert_eq!(
        failed["response"]["error"]["code"], "upstream_stream_resource_limit",
        "{failed}"
    );
    assert_eq!(
        failed["response"]["error"]["knorvia"]["category"],
        "RESOURCE_EXHAUSTED"
    );
    assert_eq!(
        failed["response"]["error"]["knorvia"]["resourceLimit"]["budget"],
        "line"
    );
    assert_eq!(
        failed["response"]["error"]["knorvia"]["resourceLimit"]["limit"],
        8192
    );
}

#[test]
fn the_bridge_never_forwards_truncated_tool_arguments() {
    let mut body = String::new();
    body.push_str(&chat_args_open("exec_command", "{\"cmd\":\""));
    for _ in 0..1200 {
        body.push_str(&chat_args_piece("bbbbbbbbbb"));
    }
    body.push_str(&chat_finish_reason("tool_calls"));
    body.push_str(DONE);
    let upstream = scripted(200, "", vec![body.into_bytes()]);
    let mut bridge = spawn_responses_bridge_with_budget(
        UpstreamProtocol::ChatCompletions,
        upstream,
        "fixture-key".into(),
        None,
        StreamBudget {
            max_tool_args_bytes: 8 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let events = bridge_events(&bridge, kernel_request());
    bridge.close();

    assert!(
        !events.iter().any(|event| {
            event["type"] == "response.output_item.done" && event["item"]["type"] == "function_call"
        }),
        "no completed function call may be forwarded from a truncated argument stream"
    );
    let forwarded = serde_json::to_string(&events).unwrap();
    assert!(
        !forwarded.contains("bbbbbbbbbb"),
        "no partial argument text may reach the Kernel from an aborted stream"
    );
    let kinds = kinds(&events);
    assert!(
        !kinds.contains(&"response.completed".to_string()),
        "{kinds:?}"
    );
    let failed = events
        .iter()
        .find(|event| event["type"] == "response.failed")
        .expect("the Kernel sees a failure, not a hang");
    assert_eq!(
        failed["response"]["error"]["code"], "upstream_stream_resource_limit",
        "{failed}"
    );
    assert_eq!(
        failed["response"]["error"]["knorvia"]["resourceLimit"]["budget"],
        "toolArguments"
    );
    assert_eq!(
        failed["response"]["error"]["knorvia"]["resourceLimit"]["limit"],
        8 * 1024
    );
}

#[test]
fn the_bridge_still_completes_a_normal_stream_under_the_same_budgets() {
    let body = concat!(
        "data: {\"id\":\"chatcmpl-ok\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"fine\"}}]}\n\n",
        "data: {\"id\":\"chatcmpl-ok\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    let upstream = scripted(200, "", vec![body.as_bytes().to_vec()]);
    let mut bridge = spawn_responses_bridge_with_budget(
        UpstreamProtocol::ChatCompletions,
        upstream,
        "fixture-key".into(),
        None,
        StreamBudget::default(),
    )
    .unwrap();
    let events = bridge_events(&bridge, kernel_request());
    bridge.close();

    let kinds = kinds(&events);
    assert!(
        kinds.contains(&"response.completed".to_string()),
        "{kinds:?}"
    );
    assert!(!kinds.contains(&"response.failed".to_string()), "{kinds:?}");
    let text: String = events
        .iter()
        .filter(|event| event["type"] == "response.output_text.delta")
        .map(|event| event["delta"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(text, "fine");
}
