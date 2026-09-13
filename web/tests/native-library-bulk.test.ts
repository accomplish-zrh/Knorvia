import test from "node:test";
import assert from "node:assert/strict";
import { LibraryBulkOperation, bulkTargetPath, isBulkConflict, type BulkEntry } from "../lib/native-library-bulk";

const entry = (id: string, path = `notes/${id}.md`): BulkEntry => ({ id, path, name: `${id}.md`, sha256: `sha-${id}` });

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

test("a batch moves every file with frozen identity guards and per-item targets", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const op = new LibraryBulkOperation(async (method, params) => {
    calls.push({ method, params });
    return { path: params.to };
  }, "move", [entry("a"), entry("b", "notes/sub/b.md")], "organized/2026");
  await op.run();
  const state = op.getSnapshot();
  assert.equal(state.done, 2);
  assert.equal(state.failed, 0);
  assert.deepEqual(calls.map(call => call.params.to), ["organized/2026/a.md", "organized/2026/b.md"]);
  for (const call of calls) {
    assert.equal(call.method, "library/move");
    assert.equal(call.params.expectedId, call.params.from === "notes/a.md" ? "a" : "b");
    assert.equal(call.params.expectedSha256, call.params.from === "notes/a.md" ? "sha-a" : "sha-b");
  }
  assert.deepEqual(state.items.map(item => item.target), ["organized/2026/a.md", "organized/2026/b.md"]);
});

test("a renamed or replaced file fails that item alone; the rest stay done", async () => {
  const responses: Record<string, { code?: number }> = { "notes/a.md": { code: -32005 }, "notes/b.md": {} };
  const op = new LibraryBulkOperation(async (_method, params) => {
    const outcome = responses[params.path as string];
    if (outcome?.code) { const error = new Error("Conflict: file changed since selection"); (error as { code?: number }).code = outcome.code; throw error; }
    return {};
  }, "trash", [entry("a"), entry("b")]);
  await op.run();
  const state = op.getSnapshot();
  assert.deepEqual(state.items.map(item => item.status), ["conflict", "done"]);
  assert.equal(state.done, 1);
  assert.equal(state.failed, 1);
});

test("retry runs only the failed item and never repeats a succeeded one", async () => {
  let attempts = 0;
  const moves: string[] = [];
  const op = new LibraryBulkOperation(async (_method, params) => {
    attempts += 1;
    moves.push(`${params.from}:${attempts}`);
    if (params.from === "notes/a.md" && attempts <= 1) throw new Error("target already exists");
    return { path: params.to };
  }, "move", [entry("a"), entry("b")], "sorted");
  await op.run();
  assert.deepEqual(op.getSnapshot().items.map(item => item.status), ["failed", "done"]);
  await op.retryFailed();
  const state = op.getSnapshot();
  assert.deepEqual(state.items.map(item => item.status), ["done", "done"]);
  // notes/b.md was sent exactly once across the whole operation.
  assert.equal(moves.filter(move => move.startsWith("notes/b.md")).length, 1);
});

test("a retry may use a new destination after conflicts; success records the actual target", async () => {
  const op = new LibraryBulkOperation(async () => { throw new Error("目标位置已存在同名资料"); }, "move", [entry("a")], "old-folder");
  await op.run();
  assert.equal(op.getSnapshot().items[0].status, "conflict");
  const op2 = op;
  const seen: Record<string, unknown>[] = [];
  (op2 as unknown as { transport: (method: string, params: Record<string, unknown>) => Promise<unknown> }).transport = async (_method, params) => { seen.push(params); return { path: params.to }; };
  await op2.retryFailed("new-folder");
  assert.equal(op2.getSnapshot().items[0].status, "done");
  assert.equal(op2.getSnapshot().items[0].target, "new-folder/a.md");
});

test("cancelling marks remaining items skipped; retryFailed picks them up", async () => {
  let calls = 0;
  const op = new LibraryBulkOperation(async () => {
    if (++calls === 1) op.cancel();
    return {};
  }, "trash", [entry("a"), entry("b"), entry("c")]);
  await op.run();
  const statuses = op.getSnapshot().items.map(item => item.status);
  assert.equal(statuses[0], "done");
  assert.ok(statuses.slice(1).every(status => status === "skipped" || status === "done"));
  await op.retryFailed();
  assert.ok(op.getSnapshot().items.every(item => item.status === "done"));
});

test("restore targets resolve per file; empty destination restores in place; trash ignores destination", () => {
  assert.equal(bulkTargetPath(entry("a"), "restore", "back/2026"), "back/2026/a.md");
  assert.equal(bulkTargetPath(entry("a"), "restore", "  "), "notes/a.md");
  assert.equal(bulkTargetPath(entry("a"), "trash", "ignored"), "notes/a.md");
  assert.equal(bulkTargetPath(entry("a"), "move", "folder/"), "folder/a.md");
});

test("conflict detection accepts RPC codes and daemon wording, rejects ordinary failures", () => {
  const coded = new Error("nope"); (coded as { code?: number }).code = -32005;
  assert.equal(isBulkConflict(coded), true);
  assert.equal(isBulkConflict(new Error("目标位置已存在同名资料")), true);
  assert.equal(isBulkConflict(new Error("destination exists (conflict)")), true);
  assert.equal(isBulkConflict(new Error("disk full")), false);
});
