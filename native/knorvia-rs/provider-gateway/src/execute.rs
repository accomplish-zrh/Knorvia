//! Live provider execution for translated Knorvia requests.
//!
//! Executes the exact body produced by `translate` against the configured
//! gateway and normalizes the provider response into text + tool calls.
//! Transport errors are typed; provider-side HTTP errors are returned in
//! `ExecutionResult.error` with the HTTP status. Secrets are substituted into
//! headers at execution time and never logged or returned.

use crate::{ProviderKind, TranslatedRequest};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

pub const PROVIDER_KEY_ENV: &str = "KNORVIA_PROVIDER_API_KEY";
pub const PROVIDER_BASE_URL_ENV: &str = "KNORVIA_PROVIDER_BASE_URL";
/// Placeholder in `TranslatedRequest.headers` that receives the real key at
/// execution time.
pub const KEY_PLACEHOLDER: &str = "${KNORVIA_PROVIDER_KEY}";

#[derive(Debug, thiserror::Error)]
pub enum ExecuteError {
    #[error("transport failure talking to the provider gateway: {0}")]
    Transport(String),
    #[error(
        "provider request needs an API key (set {PROVIDER_KEY_ENV}); refusing to send a placeholder"
    )]
    MissingKey,
    #[error("no provider base URL configured (set {PROVIDER_BASE_URL_ENV})")]
    MissingBaseUrl,
    #[error("failed to parse provider response: {0}")]
    Protocol(String),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, Default)]
pub struct ExecutionResult {
    /// HTTP status of the provider response (0 when transport failed before a
    /// response existed).
    pub status: u16,
    /// Concatenated assistant text.
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    /// Number of provider events/objects parsed (audit evidence).
    pub events: u64,
    /// Provider-side error message (HTTP >= 400 or stream error).
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecuteConfig {
    /// Provider origin, e.g. `https://api.openai.com/v1`. `join_url` resolves
    /// the translated endpoint against it.
    pub base_url: String,
    pub api_key: Option<String>,
}

fn host_of(url: &str) -> String {
    url.split_once("//")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn loopback_host(url: &str) -> bool {
    let host = host_of(url);
    let host = host.split(':').next().unwrap_or("");
    host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1"
}

/// Honor HTTP(S)_PROXY/ALL_PROXY for non-loopback targets, with NO_PROXY
/// exclusion. ureq 2 does not read these itself.
fn env_proxy_for(url: &str) -> Option<ureq::Proxy> {
    let scheme_value = if url.starts_with("https") {
        std::env::var("HTTPS_PROXY")
            .or_else(|_| std::env::var("https_proxy"))
            .ok()
    } else {
        std::env::var("HTTP_PROXY")
            .or_else(|_| std::env::var("http_proxy"))
            .ok()
    };
    let value = scheme_value
        .or_else(|| std::env::var("ALL_PROXY").ok())
        .or_else(|| std::env::var("all_proxy").ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let no_proxy = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let host = host_of(url);
    for rule in no_proxy.split(',') {
        let rule = rule.trim().trim_start_matches('.').to_ascii_lowercase();
        if rule.is_empty() {
            continue;
        }
        if host == rule || host.ends_with(&format!(".{rule}")) {
            return None;
        }
    }
    ureq::Proxy::new(value).ok()
}

/// Resolve the full request URL. The translated endpoint carries its own
/// version prefix (e.g. `/v1/responses`); a base URL that already ends with
/// the same prefix is joined without doubling it.
pub fn join_url(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = if endpoint.starts_with('/') {
        endpoint.to_string()
    } else {
        format!("/{endpoint}")
    };
    for prefix in ["/v1", "/v1beta"] {
        if let Some(stripped) = path.strip_prefix(prefix) {
            let base_trimmed = base.trim_end_matches(prefix);
            return format!("{}{prefix}{stripped}", base_trimmed.trim_end_matches('/'));
        }
    }
    format!("{base}{path}")
}

fn substitute_key(value: &str, api_key: Option<&str>) -> Result<String, ExecuteError> {
    if value.contains(KEY_PLACEHOLDER) {
        match api_key {
            Some(key) if !key.trim().is_empty() => return Ok(value.replace(KEY_PLACEHOLDER, key)),
            _ => return Err(ExecuteError::MissingKey),
        }
    }
    Ok(value.to_string())
}

fn provider_error_message(status: u16, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        let pointers = ["/error/message", "/message", "/error/status", "/error"];
        for pointer in pointers {
            if let Some(candidate) = v.pointer(pointer) {
                if let Some(s) = candidate.as_str() {
                    if !s.trim().is_empty() {
                        return s.to_string();
                    }
                }
            }
        }
    }
    if body.trim().is_empty() {
        format!("provider returned HTTP {status} with an empty body")
    } else {
        format!("provider returned HTTP {status}: {}", truncate(body, 300))
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

fn agent(proxy: Option<ureq::Proxy>) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(180));
    if let Some(proxy) = proxy {
        builder = builder.proxy(proxy);
    }
    builder.build()
}
/// Execute a translated request against the configured gateway.
pub fn execute(
    tx: &TranslatedRequest,
    cfg: &ExecuteConfig,
) -> Result<ExecutionResult, ExecuteError> {
    if cfg.base_url.trim().is_empty() {
        return Err(ExecuteError::MissingBaseUrl);
    }
    let url = join_url(&cfg.base_url, &tx.endpoint);
    // Local gateways must never traverse a proxy; remote gateways honor
    // HTTP(S)_PROXY/ALL_PROXY with NO_PROXY exclusion when configured.
    let proxy = if loopback_host(&url) {
        None
    } else {
        env_proxy_for(&url)
    };
    let agent = agent(proxy);
    let mut req = agent.request(tx.method.as_str(), &url);
    for (name, value) in &tx.headers {
        let resolved = substitute_key(value, cfg.api_key.as_deref())?;
        req = req.set(name, &resolved);
    }
    let body = serde_json::to_vec(&tx.body).map_err(|e| ExecuteError::Protocol(e.to_string()))?;
    let response = match req.send_bytes(&body) {
        Ok(resp) => resp,
        Err(ureq::Error::Status(code, resp)) => {
            // HTTP-level error: read the body and surface a typed result.
            let mut raw = Vec::new();
            let _ = resp.into_reader().take(64 * 1024).read_to_end(&mut raw);
            let text = String::from_utf8_lossy(&raw).to_string();
            return Ok(ExecutionResult {
                status: code,
                text: String::new(),
                tool_calls: Vec::new(),
                events: 0,
                error: Some(provider_error_message(code, &text)),
            });
        }
        Err(other) => return Err(ExecuteError::Transport(other.to_string())),
    };
    let status = response.status();
    let content_type = response
        .content_type()
        .split(';')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if status >= 400 {
        let mut raw = Vec::new();
        let _ = response.into_reader().take(64 * 1024).read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).to_string();
        return Ok(ExecutionResult {
            status,
            text: String::new(),
            tool_calls: Vec::new(),
            events: 0,
            error: Some(provider_error_message(status, &text)),
        });
    }
    let mut result = ExecutionResult {
        status,
        ..Default::default()
    };
    if content_type.contains("text/event-stream") {
        parse_sse(tx.kind, response.into_reader(), &mut result)?;
    } else {
        let mut raw = String::new();
        response
            .into_reader()
            .take(16 * 1024 * 1024)
            .read_to_string(&mut raw)
            .map_err(|e| ExecuteError::Transport(e.to_string()))?;
        let v: Value = serde_json::from_str(raw.trim())
            .map_err(|e| ExecuteError::Protocol(format!("non-JSON provider body: {e}")))?;
        result.events = 1;
        parse_single(tx.kind, &v, &mut result)?;
    }
    Ok(result)
}

/// Parse one provider object (non-streaming response body) into the result.
fn parse_single(
    kind: ProviderKind,
    v: &Value,
    out: &mut ExecutionResult,
) -> Result<(), ExecuteError> {
    if let Some(err) = extract_stream_error(kind, v) {
        out.error = Some(err);
        return Ok(());
    }
    match kind {
        ProviderKind::OpenAiResponses => {
            if let Some(items) = v.get("output").and_then(|o| o.as_array()) {
                for item in items {
                    collect_responses_item(item, out)?;
                }
            }
        }
        ProviderKind::OpenAiCompatible | ProviderKind::Local => {
            if let Some(choice) = v.pointer("/choices/0") {
                if let Some(text) = choice.pointer("/message/content").and_then(|c| c.as_str()) {
                    out.text.push_str(text);
                }
                if let Some(calls) = choice
                    .pointer("/message/tool_calls")
                    .and_then(|t| t.as_array())
                {
                    for call in calls {
                        out.tool_calls.push(openai_tool_call(call)?);
                    }
                }
            }
        }
        ProviderKind::Anthropic => {
            if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    collect_anthropic_block(block, out)?;
                }
            }
        }
        ProviderKind::Gemini => {
            if let Some(parts) = v
                .pointer("/candidates/0/content/parts")
                .and_then(|p| p.as_array())
            {
                collect_gemini_parts(parts, out)?;
            }
        }
    }
    Ok(())
}

/// Stream-parse an SSE body for the provider's wire format.
fn parse_sse<R: Read>(
    kind: ProviderKind,
    reader: R,
    out: &mut ExecutionResult,
) -> Result<(), ExecuteError> {
    let mut stream = SseStream::new(reader);
    while let Some(data) = stream.next_data()? {
        // Chat-completions wire: `[DONE]` is a non-JSON sentinel.
        if (kind == ProviderKind::OpenAiCompatible || kind == ProviderKind::Local)
            && data.trim() == "[DONE]"
        {
            return Ok(());
        }
        let v: Value = match serde_json::from_str(data.trim()) {
            Ok(v) => v,
            Err(e) => {
                return Err(ExecuteError::Protocol(format!(
                    "malformed SSE data from provider: {e}"
                )));
            }
        };
        out.events += 1;
        if let Some(err) = extract_stream_error(kind, &v) {
            out.error = Some(err);
            return Ok(());
        }
        match kind {
            ProviderKind::OpenAiResponses => match v.get("type").and_then(|t| t.as_str()) {
                Some("response.output_item.done") => {
                    if let Some(item) = v.get("item") {
                        collect_responses_item(item, out)?;
                    }
                }
                Some("response.completed") | Some("response.failed") => return Ok(()),
                _ => {}
            },
            ProviderKind::OpenAiCompatible | ProviderKind::Local => {
                if let Some(delta) = v.pointer("/choices/0/delta") {
                    if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                        out.text.push_str(text);
                    }
                    if let Some(calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                        for call in calls {
                            out.tool_calls.push(partial_tool_call(call));
                        }
                    }
                }
            }
            ProviderKind::Anthropic => match v.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if v.pointer("/delta/type").and_then(|t| t.as_str()) == Some("text_delta") {
                        if let Some(text) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                            out.text.push_str(text);
                        }
                    }
                }
                Some("message_stop") | Some("error") => return Ok(()),
                _ => {}
            },
            ProviderKind::Gemini => {
                if let Some(parts) = v
                    .pointer("/candidates/0/content/parts")
                    .and_then(|p| p.as_array())
                {
                    collect_gemini_parts(parts, out)?;
                }
                if v.get("done").and_then(|d| d.as_bool()) == Some(true) {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn extract_stream_error(kind: ProviderKind, v: &Value) -> Option<String> {
    match kind {
        ProviderKind::OpenAiResponses => {
            if v.get("type").and_then(|t| t.as_str()) == Some("response.failed") {
                return v
                    .pointer("/response/status_details/error/message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
                    .or_else(|| {
                        v.pointer("/response/error/message")
                            .and_then(|m| m.as_str())
                            .map(str::to_string)
                    })
                    .or_else(|| Some("response.failed".into()));
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("error") {
                return Some(
                    v.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("provider stream error")
                        .to_string(),
                );
            }
            None
        }
        ProviderKind::Anthropic => {
            if v.get("type").and_then(|t| t.as_str()) == Some("error") {
                return Some(
                    v.pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("provider stream error")
                        .to_string(),
                );
            }
            None
        }
        ProviderKind::OpenAiCompatible | ProviderKind::Local | ProviderKind::Gemini => {
            if v.get("error").is_some() {
                return Some(
                    v.pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("provider stream error")
                        .to_string(),
                );
            }
            None
        }
    }
}

fn collect_responses_item(item: &Value, out: &mut ExecutionResult) -> Result<(), ExecuteError> {
    match item.get("type").and_then(|t| t.as_str()) {
        Some("message") => {
            if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                for part in content {
                    if part.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                            out.text.push_str(text);
                        }
                    }
                }
            }
            Ok(())
        }
        Some("function_call") => {
            let name = item
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let raw_args = item.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let arguments = match raw_args {
                Value::String(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({"raw": s})),
                other => other,
            };
            out.tool_calls.push(ToolCall { name, arguments });
            Ok(())
        }
        _ => Ok(()),
    }
}

fn collect_anthropic_block(block: &Value, out: &mut ExecutionResult) -> Result<(), ExecuteError> {
    match block.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                out.text.push_str(text);
            }
            Ok(())
        }
        Some("tool_use") => {
            out.tool_calls.push(ToolCall {
                name: block
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string(),
                arguments: block.get("input").cloned().unwrap_or_else(|| json!({})),
            });
            Ok(())
        }
        _ => Ok(()),
    }
}

fn collect_gemini_parts(parts: &[Value], out: &mut ExecutionResult) -> Result<(), ExecuteError> {
    for part in parts {
        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
            out.text.push_str(text);
        }
        if let Some(call) = part.get("functionCall") {
            out.tool_calls.push(ToolCall {
                name: call
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string(),
                arguments: call.get("args").cloned().unwrap_or_else(|| json!({})),
            });
        }
    }
    Ok(())
}

fn openai_tool_call(call: &Value) -> Result<ToolCall, ExecuteError> {
    let name = call
        .pointer("/function/name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let raw = call
        .pointer("/function/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let arguments = match raw {
        Value::String(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({"raw": s})),
        other => other,
    };
    Ok(ToolCall { name, arguments })
}

fn partial_tool_call(call: &Value) -> ToolCall {
    let name = call
        .pointer("/function/name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let raw = call
        .pointer("/function/arguments")
        .cloned()
        .unwrap_or(json!({}));
    let arguments = match raw {
        Value::String(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({"raw": s})),
        other => other,
    };
    ToolCall { name, arguments }
}

/// Minimal SSE reader: yields the payload of each `data:` block.
struct SseStream<R: Read> {
    reader: BufReader<R>,
    buf: String,
}

impl<R: Read> SseStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            buf: String::new(),
        }
    }

    fn next_data(&mut self) -> Result<Option<String>, ExecuteError> {
        let mut data = String::new();
        loop {
            let mut line = String::new();
            let n = self
                .reader
                .read_line(&mut line)
                .map_err(|e| ExecuteError::Transport(e.to_string()))?;
            if n == 0 {
                return if data.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(data))
                };
            }
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !data.is_empty() {
                    return Ok(Some(std::mem::take(&mut data)));
                }
                continue;
            }
            if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.trim_start());
            }
            // `event:`, `id:`, `retry:` and comment lines are ignored: the
            // provider wire carries its kind inside the JSON payload.
        }
    }
}

#[cfg(test)]
mod execute_tests {
    use super::*;
    use crate::{CanonicalRequest, ProviderKind, translate};

    fn tx_for(kind: ProviderKind, model: &str, stream: bool) -> TranslatedRequest {
        let req = CanonicalRequest {
            model: model.into(),
            messages: vec![crate::CanonicalMessage {
                role: "user".into(),
                text: "hi".into(),
                ..Default::default()
            }],
            stream,
            max_tokens: 64,
            ..Default::default()
        };
        translate(kind, req).unwrap()
    }

    #[test]
    fn join_url_resolves_version_prefixes_without_doubling() {
        assert_eq!(
            join_url("https://api.openai.com/v1", "/v1/responses"),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            join_url("https://api.openai.com", "/v1/responses"),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            join_url(
                "https://generativelanguage.googleapis.com",
                "/v1beta/models/m:generateContent"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent"
        );
        assert_eq!(
            join_url("http://127.0.0.1:8080/v1", "/v1/chat/completions"),
            "http://127.0.0.1:8080/v1/chat/completions"
        );
    }

    #[test]
    fn missing_key_is_typed_never_placeholder_sent() {
        let tx = tx_for(ProviderKind::OpenAiResponses, "gpt-5.2", false);
        let cfg = ExecuteConfig {
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: None,
        };
        let err = execute(&tx, &cfg).unwrap_err();
        assert!(matches!(err, ExecuteError::MissingKey), "{err}");
    }

    #[test]
    fn local_provider_needs_no_key() {
        let tx = tx_for(ProviderKind::Local, "ollama/llama3.1", false);
        let cfg = ExecuteConfig {
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: None,
        };
        // Connection refused (port 9) → typed transport error, not a panic.
        let err = execute(&tx, &cfg).unwrap_err();
        assert!(matches!(err, ExecuteError::Transport(_)), "{err}");
    }

    #[test]
    fn missing_base_url_is_typed() {
        let tx = tx_for(ProviderKind::Local, "llama", false);
        let cfg = ExecuteConfig {
            base_url: String::new(),
            api_key: None,
        };
        let err = execute(&tx, &cfg).unwrap_err();
        assert!(matches!(err, ExecuteError::MissingBaseUrl), "{err}");
    }

    #[test]
    fn parses_provider_http_error_bodies() {
        assert_eq!(
            provider_error_message(429, r#"{"error":{"message":"rate limited","code":"429"}}"#),
            "rate limited"
        );
        assert_eq!(
            provider_error_message(500, "boom"),
            "provider returned HTTP 500: boom"
        );
        assert_eq!(
            provider_error_message(500, ""),
            "provider returned HTTP 500 with an empty body"
        );
    }

    #[test]
    fn sse_stream_yields_data_blocks() {
        let body = "event: a\ndata: {\"n\":1}\n\nevent: b\ndata: {\"n\":2}\n\ndata: [DONE]\n\n";
        let mut stream = SseStream::new(body.as_bytes());
        assert_eq!(stream.next_data().unwrap().unwrap(), "{\"n\":1}");
        assert_eq!(stream.next_data().unwrap().unwrap(), "{\"n\":2}");
        assert_eq!(stream.next_data().unwrap().unwrap(), "[DONE]");
        assert!(stream.next_data().unwrap().is_none());
    }

    #[test]
    fn parses_responses_sse_text_and_tool_calls() {
        let body = concat!(
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello \"},{\"type\":\"output_text\",\"text\":\"world\"}]}}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n",
        );
        let mut out = ExecutionResult::default();
        parse_sse(ProviderKind::OpenAiResponses, body.as_bytes(), &mut out).unwrap();
        assert_eq!(out.text, "Hello world");
        assert_eq!(out.tool_calls.len(), 1);
        assert_eq!(out.tool_calls[0].name, "lookup");
        assert_eq!(out.tool_calls[0].arguments["q"], "x");
        assert_eq!(out.events, 4);
        assert!(out.error.is_none());
    }

    #[test]
    fn parses_chat_completions_sse_delta() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let mut out = ExecutionResult::default();
        parse_sse(ProviderKind::OpenAiCompatible, body.as_bytes(), &mut out).unwrap();
        assert_eq!(out.text, "Hi there");
    }

    #[test]
    fn parses_anthropic_sse_text() {
        let body = concat!(
            "data: {\"type\":\"message_start\"}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Bonjour\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\" le monde\"}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let mut out = ExecutionResult::default();
        parse_sse(ProviderKind::Anthropic, body.as_bytes(), &mut out).unwrap();
        assert_eq!(out.text, "Bonjour le monde");
    }

    #[test]
    fn parses_anthropic_stream_error() {
        let body = "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let mut out = ExecutionResult::default();
        parse_sse(ProviderKind::Anthropic, body.as_bytes(), &mut out).unwrap();
        assert_eq!(out.error.as_deref(), Some("Overloaded"));
    }

    #[test]
    fn parses_gemini_single_and_parts() {
        let v = json!({
            "candidates": [{
                "content": {"parts": [
                    {"text": "Ciao"},
                    {"functionCall": {"name": "lookup", "args": {"q": "x"}}}
                ]}
            }]
        });
        let mut out = ExecutionResult::default();
        parse_single(ProviderKind::Gemini, &v, &mut out).unwrap();
        assert_eq!(out.text, "Ciao");
        assert_eq!(out.tool_calls[0].name, "lookup");
    }

    #[test]
    fn parses_compatible_tool_call_arguments() {
        let call = json!({"id": "c1", "type": "function", "function": {"name": "lookup", "arguments": "{\"q\":\"y\"}"}});
        let parsed = openai_tool_call(&call).unwrap();
        assert_eq!(parsed.arguments["q"], "y");
    }
}
