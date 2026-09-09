/**
 * Diff a baseline spreadsheet model against the edited one and emit a strict
 * Office-artifact operation batch — the same typed protocol the agent uses.
 *
 * Pure data module (no ExcelJS import) so node tests can run it directly.
 * Cell text is the display text produced by ``describeExcelCell`` — ExcelJS
 * rich text arrives concatenated and dates arrive formatted — so the diff
 * compares exactly what the editor shows.
 */

import { cellAddress, type SpreadsheetWorkbook } from "@/lib/xlsx-workbook";

export const MAX_SAVE_OPERATIONS = 400;
export const MAX_OPERATIONS_PER_BATCH = 200;

export type OfficeOperation =
  | {
      op: "set_cell";
      sheet: string;
      cell: string;
      text?: string;
      number?: number;
      boolean?: boolean;
      empty?: boolean;
    }
  | { op: "set_formula"; sheet: string; cell: string; formula: string }
  | { op: "clear_cells"; sheet: string; range: string };

export class TooManyOperationsError extends Error {
  count: number;

  constructor(count: number) {
    super(
      `Spreadsheet diff produced ${count} operations (max ${MAX_SAVE_OPERATIONS}).`,
    );
    this.name = "TooManyOperationsError";
    this.count = count;
  }
}

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function numericValue(text: string): number | null {
  const trimmed = text.trim();
  if (!NUMBER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function displayText(cell: { text?: string; formula?: string } | undefined): string {
  if (!cell) return "";
  if (cell.formula) return `=${cell.formula}`;
  return cell.text ?? "";
}

export function diffWorkbookToOperations(
  baseline: SpreadsheetWorkbook,
  current: SpreadsheetWorkbook,
): OfficeOperation[] {
  const operations: OfficeOperation[] = [];
  const currentByName = new Map(current.sheets.map((sheet) => [sheet.name, sheet]));
  for (const baseSheet of baseline.sheets) {
    const nextSheet = currentByName.get(baseSheet.name);
    if (!nextSheet) continue;
    const rowCount = Math.max(baseSheet.rowCount, nextSheet.rowCount);
    const colCount = Math.max(baseSheet.colCount, nextSheet.colCount);
    for (let row = 0; row < rowCount; row += 1) {
      for (let col = 0; col < colCount; col += 1) {
        const before = baseSheet.rows[row]?.[col];
        const after = nextSheet.rows[row]?.[col];
        const beforeText = displayText(before);
        const afterText = displayText(after);
        if (beforeText === afterText) continue;
        const address = cellAddress(row + 1, col + 1);
        if (after?.formula) {
          operations.push({
            op: "set_formula",
            sheet: baseSheet.name,
            cell: address,
            formula: `=${after.formula}`,
          });
          continue;
        }
        if (afterText === "") {
          operations.push({
            op: "clear_cells",
            sheet: baseSheet.name,
            range: address,
          });
          continue;
        }
        if (afterText === "true" || afterText === "false") {
          operations.push({
            op: "set_cell",
            sheet: baseSheet.name,
            cell: address,
            boolean: afterText === "true",
          });
          continue;
        }
        const number = numericValue(afterText);
        if (number !== null) {
          operations.push({
            op: "set_cell",
            sheet: baseSheet.name,
            cell: address,
            number,
          });
          continue;
        }
        operations.push({
          op: "set_cell",
          sheet: baseSheet.name,
          cell: address,
          text: afterText,
        });
      }
    }
  }
  if (operations.length > MAX_SAVE_OPERATIONS) {
    throw new TooManyOperationsError(operations.length);
  }
  return operations;
}

export function chunkOperations(
  operations: OfficeOperation[],
  size = MAX_OPERATIONS_PER_BATCH,
): OfficeOperation[][] {
  const chunks: OfficeOperation[][] = [];
  for (let index = 0; index < operations.length; index += size) {
    chunks.push(operations.slice(index, index + size));
  }
  return chunks;
}
