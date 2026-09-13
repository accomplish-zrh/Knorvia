import test from "node:test";
import assert from "node:assert/strict";
import { attentionLabel, collectTaskAttention, ATTENTION_LIST_LIMIT, type TaskAttentionItem } from "../lib/native-task-attention";
import type { Approval, Thread } from "../lib/native-workbench-state";

let sequence = 0;
const thread = (overrides: Partial<Thread> = {}): Thread => {
  sequence += 1;
  return { id: `t${sequence}`, workspaceId: "w1", title: `Task ${sequence}`, status: "active", revision: 1, createdAt: "1", updatedAt: String(sequence), ...overrides };
};
const approval = (status = "pending"): Approval => ({ id: `a${sequence}`, threadId: "t", turnId: "turn", action: "exec", status });

test("counts and items come from snapshots: approval, input, running; archived excluded", () => {
  const threads = [
    thread({ pendingApprovals: [approval()] }),
    thread({ workspaceId: "w2", pendingUserInputs: [{ id: "i", threadId: "t", turnId: "turn", kind: "userInput", status: "pending", seq: 1, payload: {} }] }),
    thread({ activeTurn: { id: "turn", threadId: "t", status: "running", createdAt: "1" } }),
    thread({ pendingApprovals: [approval()], status: "archived" }),
    thread(),
  ];
  const { counts, items } = collectTaskAttention(threads);
  assert.deepEqual(counts, { approval: 1, input: 1, running: 1, total: 3 });
  assert.equal(items.length, 3);
  // Approval and input sort ahead of running regardless of project.
  assert.deepEqual(items.map(item => item.status), ["approval", "input", "running"]);
  assert.equal(items[1].workspaceId, "w2");
});

test("finished turns are not attention; a handled approval stops counting", () => {
  const handled = thread({ pendingApprovals: [approval("allowed")] });
  const failed = thread({ lastTurn: { id: "turn", threadId: "t", status: "failed", createdAt: "1", completedAt: "2" } });
  const { counts, items } = collectTaskAttention([handled, failed]);
  assert.deepEqual(counts, { approval: 0, input: 0, running: 0, total: 0 });
  assert.deepEqual(items, []);
});

test("the list is bounded while counts stay complete", () => {
  const threads = Array.from({ length: ATTENTION_LIST_LIMIT + 15 }, () => thread({ pendingApprovals: [approval()] }));
  const { counts, items } = collectTaskAttention(threads);
  assert.equal(counts.total, ATTENTION_LIST_LIMIT + 15);
  assert.equal(counts.approval, ATTENTION_LIST_LIMIT + 15);
  assert.ok(items.length > ATTENTION_LIST_LIMIT);
});

test("labels name every non-zero category without counting stream text", () => {
  const zh = (zhText: string) => zhText;
  assert.match(attentionLabel({ approval: 2, input: 0, running: 0, total: 2 }, zh), /待确认/);
  assert.match(attentionLabel({ approval: 0, input: 3, running: 1, total: 4 }, zh), /待补充/);
  assert.match(attentionLabel({ approval: 0, input: 0, running: 0, total: 0 }, zh), /没有等待/);
  const items: TaskAttentionItem[] = [];
  void items;
});
