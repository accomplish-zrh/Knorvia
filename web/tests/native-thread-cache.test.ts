import test from "node:test";
import assert from "node:assert/strict";
import { lightThread, readThreadsBounded, ThreadCache } from "../lib/native-thread-cache";
import type { ThreadSnapshot } from "../lib/native-workbench-state";

let sequence = 0;
const snapshot = (itemCount: number, overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot => {
  sequence += 1;
  return {
    id: `t${sequence}`, workspaceId: "w1", title: `Task ${sequence}`, status: "active", revision: 1, createdAt: "1", updatedAt: String(sequence),
    items: Array.from({ length: itemCount }, (_, index) => ({ id: `i${index}`, threadId: `t${sequence}`, turnId: "turn", kind: "agentMessage", status: "completed", seq: index, payload: {} })),
    turns: [], pendingApprovals: [], activeTurn: null,
    ...overrides,
  };
};

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

test("eviction respects the entry and item budgets and keeps the touched order", () => {
  const cache = new ThreadCache({ maxEntries: 3, maxItems: 100 });
  cache.set("a", snapshot(10));
  cache.set("b", snapshot(10));
  cache.set("c", snapshot(10));
  // Touch a so it is the most recent.
  cache.touch("a");
  cache.set("d", snapshot(10));
  const evicted = cache.evict();
  assert.deepEqual(evicted, ["b"]);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.has("d"), true);
});

test("the visible task, pinned consumers, and pending-attention tasks are never evicted", () => {
  const cache = new ThreadCache({ maxEntries: 2, maxItems: 1000 });
  cache.set("pending", snapshot(20, { pendingApprovals: [{ id: "a1", threadId: "pending", turnId: "turn", action: "exec", status: "pending" }] }));
  cache.set("old", snapshot(5));
  cache.set("extra", snapshot(5));
  // Three entries exceed the budget; the oldest unprotected entry leaves.
  const evicted = cache.evict((id) => id === "pending");
  assert.deepEqual(evicted, ["old"]);
  assert.equal(cache.has("pending"), true);
  assert.equal(cache.has("extra"), true);
  // A pinned consumer survives the next round; the next-oldest entry leaves.
  cache.set("pinned", snapshot(5));
  cache.pin("pinned", true);
  const again = cache.evict((id) => id === "pending");
  assert.deepEqual(again, ["extra"]);
  assert.equal(cache.has("pinned"), true);
});

test("the item budget evicts oldest-first even when entry count is fine", () => {
  const cache = new ThreadCache({ maxEntries: 10, maxItems: 12 });
  cache.set("big-old", snapshot(10));
  cache.set("new", snapshot(4));
  const evicted = cache.evict();
  assert.deepEqual(evicted, ["big-old"]);
  assert.equal(cache.has("new"), true);
});

test("the index projection carries status and activity but no item bodies", () => {
  const full = snapshot(500, { pendingApprovals: [{ id: "a", threadId: "t", turnId: "turn", action: "exec", status: "pending" }], pendingUserInputs: [], activeTurn: { id: "turn", threadId: "t", status: "running", createdAt: "1" } });
  const row = lightThread(full);
  assert.equal("items" in row, false);
  assert.equal("hasMoreItems" in row, false);
  assert.equal(row.pendingApprovals?.length, 1);
  assert.equal(row.activeTurn?.status, "running");
  assert.equal(row.title, full.title);
});

test("recovery reads with bounded concurrency, foreground first, failures isolated", async () => {
  const started: string[] = [];
  let concurrent = 0;
  let peak = 0;
  const reader = async (id: string) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    started.push(id);
    await wait();
    concurrent -= 1;
    if (id === "t-bad") throw new Error("task store unavailable");
  };
  const { read, failed } = await readThreadsBounded(["t-first", "t-bad", "t-third"], reader, { concurrency: 2 });
  assert.deepEqual(read, ["t-first", "t-third"]);
  assert.equal(failed["t-bad"], "task store unavailable");
  assert.equal(started[0], "t-first");
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the budget`);
});

test("an empty recovery list is a no-op", async () => {
  const { read, failed } = await readThreadsBounded([], async () => { throw new Error("never called"); });
  assert.deepEqual(read, []);
  assert.deepEqual(failed, {});
});
