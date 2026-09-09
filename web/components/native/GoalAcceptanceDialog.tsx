"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import type { NativeGoal, NativeGoalExecution, NativeItem, NativeTurn } from "@/lib/knorvia-native-types";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal } from "./WorkbenchShell";

type EvidenceOption = { threadId: string; title: string; turnId: string; item: NativeItem };

export function GoalAcceptanceDialog({ goal, close, saved }: {
  goal: NativeGoal; close: () => void; saved: () => Promise<void>;
}) {
  const { request, t } = useWorkbench();
  const [current, setCurrent] = useState(goal);
  const [options, setOptions] = useState<EvidenceOption[]>([]);
  const [selection, setSelection] = useState("");
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await request<NativeGoal & { execution: NativeGoalExecution }>("goal/read", { id: goal.id });
        const results: EvidenceOption[] = [];
        for (const entry of snapshot.execution.threads.filter(entry => entry.lastTurn?.status === "completed").slice(-50)) {
          const turn = await request<NativeTurn>("turn/read", { id: entry.lastTurn!.id });
          for (const item of turn.items ?? []) {
            if (item.status === "completed" && item.kind === "agentMessage") {
              results.push({ threadId: entry.thread.id, title: entry.thread.title, turnId: turn.id, item });
            }
          }
        }
        if (!cancelled) { setCurrent(snapshot); setOptions(results); setSelection(results.at(-1)?.item.id ?? ""); }
      } catch (caught) { if (!cancelled) setError(errorText(caught)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [request, goal.id]);
  const selected = options.find(option => option.item.id === selection);
  return <Modal title={t("核对并记录验收", "Review and record acceptance")} close={close}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (!selected || !summary.trim() || saving) return;
      setSaving(true); setError("");
      try {
        await request("goal/evidence/add", { id: current.id, revision: current.revision,
          turnId: selected.turnId, itemId: selected.item.id, summary: summary.trim() });
        await saved(); close();
      } catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
    }}>
      <p className="nw-help">{t("逐项核对完成判据，再记录依据。验收说明由你确认，系统会检查任务和输出的持久状态。", "Review every criterion before recording acceptance. You confirm the findings; the system checks the durable task and output.")}</p>
      <p>{current.successCriteria}</p>
      {loading ? <Loader2 className="nw-spin" size={18} /> : options.length ? <>
        <label className="nw-field">{t("作为依据的任务输出", "Supporting task output")}
          <select value={selection} onChange={event => setSelection(event.target.value)}>
            {options.map(option => <option key={option.item.id} value={option.item.id}>{option.title}</option>)}
          </select>
        </label>
        {selected && <><textarea aria-label={t("输出预览", "Output preview")} className="nw-input" rows={5} readOnly value={String(selected.item.payload?.text ?? "").slice(0, 4000)} />
          <Link href={`/workbench/task/${encodeURIComponent(selected.threadId)}`}>{t("查看完整任务", "Open full task")}</Link></>}
      </> : <p>{t("还没有可验收的已完成任务。先执行下一步，再回来核对结果。", "There is no completed task to review yet. Run the next action first.")}</p>}
      <label className="nw-field">{t("验收说明", "Acceptance findings")}
        <textarea required maxLength={4000} rows={3} value={summary} onChange={event => setSummary(event.target.value)} placeholder={t("每条判据如何满足，有哪些可以核对的结果？", "How does the result satisfy each criterion?")} />
      </label>
      {error && <p className="nw-inline-error" role="alert">{error}</p>}
      <div className="nw-dialog-actions"><button type="button" className="nw-button" onClick={close}>{t("取消", "Cancel")}</button>
        <button className="nw-button nw-button-primary" disabled={loading || saving || !selected || !summary.trim()}><Check size={14} />{t("记录验收", "Record acceptance")}</button>
      </div>
    </form>
  </Modal>;
}
