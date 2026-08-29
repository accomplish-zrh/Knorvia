"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  cellAddress,
  columnLabel,
  formulaBarValue,
  type CellAddress,
  type SpreadsheetWorkbook,
} from "@/lib/xlsx-workbook";

type Selection = CellAddress;

export default function SpreadsheetGrid({
  workbook,
  editable = false,
  error = "",
  onCommit,
}: {
  workbook: SpreadsheetWorkbook;
  editable?: boolean;
  error?: string;
  onCommit?: (address: CellAddress, raw: string) => void;
}) {
  const { t } = useTranslation();
  const [activeSheet, setActiveSheet] = useState(0);
  const [selection, setSelection] = useState<Selection>({
    sheetIndex: 0,
    row: 1,
    col: 1,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const sheet =
    workbook.sheets[Math.min(activeSheet, Math.max(workbook.sheets.length - 1, 0))];
  const selected =
    selection.sheetIndex === activeSheet
      ? sheet?.rows[selection.row - 1]?.[selection.col - 1]
      : undefined;

  const formulaValue = useMemo(() => {
    if (editing && selection.sheetIndex === activeSheet) return draft;
    return formulaBarValue(selected);
  }, [activeSheet, draft, editing, selected, selection.sheetIndex]);

  if (!sheet) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-[12px] text-[var(--muted-foreground)]">
        {t("This workbook has no sheets to preview.")}
      </div>
    );
  }

  function selectCell(row: number, col: number, startEdit = false) {
    if (editing && !commitIfNeeded()) return;
    setSelection({ sheetIndex: activeSheet, row, col });
    const cell = sheet.rows[row - 1]?.[col - 1];
    const next = formulaBarValue(cell);
    setDraft(next);
    setEditing(startEdit);
  }

  function commitIfNeeded(): boolean {
    if (!editing || !onCommit) {
      setEditing(false);
      return true;
    }
    try {
      onCommit(selection, draft);
      setEditing(false);
      return true;
    } catch {
      return false;
    }
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!sheet) return;
    const maxRow = sheet.rowCount;
    const maxCol = sheet.colCount;
    if (editing) {
      if (event.key === "Enter") {
        event.preventDefault();
        if (commitIfNeeded()) {
          selectCell(Math.min(selection.row + 1, maxRow), selection.col);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        setDraft(formulaBarValue(selected));
        setEditing(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        if (commitIfNeeded()) {
          const nextCol = event.shiftKey
            ? Math.max(1, selection.col - 1)
            : Math.min(maxCol, selection.col + 1);
          selectCell(selection.row, nextCol);
        }
      }
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      if (!editable) return;
      event.preventDefault();
      selectCell(selection.row, selection.col, true);
      return;
    }
    const move: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, event.shiftKey ? -1 : 1],
    };
    const delta = move[event.key];
    if (delta) {
      event.preventDefault();
      selectCell(
        Math.min(maxRow, Math.max(1, selection.row + delta[0])),
        Math.min(maxCol, Math.max(1, selection.col + delta[1])),
      );
    } else if (editable && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      setSelection({ sheetIndex: activeSheet, row: selection.row, col: selection.col });
      setDraft(event.key);
      setEditing(true);
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--card)]"
      data-spreadsheet-grid=""
      data-editable={editable ? "true" : "false"}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)]/50 bg-[var(--muted)]/20 px-2 py-1.5">
        <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
          {sheet ? cellAddress(selection.row, selection.col) : ""}
        </span>
        <label className="sr-only" htmlFor="spreadsheet-formula">
          {t("Formula")}
        </label>
        <input
          id="spreadsheet-formula"
          data-formula-bar=""
          value={formulaValue}
          readOnly={!editable}
          onFocus={() => {
            if (editable) {
              setDraft(formulaBarValue(selected));
              setEditing(true);
            }
          }}
          onChange={(event) => {
            if (!editable) return;
            setDraft(event.target.value);
            setEditing(true);
          }}
          onBlur={() => {
            commitIfNeeded();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (commitIfNeeded()) {
                selectCell(
                  Math.min(selection.row + 1, sheet.rowCount),
                  selection.col,
                );
              }
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border)]/60 bg-[var(--background)] px-2 font-mono text-[12px] text-[var(--foreground)] outline-none"
        />
      </div>
      {error ? (
        <p className="border-b border-[var(--border)]/40 px-3 py-1 text-[11px] text-[var(--destructive)]">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[12px] text-[var(--foreground)]">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 border border-[var(--border)]/50 bg-[var(--muted)]/80 px-2 py-1 text-[10px] font-medium text-[var(--muted-foreground)]" />
              {Array.from({ length: sheet.colCount }, (_, index) => (
                <th
                  key={index}
                  className="sticky top-0 z-10 border border-[var(--border)]/50 bg-[var(--muted)]/70 px-2 py-1 text-center text-[10px] font-medium text-[var(--muted-foreground)]"
                >
                  {columnLabel(index + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((cells, rowIndex) => (
              <tr key={rowIndex}>
                <th className="sticky left-0 z-10 border border-[var(--border)]/50 bg-[var(--muted)]/55 px-2 py-1 text-right text-[10px] tabular-nums font-medium text-[var(--muted-foreground)]/80">
                  {rowIndex + 1}
                </th>
                {cells.map((cell, colIndex) => {
                  const selectedCell =
                    selection.sheetIndex === activeSheet &&
                    selection.row === rowIndex + 1 &&
                    selection.col === colIndex + 1;
                  const editingCell = selectedCell && editing && editable;
                  return (
                    <td
                      key={colIndex}
                      data-cell={`${columnLabel(colIndex + 1)}${rowIndex + 1}`}
                      onClick={() => selectCell(rowIndex + 1, colIndex + 1)}
                      onDoubleClick={() =>
                        editable && selectCell(rowIndex + 1, colIndex + 1, true)
                      }
                      className={`max-w-[280px] truncate border border-[var(--border)]/40 px-2 py-1 ${
                        selectedCell
                          ? "bg-[var(--primary)]/12 ring-1 ring-inset ring-[var(--primary)]/50"
                          : rowIndex === 0
                            ? "bg-[var(--muted)]/25"
                            : "bg-[var(--card)]"
                      }`}
                      title={formulaBarValue(cell)}
                    >
                      {editingCell ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => commitIfNeeded()}
                          className="h-5 w-full bg-transparent font-mono text-[12px] outline-none"
                        />
                      ) : (
                        cell.text
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.truncated || workbook.truncated ? (
          <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]/70">
            {t("Large sheet — preview truncated. Download for the full file.")}
          </p>
        ) : null}
        {editable ? (
          <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]/70">
            {t("Formulas are stored, not calculated. Excel or WPS will compute them.")}
          </p>
        ) : null}
      </div>

      {workbook.sheets.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--border)]/40 bg-[var(--muted)]/25 px-2 py-1.5">
          {workbook.sheets.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              type="button"
              data-sheet-tab={item.name}
              onClick={() => {
                commitIfNeeded();
                setActiveSheet(index);
                setSelection({ sheetIndex: index, row: 1, col: 1 });
                setEditing(false);
              }}
              className={`shrink-0 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                index === activeSheet
                  ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--card)]/70 hover:text-[var(--foreground)]"
              }`}
              title={item.name}
            >
              <span className="block max-w-[140px] truncate">{item.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
