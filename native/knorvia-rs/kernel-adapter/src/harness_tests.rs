use super::*;

#[test]
fn plan_uses_upstream_instructions_and_preserves_selected_model() {
    assert_eq!(
        collaboration_mode("plan", "chosen-model", Some("high")).unwrap(),
        json!({
            "mode": "plan", "settings": {"model": "chosen-model", "reasoning_effort": "high", "developer_instructions": null}
        })
    );
    assert!(collaboration_mode("invented", "chosen-model", None).is_err());
}

#[test]
fn durable_plan_and_usage_are_distinct_from_provisional_command_output() {
    let plan =
        json!({"plan": [{"step": "Inspect", "status": "inProgress"}], "explanation": "Read first"});
    let Some(Event::Durable(item)) = project_event("turn/plan/updated", &plan) else {
        panic!("missing plan")
    };
    assert_eq!((item.kind, item.payload), ("plan".into(), plan));
    let usage = json!({"tokenUsage": {"total": {"totalTokens": 42}, "modelContextWindow": 100}});
    let Some(Event::Durable(item)) = project_event("thread/tokenUsage/updated", &usage) else {
        panic!("missing usage")
    };
    assert_eq!((item.kind, item.payload), ("tokenUsage".into(), usage));
    let Some(Event::Progress(kind, payload)) = project_event(
        "item/commandExecution/outputDelta",
        &json!({"itemId": "cmd", "delta": "hello"}),
    ) else {
        panic!("missing output")
    };
    assert_eq!(
        (kind, payload),
        (
            "commandExecution.delta",
            json!({"itemId": "cmd", "text": "hello", "truncated": false})
        )
    );
}

#[test]
fn oversized_unicode_diff_is_bounded_without_breaking_utf8() {
    let Some(Event::Durable(item)) =
        project_event("turn/diff/updated", &json!({"diff": "汉".repeat(200_000)}))
    else {
        panic!("missing diff")
    };
    let text = item.payload["diff"].as_str().unwrap();
    assert!(text.len() <= 512 * 1024);
    assert!(text.ends_with('汉'));
    assert_eq!(item.payload["truncated"], true);
}

#[test]
fn kernel_default_cache_zeroes_remain_unknown_while_positive_counts_are_evidence() {
    let raw = json!({"threadId":"child-thread","tokenUsage":{"last":{"inputTokens":160,"outputTokens":40,"cachedInputTokens":0,"cacheWriteInputTokens":0},"total":{"inputTokens":160,"cachedInputTokens":0}}});
    let annotated = annotate_kernel_usage(&raw);
    assert_eq!(
        annotated["tokenUsage"]["last"]["cacheFieldsReported"],
        json!({"cachedInput":false,"cacheWrite":false})
    );
    assert_eq!(annotated["threadId"], raw["threadId"]);
    assert_eq!(annotated["tokenUsage"]["total"], raw["tokenUsage"]["total"]);
    let Some(Event::Durable(item)) = project_event("thread/tokenUsage/updated", &raw) else {
        panic!("missing usage")
    };
    assert_eq!(
        item.payload["tokenUsage"]["last"]["cacheFieldsReported"],
        annotated["tokenUsage"]["last"]["cacheFieldsReported"]
    );
    let positive = annotate_kernel_usage(
        &json!({"tokenUsage":{"last":{"inputTokens":160,"cachedInputTokens":120,"cacheWriteInputTokens":0}}}),
    );
    assert_eq!(
        positive["tokenUsage"]["last"]["cacheFieldsReported"],
        json!({"cachedInput":true,"cacheWrite":false})
    );
    assert_eq!(positive["tokenUsage"]["last"]["cachedInputTokens"], 120);
}
