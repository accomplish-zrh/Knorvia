"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  loadExcelWorkbook,
  spreadsheetFromWorkbook,
  type ExcelJsModule,
  type SpreadsheetWorkbook,
} from "@/lib/xlsx-workbook";
import { useBinarySource } from "./useBinarySource";
import SpreadsheetGrid from "./SpreadsheetGrid";

/**
 * XLSX preview via ``exceljs`` (lazy-loaded). Renders a spreadsheet grid with
 * sheet tabs and a formula bar. Formulas are shown, never evaluated.
 */
export default function XlsxPreview({ url }: { url: string }) {
  const { t } = useTranslation();
  const src = useBinarySource(url);
  const [workbook, setWorkbook] = useState<SpreadsheetWorkbook | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");

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

  return <SpreadsheetGrid workbook={workbook} />;
}
