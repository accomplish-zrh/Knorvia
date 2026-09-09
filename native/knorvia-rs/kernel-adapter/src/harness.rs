//! Project the pinned App Server's collaboration and progress contracts.
use super::{AdapterError, KernelTurnItem, normalize_item};
use serde_json::{Value, json};

pub(super) enum Event {
    Durable(KernelTurnItem),
    Progress(&'static str, Value),
}

pub(super) fn collaboration_mode(
    mode: &str,
    model: &str,
    effort: Option<&str>,
) -> Result<Value, AdapterError> {
    if !matches!(mode, "default" | "plan") || model.trim().is_empty() {
        return Err(AdapterError::Msg(
            "Invalid collaboration mode or model".into(),
        ));
    }
    Ok(json!({"mode": mode, "settings": {
        "model": model,
        "reasoning_effort": effort,
        // Null selects the upstream built-in mode instructions.
        "developer_instructions": null
    }}))
}

fn bounded_text(value: &Value, limit: usize) -> (String, bool) {
    let text = value.as_str().unwrap_or("");
    let end = text.floor_char_boundary(text.len().min(limit));
    (text[..end].to_string(), text.len() > end)
}

/// App Server token counters default absent cache fields to numeric zero.
/// Once normalized, zero is no proof that the provider reported a cache
/// measurement. Preserve positive evidence, but keep unprovable zeroes
/// unknown until the upstream contract carries explicit field presence.
pub(super) fn annotate_kernel_usage(params: &Value) -> Value {
    let mut params = params.clone();
    if let Some(last) = params
        .pointer_mut("/tokenUsage/last")
        .and_then(Value::as_object_mut)
    {
        let reported = |field: &str| {
            last.get(field)
                .and_then(Value::as_u64)
                .is_some_and(|value| value > 0)
        };
        let presence = json!({"cachedInput": reported("cachedInputTokens"), "cacheWrite": reported("cacheWriteInputTokens")});
        last.insert("cacheFieldsReported".to_string(), presence);
    }
    params
}

pub(super) fn project_event(method: &str, params: &Value) -> Option<Event> {
    let (kind, payload) = match method {
        "turn/plan/updated" => (
            "plan",
            json!({"explanation": params["explanation"], "plan": params["plan"]}),
        ),
        "thread/tokenUsage/updated" => (
            "tokenUsage",
            json!({"tokenUsage": annotate_kernel_usage(params)["tokenUsage"]}),
        ),
        "turn/diff/updated" => {
            let (diff, truncated) = bounded_text(&params["diff"], 512 * 1024);
            ("turnDiff", json!({"diff": diff, "truncated": truncated}))
        }
        "item/started" => {
            let item = normalize_item(params.get("item")?);
            if item.kind == "userMessage" {
                return None;
            }
            return Some(Event::Progress(
                "item.started",
                json!({"itemId": params["item"]["id"], "kind": item.kind, "payload": item.payload}),
            ));
        }
        "item/commandExecution/outputDelta" => {
            let (text, truncated) = bounded_text(&params["delta"], 64 * 1024);
            return Some(Event::Progress(
                "commandExecution.delta",
                json!({"itemId": params["itemId"], "text": text, "truncated": truncated}),
            ));
        }
        _ => return None,
    };
    Some(Event::Durable(KernelTurnItem {
        kind: kind.into(),
        payload,
    }))
}

#[cfg(test)]
#[path = "harness_tests.rs"]
mod tests;
