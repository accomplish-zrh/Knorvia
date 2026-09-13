"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type QueuedMessage = { id: string; sequence: number; input: string; status: "queued" | "dispatching" | "needs_check" | "delivered" | "cancelled" | "failed"; turnId?: string | null; error?: string | null };
export type MessageQueue = { threadId: string; workspaceId: string; revision: number; paused: boolean; reason?: string | null; afterExecutionId?: string | null; items: QueuedMessage[] };
type Request = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
export const queueHasPending = (queue?: MessageQueue | null) => Boolean(queue?.items.some(row => ["queued", "dispatching", "needs_check"].includes(row.status)));

/** Observation only: the native control owner dispatches even with no renderer. */
export function useMessageQueue(threadId: string | undefined, connected: boolean, request: Request) {
  const [state, setState] = useState<{ id?: string; queue?: MessageQueue; error?: string }>({});
  const generation = useRef(0);
  const active = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    if (!threadId || !connected) return;
    if (active.current) return active.current;
    const token = generation.current;
    const work = (async () => {
      try {
        const queue = await request<MessageQueue>("turnQueue/read", { threadId });
        if (token === generation.current && queue.threadId === threadId) setState({ id: threadId, queue });
      } catch (error) {
        if (token === generation.current) setState(current => ({ ...current, id: threadId, error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    active.current = work;
    try { await work; } finally { if (active.current === work) active.current = null; }
  }, [threadId, connected, request]);
  useEffect(() => {
    generation.current += 1; active.current = null; setState({});
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 1000); };
    void poll();
    return () => { stopped = true; generation.current += 1; clearTimeout(timer); active.current = null; };
  }, [refresh]);
  return { queue: state.id === threadId ? state.queue : undefined, queueError: state.id === threadId ? state.error : undefined, refreshQueue: refresh };
}

/** Per-window durable retry intent. Separate records prevent one queued send
 * from replacing another's identity. Successful sends release only their ID. */
export function queueAttempt(storage: Storage | undefined, scope: string, body: Record<string, unknown>) {
  const fingerprint = JSON.stringify(body);
  const prefix = `${scope}:queued-attempt:`;
  if (!storage) throw new Error("Queue retry storage is unavailable. Your draft is kept.");
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const existing = JSON.parse(storage.getItem(key) || "null");
    if (existing?.fingerprint === fingerprint && typeof existing.id === "string") return existing as { id: string; fingerprint: string; body: Record<string, unknown> };
  }
  const attempt = { id: crypto.randomUUID(), fingerprint, body };
  storage.setItem(prefix + attempt.id, JSON.stringify(attempt));
  return attempt;
}
export function clearQueueAttempt(storage: Storage | undefined, scope: string, id: string) { try { storage?.removeItem(`${scope}:queued-attempt:${id}`); } catch { /* replaying the same admitted identity remains safe */ } }
