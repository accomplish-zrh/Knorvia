"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Flag, Loader2, Pause, Pencil, Play, Target } from "lucide-react";
import type { NativeGoal } from "@/lib/knorvia-native-types";
import type { ThreadSnapshot } from "@/lib/native-workbench-state";
import { goalStatusLabel } from "@/lib/native-goals";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { GoalAcceptanceDialog } from "./GoalAcceptanceDialog";
import { GoalEditor } from "./GoalsView";

export function ConversationGoal({ thread, children }: { thread: ThreadSnapshot; children: (goal: NativeGoal) => React.ReactNode }) {
  const { request, t, connection } = useWorkbench();
  const [goal, setGoal] = useState<NativeGoal>();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(false);
  const [acceptance, setAcceptance] = useState(false);
  const load = useCallback(async () => {
    const result = await request<NativeGoal>("goal/read", { id: thread.goalId });
    setGoal(result); setError("");
  }, [request, thread.goalId]);
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    const poll = async () => {
      try { const result = await request<NativeGoal>("goal/read", { id: thread.goalId }); if (!cancelled) { setGoal(result); setError(""); } }
      catch (caught) { if (!cancelled) setError(errorText(caught)); }
    };
    void poll();
    const timer = setInterval(() => { if (!document.hidden) void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [request, thread.goalId, connection]);
  const change = async (status: string) => {
    if (!goal || pending) return;
    setPending(true); setError("");
    try { await request("goal/update", { id: goal.id, revision: goal.revision, status }); await load(); }
    catch (caught) { setError(errorText(caught)); } finally { setPending(false); }
  };
  const terminal = goal && ["completed", "cancelled"].includes(goal.status);
  const status = goalStatusLabel(goal?.status ?? "active");
  return <>
    <section className="nw-conversation-goal" aria-label={t("对话目标", "Conversation goal")}>
      <div className="nw-conversation-goal-bar"><button className="nw-conversation-goal-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><Target size={16} /><span>{goal?.title ?? t("正在读取目标…", "Loading goal…")}</span>{goal && <small>{t(status.zh, status.en)}</small>}<ChevronDown size={14} /></button>
        {goal && !terminal && <div className="nw-conversation-goal-actions">{pending ? <Loader2 size={16} className="nw-spin" /> : goal.status === "active" ? <button className="nw-icon" onClick={() => void change("paused")} aria-label={t("暂停目标", "Pause goal")} title={thread.activeTurn ? t("暂停后续推进，当前轮仍可手动停止", "Pause future work; the current run can be stopped separately") : t("暂停目标", "Pause goal")}><Pause size={15} /></button> : <button className="nw-icon" onClick={() => void change("active")} aria-label={t("继续目标", "Resume goal")} title={t("继续目标", "Resume goal")}><Play size={15} /></button>}<button className="nw-icon" disabled={pending || Boolean(thread.activeTurn)} onClick={() => setAcceptance(true)} aria-label={t("核对目标结果", "Review goal results")} title={t("核对结果", "Review results")}><Check size={16} /></button></div>}
      </div>
      {error && <div role="alert" className="nw-inline-error">{error}<button className="nw-button nw-button-small" onClick={() => void load().catch(caught => setError(errorText(caught)))}>{t("重新读取", "Retry")}</button></div>}
      {expanded && goal && <div className="nw-conversation-goal-detail"><h3>{t("完成条件", "Completion criteria")}</h3><p>{goal.successCriteria}</p>{goal.constraints && <><h3>{t("约束", "Constraints")}</h3><p>{goal.constraints}</p></>}{goal.completionEvidence && <p className="nw-goal-evidence-note"><Check size={13} />{goal.completionEvidence.summary}</p>}<div>{!terminal && <button className="nw-button nw-button-small" disabled={pending} onClick={() => setEditor(true)}><Pencil size={13} />{t("编辑目标", "Edit goal")}</button>}{goal.status === "active" && goal.completionEvidence && <button className="nw-button nw-button-small" disabled={pending || Boolean(thread.activeTurn)} onClick={() => void change("completed")}><Flag size={13} />{t("标记目标完成", "Mark goal done")}</button>}<Link href="/workbench/goals">{t("所有目标记录", "All goal history")}</Link></div></div>}
    </section>
    {goal && children(goal)}
    {terminal && <Link className="nw-new-conversation" href="/workbench">{t("开始新对话", "Start a new conversation")}</Link>}
    {editor && goal && <GoalEditor goal={goal} close={() => setEditor(false)} saved={load} />}
    {acceptance && goal && <GoalAcceptanceDialog goal={goal} close={() => setAcceptance(false)} saved={load} />}
  </>;
}
