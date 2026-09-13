"use client";

import { Download, History, X } from "lucide-react";
import { historyPreview, type DraftHistoryEntry } from "@/lib/native-composer-draft";
import { useWorkbench } from "./NativeWorkbenchProvider";

/**
 * Bounded recovery history for the text task draft (B09): restore a previous
 * version (text + attachments + goal fields together), or export the draft
 * when storage is unavailable. A conflict note explains which branch was kept.
 */
export function ComposerDraftRecovery({ entries, conflict, storageIssue, historyIncomplete, onRestore, onDownload, onClose }: {
  entries: DraftHistoryEntry[];
  conflict?: string;
  storageIssue?: "unavailable" | "quota" | null;
  /** Version-slot enumeration was denied; the listed history may be incomplete. */
  historyIncomplete?: boolean;
  onRestore: (entry: DraftHistoryEntry) => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  const { t } = useWorkbench();
  return <div className="nw-draft-recovery" role="dialog" aria-label={t("草稿恢复", "Draft recovery")}>
    <div className="nw-draft-recovery-head">
      <strong><History size={14} />{t("草稿恢复历史", "Draft recovery history")}</strong>
      <button className="nw-icon" onClick={onClose} aria-label={t("关闭", "Close")}><X size={14} /></button>
    </div>
    {conflict && <p className="nw-draft-recovery-note" role="status">{conflict}</p>}
    {storageIssue && <p className="nw-draft-recovery-note" role="alert">{storageIssue === "quota" ? t("存储空间不足，草稿没有保存成功。", "Storage is full; the draft was NOT saved.") : t("本地存储不可用，草稿没有保存成功。", "Local storage is unavailable; the draft was NOT saved.")}{t("请复制或下载保留内容。", " Copy or download your content to keep it.")}</p>}
    {historyIncomplete && !storageIssue && <p className="nw-draft-recovery-note" role="note">{t("本地版本记录无法完整读取，以下历史可能不是全部。", "Local version records could not be fully read; this history may be incomplete.")}</p>}
    {!storageIssue && !entries.length && !historyIncomplete && <p className="nw-draft-recovery-note">{t("暂无可恢复的历史版本。", "No recoverable versions yet.")}</p>}
    <ul className="nw-draft-recovery-list">
      {entries.slice().reverse().map((entry, index) => <li key={`${entry.savedAt}-${index}`}>
        <span className="nw-draft-recovery-preview">{historyPreview(entry).slice(0, 120) || t("（空草稿）", "(empty draft)")}</span>
        <time>{new Date(entry.savedAt).toLocaleTimeString()}</time>
        <button className="nw-button nw-button-small" onClick={() => onRestore(entry)}>{t("恢复", "Restore")}</button>
      </li>)}
    </ul>
    <button className="nw-button nw-button-small" onClick={onDownload}><Download size={13} />{t("下载当前内容", "Download current content")}</button>
  </div>;
}
