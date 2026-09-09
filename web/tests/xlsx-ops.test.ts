import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SAVE_OPERATIONS,
  TooManyOperationsError,
  chunkOperations,
  diffWorkbookToOperations,
  type OfficeOperation,
} from "../lib/xlsx-ops";
import type { SpreadsheetCell, SpreadsheetWorkbook } from "../lib/xlsx-workbook";

function parseSpec(spec: string): SpreadsheetCell {
  if (spec.startsWith("=")) return { text: `=${spec.slice(1)}`, formula: spec.slice(1) };
  return { text: spec };
}

function book(
  cells: Record<string, string>,
  { rows = 20, cols = 8, name = "Sheet1" } = {},
): SpreadsheetWorkbook {
  const grid: SpreadsheetCell[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: SpreadsheetCell[] = [];
    for (let col = 0; col < cols; col += 1) line.push({ text: "" });
    grid.push(line);
  }
  for (const [address, spec] of Object.entries(cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    assert.ok(match, `bad address ${address}`);
    let col = 0;
    for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    grid[Number(match[2]) - 1][col - 1] = parseSpec(spec);
  }
  return {
    sheets: [{ name, rows: grid, truncated: false, rowCount: rows, colCount: cols }],
    truncated: false,
  };
}

test("no differences produce no operations", () => {
  const base = book({ A1: "keep", B2: "=SUM(A1:A2)", C3: "42" });
  assert.deepEqual(diffWorkbookToOperations(base, base), []);
});

test("text edits emit set_cell text", () => {
  const ops = diffWorkbookToOperations(book({ A1: "old" }), book({ A1: "new name" }));
  assert.deepEqual(ops, [{ op: "set_cell", sheet: "Sheet1", cell: "A1", text: "new name" }]);
});

test("numeric-looking edits emit set_cell number", () => {
  const ops = diffWorkbookToOperations(book({ A1: "" }), book({ A1: "42.5" }));
  assert.deepEqual(ops, [{ op: "set_cell", sheet: "Sheet1", cell: "A1", number: 42.5 }]);
});

test("leading-zero text stays text", () => {
  const ops = diffWorkbookToOperations(book({ A1: "" }), book({ A1: "007" }));
  assert.deepEqual(ops, [{ op: "set_cell", sheet: "Sheet1", cell: "A1", text: "007" }]);
});

test("boolean-looking edits emit set_cell boolean", () => {
  const ops = diffWorkbookToOperations(book({ A1: "" }), book({ A1: "true" }));
  assert.deepEqual(ops, [{ op: "set_cell", sheet: "Sheet1", cell: "A1", boolean: true }]);
});

test("cleared cells emit clear_cells on a single-cell range", () => {
  const ops = diffWorkbookToOperations(book({ B2: "gone" }), book({}));
  assert.deepEqual(ops, [{ op: "clear_cells", sheet: "Sheet1", range: "B2" }]);
});

test("new and edited formulas emit set_formula with a leading '='", () => {
  const ops = diffWorkbookToOperations(
    book({ A1: "=SUM(B1:B2)" }),
    book({ A1: "=SUM(B1:B3)", C1: "=A1*2" }),
  );
  assert.deepEqual(ops, [
    { op: "set_formula", sheet: "Sheet1", cell: "A1", formula: "=SUM(B1:B3)" },
    { op: "set_formula", sheet: "Sheet1", cell: "C1", formula: "=A1*2" },
  ]);
});

test("a formula replaced by plain text falls back to set_cell", () => {
  const ops = diffWorkbookToOperations(book({ A1: "=SUM(B1)" }), book({ A1: "done" }));
  assert.deepEqual(ops, [{ op: "set_cell", sheet: "Sheet1", cell: "A1", text: "done" }]);
});

test("matching by sheet name and row-major ordering", () => {
  const base: SpreadsheetWorkbook = {
    truncated: false,
    sheets: [
      book({}, { name: "A" }).sheets[0],
      book({}, { name: "B" }).sheets[0],
    ],
  };
  const current: SpreadsheetWorkbook = {
    truncated: false,
    sheets: [
      book({ A2: "second" }, { name: "A" }).sheets[0],
      book({ A1: "first" }, { name: "B" }).sheets[0],
    ],
  };
  const ops = diffWorkbookToOperations(base, current);
  assert.deepEqual(ops, [
    { op: "set_cell", sheet: "A", cell: "A2", text: "second" },
    { op: "set_cell", sheet: "B", cell: "A1", text: "first" },
  ]);
});

test("addresses stay correct past column Z", () => {
  const base = book({ AA1: "" }, { rows: 20, cols: 30 });
  const current = book({ AA1: "wide" }, { rows: 20, cols: 30 });
  const ops = diffWorkbookToOperations(base, current);
  assert.deepEqual(ops, [{ op: "set_cell", sheet: "Sheet1", cell: "AA1", text: "wide" }]);
});

test("diffs at or below the cap are returned; above it they throw", () => {
  const grid = (rows: number, cols: number, fill: string): SpreadsheetWorkbook => {
    const lines: SpreadsheetCell[][] = [];
    for (let row = 0; row < rows; row += 1) {
      const line: SpreadsheetCell[] = [];
      for (let col = 0; col < cols; col += 1) line.push({ text: fill });
      lines.push(line);
    }
    return {
      sheets: [{ name: "S", rows: lines, truncated: false, rowCount: rows, colCount: cols }],
      truncated: false,
    };
  };
  const exact = diffWorkbookToOperations(grid(25, 16, ""), grid(25, 16, "x"));
  assert.equal(exact.length, MAX_SAVE_OPERATIONS);
  assert.throws(
    () => diffWorkbookToOperations(grid(25, 16, ""), grid(26, 16, "x")),
    TooManyOperationsError,
  );
});

test("chunkOperations splits at 200 and keeps order", () => {
  const ops = Array.from({ length: 450 }, (_, index) => ({
    op: "set_cell" as const,
    sheet: "S",
    cell: `A${index + 1}`,
    text: String(index),
  }));
  const chunks = chunkOperations(ops);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [200, 200, 50],
  );
  const target = (chunk: OfficeOperation): string =>
    chunk.op === "clear_cells" ? chunk.range : chunk.cell;
  assert.equal(target(chunks[0][0]), "A1");
  assert.equal(target(chunks[2][49]), "A450");
  assert.equal(chunks.flat().length, ops.length);
});
