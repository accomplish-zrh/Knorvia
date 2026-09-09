import test from "node:test";
import assert from "node:assert/strict";
import { addDelta, displayTime, itemHistory, mergeSnapshot, needsHistoryBridge, reconcileLive, taskStatus, withItemHistory, type Item, type ThreadSnapshot } from "../lib/native-workbench-state";

const thread: ThreadSnapshot = { id: "thread-a", title: "Work", workspaceId: "project", status: "active", revision: 1, createdAt: "0", updatedAt: "0", turns: [{ id: "turn-a", threadId: "thread-a", status: "running", createdAt: "0" }], activeTurn: { id: "turn-a", threadId: "thread-a", status: "running", createdAt: "0" }, pendingApprovals: [], items: [] };
const message: Item = { id: "item-a", threadId: "thread-a", turnId: "turn-a", seq: 3, kind: "agentMessage", status: "completed", payload: { text: "Hello world", kernelItemId: "kernel-a" } };
const delta = { method: "turn/event", params: { threadId: "thread-a", turnId: "turn-a", kind: "agentMessage.delta", payload: { itemId: "kernel-a", text: "Hello" } } };

test("a durable message reconciles a live stream once, including late deltas and snapshot races", () => {
  const live = addDelta([], delta, thread);
  assert.equal(live[0].text, "Hello");
  const received = mergeSnapshot(thread, { ...thread, items: [message] });
  const olderSnapshot = mergeSnapshot(received, thread);
  assert.deepEqual(olderSnapshot.items, [message]);
  assert.deepEqual(reconcileLive(live, olderSnapshot), []);
  assert.deepEqual(addDelta([], delta, olderSnapshot), []);
});

test("switching tasks preserves independent live text; durable terminal snapshots clear only their turn", () => {
  const a = addDelta([], delta, thread);
  const b = addDelta(a, { ...delta, params: { ...delta.params, threadId: "thread-b", turnId: "turn-b" } });
  assert.equal(b.length, 2);
  const finished = { ...thread, activeTurn: null, turns: [{ ...thread.turns[0], status: "cancelled" }], lastTurn: { ...thread.turns[0], status: "cancelled" } };
  assert.deepEqual(reconcileLive(b, finished).map(item => item.threadId), ["thread-b"]);
  assert.deepEqual(addDelta([], delta, finished), []);
  assert.equal(taskStatus(finished), "cancelled");
});

test("approval takes precedence over active status; consent alone does not mark a task completed", () => {
  const waiting = { ...thread, pendingApprovals: [{ id: "approval", threadId: thread.id, turnId: "turn-a", action: "write", status: "pending" }] };
  assert.equal(taskStatus(waiting), "approval");
  assert.equal(taskStatus({ ...waiting, pendingApprovals: [{ ...waiting.pendingApprovals[0], status: "allowed" }] }), "running");
});

function timelineItem(seq: number, status = "completed"): Item {
  return { id: `item-${seq}`, threadId: thread.id, turnId: "turn-a", seq, kind: "agentMessage", status, payload: { text: String(seq) } };
}

function page(items: Item[], hasMoreItems: boolean, itemsNextCursor: number | null): ThreadSnapshot {
  return { ...thread, items, hasMoreItems, itemsNextCursor };
}

test("an early reconnect notification does not advance the fetched-history ceiling past a gap", () => {
  const initial = page([timelineItem(1), timelineItem(2), timelineItem(3)], false, null);
  const afterNotification = mergeSnapshot(initial, { ...initial, items: [timelineItem(10)] }, { source: "notification" });
  const known = itemHistory(afterNotification);
  assert.equal(known?.latestPageSeq, 3);

  const newest = page([timelineItem(8), timelineItem(9), timelineItem(10)], true, 8);
  const middle = page([timelineItem(4), timelineItem(5), timelineItem(6), timelineItem(7)], true, 4);
  const oldest = page([timelineItem(1), timelineItem(2), timelineItem(3)], false, null);
  assert.equal(needsHistoryBridge(newest, known), true);
  assert.equal(needsHistoryBridge(middle, known), true);
  assert.equal(needsHistoryBridge(oldest, known), false);

  const bridged = withItemHistory(
    mergeSnapshot(mergeSnapshot(newest, middle, { source: "older" }), oldest, { source: "older" }),
    { latestPageSeq: 10, nextCursor: null, complete: true },
  );
  const complete = mergeSnapshot(afterNotification, bridged);
  assert.deepEqual(complete.items.map(item => item.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(complete.hasMoreItems, false);
  assert.equal(complete.itemsNextCursor, null);
});

test("an older page cannot overwrite a live item update or rewind its page chain", () => {
  const completed = { ...timelineItem(10, "completed"), payload: { text: "new" } };
  const current = page([timelineItem(8), timelineItem(9), completed], true, 8);
  const olderResponse = {
    ...page([timelineItem(7), { ...completed, status: "pending", payload: { text: "old" } }], true, 7),
    activeTurn: { ...thread.turns[0], status: "running" },
  };
  const currentTerminal = { ...current, activeTurn: null, turns: [{ ...thread.turns[0], status: "completed" }] };
  const merged = mergeSnapshot(currentTerminal, olderResponse, { source: "older", preserveCurrent: true });
  assert.equal(merged.items.find(item => item.id === completed.id)?.status, "completed");
  assert.equal(merged.items.find(item => item.id === completed.id)?.payload.text, "new");
  assert.equal(merged.activeTurn, null);
  assert.equal(itemHistory(merged)?.latestPageSeq, 10);
  assert.equal(itemHistory(merged)?.nextCursor, 7);
});

test("displayTime accepts Rust milliseconds, legacy Unix values, and ISO dates", () => {
  const milliseconds = "1788609600000";
  const expected = displayTime(milliseconds, "en-US");
  assert.notEqual(expected, "");
  assert.equal(displayTime(`${milliseconds}ms`, "en-US"), expected);
  assert.equal(displayTime("1788609600", "en-US"), expected);
  assert.equal(displayTime("2026-09-05T12:00:00.000Z", "en-US"), expected);
  assert.equal(displayTime("not-a-date", "en-US"), "");
});
