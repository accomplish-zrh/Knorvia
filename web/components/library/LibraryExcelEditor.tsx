"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  applyCellEdit,
  loadExcelWorkbook,
  spreadsheetFromWorkbook,
  type CellAddress,
  type ExcelJsModule,
  type SpreadsheetWorkbook,
} from "@/lib/xlsx-workbook";
import { useBinarySource } from "@/components/chat/preview/previewers/useBinarySource";
import SpreadsheetGrid from "@/components/chat/preview/previewers/SpreadsheetGrid";
import {
  OfficeDraftApiError,
  applyOfficeOperations,
  openOfficeDraftFromSource,
  patchOfficeDraft,
} from "@/lib/office-draft";
import {
  chunkOperations,
  diffWorkbookToOperations,
  TooManyOperationsError,
  type OfficeOperation,
} from "@/lib/xlsx-ops";

export default function LibraryExcelEditor({
  entryId,
  url,
  onRegisterSave,
}: {
  entryId: string;
  url: string;
  onRegisterSave?: (save: (() => Promise<void>) | null) => void;
}) {
  const { t } = useTranslation();
  const src = useBinarySource(url);
  const live = useRef<{
    book: Awaited<ReturnType<typeof loadExcelWorkbook>>;
  } | null>(null);
  const baseline = useRef<SpreadsheetWorkbook | null>(null);
  const [model, setModel] = useState<SpreadsheetWorkbook | null>(null);
  // Hash of the exact bytes that were rendered, i.e. the version the user is
  // editing against. The draft is opened with it so a concurrent save to the
  // same entry conflicts instead of being overwritten.
  const anchor = useRef<string>("");
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (src.kind === "error") {
      setFailed(true);
      setError(src.message);
      setModel(null);
      live.current = null;
      baseline.current = null;
      anchor.current = "";
      return;
    }
    if (src.kind !== "ready") return;

    let cancelled = false;
    setFailed(false);
    setError("");
    setNotice("");
    setModel(null);
    live.current = null;
    baseline.current = null;
    anchor.current = "";
    (async () => {
      try {
        const mod = await import("exceljs");
        const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ??
          mod) as unknown as ExcelJsModule;
        if (cancelled) return;
        const fingerprint = await contentFingerprint(src.buffer);
        if (cancelled) return;
        const book = await loadExcelWorkbook(ExcelJS, src.buffer);
        if (cancelled) return;
        live.current = { book };
        // Snapshot taken before any edit; the save path diffs against it.
        baseline.current = spreadsheetFromWorkbook(book, { editable: true });
        anchor.current = fingerprint;
        setModel(spreadsheetFromWorkbook(book, { editable: true }));
      } catch (caught) {
        if (cancelled) return;
        setFailed(true);
        setError(caught instanceof Error ? caught.message : "");
      }
    })();

    return () => {
      cancelled = true;
      live.current = null;
      baseline.current = null;
    };
  }, [src]);

  const save = useCallback(async () => {
    const current = live.current;
    const baselineModel = baseline.current;
    if (!current || !baselineModel) throw new Error("Workbook is not loaded.");
    const currentModel = spreadsheetFromWorkbook(current.book, { editable: true });
    let operations: OfficeOperation[];
    try {
      operations = diffWorkbookToOperations(baselineModel, currentModel);
    } catch (caught) {
      if (caught instanceof TooManyOperationsError) {
        setError(
          t("Too many changes to save here. Download the file and edit it offline."),
        );
      }
      throw caught;
    }
    if (!operations.length) return;
    if (!anchor.current) {
      setError(
        t(
          "This browser can't verify which version of the entry you opened, so saving is disabled here. Download the file and edit it offline.",
        ),
      );
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const draft = await openOfficeDraftFromSource(
        `library:${entryId}`,
        anchor.current,
      );
      const artifact = draft.artifacts?.[0];
      if (!artifact) throw new Error("The office draft has no spreadsheet artifact.");
      let baseRevision = artifact.currentRevision;
      for (const chunk of chunkOperations(operations)) {
        const result = await applyOfficeOperations(
          draft.draftId,
          artifact.artifactId,
          baseRevision,
          chunk,
        );
        baseRevision = Number(result.revision_after ?? baseRevision);
      }
      const merged = await patchOfficeDraft(draft.draftId, "merge");
      const published = merged.artifacts?.find(
        (item) => item.artifactId === artifact.artifactId,
      );
      // Re-anchor on what we just published: the next save diffs against it.
      const publishedHash = published?.currentHash || "";
      baseline.current = currentModel;
      anchor.current = publishedHash;
      setError("");
      setNotice(
        publishedHash
          ? t("Saved changes to this library entry.")
          : t("Saved, but reopen this entry before making more edits."),
      );
    } catch (caught) {
      if (caught instanceof OfficeDraftApiError && caught.status === 409) {
        setError(
          t(
            "This entry changed while you were editing. Close and reopen the editor to get the latest version.",
          ),
        );
      } else {
        setError(caught instanceof Error ? caught.message : "Couldn't save this spreadsheet.");
      }
      throw caught;
    } finally {
      setSaving(false);
    }
  }, [entryId, t]);

  useEffect(() => {
    onRegisterSave?.(save);
    return () => onRegisterSave?.(null);
  }, [onRegisterSave, save]);

  const commit = useCallback((address: CellAddress, raw: string) => {
    const current = live.current;
    if (!current) throw new Error("Workbook is not loaded.");
    try {
      const cell = applyCellEdit(current.book, address, raw);
      setModel((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          sheets: prev.sheets.map((sheet, sheetIndex) => {
            if (sheetIndex !== address.sheetIndex) return sheet;
            return {
              ...sheet,
              rows: sheet.rows.map((row, rowIndex) => {
                if (rowIndex !== address.row - 1) return row;
                return row.map((item, colIndex) =>
                  colIndex === address.col - 1 ? cell : item,
                );
              }),
            };
          }),
        };
      });
      setError("");
      setNotice("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't save this spreadsheet.");
      throw caught;
    }
  }, []);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[12px] text-[var(--muted-foreground)]">
        <AlertCircle size={18} strokeWidth={1.7} className="opacity-70" />
        <p>
          {error && error.includes("too large")
            ? t("This spreadsheet is too large to edit here. Download it instead.")
            : t("Couldn't render this spreadsheet — use Download to open it.")}
        </p>
      </div>
    );
  }

  if (!model) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--muted-foreground)]">
        <Loader2 size={14} className="animate-spin" />
        <span>{t("Loading preview…")}</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted-foreground)]">
        <span>
          {saving
            ? t("Saving…")
            : notice ||
              t(
                "Editing the spreadsheet grid. Save writes the real .xlsx and keeps other sheets.",
              )}
        </span>
      </div>
      <SpreadsheetGrid workbook={model} editable error={error} onCommit={commit} />
    </div>
  );
}

/** SHA-256 of the bytes the editor is showing, used as the save-time CAS anchor. */
async function contentFingerprint(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return "";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
