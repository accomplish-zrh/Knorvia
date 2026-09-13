import { taskStatus, type Thread } from "@/lib/native-workbench-state";

/**
 * Cross-project attention entry (B05).
 *
 * Counts and lists derive ONLY from the authoritative thread index (merged
 * daemon snapshots). Streaming text never becomes status, archived tasks are
 * never counted, and an incomplete index is surfaced instead of claiming a
 * global zero.
 */
export type TaskAttentionCounts = { approval: number; input: number; running: number; total: number };

export type TaskAttentionItem = {
  id: string;
  title: string;
  workspaceId: string;
  status: "approval" | "input" | "running";
  updatedAt: string;
};

const ATTENTION_STATUSES = ["approval", "input", "running"] as const;
const STATUS_ORDER: Record<TaskAttentionItem["status"], number> = { approval: 0, input: 1, running: 2 };

export function collectTaskAttention(threads: Thread[]): { counts: TaskAttentionCounts; items: TaskAttentionItem[] } {
  const items: TaskAttentionItem[] = [];
  const counts: TaskAttentionCounts = { approval: 0, input: 0, running: 0, total: 0 };
  for (const thread of threads) {
    if (thread.status === "archived") continue;
    const status = taskStatus(thread);
    if (!(ATTENTION_STATUSES as readonly string[]).includes(status)) continue;
    counts[status as TaskAttentionItem["status"]] += 1;
    counts.total += 1;
    items.push({ id: thread.id, title: thread.title, workspaceId: thread.workspaceId, status: status as TaskAttentionItem["status"], updatedAt: thread.updatedAt });
  }
  items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  return { counts, items };
}

/** Display bound for the popover; counts stay complete above it. */
export const ATTENTION_LIST_LIMIT = 20;

export function attentionLabel(counts: TaskAttentionCounts, t: (zh: string, en: string) => string): string {
  if (counts.total === 0) return t("没有等待你的任务", "Nothing is waiting for you");
  const parts: string[] = [];
  if (counts.approval) parts.push(t(`${counts.approval} 项待确认`, `${counts.approval} need approval`));
  if (counts.input) parts.push(t(`${counts.input} 项待补充`, `${counts.input} need input`));
  if (counts.running) parts.push(t(`${counts.running} 项进行中`, `${counts.running} running`));
  return parts.join(t("，", ", "));
}
