//! Loopback Responses-compatibility endpoint backed by a non-Responses
//! upstream. The Kernel keeps its single agent loop and always talks to this
//! bridge as if it were a Responses provider; the bridge translates each
//! request to the configured upstream protocol and streams the upstream SSE
//! back as Responses events.
//!
//! The listener binds loopback only and requires the caller-generated bearer
//! token on every request, so the bridge never becomes an open proxy.

use crate::bridge_cancel::{DisconnectWatch, RequestCancel, UpstreamTransport};
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::{Value, json};

use crate::bridge::{
    AnthropicSseTranslator, ChatSseTranslator, UpstreamProtocol, translate_request,
};
use crate::budget::{
    BudgetBreach, ERROR_BODY_BUDGET, LINE_BUDGET, LineRead, SseFrame, SseFramer, StreamBudget,
    read_capped_body, read_capped_line,
};
use crate::error_class::{classify_status, classify_transport, redact_secrets};
use crate::execute::category_name;
use knorvia_protocol::ErrorCategory;

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const UPSTREAM_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

pub struct BridgeServer {
    pub address: SocketAddr,
    pub auth_token: String,
    shutdown: crossbeam_stop::Stop,
    handle: Option<JoinHandle<()>>,
    requests: Arc<Mutex<HashMap<u64, RequestCancel>>>,
}

mod crossbeam_stop {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Clone, Default)]
    pub struct Stop(Arc<AtomicBool>);

    impl Stop {
        pub fn new() -> Self {
            Self::default()
        }
        pub fn stop(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
        pub fn stopped(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
}

/// Start the bridge on a random loopback port. Returns the bound address so
/// the Kernel can be pointed at it, plus the token the Kernel must present.
/// Upstream responses are read under the deployed budgets.
pub fn spawn(
    protocol: UpstreamProtocol,
    upstream_base_url: String,
    upstream_api_key: String,
    upstream_model_header: Option<String>,
) -> std::io::Result<BridgeServer> {
    spawn_with_budget(
        protocol,
        upstream_base_url,
        upstream_api_key,
        upstream_model_header,
        StreamBudget::from_env(),
    )
}

/// Start the bridge with explicitly declared response budgets, so a test (or
/// a tuned deployment) can pin what one upstream response may cost.
pub fn spawn_with_budget(
    protocol: UpstreamProtocol,
    upstream_base_url: String,
    upstream_api_key: String,
    upstream_model_header: Option<String>,
    budget: StreamBudget,
) -> std::io::Result<BridgeServer> {
    let transport = UpstreamTransport::prepare(&upstream_base_url)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let address = listener.local_addr()?;
    let auth_token = Arc::new(random_token()?);
    let accept_token = Arc::clone(&auth_token);
    let stop = crossbeam_stop::Stop::new();
    let listener_stop = stop.clone();
    let requests: Arc<Mutex<HashMap<u64, RequestCancel>>> = Arc::default();
    let active = Arc::clone(&requests);
    let handle = std::thread::Builder::new()
        .name("provider-bridge".into())
        .spawn(move || {
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            let mut request_id = 0u64;
            for stream in listener.incoming() {
                if listener_stop.stopped() {
                    break;
                }
                let Ok(stream) = stream else {
                    continue;
                };
                workers.retain(|worker| !worker.is_finished());
                if active.lock().unwrap_or_else(|e| e.into_inner()).len() >= 64 {
                    continue;
                }
                let cancel = RequestCancel::default();
                if cancel.register(&stream).is_err() {
                    continue;
                }
                request_id += 1;
                let id = request_id;
                active
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id, cancel.clone());
                let stop_for_connection = listener_stop.clone();
                let upstream = upstream_base_url.clone();
                let key = upstream_api_key.clone();
                let expected = Arc::clone(&accept_token);
                let model_header = upstream_model_header.clone();
                let transport = transport.clone();
                let registry = Arc::clone(&active);
                let request_cancel = cancel.clone();
                let budget_for_connection = budget.clone();
                let spawned = std::thread::Builder::new()
                    .name("provider-bridge-conn".into())
                    .spawn(move || {
                        serve_connection(
                            stream,
                            protocol,
                            &upstream,
                            &key,
                            expected,
                            model_header.as_deref(),
                            &stop_for_connection,
                            &request_cancel,
                            &transport,
                            &budget_for_connection,
                        );
                        request_cancel.cancel();
                        registry
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&id);
                    });
                match spawned {
                    Ok(worker) => workers.push(worker),
                    Err(_) => {
                        cancel.cancel();
                        active.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                    }
                }
            }
            for cancel in active.lock().unwrap_or_else(|e| e.into_inner()).values() {
                cancel.cancel();
            }
            for worker in workers {
                let _ = worker.join();
            }
        })?;
    Ok(BridgeServer {
        address,
        auth_token: auth_token.to_string(),
        shutdown: stop,
        handle: Some(handle),
        requests,
    })
}

impl BridgeServer {
    pub fn active_requests(&self) -> usize {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }
    pub fn active_request_ids(&self) -> Vec<u64> {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect()
    }
    pub fn cancel_request(&self, id: u64) -> bool {
        let cancel = self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned();
        if let Some(cancel) = cancel {
            cancel.cancel();
            true
        } else {
            false
        }
    }
    /// Stop accepting connections and join the accept thread.
    pub fn close(&mut self) {
        self.shutdown.stop();
        for cancel in self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            cancel.cancel();
        }
        // The accept thread blocks in `incoming()`; a loopback self-connect
        // gives it one more event so the stop flag is observed and the join
        // terminates.
        if std::net::TcpStream::connect(self.address).is_err() {
            // Already gone; nothing to wake.
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.close();
    }
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn serve_connection(
    mut stream: TcpStream,
    protocol: UpstreamProtocol,
    upstream_base: &str,
    upstream_key: &str,
    expected_token: std::sync::Arc<String>,
    upstream_model_header: Option<&str>,
    stop: &crossbeam_stop::Stop,
    cancel: &RequestCancel,
    transport: &UpstreamTransport,
    budget: &StreamBudget,
) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
    let Ok(raw) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(raw);
    if stop.stopped() {
        return;
    }
    // One request per connection: the only endpoint streams until close, so
    // dropping the socket after the response is the response framing.
    let Some(request) = read_request(&mut reader, &expected_token) else {
        let _ = write_simple(&mut stream, 400, "{\"error\":\"invalid request\"}");
        return;
    };
    let (authorized, _keep_alive, body) = request;
    if !authorized {
        let _ = write_simple(&mut stream, 401, "{\"error\":\"unauthorized\"}");
        return;
    }
    let Ok(_watch) = DisconnectWatch::start(&stream, cancel.clone()) else {
        return;
    };
    let _ = handle_responses_post(
        &mut stream,
        protocol,
        upstream_base,
        upstream_key,
        upstream_model_header,
        &body,
        cancel,
        transport,
        budget,
    );
}

type ParsedRequest = (bool, bool, Vec<u8>);

fn read_request(reader: &mut BufReader<TcpStream>, expected_token: &str) -> Option<ParsedRequest> {
    let request_line = capped_header_line(reader)?;
    let request_line = String::from_utf8_lossy(&request_line).to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?.to_string();
    if method != "POST" || !matches!(path.as_str(), "/v1/responses" | "/responses") {
        return None;
    }
    let mut content_length = 0usize;
    let mut authorization = String::new();
    let mut connection_close = false;
    let mut total = 0usize;
    loop {
        let read = capped_header_line(reader)?;
        total += read.len();
        if total > MAX_HEADER_BYTES {
            return None;
        }
        let line = String::from_utf8_lossy(&read).to_string();
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        } else if lower.starts_with("authorization:") {
            if !authorization.is_empty() {
                return None;
            }
            authorization = trimmed.split_once(':')?.1.trim().to_string();
        } else if lower.starts_with("transfer-encoding:") || lower.starts_with("origin:") {
            return None;
        } else if lower.starts_with("connection:") && lower.contains("close") {
            connection_close = true;
        }
    }
    if content_length > MAX_BODY_BYTES {
        return None;
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).ok()?;
    }
    // Header names are case-insensitive. reqwest emits lowercase names;
    // accepting only `Authorization:` previously mistook valid auth as absent.
    let authorized = authorization == format!("Bearer {expected_token}");
    Some((authorized, !connection_close, body))
}

/// One inbound HTTP line, bounded: an over-long line (or a stream that ends
/// mid-headers) is a rejected request, never an absorbed buffer.
fn capped_header_line(reader: &mut BufReader<TcpStream>) -> Option<Vec<u8>> {
    match read_capped_line(reader, MAX_HEADER_BYTES, LINE_BUDGET).ok()? {
        LineRead::Line(line) => Some(line),
        LineRead::End | LineRead::Breach(_) => None,
    }
}

fn handle_responses_post(
    stream: &mut TcpStream,
    protocol: UpstreamProtocol,
    upstream_base: &str,
    upstream_key: &str,
    upstream_model_header: Option<&str>,
    body: &[u8],
    cancel: &RequestCancel,
    transport: &UpstreamTransport,
    budget: &StreamBudget,
) -> std::io::Result<()> {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return write_simple(stream, 400, "{\"error\":\"invalid json\"}"),
    };
    let (compatible, identities) = crate::compat_tools::CompatTools::prepare(&parsed);
    let translated = match translate_request(protocol, &compatible) {
        Ok(value) => value,
        Err(message) => {
            let payload = json!({"error": {"message": redact_secrets(&message)}}).to_string();
            return write_simple(stream, 400, &payload);
        }
    };
    let upstream_path = match protocol {
        UpstreamProtocol::Responses => "responses",
        UpstreamProtocol::ChatCompletions => "chat/completions",
        UpstreamProtocol::AnthropicMessages => "messages",
    };
    let base = upstream_base.trim_end_matches('/');
    let url = if base.ends_with(upstream_path) {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/{upstream_path}")
    } else {
        format!("{base}/v1/{upstream_path}")
    };
    let request = transport.request(&url, cancel.clone())?;
    let mut request = match protocol {
        UpstreamProtocol::AnthropicMessages => request
            .set("x-api-key", upstream_key)
            .set("anthropic-version", "2023-06-01"),
        _ => request.set("Authorization", &format!("Bearer {upstream_key}")),
    };
    if let Some(model) = upstream_model_header {
        request = request.set("x-knorvia-upstream-model", model);
    }
    let response = match request
        .timeout(UPSTREAM_READ_TIMEOUT)
        .set("Content-Type", "application/json")
        .send_string(&translated.to_string())
    {
        Ok(response) => response,
        Err(ureq::Error::Status(status, response)) => {
            // Same classification contract as the direct execute path: keep
            // the status, forward Retry-After, surface a sanitized message
            // with typed retry metadata — never the raw upstream body.
            let retry_after = response.header("retry-after").map(str::to_string);
            let (text, breach) = read_upstream_error_body(response.into_reader(), budget);
            return write_classified_error(
                stream,
                status,
                retry_after.as_deref(),
                &text,
                breach.as_ref(),
            );
        }
        Err(error) => {
            let failure = classify_transport(&error.to_string());
            return write_error(
                stream,
                502,
                &error_json(
                    "upstream unreachable before a response arrived",
                    &failure,
                    None,
                ),
                None,
            );
        }
    };
    if response.status() >= 400 {
        let status = response.status();
        let retry_after = response.header("retry-after").map(str::to_string);
        let (text, breach) = read_upstream_error_body(response.into_reader(), budget);
        return write_classified_error(
            stream,
            status,
            retry_after.as_deref(),
            &text,
            breach.as_ref(),
        );
    }

    if cancel.stopped() {
        return Ok(());
    }
    // SSE pass-through with translation, framed and metered by the same
    // budgets the direct execution path uses.
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())?;
    let mut framer = SseFramer::new(response.into_reader(), budget.clone());
    let mut translator = match protocol {
        UpstreamProtocol::AnthropicMessages => {
            Translator::Anthropic(AnthropicSseTranslator::new().with_budget(budget.clone()))
        }
        _ => Translator::Chat(ChatSseTranslator::new().with_budget(budget.clone())),
    };
    let mut terminated = false;
    let mut wrote_event = false;
    let mut breach: Option<BudgetBreach> = None;
    loop {
        if cancel.stopped() {
            return Ok(());
        }
        let payload = match framer.next_frame() {
            Ok(SseFrame::Event(payload)) => payload,
            Ok(SseFrame::End) => break,
            Ok(SseFrame::Breach(limit)) => {
                breach = Some(limit);
                break;
            }
            Err(_) if cancel.stopped() => return Ok(()),
            // A failed upstream read leaves the stream unfinished; that is
            // reported below, not as a completed turn.
            Err(_) => break,
        };
        let events = match &mut translator {
            Translator::Chat(inner) => inner.feed(&payload),
            Translator::Anthropic(inner) => inner.feed(&payload),
        };
        for mut event in events {
            if cancel.stopped() {
                return Ok(());
            }
            identities.restore(&mut event);
            terminated |= matches!(
                event["type"].as_str(),
                Some("response.completed" | "response.failed")
            );
            let frame = format!("data: {}\n\n", event);
            stream.write_all(frame.as_bytes())?;
            stream.flush()?;
            wrote_event = true;
        }
        if let Some(limit) = translator.breach() {
            breach = Some(limit);
            break;
        }
        if payload.trim() == "[DONE]" {
            break;
        }
    }
    // A budget breach aborts this request with a typed resource-limit
    // failure — unless the upstream already finished its own turn, in which
    // case that completed fact stands and the unread remainder is dropped.
    if let Some(mut limit) = breach {
        limit.partial_kept = wrote_event;
        if !terminated {
            write_resource_limit_failure(stream, &limit)?;
        }
        return Ok(());
    }
    // A truncated stream is a failure, never a fabricated successful turn.
    if !terminated && !cancel.stopped() {
        let event = json!({"type":"response.failed","response":{"id":"bridge-interrupted","status":"failed","error":{"code":"upstream_stream_incomplete","message":"Upstream closed before its terminal event"}}});
        let frame = format!("data: {}\n\n", event);
        stream.write_all(frame.as_bytes())?;
    }
    stream.flush()
}

enum Translator {
    Chat(ChatSseTranslator),
    Anthropic(AnthropicSseTranslator),
}

impl Translator {
    fn breach(&self) -> Option<BudgetBreach> {
        match self {
            Self::Chat(inner) => inner.breach(),
            Self::Anthropic(inner) => inner.breach(),
        }
    }
}

/// Read an upstream error document under its budget: a truncated body stays
/// a diagnostic note beside the status, never a half-read document passed on
/// as the provider's full answer.
fn read_upstream_error_body<R: Read>(
    mut reader: R,
    budget: &StreamBudget,
) -> (String, Option<BudgetBreach>) {
    let (raw, breach) =
        read_capped_body(&mut reader, budget.max_error_body_bytes, ERROR_BODY_BUDGET)
            .unwrap_or_else(|_| (Vec::new(), None));
    (String::from_utf8_lossy(&raw).to_string(), breach)
}

/// The terminal event a budget breach produces for the Kernel: a failed
/// response carrying the declared limit that fired. Streaming text already
/// delivered stays provisional.
fn write_resource_limit_failure(
    stream: &mut TcpStream,
    limit: &BudgetBreach,
) -> std::io::Result<()> {
    let event = json!({
        "type": "response.failed",
        "response": {
            "id": "bridge-resource-limit",
            "status": "failed",
            "error": {
                "code": "upstream_stream_resource_limit",
                "message": limit.message(),
                "knorvia": {
                    "category": category_name(&ErrorCategory::ResourceExhausted),
                    "retryable": false,
                    "resourceLimit": limit,
                }
            }
        }
    });
    let frame = format!("data: {}\n\n", event);
    stream.write_all(frame.as_bytes())?;
    stream.flush()
}

fn write_simple(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    write_error(stream, status, body, None)
}

/// Write an error response with the classified body JSON and an optional
/// forwarded `Retry-After` header (normalized seconds form).
fn write_error(
    stream: &mut TcpStream,
    status: u16,
    body: &str,
    retry_after: Option<u64>,
) -> std::io::Result<()> {
    let retry_line = retry_after
        .map(|s| format!("retry-after: {s}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{}connection: close\r\n\r\n",
        status,
        match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            502 => "Bad Gateway",
            _ => "Error",
        },
        body.len(),
        retry_line
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// Extract a structured message from an upstream error body and respond
/// with the same classification contract the direct execute path uses.
/// `truncated` is the error-body budget breach, when the document was cut
/// off: the status classification stands and the message says so.
fn write_classified_error(
    stream: &mut TcpStream,
    status: u16,
    retry_after: Option<&str>,
    upstream_body: &str,
    truncated: Option<&BudgetBreach>,
) -> std::io::Result<()> {
    let mut failure = classify_status(
        status,
        retry_after,
        &crate::error_class::extract_provider_message(upstream_body)
            .unwrap_or_else(|| format!("provider returned HTTP {status} (body not surfaced)")),
    );
    if let Some(limit) = truncated {
        failure.message = format!("{} — {}", failure.message, limit.truncation_note());
    }
    let body = error_json(&failure.message, &failure, truncated);
    write_error(stream, status, &body, failure.retry_after_secs)
}

/// OpenAI-shaped error JSON plus the additive `knorvia` classification
/// block (category / retryable / retryAfter, and `resourceLimit` when a
/// declared budget was crossed) for typed consumers.
fn error_json(
    message: &str,
    failure: &crate::error_class::ProviderFailure,
    resource_limit: Option<&BudgetBreach>,
) -> String {
    let retry = failure
        .retry_after_secs
        .map(|s| json!(s))
        .unwrap_or(json!(null));
    let mut knorvia = json!({
        "category": category_name(&failure.category),
        "retryable": failure.retryable,
        "retryAfter": retry,
    });
    if let Some(limit) = resource_limit {
        knorvia["resourceLimit"] =
            serde_json::to_value(limit).unwrap_or_else(|_| json!({"budget": limit.budget}));
    }
    json!({
        "error": {
            "message": message,
            "type": category_name(&failure.category).to_lowercase(),
            "knorvia": knorvia,
        }
    })
    .to_string()
}
