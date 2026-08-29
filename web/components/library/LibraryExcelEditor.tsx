"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  applyCellEdit,
  loadExcelWorkbook,
  spreadsheetFromWorkbook,
  workbookToXlsxFile,
  type CellAddress,
  type ExcelJsModule,
  type SpreadsheetWorkbook,
} from "@/lib/xlsx-workbook";
import { useBinarySource } from "@/components/chat/preview/previewers/useBinarySource";
import SpreadsheetGrid from "@/components/chat/preview/previewers/SpreadsheetGrid";
import { putLibraryEntryContent } from "@/lib/creative-library-api";

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
  const [model, setModel] = useState<SpreadsheetWorkbook | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (src.kind === "error") {
      setFailed(true);
      setError(src.message);
      setModel(null);
      live.current = null;
      return;
    }
    if (src.kind !== "ready") return;

    let cancelled = false;
    setFailed(false);
    setError("");
    setModel(null);
    live.current = null;
    (async () => {
      try {
        const mod = await import("exceljs");
        const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ??
          mod) as unknown as ExcelJsModule;
        if (cancelled) return;
        const book = await loadExcelWorkbook(ExcelJS, src.buffer);
        if (cancelled) return;
        live.current = { book };
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
    };
  }, [src]);

  const save = useCallback(async () => {
    const current = live.current;
    if (!current) throw new Error("Workbook is not loaded.");
    const file = await workbookToXlsxFile(current.book, "workbook.xlsx");
    await putLibraryEntryContent(entryId, file);
  }, [entryId]);

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
          {t(
            "Editing the spreadsheet grid. Save writes the real .xlsx and keeps other sheets.",
          )}
        </span>
      </div>
      <SpreadsheetGrid workbook={model} editable error={error} onCommit={commit} />
    </div>
  );
}
