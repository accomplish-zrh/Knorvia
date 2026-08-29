import test from "node:test";
import assert from "node:assert/strict";

import ExcelJS from "exceljs";
import {
  applyCellEdit,
  columnLabel,
  formulaBarValue,
  isOoxmlZip,
  loadExcelWorkbook,
  MAX_SPREADSHEET_BYTES,
  parseCellInput,
  spreadsheetFromWorkbook,
  type ExcelJsModule,
} from "../lib/xlsx-workbook";

test("columnLabel uses Excel-style letters", () => {
  assert.equal(columnLabel(1), "A");
  assert.equal(columnLabel(26), "Z");
  assert.equal(columnLabel(27), "AA");
  assert.equal(columnLabel(52), "AZ");
});

test("parseCellInput stores formulas without evaluating them", () => {
  assert.deepEqual(parseCellInput(""), { ok: true, value: null });
  assert.deepEqual(parseCellInput("42"), { ok: true, value: 42 });
  assert.deepEqual(parseCellInput("=B1*2"), { ok: true, value: { formula: "B1*2" } });
  assert.equal(parseCellInput("=javascript:alert(1)").ok, false);
  assert.equal(parseCellInput("=HYPERLINK(\"javascript:alert(1)\")").ok, false);
  assert.equal(parseCellInput(`=${"x".repeat(9000)}`).ok, false);
});

test("isOoxmlZip checks the ZIP magic", () => {
  assert.equal(isOoxmlZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.equal(isOoxmlZip(new Uint8Array([0x00, 0x01, 0x02, 0x03])), false);
});

test("loadExcelWorkbook rejects invalid and oversized buffers", async () => {
  await assert.rejects(
    () => loadExcelWorkbook(ExcelJS as unknown as ExcelJsModule, new Uint8Array([1, 2, 3, 4])),
    /Invalid spreadsheet file/,
  );
  const oversized = new Uint8Array(MAX_SPREADSHEET_BYTES + 1);
  oversized.set([0x50, 0x4b, 0x03, 0x04]);
  await assert.rejects(
    () => loadExcelWorkbook(ExcelJS as unknown as ExcelJsModule, oversized),
    /too large/,
  );
});

test("exceljs round-trip keeps a second sheet and formula text", async () => {
  const created = new ExcelJS.Workbook();
  const sales = created.addWorksheet("Sales");
  sales.getCell("A1").value = "header";
  sales.getCell("B1").value = 10;
  sales.getCell("B2").value = { formula: "B1*2" };
  const notes = created.addWorksheet("Notes");
  notes.getCell("A1").value = "second-sheet";
  const buffer = await created.xlsx.writeBuffer();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  const loaded = await loadExcelWorkbook(ExcelJS as unknown as ExcelJsModule, bytes);
  const model = spreadsheetFromWorkbook(loaded, { editable: true });
  assert.equal(model.sheets.length, 2);
  assert.equal(model.sheets[0]?.name, "Sales");
  assert.equal(model.sheets[1]?.rows[0]?.[0]?.text, "second-sheet");
  assert.equal(formulaBarValue(model.sheets[0]?.rows[1]?.[1]), "=B1*2");

  applyCellEdit(loaded, { sheetIndex: 0, row: 1, col: 1 }, "kept");
  const after = spreadsheetFromWorkbook(loaded);
  assert.equal(after.sheets[0]?.rows[0]?.[0]?.text, "kept");
  assert.equal(after.sheets[1]?.rows[0]?.[0]?.text, "second-sheet");
});
