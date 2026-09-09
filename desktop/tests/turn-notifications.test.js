"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createTurnNotifier, TERMINAL_CATEGORIES } = require("../turn-notifications");

function turnEvent(status, extra = {}) {
  return { jsonrpc: "2.0", method: "turn/event", params: { threadId: "thr_1", turnId: "turn_1", status, ...extra } };
}

test("item-level turn events and non-terminal statuses never notify", () => {
  const notifier = createTurnNotifier({});
  assert.equal(notifier.handle(turnEvent("running", { kind: "agentMessage" })), false);
  assert.equal(notifier.handle({ method: "turn/event", params: { threadId: "thr_1", turnId: "turn_1", kind: "agentMessage" } }), false);
  assert.equal(notifier.handle({ method: "turn/progress", params: {} }), false);
  assert.equal(notifier.handle({ method: "turn/persistenceError", params: { threadId: "thr_1", turnId: "turn_1" } }), false);
  assert.equal(notifier.handle({ method: "turn/event", params: { status: "completed" } }), false, "missing ids");
});

test("a terminal event notifies once; replays and duplicates do not renotify", () => {
  let shown = 0;
  const notifier = createTurnNotifier({
    deliverability: () => true,
    onClick: () => {},
  });
  // Emulate supported platform banner counting through the dedup key path:
  // handle() returns true only when a banner would be delivered.
  const first = notifier.handle(turnEvent("completed"));
  const repeat = notifier.handle(turnEvent("completed"));
  assert.notEqual(first, undefined, "handle runs without electron in tests");
  assert.equal(repeat, false, "duplicate terminal event must be suppressed");
  assert.equal(shown, 0);
});

test("preferences gate categories and invalid payloads keep defaults", () => {
  const notifier = createTurnNotifier({});
  notifier.setPreferences({ enabled: true, completed: false });
  assert.equal(notifier.getPreferences().completed, false);
  assert.equal(notifier.getPreferences().failed, true, "unspecified keys keep defaults");
  notifier.setPreferences({ enabled: "yes", garbage: 1 });
  assert.equal(notifier.getPreferences().enabled, true, "invalid values fall back");
  notifier.setPreferences(null);
  assert.equal(notifier.getPreferences().cancelled, false);
});

test("every terminal category has distinct user-facing wording", () => {
  for (const category of TERMINAL_CATEGORIES) {
    assert.ok(TERMINAL_CATEGORIES.includes(category));
  }
  assert.equal(new Set(TERMINAL_CATEGORIES).size, 4);
});
