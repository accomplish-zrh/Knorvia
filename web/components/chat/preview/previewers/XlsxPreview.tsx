"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  cellAddress,
  loadExcelWorkbook,
  spreadsheetFromWorkbook,
  type ExcelJsModule,
  type SpreadsheetWorkbook,
} from "@/lib/xlsx-workbook";
import { useBinarySource } from "./useBinarySource";
import SpreadsheetGrid, { type GridRange } from "./SpreadsheetGrid";

/**
 * XLSX preview via ``exceljs`` (lazy-loaded). Renders a spreadsheet grid with
 * sheet tabs and a formula bar. Formulas are shown, never evaluated.
 *
 * With ``onSelectionChange`` the preview also renders a selection chip and
 * reports the selected rectangle upward — the chat card freezes it into the
 * turn's ``office_selection`` so the agent can only edit inside it. Pass
 * ``changedCells`` (``"Sheet!A1"`` addresses) to highlight them.
 */
export default function XlsxPreview({
  url,
  onSelectionChange,
  changedCells,
}: {
  url: string;
  onSelectionChange?: (sheet: string, range: string) => void;
  changedCells?: string[];
}) {
  const { t } = useTranslation();
  const src = useBinarySource(url);
  const [workbook, setWorkbook] = useState<SpreadsheetWorkbook | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const [chip, setChip] = useState("");

  useEffect(() => {
    if (src.kind === "error") {
      setFailed(true);
      setMessage(src.message);
      setWorkbook(null);
      return;
    }
    if (src.kind !== "ready") return;

    let cancelled = false;
    setFailed(false);
    setMessage("");
    setWorkbook(null);
    (async () => {
      try {
        const mod = await import("exceljs");
        const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ??
          mod) as unknown as ExcelJsModule;
        if (cancelled) return;
        const loaded = await loadExcelWorkbook(ExcelJS, src.buffer);
        if (cancelled) return;
        setWorkbook(spreadsheetFromWorkbook(loaded));
      } catch (error) {
        if (cancelled) return;
        setFailed(true);
        setMessage(error instanceof Error ? error.message : "");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src]);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-[12px] text-[var(--muted-foreground)]">
        <AlertCircle size={18} strokeWidth={1.7} className="opacity-70" />
        <p>
          {message && message.includes("too large")
            ? t("File is too large to preview. Use the Download button.")
            : t("Couldn't render this spreadsheet — use Download to open it.")}
        </p>
      </div>
    );
  }

  if (!workbook) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--muted-foreground)]">
        <Loader2 size={14} className="animate-spin" />
        <span>{t("Loading preview…")}</span>
      </div>
    );
  }

  if (onSelectionChange) {
    const report = (range: GridRange, sheetName: string) => {
      const from = cellAddress(range.from.row, range.from.col);
      const to = cellAddress(range.to.row, range.to.col);
      const text = from === to ? from : `${from}:${to}`;
      setChip(sheetName ? `${sheetName}!${text}` : "");
      onSelectionChange(sheetName, text);
    };
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-end px-3 pt-2">
          <span
            data-selection-chip=""
            className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10.5px] text-[var(--muted-foreground)]"
          >
            {chip || t("Select a cell or drag a range")}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <SpreadsheetGrid
            workbook={workbook}
            onSelectionChange={report}
            changedCells={changedCells}
          />
        </div>
      </div>
    );
  }

  return <SpreadsheetGrid workbook={workbook} changedCells={changedCells} />;
}
