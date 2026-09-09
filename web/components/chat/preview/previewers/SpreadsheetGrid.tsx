"use client";

import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  cellAddress,
  columnLabel,
  formulaBarValue,
  type CellAddress,
  type SpreadsheetWorkbook,
} from "@/lib/xlsx-workbook";

export type GridCell = { row: number; col: number };
export type GridRange = { sheetIndex: number; from: GridCell; to: GridCell };

function normalize(from: GridCell, to: GridCell): { from: GridCell; to: GridCell } {
  return {
    from: {
      row: Math.min(from.row, to.row),
      col: Math.min(from.col, to.col),
    },
    to: {
      row: Math.max(from.row, to.row),
      col: Math.max(from.col, to.col),
    },
  };
}

export default function SpreadsheetGrid({
  workbook,
  editable = false,
  error = "",
  onCommit,
  onSelectionChange,
  changedCells,
}: {
  workbook: SpreadsheetWorkbook;
  editable?: boolean;
  error?: string;
  onCommit?: (address: CellAddress, raw: string) => void;
  /** Reports the selected rectangle (single cells included) for a frozen turn selection. */
  onSelectionChange?: (range: GridRange, sheetName: string) => void;
  /** "Sheet!A1" addresses to highlight, e.g. the cells a draft's last diff touched. */
  changedCells?: string[];
}) {
  const { t } = useTranslation();
  const [activeSheet, setActiveSheet] = useState(0);
  const [anchor, setAnchor] = useState<GridCell>({ row: 1, col: 1 });
  const [focus, setFocus] = useState<GridCell>({ row: 1, col: 1 });
  const [selectionSheet, setSelectionSheet] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const dragging = useRef(false);
  const [formulaEditing, setFormulaEditing] = useState(false);

  const sheet =
    workbook.sheets[Math.min(activeSheet, Math.max(workbook.sheets.length - 1, 0))];
  const bounds = useMemo(() => normalize(anchor, focus), [anchor, focus]);
  const selected =
    selectionSheet === activeSheet
      ? sheet?.rows[focus.row - 1]?.[focus.col - 1]
      : undefined;
  const changed = useMemo(() => new Set(changedCells ?? []), [changedCells]);

  const formulaValue = useMemo(() => {
    if (editing && selectionSheet === activeSheet) return draft;
    return formulaBarValue(selected);
  }, [activeSheet, draft, editing, selected, selectionSheet]);

  const rangeLabel = `${cellAddress(bounds.from.row, bounds.from.col)}${
    bounds.from.row === bounds.to.row && bounds.from.col === bounds.to.col
      ? ""
      : `:${cellAddress(bounds.to.row, bounds.to.col)}`
  }`;

  if (!sheet) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-[12px] text-[var(--muted-foreground)]">
        {t("This workbook has no sheets to preview.")}
      </div>
    );
  }

  function report(sheetIndex: number, from: GridCell, to: GridCell) {
    if (!onSelectionChange) return;
    const span = normalize(from, to);
    onSelectionChange(
      { sheetIndex, from: span.from, to: span.to },
      workbook.sheets[sheetIndex]?.name || "",
    );
  }

  function selectCell(
    row: number,
    col: number,
    options: { extend?: boolean; startEdit?: boolean } = {},
  ) {
    if (editing && !commitIfNeeded()) return;
    const { extend = false, startEdit = false } = options;
    const next = { row, col };
    const from = extend ? anchor : next;
    if (!extend) setAnchor(next);
    setFocus(next);
    setSelectionSheet(activeSheet);
    const cell = sheet.rows[row - 1]?.[col - 1];
    setDraft(formulaBarValue(cell));
    setEditing(startEdit);
    report(activeSheet, from, next);
  }

  function onMouseDownCell(event: MouseEvent<HTMLTableCellElement>, row: number, col: number) {
    // Left button only; a plain click selects one cell, then dragging extends.
    if (event.button !== 0) return;
    setFormulaEditing(false);
    dragging.current = true;
    selectCell(row, col, { extend: event.shiftKey });
  }

  function onMouseEnterCell(row: number, col: number) {
    if (!dragging.current) return;
    selectCell(row, col, { extend: true });
  }

  function endDrag() {
    dragging.current = false;
  }

  function commitIfNeeded(): boolean {
    if (!editing || !onCommit) {
      setEditing(false);
      return true;
    }
    try {
      onCommit({ sheetIndex: activeSheet, row: focus.row, col: focus.col }, draft);
      setEditing(false);
      return true;
    } catch {
      return false;
    }
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (!sheet) return;
    const maxRow = sheet.rowCount;
    const maxCol = sheet.colCount;
    if (editing) {
      if (event.key === "Enter") {
        event.preventDefault();
        if (commitIfNeeded()) {
          selectCell(Math.min(focus.row + 1, maxRow), focus.col);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        setDraft(formulaBarValue(selected));
        setEditing(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        if (commitIfNeeded()) {
          const nextCol = event.shiftKey
            ? Math.max(1, focus.col - 1)
            : Math.min(maxCol, focus.col + 1);
          selectCell(focus.row, nextCol);
        }
      }
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      if (!editable) return;
      event.preventDefault();
      setFormulaEditing(false);
      selectCell(focus.row, focus.col, { startEdit: true });
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
        Math.min(maxRow, Math.max(1, focus.row + delta[0])),
        Math.min(maxCol, Math.max(1, focus.col + delta[1])),
        { extend: event.shiftKey },
      );
    } else if (editable && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      setFormulaEditing(false);
      setDraft(event.key);
      setEditing(true);
    }
  }

  function cellState(row: number, col: number) {
    if (selectionSheet !== activeSheet) return { inRange: false, isFocus: false };
    const inRange =
      row >= bounds.from.row &&
      row <= bounds.to.row &&
      col >= bounds.from.col &&
      col <= bounds.to.col;
    return { inRange, isFocus: row === focus.row && col === focus.col };
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--card)]"
      data-spreadsheet-grid=""
      data-editable={editable ? "true" : "false"}
      data-selection-range={sheet ? `${sheet.name}!${rangeLabel}` : ""}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)]/50 bg-[var(--muted)]/20 px-2 py-1.5">
        <span
          data-selection-label=""
          className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]"
        >
          {rangeLabel}
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
              setFormulaEditing(true);
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
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (commitIfNeeded()) {
                selectCell(
                  Math.min(focus.row + 1, sheet.rowCount),
                  focus.col,
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
                  const address = `${columnLabel(colIndex + 1)}${rowIndex + 1}`;
                  const { inRange, isFocus } = cellState(rowIndex + 1, colIndex + 1);
                  const editingCell = isFocus && editing && editable;
                  const isChanged = changed.has(`${sheet.name}!${address}`);
                  return (
                    <td
                      key={colIndex}
                      data-cell={address}
                      data-changed={isChanged ? "true" : undefined}
                      onMouseDown={(event) =>
                        onMouseDownCell(event, rowIndex + 1, colIndex + 1)
                      }
                      onMouseEnter={() => onMouseEnterCell(rowIndex + 1, colIndex + 1)}
                      onDoubleClick={() =>
                        editable && selectCell(rowIndex + 1, colIndex + 1, { startEdit: true })
                      }
                      className={`max-w-[280px] truncate border border-[var(--border)]/40 px-2 py-1 ${
                        isFocus
                          ? "bg-[var(--primary)]/12 ring-1 ring-inset ring-[var(--primary)]/50"
                          : inRange
                            ? "bg-[var(--primary)]/8"
                            : isChanged
                              ? "bg-amber-500/12"
                              : rowIndex === 0
                                ? "bg-[var(--muted)]/25"
                                : "bg-[var(--card)]"
                      }${isChanged ? " outline outline-1 -outline-offset-1 outline-amber-500/60" : ""}`}
                      title={
                        isChanged
                          ? `${formulaBarValue(cell)} — ${t("Changed in this draft")}`
                          : formulaBarValue(cell)
                      }
                    >
                      {editingCell && !formulaEditing ? (
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
        {changed.size ? (
          <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]/70">
            {t("Highlighted cells changed in this draft.")}
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
                const reset = { row: 1, col: 1 };
                setAnchor(reset);
                setFocus(reset);
                setSelectionSheet(index);
                setEditing(false);
                report(index, reset, reset);
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
