import JSZip from 'jszip';
import { cellAddress, parseCellInput, type CellAddress, type SpreadsheetWorkbook, type ExcelJsModule } from './xlsx-workbook';
import { MAX_OFFICE_BYTES } from './native-library';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export type OfficeBlock = { id: string; part: string; label: string; values: string[] };
export type OfficeDocument = { kind: 'docx' | 'pptx' | 'xlsx'; zip: JSZip; blocks: OfficeBlock[]; grid?: SpreadsheetWorkbook; sheetPaths?: string[] };
const xml = (source: string) => { if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('文档包含不支持的 XML 声明'); const doc = new DOMParser().parseFromString(source, 'application/xml'); if (doc.querySelector('parsererror')) throw new Error('文档结构无法读取'); return doc; };
const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);

/** Check declared ZIP sizes before allocating decompressed Office content. */
export function checkOfficeZip(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_OFFICE_BYTES || bytes.byteLength < 22) throw new Error('Office 预览支持 25 MB 以内的文件');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (data.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('不是有效的 Office 文件');
  const count = data.getUint16(end + 10, true); let at = data.getUint32(end + 16, true), total = 0;
  if (count > 4096 || count === 0 || data.getUint16(end + 4, true) !== 0) throw new Error('文档结构超出预览范围');
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || data.getUint32(at, true) !== 0x02014b50) throw new Error('Office 压缩目录无效');
    const compressed = data.getUint32(at + 20, true), size = data.getUint32(at + 24, true); total += size;
    if (size > 32 * 1024 * 1024 || total > 96 * 1024 * 1024 || size / Math.max(1, compressed) > 500) throw new Error('解压后的文档过大，请下载后打开');
    at += 46 + data.getUint16(at + 28, true) + data.getUint16(at + 30, true) + data.getUint16(at + 32, true);
  }
}
async function partXml(zip: JSZip, name: string) { const file = zip.file(name); if (!file) throw new Error(`缺少文档内容：${name}`); const source = await file.async('string'); if (source.length > 12 * 1024 * 1024) throw new Error('文档内容过大'); return xml(source); }
export async function loadOffice(bytes: Uint8Array, kind: OfficeDocument['kind']): Promise<OfficeDocument> {
  checkOfficeZip(bytes); const zip = await JSZip.loadAsync(bytes); const blocks: OfficeBlock[] = [];
  if (kind === 'xlsx') {
    const { loadExcelWorkbook, spreadsheetFromWorkbook } = await import('./xlsx-workbook');
    const Excel = (await import('exceljs')).default;
    const workbook = await loadExcelWorkbook(Excel as unknown as ExcelJsModule, bytes);
    const main = await partXml(zip, 'xl/workbook.xml'), rels = await partXml(zip, 'xl/_rels/workbook.xml.rels');
    const sheetPaths = Array.from(main.getElementsByTagNameNS(S, 'sheet')).map(sheet => {
      const rel = Array.from(rels.documentElement.children).find(node => node.getAttribute('Id') === sheet.getAttributeNS(R, 'id'));
      const target = rel?.getAttribute('Target') ?? ''; if (rel?.getAttribute('TargetMode') === 'External' || target.includes('..') || target.includes('\\')) throw new Error('表格位置无法读取');
      return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    });
    return { kind, zip, blocks, grid: spreadsheetFromWorkbook(workbook, { editable: true }), sheetPaths };
  }
  const names = Object.keys(zip.files).filter(name => kind === 'docx' ? /^word\/(document|header\d+|footer\d+)\.xml$/.test(name) : /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!names.length) throw new Error('没有找到可读取的文字内容');
  for (const name of names) {
    const doc = await partXml(zip, name), paragraphs = Array.from(doc.getElementsByTagNameNS(kind === 'docx' ? W : A, 'p'));
    paragraphs.forEach((paragraph, i) => {
      const values = Array.from(paragraph.getElementsByTagNameNS(kind === 'docx' ? W : A, 't')).map(run => run.textContent ?? '');
      if (values.length) blocks.push({ id: `${name}:${i}`, part: name, label: kind === 'pptx' ? `幻灯片 ${name.match(/slide(\d+)\.xml/)?.[1]} · ${i + 1}` : `${name.includes('header') ? '页眉' : name.includes('footer') ? '页脚' : '段落'} ${i + 1}`, values });
    });
  }
  if (blocks.length > 4000) throw new Error('文字段落超过 4000，请下载后编辑');
  return { kind, zip, blocks };
}
export type CellChange = { address: CellAddress; raw: string };
export async function saveOffice(document: OfficeDocument, changes: Record<string, string>, cells: CellChange[] = []): Promise<Uint8Array<ArrayBuffer>> {
  const { zip, kind } = document; const parts = new Map<string, Document>();
  const get = async (name: string) => { if (!parts.has(name)) parts.set(name, await partXml(zip, name)); return parts.get(name)!; };
  for (const block of document.blocks) {
    const changesInBlock = block.values.some((_, i) => Object.hasOwn(changes, `${block.id}:${i}`)); if (!changesInBlock) continue;
    const doc = await get(block.part); const paragraph = doc.getElementsByTagNameNS(kind === 'docx' ? W : A, 'p')[Number(block.id.split(':').at(-1))];
    const runs = paragraph.getElementsByTagNameNS(kind === 'docx' ? W : A, 't');
    for (let i = 0; i < runs.length; i++) { const value = changes[`${block.id}:${i}`]; if (value !== undefined) { if (value.length > 100_000) throw new Error('单段文字过长'); runs[i].textContent = value; runs[i].setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); } }
  }
  for (const { address, raw } of cells) {
    const sheetPath = document.sheetPaths?.[address.sheetIndex]; if (!sheetPath) throw new Error('找不到工作表');
    const doc = await get(sheetPath), data = doc.getElementsByTagNameNS(S, 'sheetData')[0]; if (!data) throw new Error('找不到表格数据');
    if (doc.getElementsByTagNameNS(S, 'sheetProtection').length) throw new Error('这张工作表受保护，请在原应用中取消保护');
    const ref = cellAddress(address.row, address.col);
    for (const formula of Array.from(doc.getElementsByTagNameNS(S, 'f'))) { const range = formula.getAttribute('ref'); if (range) { const [start, end = start] = range.split(':'); const number = (value: string) => { const match = /^([A-Z]+)(\d+)$/.exec(value); if (!match) throw new Error('公式范围无法读取'); return [Array.from(match[1]).reduce((col, char) => col * 26 + char.charCodeAt(0) - 64, 0), Number(match[2])]; }; const [c1, r1] = number(start), [c2, r2] = number(end); if (address.row >= r1 && address.row <= r2 && address.col >= c1 && address.col <= c2) throw new Error('数组或共享公式区域请在原应用中编辑'); } }
    let row = Array.from(data.children).find(node => node.getAttribute('r') === String(address.row));
    if (!row) { row = doc.createElementNS(S, 'row'); row.setAttribute('r', String(address.row)); data.insertBefore(row, Array.from(data.children).find(node => Number(node.getAttribute('r')) > address.row) ?? null); }
    let cell = Array.from(row.children).find(node => node.getAttribute('r') === ref);
    if (!cell) { cell = doc.createElementNS(S, 'c'); cell.setAttribute('r', ref); const col = (node: Element) => (node.getAttribute('r')?.match(/^[A-Z]+/)?.[0] ?? '').split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0); row.insertBefore(cell, Array.from(row.children).find(node => col(node) > address.col) ?? null); }
    if (cell.getElementsByTagNameNS(S, 'f')[0]?.getAttribute('t') === 'shared') throw new Error('共享公式请在原应用中编辑');
    const parsed = parseCellInput(raw); if (!parsed.ok) throw new Error(parsed.error);
    for (const child of Array.from(cell.children)) if (['v', 'f', 'is'].includes(child.localName)) child.remove(); cell.removeAttribute('t');
    const element = (name: string, text: string) => { const node = doc.createElementNS(S, name); node.textContent = text; return node; };
    if (typeof parsed.value === 'number') cell.append(element('v', String(parsed.value)));
    else if (typeof parsed.value === 'string') { cell.setAttribute('t', 'inlineStr'); const inline = doc.createElementNS(S, 'is'), text = element('t', parsed.value); text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); inline.append(text); cell.append(inline); }
    else if (parsed.value) cell.append(element('f', parsed.value.formula));
    // Existing dimensions are only a hint; include cells added inside the editable grid.
    doc.getElementsByTagNameNS(S, 'dimension')[0]?.remove();
  }
  if (cells.length) {
    const doc = await get('xl/workbook.xml'); let calc = doc.getElementsByTagNameNS(S, 'calcPr')[0]; if (!calc) { calc = doc.createElementNS(S, 'calcPr'); doc.documentElement.append(calc); } calc.setAttribute('fullCalcOnLoad', '1'); calc.setAttribute('forceFullCalc', '1'); calc.setAttribute('calcMode', 'auto');
  }
  // Only changed XML parts are replaced; drawings, styles, media and unrelated parts stay byte-identical.
  const copy = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
  for (const [name, doc] of parts) copy.file(name, serialize(doc));
  return new Uint8Array(await copy.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
}
