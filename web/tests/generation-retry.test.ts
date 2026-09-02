import test from "node:test";
import assert from "node:assert/strict";
import {
  EXTRA_GENERATION_RETRIES,
  isRetryableGenerationError,
  nextAutoRetryCount,
  reduceRetryBudget,
} from "../lib/generation-retry";

test("502 and timeout are retryable; cancel is not", () => {
  assert.equal(isRetryableGenerationError("HTTP 502 Bad Gateway"), true);
  assert.equal(
    isRetryableGenerationError("Connection timed out — no response received for 180 seconds."),
    true,
  );
  assert.equal(
    isRetryableGenerationError("busy", { reason: "regenerate_busy", turn_terminal: true }),
    false,
  );
  assert.equal(isRetryableGenerationError("stopped", { status: "cancelled" }), false);
});

test("auto retry allows two extra attempts then the existing button", () => {
  assert.equal(EXTRA_GENERATION_RETRIES, 2);
  assert.equal(nextAutoRetryCount(0), 1);
  assert.equal(nextAutoRetryCount(1), 2);
  assert.equal(nextAutoRetryCount(2), null);
});

test("retryable error then failed done keeps used and stops at two extras", () => {
  const gateway = {
    type: "error" as const,
    content: "HTTP 502 Bad Gateway",
    metadata: { turn_terminal: true, status: "failed" },
  };
  const failedDone = { type: "done" as const, status: "failed" };

  let state = reduceRetryBudget(0, gateway);
  assert.equal(state.used, 1);
  assert.equal(state.shouldRetry, true);

  state = reduceRetryBudget(state.used, failedDone);
  assert.equal(state.used, 1);
  assert.equal(state.shouldRetry, false);

  state = reduceRetryBudget(state.used, gateway);
  assert.equal(state.used, 2);
  assert.equal(state.shouldRetry, true);

  state = reduceRetryBudget(state.used, failedDone);
  assert.equal(state.used, 2);
  assert.equal(state.shouldRetry, false);

  state = reduceRetryBudget(state.used, gateway);
  assert.equal(state.used, 2);
  assert.equal(state.shouldRetry, false);
});

test("completed or cancelled done clears the retry budget", () => {
  const afterRetries = reduceRetryBudget(2, { type: "done", status: "completed" });
  assert.equal(afterRetries.used, 0);
  assert.equal(afterRetries.shouldRetry, false);
  const afterCancel = reduceRetryBudget(1, { type: "done", status: "cancelled" });
  assert.equal(afterCancel.used, 0);
  assert.equal(afterCancel.shouldRetry, false);
});

test("timeout error then failed done is the same two-extra budget", () => {
  const timeout = {
    type: "error" as const,
    content: "Connection timed out — no response received for 180 seconds.",
    metadata: { turn_terminal: true, status: "failed" },
  };
  let state = reduceRetryBudget(0, timeout);
  assert.equal(state.used, 1);
  assert.equal(state.shouldRetry, true);
  state = reduceRetryBudget(state.used, { type: "done", status: "failed" });
  assert.equal(state.used, 1);
  state = reduceRetryBudget(state.used, timeout);
  assert.equal(state.used, 2);
  assert.equal(state.shouldRetry, true);
  state = reduceRetryBudget(state.used, timeout);
  assert.equal(state.shouldRetry, false);
  assert.equal(state.used, 2);
});
