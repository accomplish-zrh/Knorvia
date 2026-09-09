//! Loopback Responses-compatibility endpoint backed by a non-Responses
//! upstream. The Kernel keeps its single agent loop and always talks to this
//! bridge as if it were a Responses provider; the bridge translates each
//! request to the configured upstream protocol and streams the upstream SSE
//! back as Responses events.
//!
//! The listener binds loopback only and requires the caller-generated bearer
//! token on every request, so the bridge never becomes an open proxy.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::thread::JoinHandle;

use serde_json::{Value, json};

use crate::bridge::{
    AnthropicSseTranslator, ChatSseTranslator, UpstreamProtocol, translate_request,
};

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const UPSTREAM_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

pub struct BridgeServer {
    pub address: SocketAddr,
    pub auth_token: String,
    shutdown: crossbeam_stop::Stop,
    handle: Option<JoinHandle<()>>,
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
pub fn spawn(
    protocol: UpstreamProtocol,
    upstream_base_url: String,
    upstream_api_key: String,
    upstream_model_header: Option<String>,
) -> std::io::Result<BridgeServer> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let address = listener.local_addr()?;
    let auth_token = std::sync::Arc::new(random_token()?);
    let accept_token = std::sync::Arc::clone(&auth_token);
    let stop = crossbeam_stop::Stop::new();
    let listener_stop = stop.clone();
    let handle = std::thread::Builder::new()
        .name("provider-bridge".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if listener_stop.stopped() {
                    break;
                }
                let Ok(stream) = stream else { continue };
                if stream
                    .set_read_timeout(Some(UPSTREAM_READ_TIMEOUT))
                    .is_err()
                {
                    continue;
                }
                let stop_for_connection = listener_stop.clone();
                let upstream = upstream_base_url.clone();
                let key = upstream_api_key.clone();
                let expected = std::sync::Arc::clone(&accept_token);
                let model_header = upstream_model_header.clone();
                std::thread::Builder::new()
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
                        );
                    })
                    .ok();
            }
        })?;
    Ok(BridgeServer {
        address,
        auth_token: std::sync::Arc::clone(&auth_token).to_string(),
        shutdown: stop,
        handle: Some(handle),
    })
}

impl BridgeServer {
    /// Stop accepting connections and join the accept thread.
    pub fn close(&mut self) {
        self.shutdown.stop();
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
) {
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
    let _ = handle_responses_post(
        &mut stream,
        protocol,
        upstream_base,
        upstream_key,
        upstream_model_header,
        &body,
    );
}

type ParsedRequest = (bool, bool, Vec<u8>);

fn read_request(reader: &mut BufReader<TcpStream>, expected_token: &str) -> Option<ParsedRequest> {
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
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
        let mut line = String::new();
        let read = reader.read_line(&mut line).ok()?;
        if read == 0 {
            return None;
        }
        total += read;
        if total > MAX_HEADER_BYTES {
            return None;
        }
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

fn handle_responses_post(
    stream: &mut TcpStream,
    protocol: UpstreamProtocol,
    upstream_base: &str,
    upstream_key: &str,
    upstream_model_header: Option<&str>,
    body: &[u8],
) -> std::io::Result<()> {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return write_simple(stream, 400, "{\"error\":\"invalid json\"}"),
    };
    let (compatible, identities) = crate::compat_tools::CompatTools::prepare(&parsed);
    let translated = match translate_request(protocol, &compatible) {
        Ok(value) => value,
        Err(message) => {
            let payload = json!({"error": {"message": message}}).to_string();
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
    let mut request = match protocol {
        UpstreamProtocol::AnthropicMessages => ureq::post(&url)
            .set("x-api-key", upstream_key)
            .set("anthropic-version", "2023-06-01"),
        _ => ureq::post(&url).set("Authorization", &format!("Bearer {upstream_key}")),
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
            let text = response.into_string().unwrap_or_default();
            return write_simple(stream, status, &text);
        }
        Err(_) => {
            return write_simple(stream, 502, "{\"error\":\"upstream unreachable\"}");
        }
    };
    if response.status() >= 400 {
        let status = response.status();
        let text = response.into_string().unwrap_or_default();
        return write_simple(stream, status, &text);
    }

    // SSE pass-through with translation.
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())?;
    let mut reader = BufReader::new(response.into_reader());
    let mut translator = match protocol {
        UpstreamProtocol::AnthropicMessages => Translator::Anthropic(AnthropicSseTranslator::new()),
        _ => Translator::Chat(ChatSseTranslator::new()),
    };
    let mut terminated = false;
    loop {
        let mut line = String::new();
        let read = reader
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_line(&mut line)?;
        if line.len() > 8 * 1024 * 1024 {
            break;
        }
        if read == 0 {
            break;
        }
        let payload = match crate::bridge::sse_data_payload(line.trim_end()) {
            Some(payload) => payload,
            None => continue,
        };
        let events = match &mut translator {
            Translator::Chat(inner) => inner.feed(payload),
            Translator::Anthropic(inner) => inner.feed(payload),
        };
        for mut event in events {
            identities.restore(&mut event);
            terminated |= matches!(
                event["type"].as_str(),
                Some("response.completed" | "response.failed")
            );
            let frame = format!("data: {}\n\n", event);
            stream.write_all(frame.as_bytes())?;
            stream.flush()?;
        }
        if line.trim() == "data: [DONE]" {
            break;
        }
    }
    // A truncated stream is a failure, never a fabricated successful turn.
    if !terminated {
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

fn write_simple(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        status,
        match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            502 => "Bad Gateway",
            _ => "Error",
        },
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}
