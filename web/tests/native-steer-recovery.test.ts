import test from "node:test";
import assert from "node:assert/strict";
import { locateSteerReceipt, steerTurnStillRunning, STEER_RECEIPT_MAX_PAGES, type SteerHistoryPage } from "../lib/native-steer-recovery";
import { markSubmissionFailed, readStoredSubmission, submissionAttempt, clearSubmission } from "../lib/native-submission";
import type { Item, ThreadSnapshot } from "../lib/native-workbench-state";

const userMessage = (id: string, seq: number, clientId?: string): Item => ({
  id, threadId: "thread", turnId: "turn-1", kind: "userMessage", status: "completed", seq,
  payload: clientId ? { text: "hi", clientId } : { text: "hi" },
});

const page = (items: Item[], nextCursor: number | null): SteerHistoryPage => ({
  items, itemsNextCursor: nextCursor, hasMoreItems: nextCursor !== null,
});

test("a persisted userMessage with the attempt clientId proves delivery even when later pages stay unread", async () => {
  const pages = [page([userMessage("i1", 1), userMessage("i2", 2, "attempt-1")], 2)];
  let reads = 0;
  const receipt = await locateSteerReceipt(async () => { reads += 1; return pages.shift()!; }, "attempt-1");
  assert.deepEqual(receipt, { state: "received", itemId: "i2", turnId: "turn-1", seq: 2 });
  assert.equal(reads, 1);
});

test("a first-screen miss keeps scanning older pages before absence can be concluded", async () => {
  const pages = [page([userMessage("i1", 1)], 1), page([userMessage("i0", 0)], null)];
  let reads = 0;
  const receipt = await locateSteerReceipt(async () => { reads += 1; return pages.shift()!; }, "attempt-1");
  assert.equal(reads, 2);
  assert.equal(receipt.state, "absent");
});

test("a missing clientId only becomes absent after the complete chain reports no more items", async () => {
  const receipt = await locateSteerReceipt(async () => page([userMessage("i1", 1)], null), "attempt-1");
  assert.deepEqual(receipt, { state: "absent", scannedItems: 1 });
});

test("a read failure keeps the outcome unknown and preserves the attempt", async () => {
  const receipt = await locateSteerReceipt(async () => { throw new Error("connection lost"); }, "attempt-1");
  assert.equal(receipt.state, "unknown");
  assert.match((receipt as { reason: string }).reason, /connection lost/);
});

test("a cursor that never advances stays unknown instead of looping or claiming absence", async () => {
  let reads = 0;
  const receipt = await locateSteerReceipt(async () => { reads += 1; return page([], 7); }, "attempt-1");
  assert.equal(receipt.state, "unknown");
  assert.match((receipt as { reason: string }).reason, /did not advance/);
  assert.equal(reads, 2);
});

test("the page budget bounds the scan and reports unknown, never absence", async () => {
  let reads = 0;
  const receipt = await locateSteerReceipt(async () => { reads += 1; return page([], 100 - reads); }, "attempt-1", { maxPages: 3 });
  assert.equal(reads, 3);
  assert.equal(receipt.state, "unknown");
  assert.ok(STEER_RECEIPT_MAX_PAGES >= 1);
});

test("recovery only applies to a steer attempt whose target turn is no longer running", () => {
  const attempt = { id: "attempt-1", action: { kind: "steer" as const, turnId: "turn-1" } };
  const running: Partial<ThreadSnapshot> = { activeTurn: { id: "turn-1", threadId: "t", status: "running", createdAt: "1" } };
  const ended: Partial<ThreadSnapshot> = { activeTurn: { id: "turn-2", threadId: "t", status: "running", createdAt: "2" } };
  const finished: Partial<ThreadSnapshot> = { activeTurn: { id: "turn-1", threadId: "t", status: "completed", createdAt: "1" } };
  assert.equal(steerTurnStillRunning(running as ThreadSnapshot, attempt), true);
  assert.equal(steerTurnStillRunning(ended as ThreadSnapshot, attempt), false);
  assert.equal(steerTurnStillRunning(finished as ThreadSnapshot, attempt), false);
  assert.equal(steerTurnStillRunning(undefined, attempt), false);
  assert.equal(steerTurnStillRunning(running as ThreadSnapshot, { id: "a", action: { kind: "start" } }), false);
});

test("the retained attempt keeps its identity through a failure mark and clears only for its own id", async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const first = await submissionAttempt(storage, "scope", { body: "v1" }, { kind: "steer", turnId: "turn-1" });
  markSubmissionFailed(storage, "scope", first.id);
  const stored = readStoredSubmission(storage, "scope");
  assert.equal(stored?.id, first.id);
  assert.equal(stored?.action.kind, "steer");
  // The unchanged retry still resolves to the same admission identity.
  const retried = await submissionAttempt(storage, "scope", { body: "v1" }, { kind: "steer", turnId: "turn-1" });
  assert.equal(retried.id, first.id);
  clearSubmission(storage, "scope", "other-id");
  assert.ok(readStoredSubmission(storage, "scope"));
  clearSubmission(storage, "scope", first.id);
  assert.equal(readStoredSubmission(storage, "scope"), undefined);
});
