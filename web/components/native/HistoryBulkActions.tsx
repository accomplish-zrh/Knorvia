"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, ArchiveRestore, Check, Loader2, RefreshCw } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal } from "./WorkbenchShell";
import {
  bulkIneligibilityReason,
  mergeBulkResults,
  planBulkRun,
  retryBulkEntries,
  runBulkThreadAction,
  type BulkRunResult,
  type BulkThreadAction,
} from "@/lib/native-history-actions";
import type { Thread } from "@/lib/native-workbench-state";
import "./history-actions.css";

const kindLabel = {
  succeeded: { zh: "成功", en: "Done" },
  skipped: { zh: "已跳过", en: "Skipped" },
  conflict: { zh: "冲突", en: "Conflict" },
  failed: { zh: "失败", en: "Failed" },
} as const;

/**
 * Preview → run → per-item results for one bulk archive/restore pass. The
 * selection is frozen when the run is confirmed; rows that already succeeded
 * are never re-sent by the retry path.
 */
export function HistoryBulkModal({ threads, selectedIds, action, close, onChanged, onRunningChange }: {
  threads: Thread[];
  selectedIds: ReadonlySet<string>;
  action: BulkThreadAction;
  close: () => void;
  onChanged: () => void;
  onRunningChange?: (running: boolean) => void;
}) {
  const { t, request } = useWorkbench();
  const [phase, setPhase] = useState<"preview" | "running">("preview");
  const [run, setRun] = useState<BulkRunResult | null>(null);
  const [error, setError] = useState("");
  const plan = useMemo(() => planBulkRun(threads, selectedIds, action), [threads, selectedIds, action]);
  const results = run?.results ?? [];
  const counts = useMemo(() => {
    const tally = { succeeded: 0, skipped: 0, conflict: 0, failed: 0 } as Record<keyof typeof kindLabel, number>;
    for (const result of results) tally[result.kind] += 1;
    return tally;
  }, [results]);
  const retryableCount = results.filter(result => result.kind !== "succeeded" && result.retryable).length;
  const stopped = run?.stopped === true;
  const running = phase === "running";
  useEffect(() => { onRunningChange?.(running); }, [running, onRunningChange]);
  const start = async () => {
    setPhase("running");
    setError("");
    try {
      setRun(await runBulkThreadAction({ entries: plan.entries, action, request }));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPhase("preview");
      onChanged();
    }
  };
  const retry = async () => {
    if (!run) return;
    setPhase("running");
    setError("");
    try {
      const next = await retryBulkEntries({ previous: run.results, action, request });
      setRun({ results: mergeBulkResults(run.results, next.results), stopped: next.stopped });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPhase("preview");
      onChanged();
    }
  };
  const heading = action === "archive" ? t("批量归档任务", "Bulk archive tasks") : t("批量恢复任务", "Bulk restore tasks");
  const verb = action === "archive" ? t("归档", "archive") : t("恢复", "restore");
  return <Modal title={heading} close={close} busy={running}>
    <div className="hw-bulk" aria-busy={running}>
      {phase === "preview" && !run && <>
        <p className="nw-help">
          {t(`将对 ${plan.entries.length} 个任务执行${verb}；版本号在确认时锁定，逐项独立提交。`,
            `About to ${verb} ${plan.entries.length} tasks; revisions are locked now and each task is committed independently.`)}
        </p>
        {plan.ineligible.length > 0 && <div className="hw-bulk-note" role="note">
          <AlertTriangle size={14} />
          <span>{t(`${plan.ineligible.length} 个所选任务当前不可执行，将自动跳过：`, `${plan.ineligible.length} selected tasks cannot take this action and will be skipped:`)}</span>
          <ul>{plan.ineligible.slice(0, 8).map(row => <li key={row.id}><strong>{row.title}</strong> — {t(bulkIneligibilityReason[row.reason].zh, bulkIneligibilityReason[row.reason].en)}</li>)}
            {plan.ineligible.length > 8 && <li>{t(`…等 ${plan.ineligible.length} 项`, `…and ${plan.ineligible.length - 8} more`)}</li>}</ul>
        </div>}
        <div className="hw-bulk-actions">
          <button type="button" className="nw-button" onClick={close}>{t("取消", "Cancel")}</button>
          <button type="button" className="nw-button nw-button-primary" disabled={plan.entries.length === 0} onClick={() => void start()}>
            {action === "archive" ? <Archive size={15} /> : <ArchiveRestore size={15} />}
            {t(`确认${verb} ${plan.entries.length} 项`, `Confirm ${verb} ${plan.entries.length}`)}
          </button>
        </div>
      </>}
      {running && <p className="nw-help" role="status"><Loader2 size={14} className="nw-spin" /> {t("正在逐项执行…", "Working through the selection…")}</p>}
      {run && !running && <>
        <div className="hw-bulk-summary" role="status">
          <span className="hw-chip hw-chip-succeeded"><Check size={12} />{t(`成功 ${counts.succeeded}`, `Done ${counts.succeeded}`)}</span>
          <span className="hw-chip hw-chip-skipped">{t(`跳过 ${counts.skipped}`, `Skipped ${counts.skipped}`)}</span>
          <span className="hw-chip hw-chip-conflict">{t(`冲突 ${counts.conflict}`, `Conflicts ${counts.conflict}`)}</span>
          <span className="hw-chip hw-chip-failed">{t(`失败 ${counts.failed}`, `Failed ${counts.failed}`)}</span>
          {stopped && <span className="hw-chip hw-chip-failed">{t("已中断，未执行完", "Stopped early")}</span>}
        </div>
        <ul className="hw-bulk-results" aria-label={t("逐项结果", "Per-task results")}>
          {results.map(result => <li key={result.id} className={`hw-bulk-row hw-bulk-${result.kind}`}>
            <span className={`hw-chip hw-chip-${result.kind}`}>{t(kindLabel[result.kind].zh, kindLabel[result.kind].en)}</span>
            <strong>{result.title}</strong>
            {result.detail && <span className="hw-bulk-detail">{result.detail}</span>}
          </li>)}
        </ul>
        {error && <p className="nw-help" role="alert">{error}</p>}
        <div className="hw-bulk-actions">
          {retryableCount > 0 && <button type="button" className="nw-button" onClick={() => void retry()}>
            <RefreshCw size={14} />{t(`重试未完成的 ${retryableCount} 项`, `Retry ${retryableCount} unfinished`)}</button>}
          <button type="button" className="nw-button nw-button-primary" onClick={() => { onChanged(); close(); }}>
            {t("完成", "Done")}</button>
        </div>
      </>}
    </div>
  </Modal>;
}
