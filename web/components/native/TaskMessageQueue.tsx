"use client";
import { useRef, useState } from "react";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { queueHasPending, type MessageQueue } from "@/lib/native-message-queue";

export function TaskMessageQueue({ queue, error, refresh, goal }: { queue?: MessageQueue; error?: string; refresh: () => Promise<void>; goal: boolean }) {
  const { request, t, connection } = useWorkbench();
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const inFlight = useRef(false);
  const action = async (name: "cancel" | "pause" | "resume", messageId?: string) => {
    if (!queue || inFlight.current) return;
    inFlight.current = true; setBusy(true); setOperationError("");
    try { await request(`turnQueue/${name}`, { threadId: queue.threadId, revision: queue.revision, ...(messageId ? { messageId } : {}), idempotencyKey: crypto.randomUUID() }); }
    catch (cause) { setOperationError(cause instanceof Error ? cause.message : String(cause)); }
    finally { await refresh(); inFlight.current = false; setBusy(false); }
  };
  if (!queue && !error) return null;
  if (!queueHasPending(queue) && !error && !operationError && !queue?.paused) return null;
  const labels: Record<string, string> = { queued: t("已排队", "Queued"), dispatching: t("正在发送", "Sending"), needs_check: t("送达待核对", "Delivery needs checking"), delivered: t("已送达", "Delivered"), cancelled: t("已取消", "Cancelled"), failed: t("发送失败", "Failed") };
  return <section className="nw-message-queue" aria-label={t("待发消息", "Queued messages")}>
    <div><strong>{t("待发消息", "Queued messages")}</strong>{queue && <button type="button" className="nw-button nw-button-small" disabled={busy || connection !== "connected"} onClick={() => void action(queue.paused ? "resume" : "pause")}>{queue.paused ? t("继续队列", "Continue queue") : t("暂停队列", "Pause queue")}</button>}</div>
    <p role="status">{queue?.paused ? t("队列已暂停，消息已保留。", "Queue paused; messages are kept.") : goal ? t("等待当前目标运行完整结束后按顺序发送，不打断目标续轮。", "Messages wait for the current Goal run to finish, including its automatic rounds.") : t("本轮正常结束后按顺序发送。失败或停止后会暂停。", "Messages send in order after normal completion. Failure or Stop pauses the queue.")}</p>
    {queue?.reason && <p>{queue.reason}</p>}
    {(error || operationError) && <p role="alert">{error || operationError}</p>}
    <ol>{queue?.items.filter(row => !["delivered", "cancelled"].includes(row.status)).map(row => <li key={row.id}><span>{labels[row.status] || row.status}</span><pre style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>{row.input}</pre>{row.error && <p role="alert">{row.error}</p>}<button type="button" className="nw-button nw-button-small" disabled={busy || row.status !== "queued" || connection !== "connected"} onClick={() => void action("cancel", row.id)}>{t("取消这条", "Cancel message")}</button></li>)}</ol>
  </section>;
}
