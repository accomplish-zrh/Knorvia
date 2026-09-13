use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    CapabilityReport, CapabilityStatus, ProviderKind, TRACKED_CAPABILITIES, negotiate,
    require_not_silent,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalImage {
    #[serde(default)]
    pub media_type: String,
    #[serde(default)]
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalToolCall {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalMessage {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub images: Vec<CanonicalImage>,
    #[serde(default)]
    pub tool_calls: Vec<CanonicalToolCall>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalTool {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: Value,
}

fn default_max_tokens() -> u32 {
    4096
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalRequest {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub messages: Vec<CanonicalMessage>,
    #[serde(default)]
    pub tools: Vec<CanonicalTool>,
    #[serde(default)]
    pub parallel_tools: bool,
    #[serde(default)]
    pub structured_output: Option<Value>,
    #[serde(default)]
    pub images: Vec<CanonicalImage>,
    #[serde(default)]
    pub reasoning: bool,
    /// Requested reasoning strength (e.g. `minimal|low|medium|high|xhigh`).
    /// Per-protocol translation validates it against [`REASONING_EFFORTS`];
    /// a strength the target protocol cannot express is dropped — never
    /// guessed — so unsupported values do not emit invalid fields. `None`
    /// keeps each protocol's default strength.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub prompt_cache: bool,
    #[serde(default)]
    pub stream: bool,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedField {
    pub name: String,
    pub status: CapabilityStatus,
    pub requested: bool,
    pub in_body: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedRequest {
    pub kind: ProviderKind,
    pub model: String,
    pub endpoint: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub capabilities: Vec<CapabilityReport>,
    pub applied: Vec<AppliedField>,
}

pub fn translate(kind: ProviderKind, req: CanonicalRequest) -> Result<TranslatedRequest, String> {
    if req.model.trim().is_empty() {
        return Err("model is required".into());
    }
    let capabilities = negotiate(kind, &req.model);
    require_not_silent(&capabilities, TRACKED_CAPABILITIES)?;
    let requested = requested_flags(&req);
    let status_of = |name: &str| {
        capabilities
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.status)
            .unwrap_or(CapabilityStatus::Unavailable)
    };
    let allow = |name: &str| requested(name) && status_of(name) != CapabilityStatus::Unavailable;
    let body = match kind {
        ProviderKind::OpenAiResponses => body_openai_responses(&req, &allow, &status_of),
        ProviderKind::OpenAiCompatible => body_openai_compatible(&req, &allow, &status_of, false),
        ProviderKind::Local => body_openai_compatible(&req, &allow, &status_of, true),
        ProviderKind::Anthropic => body_anthropic(&req, &allow),
        ProviderKind::Gemini => body_gemini(&req, &allow),
    };
    let endpoint = kind.endpoint(&req.model, req.stream && allow("streaming"));
    let applied = applied_fields(&req, &capabilities, &body, &endpoint, kind);
    let tx = TranslatedRequest {
        kind,
        model: req.model.clone(),
        endpoint,
        method: "POST".into(),
        headers: headers(kind),
        body,
        capabilities,
        applied,
    };
    assert_no_silent_drop(&tx)?;
    Ok(tx)
}

pub fn assert_no_silent_drop(tx: &TranslatedRequest) -> Result<(), String> {
    require_not_silent(&tx.capabilities, TRACKED_CAPABILITIES)?;
    if tx.applied.len() != TRACKED_CAPABILITIES.len() {
        return Err(format!(
            "applied list has {} entries, expected {}",
            tx.applied.len(),
            TRACKED_CAPABILITIES.len()
        ));
    }
    for name in TRACKED_CAPABILITIES {
        if !tx.applied.iter().any(|a| a.name == *name) {
            return Err(format!(
                "capability {name} missing from applied (silent drop)"
            ));
        }
    }
    for a in &tx.applied {
        if a.requested && a.status != CapabilityStatus::Unavailable && !a.in_body {
            return Err(format!(
                "silent drop of {} ({:?}: {})",
                a.name, a.status, a.reason
            ));
        }
        if a.requested && a.status != CapabilityStatus::Supported && a.reason.trim().is_empty() {
            return Err(format!(
                "capability {} is {:?} without reason",
                a.name, a.status
            ));
        }
        if a.requested && a.status == CapabilityStatus::Unavailable && a.in_body {
            return Err(format!(
                "capability {} is unavailable but was placed in the provider body",
                a.name
            ));
        }
    }
    Ok(())
}

/// Reasoning strengths this gateway can express. Anything else requested
/// is dropped per protocol rather than sent as an invalid field.
pub const REASONING_EFFORTS: [&str; 5] = ["minimal", "low", "medium", "high", "xhigh"];

/// The requested effort, case-normalized when part of the supported
/// vocabulary; unknown values yield `None` so callers fall back to the
/// protocol default instead of inventing a mapping.
fn validated_effort(req: &CanonicalRequest) -> Option<String> {
    let normalized = req.reasoning_effort.as_deref()?.trim().to_ascii_lowercase();
    if !REASONING_EFFORTS.contains(&normalized.as_str()) {
        return None;
    }
    Some(normalized)
}

/// Anthropic expresses strength as a thinking token budget.
fn anthropic_thinking_budget(req: &CanonicalRequest) -> i64 {
    match validated_effort(req).as_deref() {
        Some("minimal") => 1024,
        Some("low") => 4096,
        Some("high") => 16_000,
        Some("xhigh") => 32_000,
        // medium, or no explicit request: the historical default.
        _ => 8_000,
    }
}

fn requested_flags(req: &CanonicalRequest) -> impl Fn(&str) -> bool + '_ {
    let has_images = !req.images.is_empty() || req.messages.iter().any(|m| !m.images.is_empty());
    let has_tools = !req.tools.is_empty();
    let stream = req.stream;
    let parallel = req.parallel_tools;
    let structured = req.structured_output.is_some();
    let reasoning = req.reasoning;
    let cache = req.prompt_cache;
    move |name: &str| match name {
        "streaming" => stream,
        "tools" => has_tools,
        "parallel_tools" => has_tools && parallel,
        "structured_output" => structured,
        "images" => has_images,
        "reasoning" => reasoning,
        "prompt_cache" => cache,
        "cancellation" => false,
        _ => false,
    }
}

fn applied_fields(
    req: &CanonicalRequest,
    capabilities: &[CapabilityReport],
    body: &Value,
    endpoint: &str,
    kind: ProviderKind,
) -> Vec<AppliedField> {
    let requested = requested_flags(req);
    capabilities
        .iter()
        .map(|report| AppliedField {
            name: report.name.clone(),
            status: report.status,
            requested: requested(&report.name),
            in_body: capability_in_body(&report.name, body, endpoint, kind),
            reason: report.reason.clone(),
        })
        .collect()
}

fn capability_in_body(name: &str, body: &Value, endpoint: &str, kind: ProviderKind) -> bool {
    match name {
        "streaming" => {
            body.get("stream").and_then(|v| v.as_bool()) == Some(true)
                || endpoint.contains("streamGenerateContent")
        }
        "tools" => tools_in_body(body),
        "parallel_tools" => match kind {
            ProviderKind::OpenAiResponses
            | ProviderKind::OpenAiCompatible
            | ProviderKind::Local => body.get("parallel_tool_calls").is_some(),
            ProviderKind::Anthropic | ProviderKind::Gemini => tools_in_body(body),
        },
        "structured_output" => {
            body.pointer("/text/format").is_some()
                || body.get("response_format").is_some()
                || body.pointer("/generationConfig/responseSchema").is_some()
                || body.get("tool_choice").is_some()
        }
        "images" => body_contains_image(body),
        "reasoning" => {
            body.get("reasoning").is_some()
                || body.get("thinking").is_some()
                || body.pointer("/generationConfig/thinkingConfig").is_some()
        }
        "prompt_cache" => {
            body.get("prompt_cache_key").is_some() || body_contains_cache_control(body)
        }
        "cancellation" => false,
        _ => false,
    }
}

fn tools_in_body(body: &Value) -> bool {
    if let Some(tools) = body.get("tools") {
        if let Some(arr) = tools.as_array() {
            if arr.iter().any(|t| {
                t.get("functionDeclarations")
                    .and_then(|v| v.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(true)
            }) {
                return !arr.is_empty();
            }
        } else {
            return !tools.is_null();
        }
    }
    false
}

fn body_contains_image(body: &Value) -> bool {
    let raw = body.to_string();
    raw.contains("input_image")
        || raw.contains("image_url")
        || raw.contains("\"type\":\"image\"")
        || raw.contains("inlineData")
        || raw.contains("inline_data")
}

fn body_contains_cache_control(body: &Value) -> bool {
    body.to_string().contains("cache_control")
}

fn headers(kind: ProviderKind) -> Vec<(String, String)> {
    match kind {
        ProviderKind::OpenAiResponses | ProviderKind::OpenAiCompatible => vec![
            (
                "Authorization".into(),
                "Bearer ${KNORVIA_PROVIDER_KEY}".into(),
            ),
            ("Content-Type".into(), "application/json".into()),
        ],
        ProviderKind::Anthropic => vec![
            ("x-api-key".into(), "${KNORVIA_PROVIDER_KEY}".into()),
            ("anthropic-version".into(), "2023-06-01".into()),
            ("Content-Type".into(), "application/json".into()),
        ],
        ProviderKind::Gemini => vec![
            ("x-goog-api-key".into(), "${KNORVIA_PROVIDER_KEY}".into()),
            ("Content-Type".into(), "application/json".into()),
        ],
        ProviderKind::Local => vec![("Content-Type".into(), "application/json".into())],
    }
}

fn data_url(img: &CanonicalImage) -> String {
    let media = if img.media_type.trim().is_empty() {
        "image/png"
    } else {
        img.media_type.as_str()
    };
    if img.data.starts_with("data:")
        || img.data.starts_with("http://")
        || img.data.starts_with("https://")
    {
        img.data.clone()
    } else {
        format!("data:{media};base64,{}", img.data)
    }
}

fn raw_b64(img: &CanonicalImage) -> String {
    if let Some(idx) = img.data.find("base64,") {
        img.data[idx + 7..].to_string()
    } else {
        img.data.clone()
    }
}

fn max_tokens(req: &CanonicalRequest) -> u32 {
    if req.max_tokens == 0 {
        4096
    } else {
        req.max_tokens
    }
}

fn openai_function_tool(tool: &CanonicalTool) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": if tool.parameters.is_null() {
                json!({"type": "object", "properties": {}})
            } else {
                tool.parameters.clone()
            }
        }
    })
}

fn responses_function_tool(tool: &CanonicalTool) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": if tool.parameters.is_null() {
            json!({"type": "object", "properties": {}})
        } else {
            tool.parameters.clone()
        }
    })
}

fn json_schema_format(schema: &Value) -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "knorvia_result",
            "schema": schema,
            "strict": true
        }
    })
}

fn body_openai_responses(
    req: &CanonicalRequest,
    allow: &impl Fn(&str) -> bool,
    status_of: &impl Fn(&str) -> CapabilityStatus,
) -> Value {
    let mut instructions = String::new();
    let mut input: Vec<Value> = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            if !instructions.is_empty() {
                instructions.push('\n');
            }
            instructions.push_str(&msg.text);
            continue;
        }
        let mut content: Vec<Value> = Vec::new();
        if !msg.text.is_empty() {
            content.push(json!({"type": "input_text", "text": msg.text}));
        }
        if allow("images") {
            for img in &msg.images {
                content.push(json!({
                    "type": "input_image",
                    "image_url": data_url(img)
                }));
            }
        }
        if content.is_empty() && msg.tool_calls.is_empty() {
            content.push(json!({"type": "input_text", "text": ""}));
        }
        let role = if msg.role == "tool" {
            "user"
        } else {
            msg.role.as_str()
        };
        input.push(json!({"role": role, "content": content}));
    }
    if allow("images") {
        for img in &req.images {
            input.push(json!({
                "role": "user",
                "content": [{"type": "input_image", "image_url": data_url(img)}]
            }));
        }
    }
    let mut body = json!({
        "model": req.model,
        "input": input,
        "max_output_tokens": max_tokens(req),
    });
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions);
    }
    if allow("streaming") {
        body["stream"] = json!(true);
    }
    if allow("tools") {
        body["tools"] = json!(
            req.tools
                .iter()
                .map(responses_function_tool)
                .collect::<Vec<_>>()
        );
        if allow("parallel_tools") {
            body["parallel_tool_calls"] =
                json!(status_of("parallel_tools") == CapabilityStatus::Supported);
        }
    }
    if allow("structured_output") {
        if let Some(schema) = &req.structured_output {
            body["text"] = json!({
                "format": {
                    "type": "json_schema",
                    "name": "knorvia_result",
                    "schema": schema,
                    "strict": true
                }
            });
        }
    }
    if allow("reasoning") {
        let effort = validated_effort(req).unwrap_or_else(|| "medium".into());
        body["reasoning"] = json!({"effort": effort});
    }
    if allow("prompt_cache") {
        body["prompt_cache_key"] = json!("knorvia");
    }
    body
}

fn body_openai_compatible(
    req: &CanonicalRequest,
    allow: &impl Fn(&str) -> bool,
    status_of: &impl Fn(&str) -> CapabilityStatus,
    _local: bool,
) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for msg in &req.messages {
        let content: Value;
        if allow("images") && !msg.images.is_empty() {
            let mut parts: Vec<Value> = Vec::new();
            if !msg.text.is_empty() {
                parts.push(json!({"type": "text", "text": msg.text}));
            }
            for img in &msg.images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": {"url": data_url(img)}
                }));
            }
            content = json!(parts);
        } else {
            content = json!(msg.text);
        }
        let mut row = json!({"role": msg.role, "content": content});
        if !msg.tool_calls.is_empty() && allow("tools") {
            row["tool_calls"] = json!(
                msg.tool_calls
                    .iter()
                    .map(|tc| json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": tc.arguments}
                    }))
                    .collect::<Vec<_>>()
            );
        }
        if let Some(id) = &msg.tool_call_id {
            row["tool_call_id"] = json!(id);
        }
        messages.push(row);
    }
    if allow("images") {
        for img in &req.images {
            messages.push(json!({
                "role": "user",
                "content": [{
                    "type": "image_url",
                    "image_url": {"url": data_url(img)}
                }]
            }));
        }
    }
    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": max_tokens(req),
    });
    if allow("streaming") {
        body["stream"] = json!(true);
    }
    if allow("tools") {
        body["tools"] = json!(
            req.tools
                .iter()
                .map(openai_function_tool)
                .collect::<Vec<_>>()
        );
        if allow("parallel_tools") {
            body["parallel_tool_calls"] =
                json!(status_of("parallel_tools") == CapabilityStatus::Supported);
        }
    }
    if allow("structured_output") {
        if let Some(schema) = &req.structured_output {
            body["response_format"] = json_schema_format(schema);
        }
    }
    body
}

fn body_anthropic(req: &CanonicalRequest, allow: &impl Fn(&str) -> bool) -> Value {
    let mut system_parts: Vec<Value> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            let mut part = json!({"type": "text", "text": msg.text});
            if allow("prompt_cache") {
                part["cache_control"] = json!({"type": "ephemeral"});
            }
            system_parts.push(part);
            continue;
        }
        if msg.role == "tool" {
            messages.push(json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": msg.tool_call_id.clone().unwrap_or_default(),
                    "content": msg.text
                }]
            }));
            continue;
        }
        let mut content: Vec<Value> = Vec::new();
        if !msg.text.is_empty() {
            content.push(json!({"type": "text", "text": msg.text}));
        }
        if allow("images") {
            for img in &msg.images {
                let media = if img.media_type.trim().is_empty() {
                    "image/png".to_string()
                } else {
                    img.media_type.clone()
                };
                content.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media,
                        "data": raw_b64(img)
                    }
                }));
            }
        }
        if allow("tools") && !msg.tool_calls.is_empty() {
            for tc in &msg.tool_calls {
                content.push(json!({
                    "type": "tool_use",
                    "id": tc.id,
                    "name": tc.name,
                    "input": tc.arguments
                }));
            }
        }
        if content.is_empty() {
            content.push(json!({"type": "text", "text": ""}));
        }
        let role = if msg.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        messages.push(json!({"role": role, "content": content}));
    }
    if allow("images") {
        for img in &req.images {
            let media = if img.media_type.trim().is_empty() {
                "image/png".to_string()
            } else {
                img.media_type.clone()
            };
            messages.push(json!({
                "role": "user",
                "content": [{
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media,
                        "data": raw_b64(img)
                    }
                }]
            }));
        }
    }
    if allow("prompt_cache") && system_parts.is_empty() {
        if let Some(last) = messages.last_mut() {
            if let Some(content) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                if let Some(part) = content.last_mut() {
                    part["cache_control"] = json!({"type": "ephemeral"});
                }
            }
        }
    }
    let mut body = json!({
        "model": req.model,
        "max_tokens": max_tokens(req),
        "messages": messages,
    });
    if !system_parts.is_empty() {
        body["system"] = json!(system_parts);
    }
    if allow("streaming") {
        body["stream"] = json!(true);
    }
    let mut tools: Vec<Value> = Vec::new();
    if allow("tools") {
        for tool in &req.tools {
            tools.push(json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": if tool.parameters.is_null() {
                    json!({"type": "object", "properties": {}})
                } else {
                    tool.parameters.clone()
                }
            }));
        }
    }
    if allow("structured_output") {
        if let Some(schema) = &req.structured_output {
            tools.push(json!({
                "name": "structured_output",
                "description": "Return the final answer matching the requested JSON schema.",
                "input_schema": schema
            }));
            body["tool_choice"] = json!({"type": "tool", "name": "structured_output"});
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    if allow("reasoning") {
        body["thinking"] =
            json!({"type": "enabled", "budget_tokens": anthropic_thinking_budget(req)});
    }
    body
}

fn body_gemini(req: &CanonicalRequest, allow: &impl Fn(&str) -> bool) -> Value {
    let mut system_text = String::new();
    let mut contents: Vec<Value> = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            if !system_text.is_empty() {
                system_text.push('\n');
            }
            system_text.push_str(&msg.text);
            continue;
        }
        let mut parts: Vec<Value> = Vec::new();
        if !msg.text.is_empty() {
            parts.push(json!({"text": msg.text}));
        }
        if allow("images") {
            for img in &msg.images {
                let mime = if img.media_type.trim().is_empty() {
                    "image/png".to_string()
                } else {
                    img.media_type.clone()
                };
                parts.push(json!({
                    "inlineData": {"mimeType": mime, "data": raw_b64(img)}
                }));
            }
        }
        if allow("tools") && !msg.tool_calls.is_empty() {
            for tc in &msg.tool_calls {
                parts.push(json!({
                    "functionCall": {"name": tc.name, "args": tc.arguments}
                }));
            }
        }
        if parts.is_empty() {
            parts.push(json!({"text": ""}));
        }
        let role = if msg.role == "assistant" {
            "model"
        } else {
            "user"
        };
        contents.push(json!({"role": role, "parts": parts}));
    }
    if allow("images") {
        for img in &req.images {
            let mime = if img.media_type.trim().is_empty() {
                "image/png".to_string()
            } else {
                img.media_type.clone()
            };
            contents.push(json!({
                "role": "user",
                "parts": [{"inlineData": {"mimeType": mime, "data": raw_b64(img)}}]
            }));
        }
    }
    let mut body = json!({"contents": contents});
    if !system_text.is_empty() {
        body["systemInstruction"] = json!({"parts": [{"text": system_text}]});
    }
    if allow("tools") {
        let decls: Vec<Value> = req
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": if tool.parameters.is_null() {
                        json!({"type": "object", "properties": {}})
                    } else {
                        tool.parameters.clone()
                    }
                })
            })
            .collect();
        body["tools"] = json!([{"functionDeclarations": decls}]);
    }
    let mut generation = json!({});
    if allow("structured_output") {
        if let Some(schema) = &req.structured_output {
            generation["responseMimeType"] = json!("application/json");
            generation["responseSchema"] = schema.clone();
        }
    }
    if allow("reasoning") {
        generation["thinkingConfig"] = json!({"includeThoughts": true});
    }
    if !generation.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        body["generationConfig"] = generation;
    }
    body
}

#[cfg(test)]
mod effort_tests {
    use super::*;
    use serde_json::json;

    fn req(effort: Option<&str>) -> CanonicalRequest {
        CanonicalRequest {
            model: "gpt-5.2".into(),
            messages: vec![CanonicalMessage {
                role: "user".into(),
                text: "hi".into(),
                ..Default::default()
            }],
            reasoning: true,
            reasoning_effort: effort.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn models_without_a_reasoning_channel_never_receive_effort_fields() {
        let mut r = req(Some("high"));
        r.model = "text-embedding-mini".into();
        let tx = translate(ProviderKind::OpenAiResponses, r).unwrap();
        assert!(
            tx.body.get("reasoning").is_none(),
            "capability negotiation keeps unsupported models clean"
        );
    }

    #[test]
    fn requested_effort_is_forwarded_and_case_normalized() {
        let tx = translate(ProviderKind::OpenAiResponses, req(Some("HIGH"))).unwrap();
        assert_eq!(tx.body["reasoning"]["effort"], json!("high"));
        let tx = translate(ProviderKind::OpenAiResponses, req(None)).unwrap();
        assert_eq!(
            tx.body["reasoning"]["effort"],
            json!("medium"),
            "no request keeps the protocol default"
        );
    }

    #[test]
    fn unknown_effort_never_produces_invalid_fields() {
        // Responses: fall back to a valid default instead of sending the
        // unsupported value verbatim.
        let tx = translate(ProviderKind::OpenAiResponses, req(Some("ultra"))).unwrap();
        assert_eq!(tx.body["reasoning"]["effort"], json!("medium"));
        // Anthropic: the budget maps from the validated vocabulary only.
        let tx = translate(ProviderKind::Anthropic, req(Some("high"))).unwrap();
        assert_eq!(tx.body["thinking"]["budget_tokens"], json!(16_000));
        let tx = translate(ProviderKind::Anthropic, req(Some("ultra"))).unwrap();
        assert_eq!(tx.body["thinking"]["budget_tokens"], json!(8_000));
        // Gemini has no numeric strength in this gateway: thinking stays
        // a visibility flag and no effort field is invented.
        let tx = translate(ProviderKind::Gemini, req(Some("high"))).unwrap();
        assert_eq!(
            tx.body["generationConfig"]["thinkingConfig"]["includeThoughts"],
            json!(true)
        );
        assert!(
            tx.body["generationConfig"]["thinkingConfig"]
                .get("effort")
                .is_none()
        );
        // reasoning=false never emits strength fields anywhere.
        let mut off = req(Some("high"));
        off.reasoning = false;
        let tx = translate(ProviderKind::OpenAiResponses, off).unwrap();
        assert!(tx.body.get("reasoning").is_none());
    }
}
