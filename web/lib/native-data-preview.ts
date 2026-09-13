/**
 * Read-only structured review for CSV/TSV/JSON project files (B18).
 *
 * Everything is derived from the already-loaded text: no extra file reads, no
 * writes, no formula execution, no type conversion. Numbers keep their raw
 * lexemes (JSON.parse would silently lose precision on long values), and all
 * bounds are explicit so a 100k-row table or a deeply nested document stays
 * a bounded render with an honest truncation note.
 */

export type CsvTable = {
  headers: string[];
  rows: string[][];
  /** The text ran out before the table was complete (quote left open). */
  truncated: boolean;
  delimiter: string;
};

export const CSV_MAX_ROWS = 1000;
export const CSV_MAX_ROW_CHARS = 20_000;
const DELIMITER_CANDIDATES = [",", "\t", ";", "|"];

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 4000);
  let best = ","; let bestCount = -1;
  for (const candidate of DELIMITER_CANDIDATES) {
    let count = 0; let inQuotes = false;
    for (let index = 0; index < sample.length; index += 1) {
      const char = sample[index];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) { best = candidate; bestCount = count; }
  }
  return best;
}

/** RFC4180-style parser: quoted fields may contain delimiters and newlines. */
export function parseCsv(rawText: string, options: { delimiter?: string; maxRows?: number; maxRowChars?: number } = {}): CsvTable {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const delimiter = options.delimiter ?? (text.slice(0, 4000).includes("\t") && !text.slice(0, 4000).includes(",") ? "\t" : detectDelimiter(text));
  const maxRows = options.maxRows ?? CSV_MAX_ROWS;
  const maxRowChars = options.maxRowChars ?? CSV_MAX_ROW_CHARS;
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let truncated = false;
  let emitted = 0;
  let rowChars = 0;
  let stopped = false;
  const pushField = () => { if (field.length > maxRowChars) truncated = true; row.push(field.slice(0, maxRowChars)); field = ""; };
  const pushRow = () => {
    pushField();
    if (emitted >= maxRows) { truncated = true; row = []; return; }
    rows.push(row); emitted += 1; row = []; rowChars = 0;
  };
  for (let index = 0; index < text.length; index += 1) {
    if (emitted >= maxRows || row.length >= 512 || rowChars >= maxRowChars || index >= 4 * 1024 * 1024) { truncated = true; stopped = true; break; }
    rowChars += 1;
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === delimiter) pushField();
    else if (char === "\n") pushRow();
    else if (char === "\r") { /* \r\n handled by the \n branch */ }
    else field += char;
  }
  if (inQuotes) truncated = true;
  else if (!stopped && (field.length > 0 || row.length > 0)) pushRow();
  const headers = rows[0] ?? [];
  return { headers, rows: rows.slice(1), truncated, delimiter };
}

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";
export type JsonNode = {
  kind: JsonKind;
  /** Raw lexeme for numbers (never run through Number), string value as-is. */
  value?: string;
  entries?: { key: string; node: JsonNode }[];
  childCount?: number;
  /** Exact offsets in the supplied source, including any leading BOM. */
  start?: number;
  end?: number;
};

export type JsonPreviewResult = {
  valid: boolean;
  root?: JsonNode;
  /** Explain invalid or over-budget documents instead of faking a tree. */
  error?: string;
};

export const JSON_MAX_NODES = 5000;
export const JSON_MAX_DEPTH = 32;
export const JSON_MAX_STRING = 20_000;

/** Bounded JSON parser that preserves number lexemes verbatim. */
export function parseJsonPreview(rawText: string, options: { maxNodes?: number; maxDepth?: number; maxString?: number } = {}): JsonPreviewResult {
  const maxNodes = options.maxNodes ?? JSON_MAX_NODES;
  const maxDepth = options.maxDepth ?? JSON_MAX_DEPTH;
  const maxString = options.maxString ?? JSON_MAX_STRING;
  const text = rawText;
  if (text.length > 4 * 1024 * 1024) return { valid: false, error: "JSON exceeds the 4 MiB preview bound; use raw text." };
  let nodes = 0;
  let pos = text.startsWith("\uFEFF") ? 1 : 0;
  let failureReason = "";

  const lineCol = (at: number): string => {
    let line = 1; let column = 1;
    for (let index = 0; index < at && index < text.length; index += 1) {
      if (text[index] === "\n") { line += 1; column = 1; } else column += 1;
    }
    return `${line}:${column}`;
  };

  const fail = (reason: string, at: number): JsonPreviewResult => ({ valid: false, error: `${reason} (line ${lineCol(at)})` });

  const skipWhitespace = () => { while (pos < text.length && " \t\r\n".includes(text[pos])) pos += 1; };

  const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

  const parseString = (): string | null => {
    // pos is at the opening quote
    let out = "";
    pos += 1;
    while (pos < text.length) {
      const char = text[pos];
      if (char === '"') { pos += 1; return out; }
      if (char === "\\") {
        const next = text[pos + 1];
        if (next === "u") {
          const hex = text.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          if (out.length > maxString) return null;
          pos += 6;
          continue;
        }
        if (next !== undefined && ESCAPES[next] !== undefined) {
          out += ESCAPES[next];
          if (out.length > maxString) return null;
          pos += 2;
          continue;
        }
        return null;
      }
      if (char.charCodeAt(0) < 32) return null;
      out += char;
      if (out.length > maxString) return null;
      pos += 1;
    }
    return null;
  };

  const parseValueBody = (depth: number): JsonNode | null => {
    if (nodes >= maxNodes) return null;
    skipWhitespace();
    if (pos >= text.length) return null;
    const char = text[pos];
    if (char === '"') {
      const value = parseString();
      if (value === null) return null;
      nodes += 1;
      return { kind: "string", value };
    }
    if (char === "{") {
      nodes += 1;
      if (depth >= maxDepth) return null;
      const node: JsonNode = { kind: "object", entries: [], childCount: 0 };
      const keys = new Set<string>();
      pos += 1;
      skipWhitespace();
      if (text[pos] === "}") { pos += 1; return node; }
      for (;;) {
        skipWhitespace();
        if (text[pos] !== '"') return null;
        const key = parseString();
        if (key === null) return null;
        if (keys.has(key)) { failureReason = "Duplicate object keys have ambiguous source paths; use raw text"; return null; }
        keys.add(key);
        skipWhitespace();
        if (text[pos] !== ":") return null;
        pos += 1;
        const child = parseValue(depth + 1);
        if (child === null) return null;
        node.entries!.push({ key, node: child });
        node.childCount = (node.childCount ?? 0) + 1;
        skipWhitespace();
        if (text[pos] === ",") { pos += 1; continue; }
        if (text[pos] === "}") { pos += 1; return node; }
        return null;
      }
    }
    if (char === "[") {
      nodes += 1;
      if (depth >= maxDepth) return null;
      const node: JsonNode = { kind: "array", entries: [], childCount: 0 };
      pos += 1;
      skipWhitespace();
      if (text[pos] === "]") { pos += 1; return node; }
      for (;;) {
        const child = parseValue(depth + 1);
        if (child === null) return null;
        node.entries!.push({ key: String(node.entries!.length), node: child });
        node.childCount = (node.childCount ?? 0) + 1;
        skipWhitespace();
        if (text[pos] === ",") { pos += 1; continue; }
        if (text[pos] === "]") { pos += 1; return node; }
        return null;
      }
    }
    const literal = /^(true|false|null)/.exec(text.slice(pos, pos + 5));
    if (literal) { pos += literal[1].length; nodes += 1; return { kind: literal[1] === "null" ? "null" : "boolean", value: literal[1] }; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(pos, pos + 64));
    if (number && number[0]) {
      pos += number[0].length;
      // Keep the raw lexeme: long values must survive without precision loss.
      nodes += 1;
      return { kind: "number", value: number[0] };
    }
    return null;
  };

  const parseValue = (depth: number): JsonNode | null => {
    skipWhitespace();
    const start = pos;
    const node = parseValueBody(depth);
    if (node) { node.start = start; node.end = pos; }
    return node;
  };
  const root = parseValue(0);
  if (root === null) return fail(failureReason || (pos >= text.length ? "JSON 在文档结束前中断" : "JSON 解析失败或超过预览限制"), Math.min(pos, text.length));
  skipWhitespace();
  if (pos < text.length) return fail("JSON 之后还有未预期的内容", pos);
  return { valid: true, root };
}

/** Object keys and array indices remain distinct, including punctuation keys. */
export function jsonNodePath(path: (string | number)[]): string {
  return "$" + path.map(part => typeof part === "number" ? `[${part}]` : /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join("");
}

export function jsonNodeSource(text: string, node: JsonNode): string {
  return text.slice(node.start ?? 0, node.end ?? 0);
}

export function searchJsonNodes(root: JsonNode | undefined, query: string, limit = 200): { matches: { path: (string | number)[]; node: JsonNode }[]; truncated: boolean } {
  const matches: { path: (string | number)[]; node: JsonNode }[] = [];
  const needle = query.trim().toLowerCase();
  let truncated = false;
  if (!root || !needle) return { matches, truncated };
  const visit = (node: JsonNode, path: (string | number)[]) => {
    if (truncated) return;
    if (String(path.at(-1) ?? "").toLowerCase().includes(needle) || (node.value ?? "").toLowerCase().includes(needle)) {
      if (matches.length >= limit) { truncated = true; return; }
      matches.push({ path, node });
    }
    for (const entry of node.entries ?? []) visit(entry.node, [...path, node.kind === "array" ? Number(entry.key) : entry.key]);
  };
  visit(root, []);
  return { matches, truncated };
}

export function isStructuredFile(name: string): "csv" | "tsv" | "json" | null {
  if (/\.csv$/i.test(name)) return "csv";
  if (/\.(tsv|tab)$/i.test(name)) return "tsv";
  if (/\.json$/i.test(name)) return "json";
  return null;
}
