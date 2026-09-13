import test from "node:test";
import assert from "node:assert/strict";
import {
  BULK_CONFLICT_CODE,
  bulkIneligibility,
  mergeBulkResults,
  planBulkRun,
  retryBulkEntries,
  runBulkThreadAction,
  type BulkEntryResult,
  type BulkSelectionEntry,
  type BulkThreadAction,
} from "../lib/native-history-actions";
import type { Thread } from "../lib/native-workbench-state";

let sequence = 0;
function row(overrides: Partial<Thread> = {}): Thread {
  sequence += 1;
  return {
    id: `t${sequence}`, workspaceId: "p1", title: `任务 ${sequence}`, revision: 1,
    createdAt: "1", updatedAt: "1", status: "active", ...overrides,
  };
}

function rpcError(code: number, message: string): Error {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  return error;
}

/** Fake requester recording calls; behaviour keyed by thread id. */
function fakeRpc(handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params });
    const handler = handlers[`${method}:${params.id as string}`];
    if (!handler) throw new Error(`unexpected ${method} ${String(params.id)}`);
    return (await handler(params)) as T;
  };
  return { calls, request };
}

function succeedArchive(action: BulkThreadAction) {
  return () => ({ status: action === "archive" ? "archived" : "active", revision: 2 });
}

test("bulk plan freezes revisions and classifies ineligible selections without RPC", () => {
  const threads = [
    row({ id: "a", revision: 4 }),
    row({ id: "b", status: "archived" }),
    row({ id: "c", activeTurn: { id: "turn", threadId: "c", status: "running", createdAt: "1" } }),
    row({ id: "d" }),
  ];
  const plan = planBulkRun(threads, new Set(["a", "b", "c", "d"]), "archive");
  assert.deepEqual(plan.entries.map(entry => [entry.id, entry.revision]), [["a", 4], ["d", 1]]);
  assert.deepEqual(plan.ineligible.map(row => [row.id, row.reason]), [["b", "archived"], ["c", "running"]]);
  assert.equal(bulkIneligibility(threads[2], "restore"), "notArchived");
  const restorePlan = planBulkRun(threads, new Set(["a", "b"]), "restore");
  assert.deepEqual(restorePlan.entries.map(entry => entry.id), ["b"]);
  assert.deepEqual(restorePlan.ineligible.map(row => row.id), ["a"]);
});

test("150 archived-ready tasks across projects all succeed with the frozen revision", async () => {
  const threads: Thread[] = [];
  for (let index = 0; index < 150; index += 1) {
    threads.push(row({ id: `bulk-${index}`, workspaceId: index % 3 === 0 ? "p1" : index % 3 === 1 ? "p2" : "p3", revision: index + 10 }));
  }
  const { calls, request } = fakeRpc(Object.fromEntries(threads.map(thread => [`thread/archive:${thread.id}`, succeedArchive("archive")])));
  const plan = planBulkRun(threads, new Set(threads.map(thread => thread.id)), "archive");
  const result = await runBulkThreadAction({ entries: plan.entries, action: "archive", request });
  assert.equal(result.stopped, false);
  assert.equal(result.results.filter(entry => entry.kind === "succeeded").length, 150);
  assert.equal(calls.length, 150);
  for (const call of calls) {
    assert.equal(call.method, "thread/archive");
    const source = threads.find(thread => thread.id === call.params.id)!;
    assert.equal(call.params.expectedRevision, source.revision, "must send the revision frozen at confirmation");
  }
});

test("running tasks never reach the daemon: the plan excludes them", async () => {
  const running = row({ id: "run", activeTurn: { id: "turn", threadId: "run", status: "running", createdAt: "1" } });
  const settled = row({ id: "done" });
  const { calls, request } = fakeRpc({ "thread/archive:done": succeedArchive("archive") });
  const plan = planBulkRun([running, settled], new Set(["run", "done"]), "archive");
  assert.deepEqual(plan.entries.map(entry => entry.id), ["done"], "a running task is not part of the frozen plan");
  const result = await runBulkThreadAction({ entries: plan.entries, action: "archive", request });
  assert.deepEqual(result.results.map(entry => entry.kind), ["succeeded"]);
  assert.deepEqual(calls.map(call => call.params.id), ["done"]);
});

test("a task that starts running after selection is skipped through the daemon refusal", async () => {
  const { request } = fakeRpc({
    "thread/archive:late": () => { throw rpcError(BULK_CONFLICT_CODE, "cannot archive a thread with a running turn"); },
    "thread/read:late": () => ({ id: "late", revision: 1 }),
  });
  const result = await runBulkThreadAction({ entries: [{ id: "late", title: "late", revision: 1 }], action: "archive", request });
  assert.equal(result.results[0].kind, "skipped");
  assert.equal(result.results[0].retryable, true);
});

test("a concurrent rename turns into a conflict, then a refreshed retry succeeds", async () => {
  const entry: BulkSelectionEntry = { id: "x", title: "旧标题", revision: 3 };
  let renamed = false;
  const { calls, request } = fakeRpc({
    "thread/archive:x": () => {
      if (!renamed) throw rpcError(BULK_CONFLICT_CODE, "thread revision 4 != expected 3");
      return { status: "archived", revision: 5 };
    },
    "thread/read:x": () => ({ id: "x", revision: renamed ? 4 : 3, title: renamed ? "新标题" : "旧标题" }),
  });
  const first = await runBulkThreadAction({ entries: [entry], action: "archive", request });
  assert.equal(first.results[0].kind, "conflict");
  assert.equal(first.results[0].retryable, true);
  renamed = true;
  const second = await retryBulkEntries({ previous: first.results, action: "archive", request });
  assert.equal(second.results[0].kind, "succeeded");
  assert.deepEqual(calls.filter(call => call.method === "thread/archive").map(call => call.params.expectedRevision), [3, 4]);
});

test("disconnect mid-run marks the rest failed; recovery retries only unfinished rows and never repeats successes", async () => {
  const entries: BulkSelectionEntry[] = ["a", "b", "c", "d"].map(id => ({ id, title: id, revision: 1 }));
  const attempts: Record<string, number> = { c: 0, d: 0 };
  let dead = false;
  const { calls, request } = fakeRpc({
    "thread/archive:a": () => ({ status: "archived", revision: 2 }),
    "thread/archive:b": () => ({ status: "archived", revision: 2 }),
    "thread/archive:c": () => {
      attempts.c += 1;
      if (attempts.c === 1) { dead = true; throw rpcError(-32040, "socket closed during batch"); }
      return { status: "archived", revision: 2 };
    },
    "thread/archive:d": () => {
      attempts.d += 1;
      if (attempts.d === 1) throw Object.assign(new Error("Native thread/archive request timed out; its outcome may be unknown"), { code: "REQUEST_TIMEOUT" });
      return { status: "archived", revision: 3 };
    },
    "thread/read:c": () => ({ id: "c", revision: 1 }),
    "thread/read:d": () => ({ id: "d", revision: 3 }),
  });
  const first = await runBulkThreadAction({ entries, action: "archive", request, shouldStop: () => dead });
  // "a"/"b" succeeded before the socket died; "c" failed on a transport loss
  // and the walk stopped before "d" was attempted at all.
  assert.deepEqual(first.results.map(result => [result.id, result.kind]), [["a", "succeeded"], ["b", "succeeded"], ["c", "failed"]]);
  assert.equal(first.stopped, true);
  dead = false;
  const archiveCallsBefore = calls.filter(call => call.method === "thread/archive").length;
  const second = await retryBulkEntries({ previous: first.results, action: "archive", request });
  const archiveCallsAfter = calls.filter(call => call.method === "thread/archive").length;
  assert.deepEqual(second.results.map(result => [result.id, result.kind]), [["a", "succeeded"], ["b", "succeeded"], ["c", "succeeded"]]);
  assert.equal(archiveCallsAfter - archiveCallsBefore, 1, "retry dispatches only the unfinished rows");
  assert.equal(second.stopped, false);
});

test("an uncertain timeout row is retried with its fresh revision and is not re-sent once done", async () => {
  const previous: BulkEntryResult[] = [
    { id: "ok", title: "ok", revision: 1, kind: "succeeded", detail: "", retryable: false },
    { id: "maybe", title: "maybe", revision: 4, kind: "failed", detail: "request timed out", retryable: true },
  ];
  let retries = 0;
  const { calls, request } = fakeRpc({
    "thread/read:maybe": () => ({ id: "maybe", revision: 6 }),
    "thread/archive:maybe": () => {
      retries += 1;
      if (retries === 1) return { status: "archived", revision: 7 };
      throw new Error("must not dispatch a second time");
    },
  });
  const result = await retryBulkEntries({ previous, action: "archive", request });
  assert.deepEqual(result.results.map(entry => [entry.id, entry.kind]), [["ok", "succeeded"], ["maybe", "succeeded"]]);
  assert.deepEqual(calls.filter(call => call.method === "thread/archive").map(call => call.params.expectedRevision), [6]);
});

test("a running-turn refusal is a skipped row, not an edit conflict", async () => {
  const { request } = fakeRpc({
    "thread/archive:y": () => { throw rpcError(BULK_CONFLICT_CODE, "cannot archive a thread with a running turn"); },
    "thread/read:y": () => ({ id: "y", revision: 1 }),
  });
  const run = await runBulkThreadAction({ entries: [{ id: "y", title: "y", revision: 1 }], action: "archive", request });
  assert.equal(run.results[0].kind, "skipped");
  assert.equal(run.results[0].retryable, true);
});

test("explicit shouldStop leaves remaining rows out of the result instead of faking completion", async () => {
  const entries = ["a", "b", "c"].map(id => ({ id, title: id, revision: 1 }));
  const { request } = fakeRpc({ "thread/restore:a": succeedArchive("restore"), "thread/restore:b": succeedArchive("restore") });
  const result = await runBulkThreadAction({ entries, action: "restore", request, shouldStop: () => true });
  assert.deepEqual(result.results, []);
  assert.equal(result.stopped, true);
});

test("bulk restore round-trips archived rows through thread/unarchive", async () => {
  const threads = [row({ id: "r1", status: "archived" }), row({ id: "r2", status: "archived", revision: 9 })];
  const { calls, request } = fakeRpc({
    "thread/unarchive:r1": succeedArchive("restore"),
    "thread/unarchive:r2": succeedArchive("restore"),
  });
  const plan = planBulkRun(threads, new Set(["r1", "r2"]), "restore");
  const result = await runBulkThreadAction({ entries: plan.entries, action: "restore", request });
  assert.equal(result.results.every(entry => entry.kind === "succeeded"), true);
  assert.deepEqual(calls.map(call => [call.method, call.params.id, call.params.expectedRevision]),
    [["thread/unarchive", "r1", 1], ["thread/unarchive", "r2", 9]]);
});

test("a thread deleted between selection and retry is failed without retry", async () => {
  const previous: BulkEntryResult[] = [{ id: "gone", title: "gone", revision: 1, kind: "conflict", detail: "revision mismatch", retryable: true }];
  const { calls, request } = fakeRpc({
    "thread/read:gone": () => { throw rpcError(-32004, "thread not found"); },
  });
  const result = await retryBulkEntries({ previous, action: "archive", request });
  assert.equal(result.results[0].kind, "failed");
  assert.equal(result.results[0].retryable, false);
  assert.equal(calls.filter(call => call.method === "thread/archive").length, 0);
});

test("mergeBulkResults keeps the original order and replaces only retried rows", () => {
  const previous: BulkEntryResult[] = [
    { id: "a", title: "a", revision: 1, kind: "succeeded", detail: "", retryable: false },
    { id: "b", title: "b", revision: 1, kind: "failed", detail: "socket", retryable: true },
  ];
  const merged = mergeBulkResults(previous, [{ id: "b", title: "b", revision: 2, kind: "succeeded", detail: "", retryable: false }]);
  assert.deepEqual(merged.map(result => [result.id, result.kind]), [["a", "succeeded"], ["b", "succeeded"]]);
});

test("a transient refresh failure keeps the row retryable for recovery (CODEX-0030-B)", async () => {
  const previous: BulkEntryResult[] = [
    { id: "ok-row", title: "ok", revision: 1, kind: "succeeded", detail: "", retryable: false },
    { id: "lost", title: "lost", revision: 3, kind: "failed", detail: "connection lost", retryable: true },
  ];
  let online = false;
  const archiveCalls: unknown[] = [];
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === "thread/read") {
      if (!online) throw rpcError(-32040, "socket closed during refresh");
      return { id: params.id, revision: 5 } as T;
    }
    if (method === "thread/archive") {
      if (!online) throw new Error("must not dispatch while offline");
      archiveCalls.push(params);
      return { status: "archived", revision: 6 } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  // While offline the retry must NOT retire the row as "deleted": it stays
  // failed with a retryable chance, and no archive is dispatched.
  const offline = await retryBulkEntries({ previous, action: "archive", request });
  const lostRow = offline.results.find(result => result.id === "lost")!;
  assert.equal(lostRow.retryable, true, "a transient refresh failure never retires the row");
  assert.equal(lostRow.kind, "failed");
  assert.match(lostRow.detail, /socket closed/);
  assert.equal(archiveCalls.length, 0);
  assert.equal(offline.results.find(result => result.id === "ok-row")!.kind, "succeeded", "succeeded rows untouched");
  // After recovery the same row retries successfully with the fresh revision.
  online = true;
  const recovered = await retryBulkEntries({ previous: offline.results, action: "archive", request });
  assert.equal(recovered.results.find(result => result.id === "lost")!.kind, "succeeded");
  assert.equal(archiveCalls.length, 1);
  assert.equal((archiveCalls[0] as Record<string, unknown>).expectedRevision, 5, "retry uses the refreshed revision");
});

test("an abort during the refresh phase is reported as stopped, not silent completion", async () => {
  const previous: BulkEntryResult[] = [
    { id: "keep", title: "keep", revision: 1, kind: "succeeded", detail: "", retryable: false },
    { id: "pending", title: "pending", revision: 1, kind: "failed", detail: "socket", retryable: true },
  ];
  let dispatched = 0;
  const request = async <T,>(method: string): Promise<T> => {
    dispatched += 1;
    throw new Error("must not dispatch after abort");
  };
  const result = await retryBulkEntries({ previous, action: "archive", request, shouldStop: () => true });
  assert.equal(result.stopped, true, "refresh-phase abort surfaces as stopped");
  assert.equal(dispatched, 0);
  assert.equal(result.results.find(entry => entry.id === "pending")!.retryable, true, "pending row stays retryable");
  assert.equal(result.results.find(entry => entry.id === "keep")!.kind, "succeeded");
});

test("only a real daemon NotFound retires a retryable row", async () => {
  const previous: BulkEntryResult[] = [{ id: "gone", title: "gone", revision: 1, kind: "conflict", detail: "revision", retryable: true }];
  const { calls, request } = fakeRpc({
    "thread/read:gone": () => { throw rpcError(-32004, "thread not found"); },
  });
  const result = await retryBulkEntries({ previous, action: "archive", request });
  assert.equal(result.results[0].retryable, false);
  assert.match(result.results[0].detail, /任务不存在/);
  assert.equal(calls.filter(call => call.method === "thread/archive").length, 0);
});
