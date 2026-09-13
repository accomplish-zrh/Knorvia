//! Responses-API bridge translations for non-Responses upstream protocols.
//!
//! The Kernel's agent loop speaks only the Responses wire API. This module is
//! the thin translation layer that lets the same loop drive upstream Chat
//! Completions or Anthropic Messages providers: request bodies are mapped
//! outbound, upstream SSE streams are mapped back into the subset of
//! Responses events the Kernel consumes. The loop, tool identity and durable
//! facts stay Kernel-owned; nothing here re-implements an agent.
//!
//! Honesty rules encoded here:
//! - Tool call ids are preserved end to end so history replays stay coherent.
//! - Usage is only emitted when the upstream actually reported it. A missing
//!   report stays missing (the product shows unknown); it is never written as
//!   zeros.
//! - Unknown input item types are skipped rather than guessed into a shape
//!   the upstream never asked for.

use crate::budget::{BudgetBreach, StreamBudget, TOOL_ARGS_BUDGET};
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamProtocol {
    Responses,
    ChatCompletions,
    AnthropicMessages,
}

impl UpstreamProtocol {
    pub fn from_config(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "responses" | "" => Some(Self::Responses),
            "chat" | "chat_completions" | "chat-completions" | "openai-chat" => {
                Some(Self::ChatCompletions)
            }
            "anthropic" | "anthropic_messages" | "anthropic-messages" | "messages" => {
                Some(Self::AnthropicMessages)
            }
            _ => None,
        }
    }
}

/// Map one Kernel Responses request body to the upstream protocol's request.
/// `body` is the raw `/v1/responses` JSON the Kernel sent.
pub fn translate_request(protocol: UpstreamProtocol, body: &Value) -> Result<Value, String> {
    match protocol {
        UpstreamProtocol::Responses => Ok(body.clone()),
        UpstreamProtocol::ChatCompletions => chat_request(body),
        UpstreamProtocol::AnthropicMessages => anthropic_request(body),
    }
}

fn input_items(body: &Value) -> Vec<Value> {
    match body.get("input") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => vec![json!({"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": text}]})],
        _ => Vec::new(),
    }
}

fn item_text(item: &Value, text_type: &str) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    let matches = block
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|t| t == text_type);
                    if matches {
                        block.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_else(|| {
            item.get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        })
}

fn chat_request(body: &Value) -> Result<Value, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or("Responses request is missing `model`")?;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str) {
        if !instructions.is_empty() {
            messages.push(json!({"role": "system", "content": instructions}));
        }
    }
    for item in input_items(body) {
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        match item_type {
            "message" => {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let role = match role {
                    "assistant" => "assistant",
                    "system" | "developer" => "system",
                    _ => "user",
                };
                let text = if role == "assistant" {
                    item_text(&item, "output_text")
                } else {
                    item_text(&item, "input_text")
                };
                if text.is_empty() {
                    continue;
                }
                // Chat has no `developer` role; folding repeated system items
                // into one message keeps the upstream history coherent.
                if role == "system"
                    && messages
                        .last()
                        .is_some_and(|m| m.get("role").and_then(Value::as_str) == Some("system"))
                {
                    if let Some(last) = messages.last_mut() {
                        let previous = last.get("content").and_then(Value::as_str).unwrap_or("");
                        last["content"] = json!(format!("{previous}\n{text}"));
                    }
                } else {
                    messages.push(json!({"role": role, "content": text}));
                }
            }
            "function_call" => {
                let call = json!({
                    "id": item.get("call_id").cloned().unwrap_or(json!("call_unknown")),
                    "type": "function",
                    "function": {
                        "name": item.get("name").cloned().unwrap_or(json!("unknown")),
                        "arguments": item.get("arguments").cloned().unwrap_or(json!("{}")),
                    }
                });
                if messages
                    .last()
                    .is_some_and(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
                {
                    if let Some(last) = messages.last_mut() {
                        if !last["tool_calls"].is_array() {
                            last["tool_calls"] = json!([]);
                        }
                        last["tool_calls"].as_array_mut().unwrap().push(call);
                    }
                } else {
                    messages.push(json!({"role": "assistant", "tool_calls": [call]}));
                }
            }
            "function_call_output" => {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": item.get("call_id").cloned().unwrap_or(json!("call_unknown")),
                    "content": item.get("output").cloned().unwrap_or(json!("")),
                }));
            }
            // reasoning and unknown items are deliberately skipped: guessing
            // them into another protocol would fabricate history.
            _ => {}
        }
    }
    let mut tools = Vec::new();
    if let Some(list) = body.get("tools").and_then(Value::as_array) {
        for tool in list {
            let name = tool.get("name").and_then(Value::as_str);
            let parameters = tool
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
            if let Some(name) = name {
                tools.push(json!({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": tool.get("description").cloned().unwrap_or(json!("")),
                        "parameters": parameters,
                    }
                }));
            }
        }
    }
    let mut request = Map::new();
    request.insert("model".into(), json!(model));
    request.insert("messages".into(), json!(messages));
    if !tools.is_empty() {
        request.insert("tools".into(), json!(tools));
    }
    request.insert("stream".into(), json!(true));
    request.insert("stream_options".into(), json!({"include_usage": true}));
    Ok(Value::Object(request))
}

fn anthropic_request(body: &Value) -> Result<Value, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or("Responses request is missing `model`")?;
    let mut messages: Vec<Value> = Vec::new();
    let mut system = body
        .get("instructions")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| vec![text.to_string()])
        .unwrap_or_default();
    let mut push_message = |role: &str, blocks: Vec<Value>| {
        if blocks.is_empty() {
            return;
        }
        if messages
            .last()
            .is_some_and(|m| m.get("role").and_then(Value::as_str) == Some(role))
        {
            if let Some(last) = messages.last_mut() {
                if let Some(array) = last.get_mut("content").and_then(Value::as_array_mut) {
                    array.extend(blocks);
                }
            }
        } else {
            messages.push(json!({"role": role, "content": blocks}));
        }
    };
    for item in input_items(body) {
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        match item_type {
            "message" => {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let text = if role == "assistant" {
                    item_text(&item, "output_text")
                } else {
                    item_text(&item, "input_text")
                };
                if text.is_empty() {
                    continue;
                }
                if matches!(role, "system" | "developer") {
                    system.push(text);
                    continue;
                }
                let role = if role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                push_message(role, vec![json!({"type": "text", "text": text})]);
            }
            "function_call" => {
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let input: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
                push_message(
                    "assistant",
                    vec![json!({
                        "type": "tool_use",
                        "id": item.get("call_id").cloned().unwrap_or(json!("toolu_unknown")),
                        "name": item.get("name").cloned().unwrap_or(json!("unknown")),
                        "input": input,
                    })],
                );
            }
            "function_call_output" => {
                push_message(
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": item.get("call_id").cloned().unwrap_or(json!("toolu_unknown")),
                        "content": item.get("output").cloned().unwrap_or(json!("")),
                    })],
                );
            }
            _ => {}
        }
    }
    let mut tools = Vec::new();
    if let Some(list) = body.get("tools").and_then(Value::as_array) {
        for tool in list {
            let name = tool.get("name").and_then(Value::as_str);
            let schema = tool
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
            if let Some(name) = name {
                tools.push(json!({
                    "name": name,
                    "description": tool.get("description").cloned().unwrap_or(json!("")),
                    "input_schema": schema,
                }));
            }
        }
    }
    let mut request = Map::new();
    request.insert("model".into(), json!(model));
    if !system.is_empty() {
        request.insert("system".into(), json!(system.join("\n\n")));
    }
    request.insert("messages".into(), json!(messages));
    if !tools.is_empty() {
        request.insert("tools".into(), json!(tools));
    }
    // Anthropic requires an explicit ceiling; the Kernel's context window
    // still governs the real budget, so this only bounds one response.
    request.insert("max_tokens".into(), json!(8192));
    request.insert("stream".into(), json!(true));
    Ok(Value::Object(request))
}

/// Streaming translation state machine: upstream Chat Completions SSE lines
/// in, Kernel-consumable Responses SSE events out.
#[derive(Debug, Default)]
pub struct ChatSseTranslator {
    response_id: Option<String>,
    text: String,
    tool_calls: Map<String, Value>,
    usage: Option<Value>,
    finished: bool,
    emitted_created: bool,
    emitted_text: bool,
    budget: Option<StreamBudget>,
    breach: Option<BudgetBreach>,
}

impl ChatSseTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enforce the shared budgets while reassembling streamed tool calls. The
    /// accumulated text is bounded by the reader's total-output meter (it can
    /// only grow from bytes that were charged), so the translator itself
    /// guards the one thing that must never be delivered half-formed: a
    /// function call's arguments.
    pub fn with_budget(mut self, budget: StreamBudget) -> Self {
        self.budget = Some(budget);
        self
    }

    /// Set when an upstream stream overflowed a budget. The translator then
    /// goes silent — callers must report a failure, never a completion.
    pub fn breach(&self) -> Option<BudgetBreach> {
        self.breach.clone()
    }

    /// Feed one `data:` payload (already stripped of the `data:` prefix).
    /// Returns the Responses events this chunk produced.
    pub fn feed(&mut self, payload: &str) -> Vec<Value> {
        let mut events = Vec::new();
        if self.breach.is_some() {
            return events;
        }
        let args_cap = self
            .budget
            .as_ref()
            .map_or(usize::MAX, |b| b.max_tool_args_bytes);
        if payload.trim() == "[DONE]" {
            events.extend(self.complete());
            return events;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(payload) else {
            return events;
        };
        if self.response_id.is_none() {
            self.response_id = Some(
                chunk
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("chatcmpl-bridge")
                    .to_string(),
            );
            events.push(json!({
                "type": "response.created",
                "response": {"id": self.response_id.clone().unwrap()}
            }));
            self.emitted_created = true;
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(usage.clone());
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
        else {
            return events;
        };
        if let Some(delta) = choice.get("delta") {
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                let item_id = format!("msg-{}", self.response_id.as_deref().unwrap_or_default());
                if !text.is_empty() {
                    events.extend(text_delta_events(&item_id, 0, text, !self.emitted_text));
                    self.emitted_text = true;
                }
                self.text.push_str(text);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|i| i.to_string())
                        .unwrap_or_else(|| "0".into());
                    let entry = self
                        .tool_calls
                        .entry(index)
                        .or_insert_with(|| json!({"id": null, "name": "", "arguments": ""}));
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        entry["id"] = json!(id);
                    }
                    let function = call.get("function");
                    if let Some(name) = function.and_then(|f| f.get("name")).and_then(Value::as_str)
                    {
                        entry["name"] =
                            json!(entry["name"].as_str().unwrap_or("").to_string() + name);
                    }
                    if let Some(args) = function
                        .and_then(|f| f.get("arguments"))
                        .and_then(Value::as_str)
                    {
                        let existing = entry["arguments"].as_str().unwrap_or("").to_string();
                        let received = existing.len() + args.len();
                        if received > args_cap {
                            self.breach = Some(BudgetBreach::new(
                                TOOL_ARGS_BUDGET,
                                args_cap as u64,
                                received as u64,
                                "bytes",
                            ));
                            // Drop the partial call: nothing truncated may
                            // reach the executor.
                            entry["arguments"] = json!("");
                            return events;
                        }
                        entry["arguments"] = json!(existing + args);
                    }
                }
            }
        }
        if choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .is_some()
        {
            events.extend(self.emit_items());
        }
        events
    }

    fn emit_items(&mut self) -> Vec<Value> {
        let id = self.response_id.clone().unwrap_or_default();
        let mut events = Vec::new();
        let mut indexes: Vec<&String> = self.tool_calls.keys().collect();
        indexes.sort();
        for key in &indexes {
            let call = &self.tool_calls[*key];
            let name = call.get("name").and_then(Value::as_str).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let call_id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{key}"));
            events.push(json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "name": name,
                    "call_id": call_id,
                    "arguments": call.get("arguments").cloned().unwrap_or(json!("{}")),
                }
            }));
        }
        if !self.text.is_empty() || events.is_empty() {
            events.push(json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": format!("msg-{id}"),
                    "content": [{"type": "output_text", "text": self.text.clone()}],
                }
            }));
        }
        self.text.clear();
        self.tool_calls.clear();
        events
    }

    fn complete(&mut self) -> Vec<Value> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut events = Vec::new();
        if !self.emitted_created {
            events.push(json!({
                "type": "response.created",
                "response": {"id": self.response_id.clone().unwrap_or_else(|| "chatcmpl-bridge".into())}
            }));
            self.emitted_created = true;
        }
        if !self.text.is_empty() || !self.tool_calls.is_empty() {
            events.extend(self.emit_items());
        }
        let id = self.response_id.clone().unwrap_or_default();
        let mut completed = json!({
            "type": "response.completed",
            "response": {"id": id}
        });
        if let Some(usage) = self
            .usage
            .as_ref()
            .filter(|usage| usage["prompt_tokens"].is_u64() && usage["completion_tokens"].is_u64())
        {
            let input = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            // Only reported numbers are forwarded; the details blocks stay
            // null because Chat Completions does not include them here.
            completed["response"]["usage"] = json!({
                "input_tokens": input,
                "input_tokens_details": usage.get("prompt_tokens_details").cloned().unwrap_or(Value::Null),
                "output_tokens": output,
                "output_tokens_details": usage.get("completion_tokens_details").cloned().unwrap_or(Value::Null),
                "total_tokens": input + output,
            });
        }
        events.push(completed);
        events
    }
}

/// Streaming translation state machine: upstream Anthropic Messages SSE
/// payloads (the `data:` JSON of each event) in, Responses events out.
#[derive(Debug, Default)]
pub struct AnthropicSseTranslator {
    response_id: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    cache_write_input_tokens: Option<u64>,
    /// Anthropic 5-minute / 1-hour cache-write billing tiers when the
    /// provider reports them; `None` keeps them "unknown", never zero.
    cache_write_5m_tokens: Option<u64>,
    cache_write_1h_tokens: Option<u64>,
    text: String,
    text_index: u64,
    blocks: Map<String, Value>,
    completed: bool,
    budget: Option<StreamBudget>,
    breach: Option<BudgetBreach>,
}

impl AnthropicSseTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enforce the shared tool-argument budget on streamed `partial_json`.
    /// Text accumulation is bounded by the reader's total-output meter.
    pub fn with_budget(mut self, budget: StreamBudget) -> Self {
        self.budget = Some(budget);
        self
    }

    /// Set when an upstream stream overflowed a budget; the translator then
    /// produces no further events so the caller cannot report a completion.
    pub fn breach(&self) -> Option<BudgetBreach> {
        self.breach.clone()
    }

    pub fn feed(&mut self, payload: &str) -> Vec<Value> {
        let mut events = Vec::new();
        if self.breach.is_some() {
            return events;
        }
        let args_cap = self
            .budget
            .as_ref()
            .map_or(usize::MAX, |b| b.max_tool_args_bytes);
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            return events;
        };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "message_start" => {
                let id = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .unwrap_or("msg-bridge")
                    .to_string();
                self.input_tokens = event
                    .pointer("/message/usage/input_tokens")
                    .and_then(Value::as_u64);
                self.cached_input_tokens = event
                    .pointer("/message/usage/cache_read_input_tokens")
                    .and_then(Value::as_u64);
                self.cache_write_input_tokens = event
                    .pointer("/message/usage/cache_creation_input_tokens")
                    .and_then(Value::as_u64);
                self.cache_write_5m_tokens = event
                    .pointer("/message/usage/cache_creation/ephemeral_5m_input_tokens")
                    .and_then(Value::as_u64);
                self.cache_write_1h_tokens = event
                    .pointer("/message/usage/cache_creation/ephemeral_1h_input_tokens")
                    .and_then(Value::as_u64);
                self.response_id = Some(id.clone());
                events.push(json!({"type": "response.created", "response": {"id": id}}));
            }
            "content_block_start" => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|i| i.to_string())
                    .unwrap_or_else(|| "0".into());
                let block = event.get("content_block").cloned().unwrap_or(json!({}));
                if block["type"] == "text" {
                    self.text_index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                    let item_id = format!(
                        "msg-{}-{}",
                        self.response_id.as_deref().unwrap_or_default(),
                        self.text_index
                    );
                    let initial = block.get("text").and_then(Value::as_str).unwrap_or("");
                    self.text.push_str(initial);
                    events.extend(text_delta_events(&item_id, self.text_index, initial, true));
                }
                self.blocks.insert(index, block);
            }
            "content_block_delta" => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|i| i.to_string())
                    .unwrap_or_else(|| "0".into());
                let delta = event.get("delta").cloned().unwrap_or(json!({}));
                let delta_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
                let entry = self
                    .blocks
                    .entry(index)
                    .or_insert_with(|| json!({"type": "text"}));
                match delta_type {
                    "text_delta" => {
                        let piece = delta.get("text").and_then(Value::as_str).unwrap_or("");
                        self.text.push_str(piece);
                        let item_id = format!(
                            "msg-{}-{}",
                            self.response_id.as_deref().unwrap_or_default(),
                            self.text_index
                        );
                        events.extend(text_delta_events(&item_id, self.text_index, piece, false));
                    }
                    "input_json_delta" => {
                        let piece = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let existing = entry["partial_json"].as_str().unwrap_or("").to_string();
                        let received = existing.len() + piece.len();
                        if received > args_cap {
                            self.breach = Some(BudgetBreach::new(
                                TOOL_ARGS_BUDGET,
                                args_cap as u64,
                                received as u64,
                                "bytes",
                            ));
                            entry["partial_json"] = json!("");
                            return events;
                        }
                        entry["partial_json"] = json!(existing + piece);
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|i| i.to_string())
                    .unwrap_or_else(|| "0".into());
                if let Some(block) = self.blocks.remove(&index) {
                    let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
                    match block_type {
                        "tool_use" => {
                            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                            if !name.is_empty() {
                                let partial = block
                                    .get("partial_json")
                                    .and_then(Value::as_str)
                                    .unwrap_or("{}");
                                let input: Value =
                                    serde_json::from_str(partial).unwrap_or(json!({}));
                                events.push(json!({
                                    "type": "response.output_item.done",
                                    "item": {
                                        "type": "function_call",
                                        "name": name,
                                        "call_id": block.get("id").cloned().unwrap_or(json!("toolu_unknown")),
                                        "arguments": json!(input.to_string()),
                                    }
                                }));
                            }
                        }
                        _ => {
                            if !self.text.is_empty() {
                                events.push(json!({
                                    "type": "response.output_item.done",
                                    "item": {
                                        "type": "message",
                                        "role": "assistant",
                                        "id": format!("msg-{}-{}", self.response_id.clone().unwrap_or_default(), self.text_index),
                                        "content": [{"type": "output_text", "text": self.text.clone()}],
                                    }
                                }));
                                self.text.clear();
                            }
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(usage) = event.get("usage") {
                    self.output_tokens = usage.get("output_tokens").and_then(Value::as_u64);
                }
            }
            "message_stop" => {
                events.extend(self.complete());
            }
            "error" => {
                // Upstream in-stream errors become a failed completion so the
                // Kernel surfaces a real failure instead of hanging.
                let message = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("upstream stream error");
                events.push(json!({
                    "type": "response.failed",
                    "response": {"id": self.response_id.clone().unwrap_or_default(), "status":"failed", "error": {"code":"upstream_error", "message":message}}
                }));
                self.completed = true;
            }
            _ => {}
        }
        events
    }

    fn complete(&mut self) -> Vec<Value> {
        if self.completed {
            return Vec::new();
        }
        self.completed = true;
        let mut events = Vec::new();
        if !self.text.is_empty() || !self.blocks.is_empty() {
            if !self.text.is_empty() {
                events.push(json!({
                    "type": "response.output_item.done",
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "id": format!("msg-{}-{}", self.response_id.clone().unwrap_or_default(), self.text_index),
                        "content": [{"type": "output_text", "text": self.text.clone()}],
                    }
                }));
                self.text.clear();
            }
            let mut indexes: Vec<&String> = self.blocks.keys().collect();
            indexes.sort();
            for key in indexes {
                let block = &self.blocks[key];
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let partial = block
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .unwrap_or("{}");
                    let input: Value = serde_json::from_str(partial).unwrap_or(json!({}));
                    events.push(json!({
                        "type": "response.output_item.done",
                        "item": {
                            "type": "function_call",
                            "name": name,
                            "call_id": block.get("id").cloned().unwrap_or(json!("toolu_unknown")),
                            "arguments": json!(input),
                        }
                    }));
                }
            }
            self.blocks.clear();
        }
        let mut completed = json!({
            "type": "response.completed",
            "response": {"id": self.response_id.clone().unwrap_or_default()}
        });
        if let (Some(input), Some(output)) = (self.input_tokens, self.output_tokens) {
            let input = input
                .saturating_add(self.cached_input_tokens.unwrap_or(0))
                .saturating_add(self.cache_write_input_tokens.unwrap_or(0));
            // The kernel reads `cached_tokens` and `cache_write_tokens`
            // from this block; both must stay numbers. The write-tier
            // breakdown is audit-only detail the kernel ignores.
            let breakdown = match (self.cache_write_5m_tokens, self.cache_write_1h_tokens) {
                (None, None) => Value::Null,
                (five_m, one_h) => json!({
                    "ephemeral5m": five_m,
                    "ephemeral1h": one_h,
                }),
            };
            completed["response"]["usage"] = json!({
                "input_tokens": input,
                "input_tokens_details": if self.cached_input_tokens.is_some() || self.cache_write_input_tokens.is_some() { json!({
                    "cached_tokens": self.cached_input_tokens.unwrap_or(0),
                    "cache_write_tokens": self.cache_write_input_tokens.unwrap_or(0),
                    "cache_creation_tokens": self.cache_write_input_tokens.unwrap_or(0),
                    "cache_creation_breakdown": breakdown,
                }) } else { Value::Null },
                "output_tokens": output,
                "output_tokens_details": null,
                "total_tokens": input + output,
            });
        }
        events.push(completed);
        events
    }
}

fn text_delta_events(item_id: &str, output_index: u64, text: &str, first: bool) -> Vec<Value> {
    let mut events = Vec::new();
    if first {
        events.push(json!({"type":"response.output_item.added","output_index":output_index,"item":{"type":"message","id":item_id,"role":"assistant","status":"in_progress","content":[]}}));
        events.push(json!({"type":"response.content_part.added","item_id":item_id,"output_index":output_index,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}));
    }
    if !text.is_empty() {
        events.push(json!({"type":"response.output_text.delta","item_id":item_id,"output_index":output_index,"content_index":0,"delta":text}));
    }
    events
}

#[cfg(test)]
mod bridge_tests {
    use super::*;

    const RESPONSES_REQUEST: &str = r#"{
        "model": "gpt-5.2",
        "instructions": "Be helpful.",
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
            {"type": "function_call", "name": "exec", "call_id": "call_1", "arguments": "{\"cmd\":\"ls\"}"},
            {"type": "function_call_output", "call_id": "call_1", "output": "ok"},
            {"type": "reasoning", "summary": "ignored"}
        ],
        "tools": [
            {"type": "function", "name": "exec", "description": "run", "parameters": {"type": "object"}}
        ]
    }"#;

    #[test]
    fn chat_request_maps_messages_tools_and_stream_options() {
        let body: Value = serde_json::from_str(RESPONSES_REQUEST).unwrap();
        let request = translate_request(UpstreamProtocol::ChatCompletions, &body).unwrap();
        assert_eq!(request["model"], "gpt-5.2");
        assert_eq!(request["stream"], true);
        assert_eq!(request["stream_options"]["include_usage"], true);
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(messages[3]["role"], "tool");
        assert_eq!(messages[3]["tool_call_id"], "call_1");
        assert_eq!(messages.len(), 4, "reasoning items are skipped");
        assert_eq!(request["tools"][0]["function"]["name"], "exec");
    }

    #[test]
    fn anthropic_request_maps_system_tools_and_tool_results() {
        let body: Value = serde_json::from_str(RESPONSES_REQUEST).unwrap();
        let request = translate_request(UpstreamProtocol::AnthropicMessages, &body).unwrap();
        assert_eq!(request["system"], "Be helpful.");
        assert_eq!(request["max_tokens"], 8192);
        assert_eq!(request["stream"], true);
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["type"], "tool_use");
        assert_eq!(messages[1]["content"][0]["id"], "call_1");
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(messages[2]["content"][0]["tool_use_id"], "call_1");
        assert_eq!(request["tools"][0]["name"], "exec");
    }

    #[test]
    fn chat_stream_translates_text_tool_and_usage_chunks() {
        let mut translator = ChatSseTranslator::new();
        let mut events = Vec::new();
        for line in [
            r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"lo"}}]}"#,
            r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"exec","arguments":"{\"c"}}]}}]}"#,
            r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"md\":1}"}}]}}]}"#,
            r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            r#"{"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}"#,
            "[DONE]",
        ] {
            events.extend(translator.feed(line));
        }
        let kinds: Vec<String> = events
            .iter()
            .map(|e| e["type"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "response.created",
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.delta",
                "response.output_item.done",
                "response.output_item.done",
                "response.completed"
            ]
        );
        let call = &events[5]["item"];
        assert_eq!(call["type"], "function_call");
        assert_eq!(call["name"], "exec");
        assert_eq!(call["call_id"], "call_x");
        assert_eq!(call["arguments"], "{\"cmd\":1}");
        let message = &events[6]["item"];
        assert_eq!(message["content"][0]["text"], "Hello");
        let usage = events[7]["response"]["usage"].clone();
        assert_eq!(usage["input_tokens"], 11);
        assert_eq!(usage["output_tokens"], 7);
        assert_eq!(usage["total_tokens"], 18);
    }

    #[test]
    fn chat_stream_without_usage_completes_without_fabricated_totals() {
        let mut translator = ChatSseTranslator::new();
        let mut events = Vec::new();
        for line in [
            r#"{"id":"chatcmpl-2","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}"#,
            "[DONE]",
        ] {
            events.extend(translator.feed(line));
        }
        let completed = events.last().unwrap();
        assert_eq!(completed["type"], "response.completed");
        assert!(
            completed["response"].get("usage").is_none(),
            "missing upstream usage must not become zeros"
        );
    }

    #[test]
    fn anthropic_stream_translates_blocks_usage_and_stop() {
        let mut translator = AnthropicSseTranslator::new();
        let mut events = Vec::new();
        let feed = |t: &mut AnthropicSseTranslator, payload: &str, events: &mut Vec<Value>| {
            events.extend(t.feed(payload));
        };
        for payload in [
            r#"{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":21}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bo"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"nj our"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"cm"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"d\":\"ls\"}"}}"#,
            r#"{"type":"content_block_stop","index":1}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}"#,
            r#"{"type":"message_stop"}"#,
        ] {
            feed(&mut translator, payload, &mut events);
        }
        let message = &events[5]["item"];
        assert_eq!(message["type"], "message");
        assert_eq!(message["content"][0]["text"], "bonj our");
        let call = &events[6]["item"];
        assert_eq!(call["type"], "function_call");
        assert_eq!(call["call_id"], "toolu_1");
        assert_eq!(call["arguments"], "{\"cmd\":\"ls\"}");
        let usage = events[7]["response"]["usage"].clone();
        assert_eq!(usage["input_tokens"], 21);
        assert_eq!(usage["output_tokens"], 9);
        assert_eq!(usage["total_tokens"], 30);
    }

    #[test]
    fn protocol_from_config_accepts_documented_names_and_rejects_unknown() {
        assert_eq!(
            UpstreamProtocol::from_config("responses"),
            Some(UpstreamProtocol::Responses)
        );
        assert_eq!(
            UpstreamProtocol::from_config(""),
            Some(UpstreamProtocol::Responses)
        );
        assert_eq!(
            UpstreamProtocol::from_config("chat"),
            Some(UpstreamProtocol::ChatCompletions)
        );
        assert_eq!(
            UpstreamProtocol::from_config("anthropic"),
            Some(UpstreamProtocol::AnthropicMessages)
        );
        assert_eq!(UpstreamProtocol::from_config("grpc"), None);
    }

    #[test]
    fn text_deltas_are_available_before_completion_and_failures_do_not_complete() {
        let mut chat = ChatSseTranslator::new();
        let delta = chat.feed(r#"{"id":"live","choices":[{"delta":{"content":"你好🌊"}}]}"#);
        assert!(delta.iter().any(
            |event| event["type"] == "response.output_text.delta" && event["delta"] == "你好🌊"
        ));
        assert!(
            !delta
                .iter()
                .any(|event| event["type"] == "response.completed")
        );
        let mut anthropic = AnthropicSseTranslator::new();
        anthropic
            .feed(r#"{"type":"message_start","message":{"id":"live","usage":{"input_tokens":4}}}"#);
        anthropic
            .feed(r#"{"type":"content_block_start","index":0,"content_block":{"type":"text"}}"#);
        let delta = anthropic.feed(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"流式🌊"}}"#);
        assert!(delta.iter().any(
            |event| event["type"] == "response.output_text.delta" && event["delta"] == "流式🌊"
        ));
        let failed = anthropic.feed(r#"{"type":"error","error":{"message":"stream interrupted"}}"#);
        assert_eq!(failed[0]["type"], "response.failed");
        assert!(anthropic.feed(r#"{"type":"message_stop"}"#).is_empty());
    }

    #[test]
    fn anthropic_partial_usage_stays_unknown_and_cache_counts_are_included_once() {
        let mut partial = AnthropicSseTranslator::new();
        partial.feed(
            r#"{"type":"message_start","message":{"id":"partial","usage":{"input_tokens":4}}}"#,
        );
        let ended = partial.feed(r#"{"type":"message_stop"}"#);
        assert!(ended.last().unwrap()["response"].get("usage").is_none());
        let mut cached = AnthropicSseTranslator::new();
        cached.feed(r#"{"type":"message_start","message":{"id":"cached","usage":{"input_tokens":4,"cache_read_input_tokens":10,"cache_creation_input_tokens":6}}}"#);
        cached.feed(r#"{"type":"message_delta","usage":{"output_tokens":3}}"#);
        let ended = cached.feed(r#"{"type":"message_stop"}"#);
        let usage = &ended.last().unwrap()["response"]["usage"];
        assert_eq!(usage["input_tokens"], 20);
        assert_eq!(usage["input_tokens_details"]["cached_tokens"], 10);
        assert_eq!(usage["total_tokens"], 23);
    }

    #[test]
    fn anthropic_cache_write_reaches_the_kernel_field_and_tiers_stay_attached() {
        // Regression: the bridge used to emit `cache_creation_tokens`, a
        // name the kernel never reads, so Anthropic cache-write tokens
        // silently vanished from the subset accounting. The kernel field
        // is `cache_write_tokens`.
        let mut tiers = AnthropicSseTranslator::new();
        tiers.feed(
            r#"{"type":"message_start","message":{"id":"tiers","usage":{
                "input_tokens":4,
                "cache_read_input_tokens":10,
                "cache_creation_input_tokens":6,
                "cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":2}}}}"#,
        );
        tiers.feed(r#"{"type":"message_delta","usage":{"output_tokens":3}}"#);
        let ended = tiers.feed(r#"{"type":"message_stop"}"#);
        let usage = &ended.last().unwrap()["response"]["usage"];
        assert_eq!(
            usage["input_tokens"], 20,
            "raw + read + write, counted once"
        );
        assert_eq!(usage["input_tokens_details"]["cached_tokens"], 10);
        assert_eq!(usage["input_tokens_details"]["cache_write_tokens"], 6);
        assert_eq!(
            usage["input_tokens_details"]["cache_creation_breakdown"]["ephemeral5m"],
            4
        );
        assert_eq!(
            usage["input_tokens_details"]["cache_creation_breakdown"]["ephemeral1h"],
            2
        );
        assert_eq!(usage["total_tokens"], 23);
        // No tiers reported: breakdown stays null instead of fake zeros.
        let mut no_tiers = AnthropicSseTranslator::new();
        no_tiers.feed(
            r#"{"type":"message_start","message":{"id":"plain","usage":{"input_tokens":4,"cache_creation_input_tokens":6}}}"#,
        );
        no_tiers.feed(r#"{"type":"message_delta","usage":{"output_tokens":1}}"#);
        let ended = no_tiers.feed(r#"{"type":"message_stop"}"#);
        let usage = &ended.last().unwrap()["response"]["usage"];
        assert_eq!(
            usage["input_tokens_details"]["cache_creation_breakdown"],
            serde_json::Value::Null
        );
        // No cache fields at all: details stay null (presence unknown).
        let mut bare = AnthropicSseTranslator::new();
        bare.feed(r#"{"type":"message_start","message":{"id":"bare","usage":{"input_tokens":4}}}"#);
        bare.feed(r#"{"type":"message_delta","usage":{"output_tokens":1}}"#);
        let ended = bare.feed(r#"{"type":"message_stop"}"#);
        let usage = &ended.last().unwrap()["response"]["usage"];
        assert_eq!(usage["input_tokens_details"], serde_json::Value::Null);
        assert_eq!(
            usage["input_tokens"], 4,
            "no cache fields means no invented cache tokens"
        );
    }
}
