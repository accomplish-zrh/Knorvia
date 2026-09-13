//! Model-neutral Provider Gateway.
//!
//! Negotiation returns supported / emulated / degraded / unavailable with a
//! reason. Callers must not treat "missing from the list" as a silent drop.
//! `translate` maps a canonical Knorvia request onto a provider body and
//! records every tracked capability in `applied` — never a silent drop.
//! `execute` performs the translated request against the configured gateway
//! and normalizes the provider response (text + tool calls + typed errors).

mod bridge;
mod bridge_cancel;
mod bridge_server;
mod budget;
mod compat_tools;
mod error_class;
mod execute;
mod translate;

use serde::{Deserialize, Serialize};

pub use bridge::{AnthropicSseTranslator, ChatSseTranslator, UpstreamProtocol, translate_request};
pub use bridge_server::{
    BridgeServer, spawn as spawn_responses_bridge,
    spawn_with_budget as spawn_responses_bridge_with_budget,
};
pub use budget::{
    BudgetBreach, DEFAULT_MAX_ERROR_BODY_BYTES, DEFAULT_MAX_EVENT_BYTES, DEFAULT_MAX_EVENTS,
    DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_TOOL_ARGS_BYTES, DEFAULT_MAX_TOTAL_BYTES,
    ERROR_BODY_BUDGET, EVENT_BUDGET, EVENT_COUNT_BUDGET, LINE_BUDGET, StreamBudget,
    TOOL_ARGS_BUDGET, TOTAL_OUTPUT_BUDGET,
};
pub use error_class::{
    ProviderFailure, classify_status, classify_stream_error, classify_transport,
    extract_provider_message, normalize_retry_after, redact_secrets,
};
pub use execute::{
    ExecuteConfig, ExecuteError, ExecutionResult, KEY_PLACEHOLDER, PROVIDER_BASE_URL_ENV,
    PROVIDER_KEY_ENV, ToolCall, category_name, execute, execute_with_budget,
};
pub use translate::{
    AppliedField, CanonicalImage, CanonicalMessage, CanonicalRequest, CanonicalTool,
    CanonicalToolCall, TranslatedRequest, assert_no_silent_drop, translate,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "openai_responses")]
    OpenAiResponses,
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "local")]
    Local,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 5] = [
        ProviderKind::OpenAiResponses,
        ProviderKind::OpenAiCompatible,
        ProviderKind::Anthropic,
        ProviderKind::Gemini,
        ProviderKind::Local,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "openai_responses",
            Self::OpenAiCompatible => "openai_compatible",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Local => "local",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        let n = s.trim().to_ascii_lowercase().replace('-', "_");
        match n.as_str() {
            "openai_responses" | "openai" | "responses" => Ok(Self::OpenAiResponses),
            "openai_compatible" | "compatible" | "openai_compat" => Ok(Self::OpenAiCompatible),
            "anthropic" | "claude" => Ok(Self::Anthropic),
            "gemini" | "google" => Ok(Self::Gemini),
            "local" | "ollama" | "llamacpp" | "llama.cpp" => Ok(Self::Local),
            _ => Err(format!(
                "unknown provider kind {s}; expected openai_responses, openai_compatible, anthropic, gemini, local"
            )),
        }
    }

    pub fn endpoint(self, model: &str, stream: bool) -> String {
        match self {
            Self::OpenAiResponses => "/v1/responses".into(),
            Self::OpenAiCompatible | Self::Local => "/v1/chat/completions".into(),
            Self::Anthropic => "/v1/messages".into(),
            Self::Gemini if stream => format!("/v1beta/models/{model}:streamGenerateContent"),
            Self::Gemini => format!("/v1beta/models/{model}:generateContent"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Supported,
    Emulated,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityReport {
    pub name: String,
    pub status: CapabilityStatus,
    pub reason: String,
}

pub const TRACKED_CAPABILITIES: &[&str] = &[
    "streaming",
    "tools",
    "parallel_tools",
    "structured_output",
    "images",
    "reasoning",
    "prompt_cache",
    "cancellation",
];

pub fn negotiate(kind: ProviderKind, model: &str) -> Vec<CapabilityReport> {
    TRACKED_CAPABILITIES
        .iter()
        .map(|name| report(kind, model, name))
        .collect()
}

/// Cancellation here describes only Knorvia's socket-owning Responses bridge.
/// It does not guarantee a provider stops generation or billing immediately.
pub fn negotiate_bridge(kind: ProviderKind, model: &str) -> Vec<CapabilityReport> {
    let mut reports = negotiate(kind, model);
    if matches!(
        kind,
        ProviderKind::OpenAiCompatible | ProviderKind::Anthropic | ProviderKind::Local
    ) {
        if let Some(report) = reports.iter_mut().find(|r| r.name == "cancellation") {
            report.status = CapabilityStatus::Supported;
            report.reason = "bridge request disconnect/close shuts down its registered upstream socket, including response headers and silent streams; local cleanup is bounded after bridge setup; cloud generation/billing stop is not guaranteed".into();
        }
    }
    reports
}

fn report(kind: ProviderKind, model: &str, name: &str) -> CapabilityReport {
    if name == "cancellation" {
        return CapabilityReport { name:name.into(), status:CapabilityStatus::Unavailable,
            reason:"direct provider/execute has no request cancellation handle; bridge cancellation is reported separately for its actual execution path".into() };
    }
    let (status, reason) = match (kind, name) {
        (
            ProviderKind::OpenAiResponses,
            "streaming" | "tools" | "parallel_tools" | "structured_output" | "images"
            | "cancellation",
        ) => (
            CapabilityStatus::Supported,
            format!("{model}: native Responses API"),
        ),
        (ProviderKind::OpenAiResponses, "reasoning") => {
            let m = model.to_ascii_lowercase();
            if m.contains("gpt-5")
                || m.starts_with("o1")
                || m.starts_with("o3")
                || m.starts_with("o4")
                || m.contains("o1-")
                || m.contains("o3-")
                || m.contains("o4-")
            {
                (
                    CapabilityStatus::Supported,
                    format!("{model}: reasoning native"),
                )
            } else {
                (
                    CapabilityStatus::Unavailable,
                    format!("{model}: no reasoning channel; not dropped silently"),
                )
            }
        }
        (ProviderKind::OpenAiResponses, "prompt_cache") => (
            CapabilityStatus::Supported,
            "prompt cache keys forwarded".into(),
        ),
        (ProviderKind::OpenAiCompatible, "streaming" | "tools" | "cancellation") => (
            CapabilityStatus::Supported,
            "OpenAI-compatible chat/completions subset".into(),
        ),
        (ProviderKind::OpenAiCompatible, "parallel_tools") => (
            CapabilityStatus::Degraded,
            "parallel tool calls serialized; advertised as degraded".into(),
        ),
        (ProviderKind::OpenAiCompatible, "structured_output") => (
            CapabilityStatus::Emulated,
            "json_object / schema emulated via response_format".into(),
        ),
        (ProviderKind::OpenAiCompatible, "images") => (
            CapabilityStatus::Degraded,
            "image parts mapped to data URLs when the server accepts them".into(),
        ),
        (ProviderKind::OpenAiCompatible, "reasoning") => (
            CapabilityStatus::Unavailable,
            "reasoning items are not invented for compatible endpoints".into(),
        ),
        (ProviderKind::OpenAiCompatible, "prompt_cache") => (
            CapabilityStatus::Unavailable,
            "prompt cache is not assumed from a base_url".into(),
        ),
        (ProviderKind::Anthropic, "streaming" | "tools" | "images" | "cancellation") => {
            (CapabilityStatus::Supported, "Anthropic Messages API".into())
        }
        (ProviderKind::Anthropic, "parallel_tools") => (
            CapabilityStatus::Supported,
            "parallel tool_use blocks".into(),
        ),
        (ProviderKind::Anthropic, "structured_output") => (
            CapabilityStatus::Emulated,
            "tool-enforced JSON schema".into(),
        ),
        (ProviderKind::Anthropic, "reasoning") => (
            CapabilityStatus::Supported,
            "thinking blocks when enabled".into(),
        ),
        (ProviderKind::Anthropic, "prompt_cache") => (
            CapabilityStatus::Supported,
            "cache_control breakpoints".into(),
        ),
        (ProviderKind::Gemini, "streaming" | "tools" | "images" | "cancellation") => {
            (CapabilityStatus::Supported, "Gemini generateContent".into())
        }
        (ProviderKind::Gemini, "parallel_tools") => (
            CapabilityStatus::Supported,
            "parallel function calls".into(),
        ),
        (ProviderKind::Gemini, "structured_output") => {
            (CapabilityStatus::Supported, "responseSchema".into())
        }
        (ProviderKind::Gemini, "reasoning") => (
            CapabilityStatus::Degraded,
            "thought summaries mapped when present; otherwise unavailable, not dropped".into(),
        ),
        (ProviderKind::Gemini, "prompt_cache") => (
            CapabilityStatus::Unavailable,
            "implicit cache not advertised as supported".into(),
        ),
        (ProviderKind::Local, "streaming" | "cancellation") => (
            CapabilityStatus::Supported,
            format!("local runtime ({model})"),
        ),
        (ProviderKind::Local, "tools") => (
            CapabilityStatus::Degraded,
            "tool calling depends on the local template; status is degraded until probed".into(),
        ),
        (
            ProviderKind::Local,
            "parallel_tools" | "structured_output" | "images" | "reasoning" | "prompt_cache",
        ) => (
            CapabilityStatus::Unavailable,
            "not assumed for local models; caller must not drop the request field silently".into(),
        ),
        _ => (
            CapabilityStatus::Unavailable,
            format!("untracked combo {name}"),
        ),
    };
    CapabilityReport {
        name: name.to_string(),
        status,
        reason,
    }
}

pub fn require_not_silent(reports: &[CapabilityReport], required: &[&str]) -> Result<(), String> {
    for name in required {
        match reports.iter().find(|r| r.name == *name) {
            None => {
                return Err(format!(
                    "capability {name} missing from negotiation (silent drop)"
                ));
            }
            Some(r) if r.reason.trim().is_empty() && r.status != CapabilityStatus::Supported => {
                return Err(format!(
                    "capability {name} is {:?} without reason",
                    r.status
                ));
            }
            Some(_) => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_complete(kind: ProviderKind, model: &str) {
        let reports = negotiate(kind, model);
        assert_eq!(reports.len(), TRACKED_CAPABILITIES.len());
        require_not_silent(&reports, TRACKED_CAPABILITIES).unwrap();
        for r in &reports {
            if r.status != CapabilityStatus::Supported {
                assert!(!r.reason.is_empty(), "{kind:?} {} silent", r.name);
            }
        }
    }

    #[test]
    fn all_providers_report_every_tracked_capability() {
        assert_complete(ProviderKind::OpenAiResponses, "gpt-5");
        assert_complete(ProviderKind::OpenAiCompatible, "llama-3");
        assert_complete(ProviderKind::Anthropic, "claude-sonnet-4");
        assert_complete(ProviderKind::Gemini, "gemini-2.5-pro");
        assert_complete(ProviderKind::Local, "ollama/llama3.1");
    }

    #[test]
    fn compatible_does_not_pretend_to_be_responses() {
        let reports = negotiate(ProviderKind::OpenAiCompatible, "qwen");
        let reasoning = reports.iter().find(|r| r.name == "reasoning").unwrap();
        assert_eq!(reasoning.status, CapabilityStatus::Unavailable);
        let tools = reports.iter().find(|r| r.name == "tools").unwrap();
        assert_eq!(tools.status, CapabilityStatus::Supported);
    }

    fn rich_request(model: &str) -> CanonicalRequest {
        CanonicalRequest {
            model: model.into(),
            messages: vec![
                CanonicalMessage {
                    role: "system".into(),
                    text: "You are Knorvia.".into(),
                    ..Default::default()
                },
                CanonicalMessage {
                    role: "user".into(),
                    text: "describe this".into(),
                    images: vec![CanonicalImage {
                        media_type: "image/png".into(),
                        data: "aaa".into(),
                    }],
                    ..Default::default()
                },
            ],
            tools: vec![CanonicalTool {
                name: "lookup".into(),
                description: "lookup a fact".into(),
                parameters: serde_json::json!({"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}),
            }],
            parallel_tools: true,
            structured_output: Some(serde_json::json!({
                "type": "object",
                "properties": {"answer": {"type": "string"}},
                "required": ["answer"]
            })),
            images: vec![],
            reasoning: true,
            reasoning_effort: None,
            prompt_cache: true,
            stream: true,
            max_tokens: 2048,
        }
    }

    #[test]
    fn translate_all_five_kinds_never_silently_drops() {
        let cases = [
            (ProviderKind::OpenAiResponses, "gpt-5"),
            (ProviderKind::OpenAiCompatible, "llama-3"),
            (ProviderKind::Anthropic, "claude-sonnet-4"),
            (ProviderKind::Gemini, "gemini-2.5-pro"),
            (ProviderKind::Local, "ollama/llama3.1"),
        ];
        for (kind, model) in cases {
            let tx = translate(kind, rich_request(model)).expect(kind.as_str());
            assert_no_silent_drop(&tx).expect(kind.as_str());
            assert_eq!(tx.method, "POST");
            assert_eq!(tx.applied.len(), TRACKED_CAPABILITIES.len());
            assert!(!tx.body.to_string().to_lowercase().contains("codex"));
        }
    }

    #[test]
    fn openai_responses_puts_native_tools_images_schema_reasoning_in_body() {
        let tx = translate(ProviderKind::OpenAiResponses, rich_request("gpt-5")).unwrap();
        assert_eq!(tx.endpoint, "/v1/responses");
        assert_eq!(tx.body["stream"], true);
        assert!(
            tx.body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "lookup")
        );
        assert_eq!(tx.body["parallel_tool_calls"], true);
        assert_eq!(tx.body["text"]["format"]["type"], "json_schema");
        assert_eq!(tx.body["reasoning"]["effort"], "medium");
        assert_eq!(tx.body["prompt_cache_key"], "knorvia");
        assert!(tx.body.to_string().contains("input_image"));
        let tools = tx.applied.iter().find(|a| a.name == "tools").unwrap();
        assert!(tools.requested && tools.in_body);
    }

    #[test]
    fn compatible_emulates_schema_serializes_parallel_and_does_not_invent_reasoning() {
        let tx = translate(ProviderKind::OpenAiCompatible, rich_request("qwen")).unwrap();
        assert_eq!(tx.endpoint, "/v1/chat/completions");
        assert_eq!(tx.body["parallel_tool_calls"], false);
        assert_eq!(tx.body["response_format"]["type"], "json_schema");
        assert!(tx.body.get("reasoning").is_none());
        assert!(tx.body.get("prompt_cache_key").is_none());
        let reasoning = tx.applied.iter().find(|a| a.name == "reasoning").unwrap();
        assert_eq!(reasoning.status, CapabilityStatus::Unavailable);
        assert!(reasoning.requested);
        assert!(!reasoning.in_body);
        assert!(!reasoning.reason.is_empty());
        let parallel = tx
            .applied
            .iter()
            .find(|a| a.name == "parallel_tools")
            .unwrap();
        assert_eq!(parallel.status, CapabilityStatus::Degraded);
        assert!(parallel.in_body);
        let structured = tx
            .applied
            .iter()
            .find(|a| a.name == "structured_output")
            .unwrap();
        assert_eq!(structured.status, CapabilityStatus::Emulated);
        assert!(structured.in_body);
    }

    #[test]
    fn anthropic_emulates_structured_output_via_forced_tool() {
        let tx = translate(ProviderKind::Anthropic, rich_request("claude-sonnet-4")).unwrap();
        assert_eq!(tx.endpoint, "/v1/messages");
        assert_eq!(tx.body["tool_choice"]["name"], "structured_output");
        assert!(
            tx.body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "structured_output")
        );
        assert_eq!(tx.body["thinking"]["type"], "enabled");
        assert!(tx.body.to_string().contains("cache_control"));
        assert!(tx.body.to_string().contains("\"type\":\"image\""));
    }

    #[test]
    fn gemini_uses_response_schema_and_stream_endpoint() {
        let tx = translate(ProviderKind::Gemini, rich_request("gemini-2.5-pro")).unwrap();
        assert!(tx.endpoint.contains("streamGenerateContent"));
        assert_eq!(
            tx.body["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert!(tx.body["generationConfig"].get("responseSchema").is_some());
        assert!(
            tx.body["tools"][0]["functionDeclarations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "lookup")
        );
        assert!(tx.body.to_string().contains("inlineData"));
        let cache = tx
            .applied
            .iter()
            .find(|a| a.name == "prompt_cache")
            .unwrap();
        assert_eq!(cache.status, CapabilityStatus::Unavailable);
        assert!(!cache.in_body);
    }

    #[test]
    fn local_keeps_tools_degraded_and_refuses_images_reasoning_schema() {
        let tx = translate(ProviderKind::Local, rich_request("ollama/llama3.1")).unwrap();
        assert_eq!(tx.endpoint, "/v1/chat/completions");
        assert!(tx.body.get("tools").is_some());
        assert!(tx.body.get("response_format").is_none());
        assert!(tx.body.get("reasoning").is_none());
        assert!(!tx.body.to_string().contains("image_url"));
        for name in [
            "images",
            "reasoning",
            "structured_output",
            "prompt_cache",
            "parallel_tools",
        ] {
            let field = tx.applied.iter().find(|a| a.name == name).unwrap();
            assert_eq!(field.status, CapabilityStatus::Unavailable, "{name}");
            assert!(!field.in_body, "{name}");
            assert!(!field.reason.is_empty(), "{name}");
        }
        let tools = tx.applied.iter().find(|a| a.name == "tools").unwrap();
        assert_eq!(tools.status, CapabilityStatus::Degraded);
        assert!(tools.in_body);
    }

    #[test]
    fn anthropic_prompt_cache_survives_user_only_messages() {
        let req = CanonicalRequest {
            model: "claude-sonnet-4".into(),
            messages: vec![CanonicalMessage {
                role: "user".into(),
                text: "hi".into(),
                ..Default::default()
            }],
            prompt_cache: true,
            stream: true,
            max_tokens: 256,
            ..Default::default()
        };
        let tx = translate(ProviderKind::Anthropic, req).unwrap();
        let cache = tx
            .applied
            .iter()
            .find(|a| a.name == "prompt_cache")
            .unwrap();
        assert!(cache.requested && cache.in_body);
        assert!(tx.body.to_string().contains("cache_control"));
    }

    #[test]
    fn gpt4o_does_not_silently_drop_unavailable_reasoning() {
        let tx = translate(ProviderKind::OpenAiResponses, rich_request("gpt-4o")).unwrap();
        let reasoning = tx.applied.iter().find(|a| a.name == "reasoning").unwrap();
        assert_eq!(reasoning.status, CapabilityStatus::Unavailable);
        assert!(reasoning.requested);
        assert!(!reasoning.in_body);
        assert!(tx.body.get("reasoning").is_none());
        assert!(!reasoning.reason.is_empty());
        assert!(tx.body.get("tools").is_some());
    }
}
