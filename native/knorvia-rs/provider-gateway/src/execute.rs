//! Live provider execution for translated Knorvia requests.
//!
//! Executes the exact body produced by `translate` against the configured
//! gateway and normalizes the provider response into text + tool calls.
//! Transport errors are typed; provider-side HTTP errors are classified onto
//! the protocol error contract (category + retryable + normalized
//! `Retry-After`) via `crate::error_class`, shared with the Kernel bridge
//! path. Provider response bodies are never surfaced verbatim: only redacted
//! structured message fields reach the error text. Secrets are substituted
//! into headers at execution time and never logged or returned.

use crate::budget::{
    BudgetBreach, ERROR_BODY_BUDGET, SseFrame, SseFramer, StreamBudget, TOOL_ARGS_BUDGET,
    TOTAL_OUTPUT_BUDGET, read_capped_body,
};
use crate::error_class::{ProviderFailure, classify_status, classify_stream_error, redact_secrets};
use crate::{ProviderKind, TranslatedRequest};
use knorvia_protocol::ErrorCategory;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Read;
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

impl ExecuteError {
    fn transport(message: impl AsRef<str>) -> Self {
        Self::Transport(knorvia_protocol::sanitize_diagnostic(message.as_ref()))
    }

    fn protocol(message: impl AsRef<str>) -> Self {
        Self::Protocol(knorvia_protocol::sanitize_diagnostic(message.as_ref()))
    }

    /// Safe rendering for callers that sit on another persistence boundary.
    /// This also protects against an externally constructed enum variant.
    pub fn sanitized_message(&self) -> String {
        knorvia_protocol::sanitize_diagnostic(&self.to_string())
    }
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
    /// Provider-side error message (HTTP >= 400 or stream error) — redacted
    /// structured fields only, never a raw response body.
    pub error: Option<String>,
    /// Protocol error category for `error` (e.g. `PROVIDER_RATE_LIMIT`),
    /// classified identically on the direct and Kernel bridge paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_category: Option<String>,
    /// Whether retrying the same request can succeed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    /// Normalized `Retry-After` seconds (integer or HTTP-date form).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
    /// The SSE stream ended without the provider's terminal event: whatever
    /// text was collected is provisional, never a fabricated completion.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stream_incomplete: bool,
    /// A13: the response was aborted because it crossed a declared resource
    /// budget. The partial text above stays provisional and no tool call
    /// from a truncated stream is ever handed on for execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_limit: Option<BudgetBreach>,
}

/// Record a classified failure onto the result with the shared contract
/// fields (category name, retryability, normalized retry-after).
pub(crate) fn apply_failure(out: &mut ExecutionResult, failure: ProviderFailure) {
    let category = serde_json::to_string(&failure.category)
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|_| "TRANSIENT".into());
    out.error = Some(failure.message);
    out.error_category = Some(category);
    out.retryable = Some(failure.retryable);
    out.retry_after = failure.retry_after_secs;
}

/// Abort this request on a budget breach. Partial text is kept and marked
/// provisional; half-received tool calls are dropped rather than executed.
pub(crate) fn apply_breach(out: &mut ExecutionResult, mut breach: BudgetBreach) {
    breach.partial_kept = !out.text.is_empty();
    out.resource_limit = Some(breach.clone());
    out.tool_calls.clear();
    out.stream_incomplete = true;
    apply_failure(
        out,
        ProviderFailure {
            category: ErrorCategory::ResourceExhausted,
            retryable: false,
            retry_after_secs: None,
            message: breach.message(),
        },
    );
}

/// Serialize an `ErrorCategory` to its SCREAMING_SNAKE_CASE wire name.
pub fn category_name(category: &ErrorCategory) -> String {
    serde_json::to_string(category)
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|_| "TRANSIENT".into())
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

/// Extract a safe provider error message from a response body: only the
/// structured JSON message fields are surfaced (redacted). Raw bodies never
/// reach the error text — they can echo credentials or account data.
fn provider_error_message(status: u16, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        for pointer in [
            "/error/message",
            "/errors/0/message",
            "/message",
            "/detail",
            "/msg",
            "/error",
        ] {
            if let Some(candidate) = v.pointer(pointer) {
                if let Some(s) = candidate.as_str() {
                    if !s.trim().is_empty() {
                        return redact_secrets(s);
                    }
                }
            }
        }
    }
    if body.trim().is_empty() {
        format!("provider returned HTTP {status} with an empty body")
    } else {
        format!("provider returned HTTP {status} (body not surfaced)")
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
/// Execute a translated request against the configured gateway under the
/// deployed resource budgets.
pub fn execute(
    tx: &TranslatedRequest,
    cfg: &ExecuteConfig,
) -> Result<ExecutionResult, ExecuteError> {
    execute_with_budget(tx, cfg, &StreamBudget::from_env())
}

/// Execute with an explicit budget. Tests and callers that need to raise a
/// limit for one request inject it here rather than mutating process state.
pub fn execute_with_budget(
    tx: &TranslatedRequest,
    cfg: &ExecuteConfig,
    budget: &StreamBudget,
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
    let body = serde_json::to_vec(&tx.body)
        .map_err(|error| ExecuteError::protocol(error.to_string()))?;
    let response = match req.send_bytes(&body) {
        Ok(resp) => resp,
        Err(ureq::Error::Status(code, resp)) => {
            // HTTP-level error: read the body, classify onto the shared
            // contract (status table + Retry-After), surface typed metadata.
            let retry_after = resp.header("retry-after").map(str::to_string);
            let (text, breach) = read_error_body(resp.into_reader(), budget);
            let mut out = ExecutionResult {
                status: code,
                ..Default::default()
            };
            apply_failure(
                &mut out,
                classify_status(
                    code,
                    retry_after.as_deref(),
                    &provider_error_message(code, &text),
                ),
            );
            if let Some(breach) = breach {
                note_truncated(&mut out, breach);
            }
            return Ok(out);
        }
        Err(other) => return Err(ExecuteError::transport(other.to_string())),
    };
    let status = response.status();
    let content_type = response
        .content_type()
        .split(';')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if status >= 400 {
        let retry_after = response.header("retry-after").map(str::to_string);
        let (text, breach) = read_error_body(response.into_reader(), budget);
        let mut out = ExecutionResult {
            status,
            ..Default::default()
        };
        apply_failure(
            &mut out,
            classify_status(
                status,
                retry_after.as_deref(),
                &provider_error_message(status, &text),
            ),
        );
        if let Some(breach) = breach {
            note_truncated(&mut out, breach);
        }
        return Ok(out);
    }
    let mut result = ExecutionResult {
        status,
        ..Default::default()
    };
    if content_type.contains("text/event-stream") {
        parse_sse(tx.kind, response.into_reader(), &mut result, budget)?;
    } else {
        // A single non-streaming document is this request's whole output, so
        // it is read under the total-output budget: an oversized body is an
        // honest resource-limit diagnosis, never a "non-JSON" false report.
        let (raw, breach) = match read_capped_body(
            &mut response.into_reader(),
            budget.max_total_bytes,
            TOTAL_OUTPUT_BUDGET,
        ) {
            Ok(pair) => pair,
            Err(e) => return Err(ExecuteError::transport(e.to_string())),
        };
        if let Some(breach) = breach {
            apply_breach(&mut result, breach);
            return Ok(result);
        }
        let text = String::from_utf8_lossy(&raw).to_string();
        let v: Value = serde_json::from_str(text.trim())
            .map_err(|e| ExecuteError::protocol(format!("non-JSON provider body: {e}")))?;
        result.events = 1;
        parse_single(tx.kind, &v, &mut result, budget)?;
    }
    Ok(result)
}

/// Read an HTTP error document under its budget. A failed read is not the
/// primary fact here — the status already is — so the body simply comes back
/// short; an overflow comes back as a typed breach next to it.
fn read_error_body<R: Read>(
    mut reader: R,
    budget: &StreamBudget,
) -> (String, Option<BudgetBreach>) {
    let (raw, breach) =
        read_capped_body(&mut reader, budget.max_error_body_bytes, ERROR_BODY_BUDGET)
            .unwrap_or_else(|_| (Vec::new(), None));
    (String::from_utf8_lossy(&raw).to_string(), breach)
}

/// The request already failed on status; on top of that, its error document
/// was cut off. Keep the status classification and say so, rather than
/// presenting a half-read body as the provider's full diagnosis.
fn note_truncated(out: &mut ExecutionResult, breach: BudgetBreach) {
    let note = breach.truncation_note();
    out.resource_limit = Some(breach);
    out.error = Some(match out.error.take() {
        Some(existing) if !existing.trim().is_empty() => format!("{existing} — {note}"),
        _ => note,
    });
}

/// Parse one provider object (non-streaming response body) into the result.
fn parse_single(
    kind: ProviderKind,
    v: &Value,
    out: &mut ExecutionResult,
    budget: &StreamBudget,
) -> Result<(), ExecuteError> {
    if let Some(err) = extract_stream_error(kind, v) {
        apply_failure(out, classify_stream_error(&err));
        return Ok(());
    }
    match kind {
        ProviderKind::OpenAiResponses => {
            if let Some(items) = v.get("output").and_then(|o| o.as_array()) {
                for item in items {
                    if let Some(breach) = collect_responses_item(item, out, budget) {
                        apply_breach(out, breach);
                        return Ok(());
                    }
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
                        match openai_tool_call(call, budget) {
                            Ok(call) => out.tool_calls.push(call),
                            Err(breach) => {
                                apply_breach(out, breach);
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
        ProviderKind::Anthropic => {
            if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if let Some(breach) = collect_anthropic_block(block, out, budget) {
                        apply_breach(out, breach);
                        return Ok(());
                    }
                }
            }
        }
        ProviderKind::Gemini => {
            if let Some(parts) = v
                .pointer("/candidates/0/content/parts")
                .and_then(|p| p.as_array())
            {
                if let Some(breach) = collect_gemini_parts(parts, out, budget) {
                    apply_breach(out, breach);
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

/// Stream-parse an SSE body for the provider's wire format. A stream that
/// ends without its terminal event is recorded as `stream_incomplete` —
/// the collected text stays provisional instead of passing as a completion.
/// A response that crosses a declared budget aborts here with a typed
/// resource-limit diagnosis: whatever arrived stays provisional and no
/// half-received tool call survives to be executed.
fn parse_sse<R: Read>(
    kind: ProviderKind,
    reader: R,
    out: &mut ExecutionResult,
    budget: &StreamBudget,
) -> Result<(), ExecuteError> {
    let mut stream = SseFramer::new(reader, budget.clone());
    let mut terminated = false;
    // Chat Completions streams one logical call across many fragments; they
    // are reassembled per index and emitted only once the upstream says the
    // call is over.
    let mut pending_calls: BTreeMap<u64, PartialToolCall> = BTreeMap::new();
    loop {
        let data = match stream
            .next_frame()
            .map_err(|e| ExecuteError::transport(e.to_string()))?
        {
            SseFrame::Event(data) => data,
            SseFrame::Breach(breach) => {
                apply_breach(out, breach);
                return Ok(());
            }
            SseFrame::End => break,
        };
        // Chat-completions wire: `[DONE]` is a non-JSON sentinel.
        if (kind == ProviderKind::OpenAiCompatible || kind == ProviderKind::Local)
            && data.trim() == "[DONE]"
        {
            flush_tool_calls(&mut pending_calls, out);
            terminated = true;
            break;
        }
        let v: Value = match serde_json::from_str(data.trim()) {
            Ok(v) => v,
            Err(e) => {
                return Err(ExecuteError::protocol(format!(
                    "malformed SSE data from provider: {e}"
                )));
            }
        };
        out.events += 1;
        if let Some(err) = extract_stream_error(kind, &v) {
            // A provider-reported failure event is a definite end of the
            // stream (the turn still fails — classified, not fabricated).
            terminated = true;
            apply_failure(&mut *out, classify_stream_error(&err));
            break;
        }
        match kind {
            ProviderKind::OpenAiResponses => match v.get("type").and_then(|t| t.as_str()) {
                Some("response.output_item.done") => {
                    if let Some(item) = v.get("item") {
                        if let Some(breach) = collect_responses_item(item, out, budget) {
                            apply_breach(out, breach);
                            return Ok(());
                        }
                    }
                }
                Some("response.completed") | Some("response.failed") => {
                    terminated = true;
                    break;
                }
                _ => {}
            },
            ProviderKind::OpenAiCompatible | ProviderKind::Local => {
                if let Some(choice) = v.pointer("/choices/0") {
                    if let Some(delta) = choice.get("delta") {
                        if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                            out.text.push_str(text);
                        }
                        if let Some(calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                            if let Some(breach) =
                                accumulate_tool_calls(calls, &mut pending_calls, budget)
                            {
                                apply_breach(out, breach);
                                return Ok(());
                            }
                        }
                    }
                    if choice
                        .get("finish_reason")
                        .and_then(|t| t.as_str())
                        .is_some()
                    {
                        flush_tool_calls(&mut pending_calls, out);
                    }
                }
            }
            ProviderKind::Anthropic => match v.get("type").and_then(|t| t.as_str()) {
                Some("content_block_start") => {
                    if let Some(block) = v.get("content_block") {
                        if let Some(breach) = collect_anthropic_block(block, out, budget) {
                            apply_breach(out, breach);
                            return Ok(());
                        }
                    }
                }
                Some("content_block_delta") => {
                    if v.pointer("/delta/type").and_then(|t| t.as_str()) == Some("text_delta") {
                        if let Some(text) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                            out.text.push_str(text);
                        }
                    }
                }
                Some("message_stop") | Some("error") => {
                    terminated = true;
                    break;
                }
                _ => {}
            },
            ProviderKind::Gemini => {
                if let Some(parts) = v
                    .pointer("/candidates/0/content/parts")
                    .and_then(|p| p.as_array())
                {
                    if let Some(breach) = collect_gemini_parts(parts, out, budget) {
                        apply_breach(out, breach);
                        return Ok(());
                    }
                }
                if v.get("done").and_then(|d| d.as_bool()) == Some(true) {
                    terminated = true;
                    break;
                }
            }
        }
    }
    out.stream_incomplete = !terminated;
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

fn collect_responses_item(
    item: &Value,
    out: &mut ExecutionResult,
    budget: &StreamBudget,
) -> Option<BudgetBreach> {
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
            None
        }
        Some("function_call") => {
            let name = item
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let raw_args = item.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match bounded_tool_call(name, raw_args, budget) {
                Ok(call) => {
                    out.tool_calls.push(call);
                    None
                }
                Err(breach) => Some(breach),
            }
        }
        _ => None,
    }
}

fn collect_anthropic_block(
    block: &Value,
    out: &mut ExecutionResult,
    budget: &StreamBudget,
) -> Option<BudgetBreach> {
    match block.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                out.text.push_str(text);
            }
            None
        }
        Some("tool_use") => {
            let name = block
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let raw = block.get("input").cloned().unwrap_or_else(|| json!({}));
            match bounded_tool_call(name, raw, budget) {
                Ok(call) => {
                    out.tool_calls.push(call);
                    None
                }
                Err(breach) => Some(breach),
            }
        }
        _ => None,
    }
}

fn collect_gemini_parts(
    parts: &[Value],
    out: &mut ExecutionResult,
    budget: &StreamBudget,
) -> Option<BudgetBreach> {
    for part in parts {
        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
            out.text.push_str(text);
        }
        if let Some(call) = part.get("functionCall") {
            let name = call
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let raw = call.get("args").cloned().unwrap_or_else(|| json!({}));
            match bounded_tool_call(name, raw, budget) {
                Ok(call) => out.tool_calls.push(call),
                Err(breach) => return Some(breach),
            }
        }
    }
    None
}

fn openai_tool_call(call: &Value, budget: &StreamBudget) -> Result<ToolCall, BudgetBreach> {
    let name = call
        .pointer("/function/name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let raw = call
        .pointer("/function/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    bounded_tool_call(name, raw, budget)
}

fn bounded_tool_call(
    name: String,
    raw: Value,
    budget: &StreamBudget,
) -> Result<ToolCall, BudgetBreach> {
    let received = match &raw {
        Value::String(value) => value.len(),
        other => serde_json::to_vec(other).map_or(usize::MAX, |encoded| encoded.len()),
    };
    if received > budget.max_tool_args_bytes {
        return Err(BudgetBreach::new(
            TOOL_ARGS_BUDGET,
            budget.max_tool_args_bytes as u64,
            received as u64,
            "bytes",
        ));
    }
    let arguments = match raw {
        Value::String(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({"raw": s})),
        other => other,
    };
    Ok(ToolCall { name, arguments })
}

/// One Chat Completions tool call, reassembled across delta fragments.
#[derive(Default)]
struct PartialToolCall {
    name: String,
    arguments: String,
    /// Its arguments outgrew the tool-argument budget: it must never be
    /// handed on for execution as if it were a complete call.
    overflowed: bool,
}

/// Fold one `delta.tool_calls` array into the per-index accumulator. Returns
/// the breach when a call's arguments cross their budget, so the caller
/// aborts the request instead of executing a half-received argument blob.
fn accumulate_tool_calls(
    calls: &[Value],
    pending: &mut BTreeMap<u64, PartialToolCall>,
    budget: &StreamBudget,
) -> Option<BudgetBreach> {
    for (position, call) in calls.iter().enumerate() {
        let index = call
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(position as u64);
        let entry = pending.entry(index).or_default();
        if entry.overflowed {
            continue;
        }
        if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
            entry.name.push_str(name);
        }
        let Some(args) = call.pointer("/function/arguments").and_then(Value::as_str) else {
            continue;
        };
        let received = entry.arguments.len() + args.len();
        if received > budget.max_tool_args_bytes {
            entry.arguments.clear();
            entry.overflowed = true;
            return Some(BudgetBreach::new(
                TOOL_ARGS_BUDGET,
                budget.max_tool_args_bytes as u64,
                received as u64,
                "bytes",
            ));
        }
        entry.arguments.push_str(args);
    }
    None
}

/// Emit the reassembled calls. Overflowed ones are dropped, never truncated
/// into execution.
fn flush_tool_calls(pending: &mut BTreeMap<u64, PartialToolCall>, out: &mut ExecutionResult) {
    for entry in pending.values() {
        if entry.overflowed || (entry.name.is_empty() && entry.arguments.is_empty()) {
            continue;
        }
        let arguments = serde_json::from_str(&entry.arguments)
            .unwrap_or_else(|_| json!({"raw": entry.arguments.clone()}));
        out.tool_calls.push(ToolCall {
            name: entry.name.clone(),
            arguments,
        });
    }
    pending.clear();
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
    fn transport_and_protocol_errors_are_sanitized_at_execute_boundary() {
        let transport = ExecuteError::transport(
            "request https://first.example/cb?code=code-secret-a15 then http://later/#state=state-secret-a15 Authorization: Basic ab",
        );
        let protocol = ExecuteError::protocol(
            r#"malformed {\"api_key\":\"xy\"} model=sk-secret status=400"#,
        );
        for (rendered, secrets) in [
            (
                transport.to_string(),
                vec!["code-secret-a15", "state-secret-a15", "ab"],
            ),
            (protocol.to_string(), vec!["xy", "sk-secret"]),
        ] {
            for secret in secrets {
                assert!(!rendered.contains(secret), "{secret} leaked in {rendered}");
            }
        }
        assert!(transport.to_string().contains("first.example"));
        assert!(protocol.to_string().contains("status=400"));
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
        // A non-JSON body is never surfaced verbatim: it could echo keys or
        // account data. Only the status fact remains.
        assert_eq!(
            provider_error_message(500, "boom"),
            "provider returned HTTP 500 (body not surfaced)"
        );
        assert_eq!(
            provider_error_message(500, ""),
            "provider returned HTTP 500 with an empty body"
        );
        // Secret-looking runs inside structured messages are redacted.
        assert_eq!(
            provider_error_message(401, r#"{"message":"bad key sk-abcdef1234567890abcdef12"}"#),
            "bad key [redacted]"
        );
    }

    #[test]
    fn stream_without_terminal_event_is_marked_incomplete() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Half\"}}]}

",
            "data: {\"choices\":[{\"delta\":{\"content\":\"-way\"}}]}

",
        );
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::OpenAiCompatible,
            body.as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
        assert_eq!(out.text, "Half-way");
        assert!(out.stream_incomplete, "truncated stream stays provisional");
        assert_eq!(out.error_category.as_deref(), None);

        // The same stream terminated by [DONE] is complete.
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::OpenAiCompatible,
            format!(
                "{body}data: [DONE]

"
            )
            .as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
        assert!(!out.stream_incomplete);

        // A provider failure event is a terminal (classified) failure.
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::Anthropic,
            "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}

".as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
        assert!(!out.stream_incomplete);
        assert_eq!(out.error.as_deref(), Some("Overloaded"));
        assert_eq!(
            out.error_category.as_deref(),
            Some("PROVIDER_RATE_LIMIT"),
            "in-band overload classifies like a 429"
        );
        assert!(out.retryable.unwrap_or(false));
    }

    #[test]
    fn chat_tool_call_fragments_reassemble_into_complete_calls() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"x\\\"}\"}},{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"other\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::OpenAiCompatible,
            body.as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
        assert_eq!(
            out.tool_calls.len(),
            2,
            "one call per index, not one per fragment: {:?}",
            out.tool_calls
        );
        assert_eq!(out.tool_calls[0].name, "lookup");
        assert_eq!(out.tool_calls[0].arguments["q"], "x");
        assert_eq!(out.tool_calls[1].name, "other");
        assert!(!out.stream_incomplete);
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
        parse_sse(
            ProviderKind::OpenAiResponses,
            body.as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
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
        parse_sse(
            ProviderKind::OpenAiCompatible,
            body.as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
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
        parse_sse(
            ProviderKind::Anthropic,
            body.as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
        assert_eq!(out.text, "Bonjour le monde");
    }

    #[test]
    fn parses_anthropic_stream_error() {
        let body = "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::Anthropic,
            body.as_bytes(),
            &mut out,
            &StreamBudget::default(),
        )
        .unwrap();
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
        parse_single(ProviderKind::Gemini, &v, &mut out, &StreamBudget::default()).unwrap();
        assert_eq!(out.text, "Ciao");
        assert_eq!(out.tool_calls[0].name, "lookup");
    }

    #[test]
    fn parses_compatible_tool_call_arguments() {
        let call = json!({"id": "c1", "type": "function", "function": {"name": "lookup", "arguments": "{\"q\":\"y\"}"}});
        let parsed = openai_tool_call(&call, &StreamBudget::default()).unwrap();
        assert_eq!(parsed.arguments["q"], "y");
    }

    #[test]
    fn every_complete_tool_shape_obeys_the_argument_budget() {
        let oversized = "x".repeat(5000);
        let cases = [
            (
                ProviderKind::OpenAiResponses,
                json!({"output":[{"type":"function_call","name":"run","arguments":oversized}]}),
            ),
            (
                ProviderKind::OpenAiCompatible,
                json!({"choices":[{"message":{"tool_calls":[{"function":{"name":"run","arguments":oversized}}]}}]}),
            ),
            (
                ProviderKind::Anthropic,
                json!({"content":[{"type":"tool_use","name":"run","input":{"value":oversized}}]}),
            ),
            (
                ProviderKind::Gemini,
                json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"run","args":{"value":oversized}}}]}}]}),
            ),
        ];
        for (kind, document) in cases {
            let mut budget = StreamBudget::default();
            budget.max_tool_args_bytes = 1024;
            let mut out = ExecutionResult::default();
            parse_single(kind, &document, &mut out, &budget).unwrap();
            assert!(out.tool_calls.is_empty(), "{kind:?} leaked a tool call");
            assert_eq!(
                out.resource_limit
                    .as_ref()
                    .map(|breach| breach.budget.as_str()),
                Some(TOOL_ARGS_BUDGET),
                "{kind:?} did not report the tool argument limit"
            );
        }
    }

    #[test]
    fn responses_sse_tool_arguments_obey_the_argument_budget() {
        let body = format!(
            "data: {{\"type\":\"response.output_item.done\",\"item\":{{\"type\":\"function_call\",\"name\":\"run\",\"arguments\":\"{}\"}}}}\n\n",
            "x".repeat(5000)
        );
        let mut budget = StreamBudget::default();
        budget.max_tool_args_bytes = 1024;
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::OpenAiResponses,
            body.as_bytes(),
            &mut out,
            &budget,
        )
        .unwrap();
        assert!(out.tool_calls.is_empty());
        assert_eq!(
            out.resource_limit
                .as_ref()
                .map(|breach| breach.budget.as_str()),
            Some(TOOL_ARGS_BUDGET)
        );
    }

    fn budget_with_line(cap: usize) -> StreamBudget {
        StreamBudget {
            max_line_bytes: cap,
            ..Default::default()
        }
    }

    #[test]
    fn a_line_budget_breach_aborts_the_request_and_keeps_partial_text_provisional() {
        let flood = "a".repeat(50_000);
        let body = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"so far\"}}}}]}}\n\ndata: {flood}\n\n"
        );
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::OpenAiCompatible,
            body.as_bytes(),
            &mut out,
            &budget_with_line(4096),
        )
        .unwrap();
        assert_eq!(out.text, "so far", "received facts are preserved");
        assert!(out.stream_incomplete, "a breach is never a completion");
        let breach = out.resource_limit.clone().expect("typed resource limit");
        assert_eq!(breach.budget, crate::budget::LINE_BUDGET);
        assert_eq!(breach.limit, 4096);
        assert_eq!(
            out.error_category.as_deref(),
            Some("RESOURCE_EXHAUSTED"),
            "{out:?}"
        );
        assert_eq!(out.retryable, Some(false));
        assert!(
            out.error
                .as_deref()
                .unwrap()
                .contains("this request was aborted"),
            "{:?}",
            out.error
        );
    }

    #[test]
    fn overflowing_tool_arguments_abort_instead_of_executing_a_truncated_call() {
        let mut body = String::from(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"write\",\"arguments\":\"{\\\"t\\\":\\\"\"}}]}}]}\n\n",
        );
        for _ in 0..600 {
            body.push_str(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"aaaaaaaaaa\"}}]}}]}\n\n",
            );
        }
        body.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n");
        body.push_str("data: [DONE]\n\n");

        let mut budget = StreamBudget::default();
        budget.max_tool_args_bytes = 4096;
        budget.max_line_bytes = 4096;
        let mut out = ExecutionResult::default();
        parse_sse(
            ProviderKind::OpenAiCompatible,
            body.as_bytes(),
            &mut out,
            &budget,
        )
        .unwrap();
        assert!(
            out.tool_calls.is_empty(),
            "a truncated call must never reach the executor"
        );
        assert!(out.stream_incomplete);
        let breach = out.resource_limit.clone().expect("typed resource limit");
        assert_eq!(breach.budget, crate::budget::TOOL_ARGS_BUDGET);
        assert_eq!(breach.limit, 4096);
    }
}
