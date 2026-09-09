import test from "node:test";
import assert from "node:assert/strict";
import { mergeThreadIndex, readPagedThreadIndex, type ThreadIndexPage } from "../lib/native-thread-index";
import type { Thread } from "../lib/native-workbench-state";

const row = (id: string, workspaceId = "project", updatedAt = "1"): Thread => ({
  id, workspaceId, updatedAt, createdAt: "1", title: id, revision: 1, status: "active",
});

test("bounded pages retain every project, including empty scanned pages and inserted records", async () => {
  const requests: Record<string, unknown>[] = [];
  const pages: ThreadIndexPage[] = [
    { threads: [row("a")], nextCursor: "a" },
    { threads: [], nextCursor: "b" },
    { threads: [row("c"), row("d")], nextCursor: null },
    { threads: [row("e", "other")], nextCursor: null },
  ];
  const progress: string[][] = [];
  const result = await readPagedThreadIndex(async <T,>(_method: string, params: Record<string, unknown>) => {
    requests.push(params); return pages.shift() as T;
  }, ["project", "other"], { isCurrent: () => true, onPage: rows => progress.push(rows.map(row => row.id)) });
  assert.deepEqual(result?.map(row => row.id), ["e", "d", "c", "a"]);
  assert.deepEqual(requests, [
    { workspaceId: "project", limit: 100 }, { workspaceId: "project", limit: 100, afterId: "a" },
    { workspaceId: "project", limit: 100, afterId: "b" }, { workspaceId: "other", limit: 100 },
  ]);
  assert.deepEqual(progress[0], ["a"]);
});

test("a repeated cursor fails instead of looping or reporting incomplete history as complete", async () => {
  let requests = 0;
  await assert.rejects(readPagedThreadIndex(async <T,>() => {
    requests++; return { threads: [], nextCursor: "stuck" } as T;
  }, ["project"], { isCurrent: () => true, onPage: () => {} }), /did not advance/);
  assert.equal(requests, 2);
});

test("a late page from a replaced connection cannot publish state or issue its next request", async () => {
  let current = true;
  let published = false;
  const result = await readPagedThreadIndex(async <T,>() => {
    current = false; return { threads: [row("a")], nextCursor: "a" } as T;
  }, ["project"], { isCurrent: () => current, onPage: () => { published = true; } });
  assert.equal(result, null);
  assert.equal(published, false);
});

test("invalid or cross-project pages cannot replace the trusted catalog", async () => {
  for (const response of [[row("a")], { threads: [row("a", "wrong")], nextCursor: null }]) {
    await assert.rejects(readPagedThreadIndex(async <T,>() => response as T, ["project"], {
      isCurrent: () => true, onPage: () => assert.fail("invalid data was published"),
    }));
  }
});

test("late catalog rows preserve newer task metadata and an admitted Turn", () => {
  const current = { ...row("a", "project", "2"), title: "renamed", revision: 2,
    activeTurn: { id: "turn-new", threadId: "a", status: "running", createdAt: "2" } };
  assert.deepEqual(mergeThreadIndex([current, row("b")], [row("a")]), [current, row("b")]);
  assert.deepEqual(mergeThreadIndex([current], [{ ...current, activeTurn: null, lastTurn: null }]), [current]);
  const completed = { ...current, activeTurn: null, lastTurn: { ...current.activeTurn, status: "completed" } };
  assert.deepEqual(mergeThreadIndex([completed], [current], new Set(["a"])), [completed]);
});
