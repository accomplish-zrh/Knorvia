"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Check, Download, FileJson, FileText, Loader2, X } from "lucide-react";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";
import { Modal } from "./WorkbenchShell";
import {
  composeTaskExportJson,
  composeTaskExportMarkdown,
  exportTaskHistory,
  type TaskExportFormat,
  type TaskExportResult,
} from "@/lib/native-task-export";
import type { Thread } from "@/lib/native-workbench-state";
import "./task-export.css";

function slugify(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 60) || "task";
}

/**
 * Offline export window for one native task: walks the full durable timeline
 * (both cursors), keeps a fixed cutoff, shows progress, supports cancel, and
 * never presents a partial walk as complete.
 */
export function TaskExportDialog({ thread, close }: { thread: Thread; close: () => void }) {
  const { t, request } = useWorkbench();
  const [format, setFormat] = useState<TaskExportFormat>("markdown");
  const [includeRaw, setIncludeRaw] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ fetchedItems: 0, fetchedTurns: 0, pages: 0, phase: "items" as string });
  const [result, setResult] = useState<TaskExportResult | null>(null);
  const [error, setError] = useState("");
  const cancelRef = useRef(false);

  const run = useCallback(async () => {
    setRunning(true);
    setError("");
    setResult(null);
    cancelRef.current = false;
    try {
      const outcome = await exportTaskHistory({
        threadId: thread.id,
        request,
        shouldContinue: () => !cancelRef.current,
        includeRawPayloads: includeRaw,
        onProgress: entry => setProgress({ fetchedItems: entry.fetchedItems, fetchedTurns: entry.fetchedTurns, pages: entry.pages, phase: entry.phase }),
      });
      setResult(outcome);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setRunning(false);
    }
  }, [thread.id, request, includeRaw]);

  const download = () => {
    if (!result) return;
    const body = format === "markdown" ? composeTaskExportMarkdown(result) : composeTaskExportJson(result);
    const extension = format === "markdown" ? "md" : "json";
    const blob = new Blob([body], { type: format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `knorvia-task-${slugify(thread.title)}-${new Date(result.finishedAt).toISOString().slice(0, 19).replace(/[:T]/g, "")}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const complete = result?.status === "complete";
  return <Modal title={t("导出任务", "Export task")} close={close} busy={running}>
    <div className="ht-export" aria-busy={running}>
      <p className="nw-help">
        {t(`将离线导出「${thread.title}」的完整持久时间线：从最新一页向历史方向遍历两种游标，按 ID 去重；导出开始后的新消息不在本次范围内。`,
          `Exports the full durable timeline of "${thread.title}" older-ward through both cursors with id dedup. Messages that arrive during the export are out of scope.`)}
      </p>
      {!running && !result && <>
        <div className="ht-export-formats" role="radiogroup" aria-label={t("导出格式", "Export format")}>
          <button type="button" role="radio" aria-checked={format === "markdown"} className={format === "markdown" ? "is-active" : ""} onClick={() => setFormat("markdown")}>
            <FileText size={15} />{t("完整 Markdown", "Full Markdown")}</button>
          <button type="button" role="radio" aria-checked={format === "json"} className={format === "json" ? "is-active" : ""} onClick={() => setFormat("json")}>
            <FileJson size={15} />{t("结构化 JSON", "Structured JSON")}</button>
        </div>
        <label className="ht-export-raw">
          <input type="checkbox" checked={includeRaw} onChange={event => setIncludeRaw(event.target.checked)} />
          <span>{t("包含工具原始 payload（默认排除，且始终剔除疑似机密字段）", "Include raw tool payloads (excluded by default; secret-shaped fields are always stripped)")}</span>
        </label>
        <div className="ht-export-actions">
          <button type="button" className="nw-button" onClick={close}>{t("取消", "Cancel")}</button>
          <button type="button" className="nw-button nw-button-primary" onClick={() => void run()}>
            <Download size={15} />{t("开始导出", "Start export")}</button>
        </div>
      </>}
      {running && <div className="ht-export-progress" role="status">
        <p><Loader2 size={14} className="nw-spin" /> {t("正在遍历任务历史…", "Walking the task history…")}</p>
        <p>{t(`已读取 ${progress.fetchedItems} 条 Item（${progress.pages} 页）、${progress.fetchedTurns} 个 Turn`,
          `${progress.fetchedItems} items (${progress.pages} pages), ${progress.fetchedTurns} turns read`)}</p>
        <button type="button" className="nw-button" onClick={() => { cancelRef.current = true; }}>
          <X size={14} />{t("取消导出", "Cancel export")}</button>
        <p className="nw-help">{t("取消后保留已读取的部分，并明确标记为不完整。", "Cancelling keeps the partial data, clearly marked incomplete.")}</p>
      </div>}
      {result && <div className="ht-export-result">
        <p className={complete ? "ht-export-banner ht-export-ok" : "ht-export-banner ht-export-warn"} role="status">
          {complete ? <><Check size={14} /> {t(`导出完成：${result.items.length} 条 Item、${result.turns.length} 个 Turn，时间线完整。`, `Export complete: ${result.items.length} items, ${result.turns.length} turns; the timeline is complete.`)}</>
            : <><AlertTriangle size={14} /> {t(`导出不完整（${result.status}）：${result.reason}。文件内已标记，不代表全部历史。`, `Export incomplete (${result.status}): ${result.reason}. The file is marked and is not the full history.`)}</>}
        </p>
        <p className="nw-help">
          {t(`截止位置：Item seq ${result.cutoff.newestItemSeq ?? "n/a"}；成果引用 ${result.artifactRefs.length} 条；附件引用 ${result.attachments.length} 条。`,
            `Cutoff at item seq ${result.cutoff.newestItemSeq ?? "n/a"}; ${result.artifactRefs.length} artifact references; ${result.attachments.length} attachment references.`)}
          {result.unverifiedTitleMatches.length > 0 && t(` 另有 ${result.unverifiedTitleMatches.length} 个同名成果未核实归属，未计入引用。`, ` ${result.unverifiedTitleMatches.length} same-title outputs were excluded from references (ownership unverified).`)}
        </p>
        <div className="ht-export-actions">
          <button type="button" className="nw-button" onClick={() => setResult(null)}>{t("重新配置", "Configure again")}</button>
          <button type="button" className="nw-button nw-button-primary" onClick={download}>
            <Download size={15} />{t(`下载 ${format === "markdown" ? ".md" : ".json"}`, `Download ${format === "markdown" ? ".md" : ".json"}`)}</button>
        </div>
      </div>}
      {error && <p className="nw-help" role="alert">{error}</p>}
    </div>
  </Modal>;
}
