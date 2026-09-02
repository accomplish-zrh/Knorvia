import test from "node:test";
import assert from "node:assert/strict";

import { isTransientFailure } from "../lib/transient-failure";
import type { StreamEvent } from "../lib/unified-ws";

function err(meta: Record<string, unknown>, content = "failed"): StreamEvent {
  return {
    type: "error",
    source: "chat",
    stage: "",
    content,
    metadata: { turn_terminal: true, ...meta },
    timestamp: 0,
  };
}

test("treats HTTP 502 as transient", () => {
  assert.equal(isTransientFailure(err({ status_code: 502 })), true);
});

test("treats timeout copy as transient", () => {
  assert.equal(isTransientFailure(err({}, "Request timed out contacting the model")), true);
});

test("does not retry cancelled or regenerate_busy", () => {
  assert.equal(isTransientFailure(err({ status: "cancelled" })), false);
  assert.equal(isTransientFailure(err({ reason: "regenerate_busy" })), false);
});

test("ordinary model errors are not auto-retried", () => {
  assert.equal(isTransientFailure(err({ status: "failed" }, "content filter")), false);
});
