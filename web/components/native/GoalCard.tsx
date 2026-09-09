"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, ChevronDown, CircleDashed, Flag, Folder, Loader2, Pause, Pencil, Play, Target } from "lucide-react";
import type { NativeGoal, NativeGoalExecution } from "@/lib/knorvia-native-types";
import { goalActions, goalStatusLabel } from "@/lib/native-goals";
import { useWorkbench } from "./NativeWorkbenchProvider";
import { StatusLabel } from "./WorkbenchShell";

export function GoalCard({ goal, summary, project, checkpointTime, pending, read, run, review, checkpoint, update, edit }: {
  goal: NativeGoal; summary?: NativeGoalExecution; project: string; checkpointTime: string; pending: string;
  read: () => Promise<void>; run: () => void; review: () => void; checkpoint: () => void;
  update: (status: string) => void; edit: () => void;
}) {
  const { t } = useWorkbench();
  const [expanded, setExpanded] = useState(false);
  const [reading, setReading] = useState(false);
  const terminal = ["completed", "cancelled"].includes(goal.status);
  const label = goalStatusLabel(goal.status);
  const actions = goalActions(goal.status);
  const toggle = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true); setReading(true);
    try { await read(); } finally { setReading(false); }
  };
  return <article className="nw-goal-card" data-status={goal.status} aria-label={goal.title}>
    <header className="nw-goal-heading"><span className="nw-goal-icon"><Target size={21} /></span><div><span className="nw-goal-project"><Folder size={12} />{project}</span><h2>{goal.title}</h2></div><span className="nw-goal-state" data-status={goal.status}>{t(label.zh, label.en)}</span></header>
    <div className="nw-goal-body">
      <div className="nw-goal-criteria"><h3>{t("怎样算完成", "Done when")}</h3><p>{goal.successCriteria || t("补充可核对的完成条件，再开始推进。", "Add checkable completion criteria before you begin.")}</p></div>
      {goal.constraints && <details className="nw-goal-constraints"><summary>{t("查看约束", "View constraints")}</summary><p>{goal.constraints}</p></details>}
      {goal.completionEvidence && <div className="nw-goal-findings"><Check size={15} /><div><h3>{t("已记录验收", "Acceptance recorded")}</h3><p>{goal.completionEvidence.summary}</p></div></div>}
      {!terminal && <div className="nw-goal-next"><div><h3>{t("下一步", "Next action")}</h3><p>{goal.nextAction || t("写下一个具体动作，让目标继续推进。", "Write a specific next action to move this goal forward.")}</p></div>{goal.status === "active" ? <button className="nw-button nw-button-primary" disabled={Boolean(pending) || !goal.nextAction?.trim() || !goal.successCriteria?.trim()} onClick={run}><Play size={14} />{t("执行下一步", "Run next action")}</button> : <button className="nw-button nw-button-primary" disabled={Boolean(pending)} onClick={() => update("active")}><Play size={14} />{t("继续推进", "Resume")}</button>}</div>}
    </div>
    <footer className="nw-goal-footer"><span className="nw-goal-checkpoint">{pending === goal.id ? <Loader2 size={13} className="nw-spin" /> : <CircleDashed size={13} />}{goal.lastCheckpointAt ? `${t("检查点", "Checkpoint")} · ${checkpointTime}` : t("尚未记录检查点", "No checkpoint yet")}</span>{!terminal && <div className="nw-goal-actions">
      <button className="nw-button nw-button-small" disabled={Boolean(pending)} onClick={review}><Check size={14} />{t("核对结果", "Review results")}</button>
      {goal.status === "active" && actions.includes("complete") && goal.completionEvidence && <button className="nw-button nw-button-small" disabled={Boolean(pending)} onClick={() => update("completed")}><Flag size={14} />{t("标记完成", "Mark done")}</button>}
      <button className="nw-icon" disabled={Boolean(pending)} onClick={checkpoint} aria-label={`${t("记录检查点", "Record checkpoint")}: ${goal.title}`} title={t("记录检查点", "Record checkpoint")}><CircleDashed size={16} /></button>
      {actions.includes("pause") && <button className="nw-icon" disabled={Boolean(pending)} onClick={() => update("paused")} aria-label={`${t("暂停", "Pause")}: ${goal.title}`} title={t("暂停", "Pause")}><Pause size={16} /></button>}
      <button className="nw-icon" disabled={Boolean(pending)} onClick={edit} aria-label={`${t("编辑", "Edit")}: ${goal.title}`} title={t("编辑目标", "Edit goal")}><Pencil size={15} /></button>
    </div>}</footer>
    <div className="nw-goal-history"><button className="nw-goal-history-toggle" aria-expanded={expanded} disabled={reading} onClick={() => void toggle()}><ChevronDown size={14} />{t("相关任务", "Related tasks")}{summary && <span>{t(`${summary.completed}/${summary.total} 已完成`, `${summary.completed}/${summary.total} completed`)}</span>}{reading && <Loader2 size={13} className="nw-spin" />}</button>{expanded && !reading && <div className="nw-goal-task-links">{summary?.threads.length ? summary.threads.slice(-5).map(({ thread, lastTurn }) => <Link href={`/workbench/task/${encodeURIComponent(thread.id)}`} key={thread.id}><span>{thread.title}</span><StatusLabel status={lastTurn?.status ?? "ready"} /></Link>) : <p>{t("还没有相关任务。执行下一步后，进展会记录在这里。", "No related tasks yet. Run the next action to start recording progress here.")}</p>}</div>}</div>
  </article>;
}
