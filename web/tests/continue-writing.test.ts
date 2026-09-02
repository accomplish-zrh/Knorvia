import test from "node:test";
import assert from "node:assert/strict";

import { isAssistantOutputTruncated } from "../lib/continue-writing";
import type { StreamEvent } from "../lib/unified-ws";

function event(partial: Partial<StreamEvent> & Pick<StreamEvent, "type">): StreamEvent {
  return {
    source: "chat",
    stage: "responding",
    content: "",
    metadata: {},
    timestamp: 0,
    ...partial,
  };
}

test("detects explicit output_truncated metadata", () => {
  assert.equal(
    isAssistantOutputTruncated([
      event({ type: "progress", metadata: { output_truncated: true } }),
    ]),
    true,
  );
});

test("detects length finish on a finish round", () => {
  assert.equal(
    isAssistantOutputTruncated([
      event({
        type: "progress",
        metadata: { finish_reason: "length", call_role: "finish" },
      }),
    ]),
    true,
  );
});

test("ignores truncated narration rounds that the loop continued", () => {
  assert.equal(
    isAssistantOutputTruncated([
      event({
        type: "progress",
        metadata: { finish_reason: "length", call_role: "narration" },
      }),
    ]),
    false,
  );
});

test("complete answers are not truncated", () => {
  assert.equal(
    isAssistantOutputTruncated([
      event({ type: "content", content: "hello" }),
      event({ type: "done", metadata: { status: "completed" } }),
    ]),
    false,
  );
});
