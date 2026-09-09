"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { FileSpreadsheet, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  canConfirmOfficeDraft,
  canShowOfficeDraftFiles,
  collectOfficeDrafts,
  fetchOfficeDraft,
  isOfficeDraftTerminal,
  patchOfficeDraft,
  redoArtifact,
  undoArtifact,
  type OfficeArtifactRef,
  type OfficeDiff,
  type OfficeDraftFile,
  type OfficeDraftStatus,
  type OfficeVerification,
} from "@/lib/office-draft";
import { clearPendingOfficeSelection, setPendingOfficeSelection } from "@/lib/office-selection";
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

function sideText(side: Record<string, unknown> | null, emptyLabel: string): string {
  if (!side) return "";
  for (const key of [
    "formula",
    "value",
    "merged",
    "height",
    "width",
    "freeze_panes",
    "present",
  ]) {
    if (!(key in side)) continue;
    const raw = side[key];
    if (raw === null || raw === undefined || raw === "") return emptyLabel;
    return String(raw);
  }
  return "";
}

function DiffSummary({ diff }: { diff: OfficeDiff | null }) {
  const { t } = useTranslation();
  if (!diff || !diff.entries.length) return null;
  return (
    <div className="mt-1.5 space-y-0.5" data-diff-summary="">
      {diff.entries.slice(0, 8).map((entry, index) => (
        <p
          key={`${entry.sheet}-${entry.target}-${index}`}
          className="truncate text-[11px] text-[var(--muted-foreground)]"
        >
          <span className="font-mono">
            {entry.sheet}!{entry.target}
          </span>
          {entry.kind === "sheet"
            ? ` ${sideText(entry.after, t("empty"))}`
            : `: ${sideText(entry.before, t("empty"))} → ${sideText(entry.after, t("empty"))}`}
        </p>
      ))}
      {diff.entries.length > 8 || diff.omittedCount ? (
        <p className="text-[11px] text-[var(--muted-foreground)]/80">
          {t("{{count}} more changes", {
            count: diff.entries.length - 8 + diff.omittedCount,
          })}
        </p>
      ) : null}
    </div>
  );
}

function VerificationBadges({
  verification,
  calculationRequired,
}: {
  verification: OfficeVerification | null;
  calculationRequired: boolean;
}) {
  const { t } = useTranslation();
  if (!verification) return null;
  const checks: Array<[string, boolean]> = [
    [t("Reopened"), verification.reopened],
    [t("Values read back"), verification.targetReadback],
    [t("Package valid"), verification.zipStructureValid],
    [t("Untouched parts intact"), verification.untouchedPartsVerified],
  ];
  return (
    <p className="mt-1 flex flex-wrap gap-1 text-[10.5px]" data-verification="">
      {checks.map(([label, passed]) => (
        <span
          key={label}
          className={`rounded-full px-1.5 py-0.5 ${
            passed
              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
              : "bg-[var(--destructive)]/12 text-[var(--destructive)]"
          }`}
        >
          {label}
        </span>
      ))}
      {calculationRequired ? (
        <span className="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
          {t("Formulas written, not computed")}
        </span>
      ) : null}
    </p>
  );
}

function DraftPreview({
  file,
  onSelectionChange,
  changedCells,
}: {
  file: OfficeDraftFile;
  onSelectionChange?: (sheet: string, range: string) => void;
  changedCells?: string[];
}) {
  const kind = previewKindFor({ filename: file.name, url: file.url });
  if (!file.url) return null;
  if (kind === "xlsx")
    return (
      <XlsxPreview
        url={file.url}
        onSelectionChange={onSelectionChange}
        changedCells={changedCells}
      />
    );
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
  artifacts: initialArtifacts,
  sessionId = "",
}: {
  draftId: string;
  files: OfficeDraftFile[];
  status: OfficeDraftStatus;
  artifacts?: OfficeArtifactRef[];
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const [liveStatus, setLiveStatus] = useState(status);
  const [liveFiles, setLiveFiles] = useState(files);
  const [artifacts, setArtifacts] = useState<OfficeArtifactRef[]>(
    initialArtifacts || [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<OfficeDraftFile | null>(null);
  const [selected, setSelected] = useState<{
    sheet: string;
    range: string;
    artifactId: string;
    revision: number;
  } | null>(null);
  const [error, setError] = useState("");

  const closePreview = () => {
    setPreview(null);
    setSelected(null);
    clearPendingOfficeSelection(sessionId);
  };

  // The selection slot is global: dropping it when this card goes away keeps a
  // stale intent from outliving the conversation it belonged to.
  useEffect(() => {
    return () => clearPendingOfficeSelection(sessionId);
  }, [sessionId, draftId]);

  const previewedChangedCells = useMemo(() => {
    if (!preview) return [];
    const artifact = artifacts.find((item) => item.filename === preview.name);
    const entries = artifact?.lastDiff?.entries || [];
    return entries
      .filter((entry) => /^[A-Z]+[0-9]+$/.test(entry.target))
      .map((entry) => `${entry.sheet}!${entry.target}`);
  }, [preview, artifacts]);

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
      if (live.artifacts?.length) setArtifacts(live.artifacts);
    });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const confirmable = canConfirmOfficeDraft(liveStatus);
  const showFiles = canShowOfficeDraftFiles(liveStatus);
  const terminal = isOfficeDraftTerminal(liveStatus);

  const onAction = async (action: "merge" | "discard") => {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      const next = await patchOfficeDraft(draftId, action);
      setLiveStatus(next.status);
      if (next.files.length) setLiveFiles(next.files);
      if (next.artifacts?.length) setArtifacts(next.artifacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Office draft action failed"));
    } finally {
      setBusy(null);
    }
  };

  const onHistory = async (
    artifact: OfficeArtifactRef,
    direction: "undo" | "redo",
  ) => {
    if (busy) return;
    setBusy(`${direction}:${artifact.artifactId}`);
    setError("");
    try {
      const moved =
        direction === "undo"
          ? await undoArtifact(draftId, artifact.artifactId)
          : await redoArtifact(draftId, artifact.artifactId);
      setArtifacts((current) =>
        current.map((item) =>
          item.artifactId === artifact.artifactId
            ? { ...item, ...moved, filename: item.filename, kind: item.kind }
            : item,
        ),
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(
        status === 409
          ? t("Office draft conflict")
          : err instanceof Error
            ? err.message
            : t("Office draft action failed"),
      );
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
          {showFiles ? (
            <ul className="mt-2 space-y-1">
              {liveFiles.map((file) => (
                <li
                  key={`${file.name}:${file.url}`}
                  className="flex items-center justify-between gap-2 text-[11.5px]"
                >
                  <span className="min-w-0 truncate text-[var(--foreground)]">
                    {file.name}
                  </span>
                  {file.url ? (
                    <button
                      type="button"
                      className="shrink-0 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      onClick={() => setPreview(file)}
                    >
                      {t("Preview")}
                    </button>
                  ) : file.kind === "library" ? (
                    <span
                      data-library-entry={file.library_entry_id || ""}
                      className="shrink-0 text-[11px] text-[var(--muted-foreground)]"
                    >
                      {t("Written back to the library")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {confirmable && artifacts.length ? (
            <ul className="mt-2 space-y-2">
              {artifacts.map((artifact) => (
                <li key={artifact.artifactId} className="text-[11.5px]">
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-[var(--foreground)]">
                        {artifact.filename || artifact.artifactId}
                      </span>
                      <span className="shrink-0 rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                        r{artifact.currentRevision}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!artifact.canUndo || Boolean(busy)}
                        onClick={() => void onHistory(artifact, "undo")}
                        className="text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-30"
                      >
                        {t("Undo")}
                      </button>
                      <button
                        type="button"
                        disabled={!artifact.canRedo || Boolean(busy)}
                        onClick={() => void onHistory(artifact, "redo")}
                        className="text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-30"
                      >
                        {t("Redo")}
                      </button>
                    </span>
                  </span>
                  {artifact.originRef ? (
                    <p className="mt-0.5 truncate text-[10.5px] text-[var(--muted-foreground)]/80">
                      {t("Source")}: {artifact.originRef}
                    </p>
                  ) : null}
                  <DiffSummary diff={artifact.lastDiff ?? null} />
                  <VerificationBadges
                    verification={artifact.lastVerification ?? null}
                    calculationRequired={Boolean(artifact.calculationRequired)}
                  />
                  {artifact.detachedRevisions?.length ? (
                    <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]/80">
                      {t("Superseded revisions")}:{" "}
                      {artifact.detachedRevisions.join(", ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {confirmable && selected ? (
            <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
              {t("Next message targets selection")}: {selected.sheet}!{selected.range}
            </p>
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
          onClick={closePreview}
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
                onClick={closePreview}
                className="rounded-md p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                aria-label={t("Close preview")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <DraftPreview
                file={preview}
                changedCells={previewedChangedCells}
                onSelectionChange={(sheet, range) => {
                  const artifact = artifacts.find(
                    (item) => item.filename === preview.name,
                  );
                  if (!artifact) {
                    setSelected(null);
                    clearPendingOfficeSelection(sessionId);
                    return;
                  }
                  const next = {
                    sheet,
                    range,
                    artifactId: artifact.artifactId,
                    revision: artifact.currentRevision,
                  };
                  setSelected(next);
                  setPendingOfficeSelection(
                    {
                      draftId,
                      artifactId: artifact.artifactId,
                      sheet,
                      range,
                      revision: artifact.currentRevision,
                    },
                    sessionId,
                  );
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function OfficeDraftCards({ events }: { events: StreamEvent[] }) {
  const drafts = useMemo(() => collectOfficeDrafts(events), [events]);
  const sessionId = useMemo(
    () => events.find((event) => event.session_id)?.session_id || "",
    [events],
  );
  if (!drafts.length) return null;
  return (
    <div>
      {drafts.map((draft) => (
        <OfficeDraftCard
          key={draft.draftId}
          draftId={draft.draftId}
          files={draft.files}
          status={draft.status}
          artifacts={draft.artifacts}
          sessionId={sessionId}
        />
      ))}
    </div>
  );
}
