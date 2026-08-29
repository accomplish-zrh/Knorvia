/**
 * Spreadsheet preview/edit helpers on top of ExcelJS.
 *
 * ExcelJS is passed in so the parser stays lazy-loaded. Formulas are stored
 * as text; this module never evaluates them.
 */

export const MAX_SPREADSHEET_BYTES = 25 * 1024 * 1024
export const MAX_SPREADSHEET_ROWS = 1000
export const MAX_SPREADSHEET_COLS = 60
export const MAX_SPREADSHEET_SHEETS = 32
export const MAX_CELL_CHARS = 8_000
export const MIN_EDIT_ROWS = 20
export const MIN_EDIT_COLS = 8

const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const
const BLOCKED_FORMULA =
  /javascript:|data:\s*text\/html|vbscript:|file:|\\\\|\bcmd\s*\|/i

export type SpreadsheetCell = {
  text: string
  formula?: string
}

export type SpreadsheetSheet = {
  name: string
  rows: SpreadsheetCell[][]
  truncated: boolean
  rowCount: number
  colCount: number
}

export type SpreadsheetWorkbook = {
  sheets: SpreadsheetSheet[]
  truncated: boolean
}

export type CellAddress = {
  sheetIndex: number
  row: number
  col: number
}

export type ParsedCellInput =
  | { ok: true; value: null | string | number | { formula: string } }
  | { ok: false; error: string }

type ExcelCell = {
  text?: unknown
  formula?: unknown
  value?: unknown
}

type ExcelRow = {
  getCell: (col: number) => ExcelCell
}

type ExcelWorksheet = {
  name: string
  columnCount: number
  rowCount: number
  getRow: (row: number) => ExcelRow
  getCell: (row: number, col: number) => ExcelCell & { value: unknown }
}

type ExcelWorkbook = {
  worksheets: ExcelWorksheet[]
  xlsx: {
    load: (data: ArrayBuffer | Uint8Array) => Promise<unknown>
    writeBuffer: () => Promise<ArrayBuffer | Uint8Array | Blob>
  }
}

export type ExcelJsModule = {
  Workbook: new () => ExcelWorkbook
}

export function isOoxmlZip(bytes: ArrayBuffer | Uint8Array): boolean {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view.byteLength < 4) return false
  return OOXML_MAGIC.every((part, index) => view[index] === part)
}

export function columnLabel(index1: number): string {
  if (index1 < 1) return ""
  let n = index1
  let label = ""
  while (n > 0) {
    const rem = (n - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

export function cellAddress(row1: number, col1: number): string {
  return `${columnLabel(col1)}${row1}`
}

export function formulaBarValue(cell: SpreadsheetCell | undefined): string {
  if (!cell) return ""
  if (cell.formula) return `=${cell.formula}`
  return cell.text
}

export function sanitizeCellText(value: unknown): string {
  let text = ""
  if (typeof value === "string") text = value
  else if (value == null) text = ""
  else text = String(value)
  text = text.replace(/\u0000/g, "")
  if (text.length > MAX_CELL_CHARS) return `${text.slice(0, MAX_CELL_CHARS)}…`
  return text
}

export function parseCellInput(raw: string): ParsedCellInput {
  const value = raw.replace(/\u0000/g, "")
  if (value.length > MAX_CELL_CHARS) {
    return { ok: false, error: "Cell text is too long." }
  }
  if (value === "") return { ok: true, value: null }
  if (value.startsWith("=")) {
    const formula = value.slice(1).trim()
    if (!formula) return { ok: false, error: "Formula is empty." }
    if (BLOCKED_FORMULA.test(formula)) {
      return { ok: false, error: "That formula is not allowed." }
    }
    return { ok: true, value: { formula } }
  }
  const trimmed = value.trim()
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed)
    if (Number.isFinite(number)) return { ok: true, value: number }
  }
  return { ok: true, value }
}

export function describeExcelCell(cell: ExcelCell): SpreadsheetCell {
  const formula =
    typeof cell.formula === "string" && cell.formula.trim()
      ? cell.formula.replace(/\u0000/g, "")
      : undefined
  let text = ""
  try {
    text = sanitizeCellText(cell.text ?? "")
  } catch {
    text = ""
  }
  if (!text && formula) text = `=${formula}`
  return {
    text,
    ...(formula ? { formula } : {}),
  }
}

function sheetDimensions(
  worksheet: ExcelWorksheet,
  { editable }: { editable: boolean },
): { rows: number; cols: number; truncated: boolean } {
  const minRows = editable ? MIN_EDIT_ROWS : 1
  const minCols = editable ? MIN_EDIT_COLS : 1
  const sourceRows = Math.max(worksheet.rowCount || 0, minRows)
  const sourceCols = Math.max(worksheet.columnCount || 0, minCols)
  return {
    rows: Math.min(sourceRows, MAX_SPREADSHEET_ROWS),
    cols: Math.min(sourceCols, MAX_SPREADSHEET_COLS),
    truncated:
      sourceRows > MAX_SPREADSHEET_ROWS || sourceCols > MAX_SPREADSHEET_COLS,
  }
}

export function spreadsheetFromWorkbook(
  workbook: ExcelWorkbook,
  options: { editable?: boolean } = {},
): SpreadsheetWorkbook {
  const editable = Boolean(options.editable)
  const worksheets = Array.from(workbook.worksheets).slice(0, MAX_SPREADSHEET_SHEETS)
  const sheets = worksheets.map((worksheet) => {
    const dims = sheetDimensions(worksheet, { editable })
    const rows: SpreadsheetCell[][] = []
    for (let row = 1; row <= dims.rows; row += 1) {
      const excelRow = worksheet.getRow(row)
      const cells: SpreadsheetCell[] = []
      for (let col = 1; col <= dims.cols; col += 1) {
        cells.push(describeExcelCell(excelRow.getCell(col)))
      }
      rows.push(cells)
    }
    return {
      name: sanitizeCellText(worksheet.name || "Sheet").slice(0, 31) || "Sheet",
      rows,
      truncated: dims.truncated,
      rowCount: dims.rows,
      colCount: dims.cols,
    }
  })
  return {
    sheets,
    truncated: Array.from(workbook.worksheets).length > MAX_SPREADSHEET_SHEETS,
  }
}

export async function loadExcelWorkbook(
  exceljs: ExcelJsModule,
  buffer: ArrayBuffer | Uint8Array,
): Promise<ExcelWorkbook> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.byteLength > MAX_SPREADSHEET_BYTES) {
    throw new Error("File is too large to preview. Use the Download button.")
  }
  if (!isOoxmlZip(bytes)) {
    throw new Error("Invalid spreadsheet file.")
  }
  const workbook = new exceljs.Workbook()
  await workbook.xlsx.load(bytes as never)
  if (!workbook.worksheets.length) {
    throw new Error("This workbook has no sheets to preview.")
  }
  return workbook
}

export function applyCellEdit(
  workbook: ExcelWorkbook,
  address: CellAddress,
  raw: string,
): SpreadsheetCell {
  const worksheet = workbook.worksheets[address.sheetIndex]
  if (!worksheet) throw new Error("Sheet was not found.")
  if (
    address.row < 1 ||
    address.col < 1 ||
    address.row > MAX_SPREADSHEET_ROWS ||
    address.col > MAX_SPREADSHEET_COLS
  ) {
    throw new Error("Cell is outside the editable range.")
  }
  const parsed = parseCellInput(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  const cell = worksheet.getCell(address.row, address.col)
  cell.value = parsed.value
  return describeExcelCell(cell)
}

export async function workbookToXlsxFile(
  workbook: ExcelWorkbook,
  filename = "workbook.xlsx",
): Promise<File> {
  const output = await workbook.xlsx.writeBuffer()
  const bytes =
    output instanceof Uint8Array
      ? output
      : output instanceof ArrayBuffer
        ? new Uint8Array(output)
        : new Uint8Array(await new Response(output).arrayBuffer())
  if (bytes.byteLength > MAX_SPREADSHEET_BYTES) {
    throw new Error("Workbook is too large to save here.")
  }
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return new File([copy], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
}
