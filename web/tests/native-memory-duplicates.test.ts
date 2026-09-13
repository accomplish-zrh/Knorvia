import test from "node:test";
import assert from "node:assert/strict";
import {
  DUPLICATE_JACCARD_THRESHOLD,
  fetchAllMemoryRecords,
  findDuplicatePairs,
  mergeRequestForPair,
} from "../lib/native-memory-duplicates";
import type { MemoryRecord } from "../components/native/memory-types";

let sequence = 0;
function row(overrides: Partial<MemoryRecord> & { content: string }): MemoryRecord {
  sequence += 1;
  return {
    id: `m${String(sequence).padStart(4, "0")}`,
    revision: 1,
    scope: { owner: "local", workspace: "ws", bot: "bot-a", conversation: "g1" },
    kind: "fact",
    sourceRefs: [],
    createdAtMs: 1, validFromMs: 1, validToMs: null,
    status: "active", mergedInto: null, pinned: false,
    useCount: 0, lastUsedAtMs: null, recordedAtMs: 1,
    ...overrides,
  };
}

function fakeList(records: MemoryRecord[], pageSize: number, opts: { total?: number } = {}) {
  const calls: Record<string, unknown>[] = [];
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method !== "memory/list") throw new Error(`unexpected ${method}`);
    calls.push(params);
    const offset = (params.offset as number) ?? 0;
    const limit = (params.limit as number) ?? 100;
    const total = opts.total ?? records.length;
    return { records: records.slice(offset, offset + limit), total } as T;
  };
  return { calls, request };
}

const scope = { owner: "local", workspace: "ws", bot: "bot-a", conversation: "g1" };

test("discovery pages past the old 200-row cap and finds tail duplicates", async () => {
  const records: MemoryRecord[] = [];
  for (let index = 1; index <= 320; index += 1) {
    records.push(row({ id: `a${index}`, content: `普通记忆 ${index}` }));
  }
  // A duplicate pair that only exists beyond record 200.
  records.push(row({ id: "tail-1", content: "尾部分身密码是 lantern" }));
  records.push(row({ id: "tail-2", content: "尾部分身密码是 lantern！" }));
  const { calls, request } = fakeList([...records], 150);
  const result = await fetchAllMemoryRecords({ scope, request, limits: { pageSize: 150 } });
  assert.equal(result.truncated, false);
  assert.equal(result.records.length, 322);
  assert.equal(result.total, 322);
  assert.equal(result.pages, 3, "320 records at 150/page plus the tail page");
  assert.ok(calls.every(call => call.limit === 150));
  const pairs = findDuplicatePairs(result.records);
  const tailPair = pairs.find(pair => pair.a.id === "tail-1" || pair.b.id === "tail-1");
  assert.ok(tailPair, "the pair beyond row 200 is still discovered");
  assert.equal(tailPair!.similarity, 1, "normalization folds full-width punctuation");
});

test("a page that returns nothing while the total claims more fails the scan", async () => {
  const { request } = fakeList([row({ content: "仅有一条" })], 10, { total: 50 });
  await assert.rejects(
    fetchAllMemoryRecords({ scope, request, limits: { pageSize: 10 } }),
    /incomplete/,
  );
});

test("similarity is explainable: exact twins, fuzzy pairs above threshold, non-duplicates below", () => {
  const records = [
    row({ id: "e1", content: "Knorvia 的发布时间是 2026 年 9 月" }),
    row({ id: "e2", content: "knorvia 的发布时间是 2026 年 9 月！" }),
    row({ id: "f1", content: "项目使用 Rust 控制面和 Rust 存储" }),
    row({ id: "f2", content: "项目使用 Rust 控制面和 Rust 存储、网关" }),
    row({ id: "n1", content: "完全无关的话题：今天晚饭吃面" }),
  ];
  const pairs = findDuplicatePairs(records);
  const byIds = (pair: { a: MemoryRecord; b: MemoryRecord }) => [pair.a.id, pair.b.id].sort().join("~");
  const exact = pairs.find(pair => byIds(pair) === "e1~e2");
  assert.ok(exact, "normalized twins are exact");
  assert.equal(exact!.similarity, 1);
  const fuzzy = pairs.find(pair => byIds(pair) === "f1~f2");
  assert.ok(fuzzy, "rust trio pair is above the jaccard threshold");
  assert.equal(fuzzy!.exact, false);
  assert.ok(fuzzy!.similarity >= DUPLICATE_JACCARD_THRESHOLD);
  assert.ok(fuzzy!.sharedTerms.includes("rust"));
  assert.equal(pairs.some(pair => byIds(pair).includes("n1")), false, "unrelated records are not reported");
});

test("candidates never cross conversation scopes and skip forgotten/merged records", () => {
  const records = [
    row({ id: "g1a", content: "共享密语是 lantern" }),
    row({ id: "g1b", content: "共享密语是 lantern", scope: { owner: "local", workspace: "ws", bot: "bot-a", conversation: "g2" } }),
    row({ id: "g1c", content: "共享密语是 lantern", status: "forgotten" }),
    row({ id: "g1d", content: "共享密语是 lantern", status: "merged", mergedInto: "g1a" }),
  ];
  const pairs = findDuplicatePairs(records);
  assert.equal(pairs.length, 0, "cross-scope twins and inactive records are invisible to the scan");
});

test("merge requests carry both CAS revisions and refuse self-merge", () => {
  const loser = row({ id: "src", revision: 4, content: "loser content" });
  const keeper = row({ id: "dst", revision: 7, content: "keeper content" });
  assert.deepEqual(mergeRequestForPair(loser, keeper), {
    sourceId: "src", targetId: "dst", expectedRevision: 4, expectedTargetRevision: 7,
  });
  assert.throws(() => mergeRequestForPair(loser, loser), /itself/);
});

test("a repeated non-empty page marks the memory scan honestly truncated (CODEX-0215-B03)", async () => {
  const records = [row({ id: "1", content: "第一条" }), row({ id: "2", content: "第二条" })];
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method !== "memory/list") throw new Error(`unexpected ${method}`);
    const offset = (params.offset as number) ?? 0;
    // The server re-serves rows 1-2 for every window while claiming 4 total.
    return { records: records, total: 4 } as T;
  };
  const walk = await fetchAllMemoryRecords({ scope, request, limits: { pageSize: 2 } });
  assert.equal(walk.truncated, true, "drift must surface as truncated, not a full scan");
  assert.equal(walk.records.length, 2);
  assert.equal(walk.total, 4);
  assert.equal(walk.duplicateIds, 2);
});
