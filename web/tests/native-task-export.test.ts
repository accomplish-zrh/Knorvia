import test from "node:test";
import assert from "node:assert/strict";
import {
  composeTaskExportJson,
  composeTaskExportMarkdown,
  exportTaskHistory,
  redactExportItem,
  stripSecretFields,
  type TaskExportResult,
} from "../lib/native-task-export";
import type { Item, ThreadSnapshot, Turn } from "../lib/native-workbench-state";

type ArtifactRow = { id: string; title: string; type: string };

/**
 * Fake daemon thread/read mirroring the real contract: one head read returns
 * tail pages of BOTH items and turns plus cursors; `beforeItemSeq` /
 * `beforeTurnId` fetch older pages. Pages are oldest-first inside, cursor =
 * oldest seq/id of the page, `hasMore*` until the chain end.
 */
function fakeDaemon({ itemCount, turnCount = 4, itemPageSize = 300, turnPageSize = 300, artifacts = [] as ArtifactRow[], itemFactory }:
  { itemCount: number; turnCount?: number; itemPageSize?: number; turnPageSize?: number; artifacts?: ArtifactRow[]; itemFactory?: (seq: number) => Item }) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const defaultItem = (seq: number): Item => ({
    id: `i${seq}`, threadId: "thr", turnId: `t${Math.ceil(seq / 10)}`, kind: "agentMessage", status: "completed", seq,
    payload: { text: `item ${seq}` },
  });
  const makeItem = itemFactory ?? defaultItem;
  const makeTurn = (n: number): Turn => ({ id: `t${n}`, threadId: "thr", status: "completed", createdAt: `2026-01-01T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00Z`, completedAt: null });
  const meta = { id: "thr", title: "导出样例 任务", workspaceId: "ws1", status: "active", revision: 3, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
  const itemTail = (before: number | undefined) => {
    const newest = before === undefined ? itemCount : before - 1;
    const oldest = Math.max(1, newest - itemPageSize + 1);
    const page: Item[] = [];
    for (let seq = oldest; seq <= newest; seq += 1) page.push(makeItem(seq));
    const hasMore = oldest > 1;
    return { page, nextCursor: hasMore ? oldest : null, hasMore };
  };
  const turnTail = (before: string | undefined) => {
    const turnNumber = (turn: Turn) => Number(turn.id.slice(1));
    const newest = before === undefined ? turnCount : turnNumber({ id: before } as Turn) - 1;
    const oldest = Math.max(1, newest - turnPageSize + 1);
    const page: Turn[] = [];
    for (let n = oldest; n <= newest; n += 1) page.push(makeTurn(n));
    const hasMore = oldest > 1;
    return { page, nextCursor: hasMore ? `t${oldest}` : null, hasMore };
  };
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params });
    if (method !== "thread/read") {
      if (method === "artifact/list") {
        if (params.workspaceId !== "ws1") throw new Error(`artifact/list must stay inside the task workspace, got ${String(params.workspaceId)}`);
        return artifacts.slice() as T;
      }
      throw new Error(`unexpected ${method}`);
    }
    const beforeItem = params.beforeItemSeq as number | undefined;
    const beforeTurn = params.beforeTurnId as string | undefined;
    if (beforeItem !== undefined) {
      const { page, nextCursor, hasMore } = itemTail(beforeItem);
      return { ...meta, items: page, itemsNextCursor: nextCursor, hasMoreItems: hasMore, turns: [], turnsNextCursor: null, hasMoreTurns: false } as T;
    }
    if (beforeTurn !== undefined) {
      const { page, nextCursor, hasMore } = turnTail(beforeTurn);
      return { ...meta, items: [], itemsNextCursor: null, hasMoreItems: false, turns: page, turnsNextCursor: nextCursor, hasMoreTurns: hasMore } as T;
    }
    const items = itemTail(undefined);
    const turns = turnTail(undefined);
    return { ...meta,
      items: items.page, itemsNextCursor: items.nextCursor, hasMoreItems: items.hasMore,
      turns: turns.page, turnsNextCursor: turns.nextCursor, hasMoreTurns: turns.hasMore,
    } as T;
  };
  return { calls, request };
}

test("a 950-item timeline walks every page, dedups by id, and completes", async () => {
  const { calls, request } = fakeDaemon({ itemCount: 950, itemPageSize: 300, turnCount: 95, turnPageSize: 300 });
  const progress: unknown[] = [];
  const result = await exportTaskHistory({ threadId: "thr", request, onProgress: entry => progress.push(entry) });
  assert.equal(result.status, "complete", result.reason);
  assert.equal(result.items.length, 950);
  assert.equal(new Set(result.items.map(item => item.id)).size, 950);
  assert.equal(result.stats.itemPages, 4);
  assert.equal(result.completeness.itemsComplete, true);
  assert.equal(result.cutoff.newestItemSeq, 950);
  assert.equal(result.items[0].seq, 1);
  assert.equal(result.items.at(-1)!.seq, 950);
  const itemCursors = calls.filter(call => call.method === "thread/read" && typeof call.params.beforeItemSeq === "number")
    .map(call => call.params.beforeItemSeq);
  assert.deepEqual(itemCursors, [651, 351, 51], "each older page uses the previous page's oldest seq");
  assert.equal(result.turns.length, 95);
  assert.equal(result.stats.turnPages, 1);
  assert.ok(progress.length >= 4);
});

test("multi-page turns are traversed through beforeTurnId without duplicates", async () => {
  const { calls, request } = fakeDaemon({ itemCount: 40, turnCount: 700, turnPageSize: 300 });
  const result = await exportTaskHistory({ threadId: "thr", request });
  assert.equal(result.status, "complete", result.reason);
  assert.equal(result.turns.length, 700);
  assert.equal(new Set(result.turns.map(turn => turn.id)).size, 700);
  assert.equal(result.stats.turnPages, 3);
  assert.equal(result.completeness.turnsComplete, true);
  const turnCursors = calls.filter(call => typeof call.params.beforeTurnId === "string").map(call => call.params.beforeTurnId);
  assert.deepEqual(turnCursors, ["t401", "t101"]);
});

test("chinese text, code, and attachment names survive the markdown export", async () => {
  const { request } = fakeDaemon({ itemCount: 3, itemFactory: seq => seq === 3 ? {
    id: "i3", threadId: "thr", turnId: "t1", kind: "userMessage", status: "completed", seq: 3,
    payload: { text: "# 中文标题\n```js\nconst 附加 = 1;\n```", attachments: [{ name: "报告.pdf" }, { name: "data.csv" }] },
  } : {
    id: `i${seq}`, threadId: "thr", turnId: "t1", kind: "agentMessage", status: "completed", seq,
    payload: { text: `item ${seq}` },
  } });
  const result = await exportTaskHistory({ threadId: "thr", request });
  const markdown = composeTaskExportMarkdown(result);
  assert.match(markdown, /# 中文标题/);
  assert.match(markdown, /const 附加 = 1;/);
  assert.match(markdown, /报告\.pdf/);
  assert.match(markdown, /data\.csv/);
  assert.equal(result.attachments.length, 2);
  assert.equal(result.status, "complete");
});

test("a repeated cursor fails the export instead of looping", async () => {
  let reads = 0;
  const request = async <T,>(method: string): Promise<T> => {
    if (method !== "thread/read") return [] as T;
    reads += 1;
    return {
      id: "thr", title: "t", workspaceId: "ws1", status: "active", revision: 1, createdAt: "c", updatedAt: "u",
      items: [
        { id: "i2", threadId: "thr", turnId: "t1", kind: "agentMessage", status: "completed", seq: 2, payload: {} },
        { id: "i1", threadId: "thr", turnId: "t1", kind: "agentMessage", status: "completed", seq: 1, payload: {} },
      ],
      itemsNextCursor: 1, hasMoreItems: true, turns: [], turnsNextCursor: null, hasMoreTurns: false,
    } as T;
  };
  const result = await exportTaskHistory({ threadId: "thr", request });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /cursor did not advance/);
  assert.ok(reads <= 3, `must stop quickly, made ${reads} reads`);
});

test("messages that arrive during the export are outside the fixed cutoff", async () => {
  // Live store: 950 items at export start; a durable Item (seq 951) lands
  // right after the head page is read.
  const itemCount = { value: 950 };
  const reads = 0;
  void reads;
  const makeItem = (seq: number): Item => ({
    id: `i${seq}`, threadId: "thr", turnId: `t${Math.ceil(seq / 10)}`, kind: "agentMessage", status: "completed", seq,
    payload: { text: `item ${seq}` },
  });
  const meta = { id: "thr", title: "t", workspaceId: "ws1", status: "active", revision: 1, createdAt: "c", updatedAt: "u" };
  const page = (before: number | undefined, size = 500) => {
    const newest = before === undefined ? itemCount.value : before - 1;
    const oldest = Math.max(1, newest - size + 1);
    const items: Item[] = [];
    for (let seq = oldest; seq <= newest; seq += 1) items.push(makeItem(seq));
    const hasMore = oldest > 1;
    return { items, nextCursor: hasMore ? oldest : null, hasMore };
  };
  const headsAfterGrowth: number[] = [];
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method !== "thread/read") return [] as T;
    const before = params.beforeItemSeq as number | undefined;
    if (before !== undefined) {
      const tail = page(before);
      return { ...meta, items: tail.items, itemsNextCursor: tail.nextCursor, hasMoreItems: tail.hasMore, turns: [], turnsNextCursor: null, hasMoreTurns: false } as T;
    }
    const head = page(undefined);
    if (itemCount.value === 950) itemCount.value = 951; // durable append mid-export
    else headsAfterGrowth.push(head.items.length);
    return { ...meta, items: head.items, itemsNextCursor: head.nextCursor, hasMoreItems: head.hasMore, turns: [], turnsNextCursor: null, hasMoreTurns: false } as T;
  };
  const result = await exportTaskHistory({ threadId: "thr", request });
  assert.equal(result.status, "complete");
  assert.equal(result.cutoff.newestItemSeq, 950, "cutoff frozen at the head page");
  assert.equal(Math.max(...result.items.map(item => item.seq)), 950);
  assert.ok(!result.items.some(item => item.seq === 951));
  // A fresh head read proves seq 951 really existed in the store afterwards;
  // the export simply never chased it.
  const fresh = await request<ThreadSnapshot>("thread/read", { id: "thr" });
  assert.ok(fresh.items.some(item => item.seq === 951));
});

test("cancellation keeps the partial walk explicitly incomplete", async () => {
  const { request } = fakeDaemon({ itemCount: 900, itemPageSize: 300 });
  let checks = 0;
  const result = await exportTaskHistory({ threadId: "thr", request, shouldContinue: () => (checks += 1) <= 1 });
  assert.equal(result.status, "cancelled");
  assert.equal(result.completeness.itemsComplete, false);
  assert.equal(result.items.length, 600, "pages already fetched stay in the cancelled export (head + one older page)");
  const markdown = composeTaskExportMarkdown(result);
  assert.match(markdown, /Cancelled export/);
  assert.match(markdown, /not the full task history/);
});

test("raw tool payloads are excluded by default; enabling embeds them with secrets stripped", () => {
  const toolItem: Item = { id: "i1", threadId: "thr", turnId: "t1", kind: "tool.write", status: "waiting_approval", seq: 1,
    payload: { action: "fs.write", target: { path: "/tmp/a", api_key: "sk-live-123", token: "tok" } } };
  const defaulted = redactExportItem(toolItem, false);
  assert.equal((defaulted.payload as Record<string, unknown>).redacted, true);
  assert.equal(JSON.stringify(defaulted).includes("sk-live-123"), false);
  const embedded = redactExportItem(toolItem, true);
  const embeddedPayload = embedded.payload as { target: Record<string, unknown> };
  assert.equal(embeddedPayload.target.path, "/tmp/a");
  assert.equal(embeddedPayload.target.api_key, undefined);
  assert.equal(embeddedPayload.target.token, undefined);
  assert.deepEqual(stripSecretFields({ nested: { apiKey: "x", keep: 1 } }), { nested: { keep: 1 } });
});

test("narrative kinds keep their text by default and error items keep category/message", () => {
  const message = redactExportItem({ id: "i1", threadId: "thr", turnId: "t1", kind: "userMessage", status: "completed", seq: 1, payload: { text: "正文", authorization: "Bearer x" } }, false);
  assert.equal((message.payload as { text: string }).text, "正文");
  assert.equal((message.payload as { authorization?: string }).authorization, undefined);
  const failure = redactExportItem({ id: "i2", threadId: "thr", turnId: "t1", kind: "error", status: "failed", seq: 2, payload: { category: "Conflict", message: "boom" } }, false);
  assert.deepEqual(failure.payload, { category: "Conflict", message: "boom" });
});

test("artifact references stay inside the task workspace and report how they matched", async () => {
  const { calls, request } = fakeDaemon({ itemCount: 3, artifacts: [
    { id: "a1", title: "导出样例 任务", type: "text/markdown" },
    { id: "a2", title: "无关成果", type: "text/markdown" },
  ] });
  const patched = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const snapshot = await request<ThreadSnapshot>(method, params);
    if (method === "thread/read" && params.beforeItemSeq === undefined && params.beforeTurnId === undefined) {
      return { ...snapshot, items: snapshot.items.map((entry, index) => index === 0 ? {
        ...entry, payload: { artifact: { id: "a3", title: "条目内成果", type: "image/svg" } },
      } : entry) } as T;
    }
    return snapshot as T;
  };
  const result = await exportTaskHistory({ threadId: "thr", request: patched });
  // References come ONLY from verifiable in-item payload references.
  assert.deepEqual(result.artifactRefs.map(ref => [ref.id, ref.matchedBy]), [["a3", "payload"]]);
  // Same-title outputs of OTHER tasks are unverified candidates, never refs.
  assert.deepEqual(result.unverifiedTitleMatches.map(ref => ref.id), ["a1"]);
  for (const call of calls.filter(entry => entry.method === "artifact/list")) {
    assert.equal(call.params.workspaceId, "ws1", "never queries another project's outputs");
  }
  assert.equal(result.artifactRefs.some(ref => ref.id === "a2"), false);
});

test("cancellation during the references phase is honoured, not reported complete (CODEX-0030-B02)", async () => {
  const { request } = fakeDaemon({ itemCount: 3, artifacts: [{ id: "a1", title: "导出样例 任务", type: "text/markdown" }] });
  let keepGoing = true;
  const wrapped = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === "artifact/list") { keepGoing = false; return [{ id: "a1", title: "导出样例 任务", type: "text/markdown" }] as T; }
    return request<T>(method, params);
  };
  const result = await exportTaskHistory({ threadId: "thr", request: wrapped, shouldContinue: () => keepGoing });
  assert.equal(result.status, "cancelled", "a cancelled export is never labelled complete");
  assert.equal(result.artifactRefs.length, 0);
  assert.equal(result.completeness.itemsComplete, false);
});

test("a cancelled first-page walk keeps already-read items in the markdown output", async () => {
  const { request } = fakeDaemon({ itemCount: 900, itemPageSize: 300 });
  let checks = 0;
  const result = await exportTaskHistory({ threadId: "thr", request, shouldContinue: () => (checks += 1) <= 1 });
  assert.equal(result.status, "cancelled");
  assert.equal(result.items.length, 600);
  // Every read item survives into the markdown, even with turns=[] and
  // items whose turns were never walked.
  const markdown = composeTaskExportMarkdown(result);
  assert.ok(markdown.includes("Items without an exported turn (600)"), "orphan items are rendered");
  assert.ok(markdown.includes("item 301"), "first read item is kept");
  assert.ok(markdown.includes("item 900"), "newest read item is kept");
  assert.ok(markdown.includes("### Turn `t1`") === false, "unwalked turns are not fabricated");
});

test("a bounded walk reports incomplete and every rendering refuses to claim fullness", async () => {
  const { request } = fakeDaemon({ itemCount: 2000, itemPageSize: 300 });
  const result = await exportTaskHistory({ threadId: "thr", request, limits: { itemPages: 2 } });
  assert.equal(result.status, "incomplete");
  assert.equal(result.completeness.itemsComplete, false);
  assert.equal(result.completeness.bounded, true);
  assert.match(result.reason, /safety bound/);
  const markdown = composeTaskExportMarkdown(result);
  assert.match(markdown, /Incomplete export/);
  const json = JSON.parse(composeTaskExportJson(result)) as TaskExportResult;
  assert.equal(json.status, "incomplete");
  assert.equal(json.completeness.itemsComplete, false);
});

test("a complete export renders a full markdown timeline ordered by turn", async () => {
  const { request } = fakeDaemon({ itemCount: 25, turnCount: 3 });
  const result = await exportTaskHistory({ threadId: "thr", request });
  const markdown = composeTaskExportMarkdown(result);
  assert.match(markdown, /# 导出样例 任务/);
  assert.match(markdown, /Coverage: 25 items across 3 turns/);
  assert.match(markdown, /### Turn `t1` — completed/);
  assert.equal(markdown.includes("⚠️"), false);
  const json = JSON.parse(composeTaskExportJson(result)) as { format: string; status: string };
  assert.equal(json.format, "knorvia-task-export");
  assert.equal(json.status, "complete");
});
