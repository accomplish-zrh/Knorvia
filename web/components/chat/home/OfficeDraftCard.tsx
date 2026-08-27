"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { FileSpreadsheet, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  canConfirmOfficeDraft,
  collectOfficeDrafts,
  fetchOfficeDraft,
  isOfficeDraftTerminal,
  patchOfficeDraft,
  type OfficeDraftFile,
  type OfficeDraftStatus,
} from "@/lib/office-draft";
import { previewKindFor } from "@/components/chat/preview/previewerFor";
import type { StreamEvent } from "@/lib/unified-ws";

const XlsxPreview = dynamic(
  () => import("@/components/chat/preview/previewers/XlsxPreview"),
  { ssr: false },
);
const DocxPreview = dynamic(
  () => import("@/components/chat/preview/previewers/DocxPreview"),
  { ssr: false },
);
const PptxPreview = dynamic(
  () => import("@/components/chat/preview/previewers/PptxPreview"),
  { ssr: false },
);
const UniverPreview = dynamic(
  () => import("@/components/chat/preview/previewers/UniverPreview"),
  { ssr: false },
);

function statusKey(status: OfficeDraftStatus): string {
  if (status === "ready") return "Waiting for confirmation";
  if (status === "merged") return "Office draft merged";
  if (status === "discarded") return "Office draft discarded";
  return "Draft";
}

function DraftPreview({ file }: { file: OfficeDraftFile }) {
  const kind = previewKindFor({ filename: file.name, url: file.url });
  if (!file.url) return null;
  if (kind === "xlsx") return <XlsxPreview url={file.url} />;
  if (kind === "docx") return <DocxPreview url={file.url} />;
  if (kind === "pptx") {
    return <PptxPreview url={file.url} filename={file.name} />;
  }
  if (kind === "univer") {
    return <UniverPreview key={file.url} url={file.url} filename={file.name} />;
  }
  return (
    <object
      data={file.url}
      className="h-full w-full"
      aria-label={file.name}
    />
  );
}

export function OfficeDraftCard({
  draftId,
  files,
  status,
}: {
  draftId: string;
  files: OfficeDraftFile[];
  status: OfficeDraftStatus;
}) {
  const { t } = useTranslation();
  const [liveStatus, setLiveStatus] = useState(status);
  const [liveFiles, setLiveFiles] = useState(files);
  const [busy, setBusy] = useState<"merge" | "discard" | null>(null);
  const [preview, setPreview] = useState<OfficeDraftFile | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setLiveStatus(status);
    setLiveFiles(files);
  }, [status, files]);

  useEffect(() => {
    let cancelled = false;
    void fetchOfficeDraft(draftId).then((live) => {
      if (cancelled || !live) return;
      setLiveStatus(live.status);
      if (live.files.length) setLiveFiles(live.files);
    });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const confirmable = canConfirmOfficeDraft(liveStatus);
  const terminal = isOfficeDraftTerminal(liveStatus);

  const onAction = async (action: "merge" | "discard") => {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      const next = await patchOfficeDraft(draftId, action);
      setLiveStatus(next.status);
      if (next.files.length) setLiveFiles(next.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Office draft action failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
          <FileSpreadsheet size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--foreground)]">
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            <span>{t("Office draft")}</span>
            <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] font-normal text-[var(--muted-foreground)]">
              {t(statusKey(liveStatus))}
            </span>
          </div>
          {liveStatus === "ready" ? (
            <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
              {t("Waiting for confirmation")}
            </p>
          ) : null}
          {confirmable ? (
            <ul className="mt-2 space-y-1">
              {liveFiles.map((file) => (
                <li
                  key={`${file.name}:${file.url}`}
                  className="flex items-center justify-between gap-2 text-[11.5px]"
                >
                  <span className="min-w-0 truncate text-[var(--foreground)]">
                    {file.name}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    onClick={() => setPreview(file)}
                  >
                    {t("Preview")}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {confirmable ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void onAction("merge")}
                className="rounded-lg bg-[var(--foreground)] px-2.5 py-1 text-[11px] text-[var(--background)] disabled:opacity-40"
              >
                {t("Confirm merge")}
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void onAction("discard")}
                className="rounded-lg border border-[var(--destructive)] px-2.5 py-1 text-[11px] text-[var(--destructive)] disabled:opacity-40"
              >
                {t("Discard draft")}
              </button>
            </div>
          ) : null}
          {terminal ? (
            <p className="mt-1 text-[11.5px] text-[var(--muted-foreground)]">
              {t(statusKey(liveStatus))}
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 text-[11px] text-[var(--destructive)]">{error}</p>
          ) : null}
        </div>
      </div>
      {preview ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] px-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("Review office draft")}
          onClick={() => setPreview(null)}
        >
          <div
            className="flex h-[75vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
              <span className="truncate text-[13px] font-medium text-[var(--foreground)]">
                {preview.name}
              </span>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded-md p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                aria-label={t("Close preview")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <DraftPreview file={preview} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function OfficeDraftCards({ events }: { events: StreamEvent[] }) {
  const drafts = useMemo(() => collectOfficeDrafts(events), [events]);
  if (!drafts.length) return null;
  return (
    <div>
      {drafts.map((draft) => (
        <OfficeDraftCard
          key={draft.draftId}
          draftId={draft.draftId}
          files={draft.files}
          status={draft.status}
        />
      ))}
    </div>
  );
}
