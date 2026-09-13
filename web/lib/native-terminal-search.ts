/**
 * Terminal buffer search and traceable export (B13).
 *
 * Everything here reads the emulator's PUBLIC parsed buffer (`buffer.active`,
 * `IBufferLine.translateToString/isWrapped/getChars`) and highlights through
 * the public `select`/`scrollToLine` APIs. Nothing in this module can write
 * to the shell: there is no transport, no `terminal/write`, no keystroke
 * injection. Soft-wrapped rows are joined into logical lines so matches span
 * wraps, and wide characters keep one string index per cell cluster via
 * `getChars`, so CJK text highlights at the right cell columns.
 */

export type RowLineLike = {
  /** Cells in the row (wide characters occupy two). */
  length: number;
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
  getChars(x: number): string;
};

export type BufferLike = {
  height: number;
  getLine(y: number): RowLineLike | undefined;
};

export type LogicalLine = {
  /** Buffer rows composing this logical line, in order. */
  rows: number[];
  /** String index where each row's text starts within `text`. */
  rowStarts: number[];
  text: string;
};

/** Join soft-wrapped rows into logical lines. Bounded by the buffer height. */
export function buildLogicalLines(buffer: BufferLike, maxRows = 10_000): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  const height = Math.min(buffer.height, maxRows);
  for (let y = 0; y < height; y += 1) {
    const row = buffer.getLine(y);
    if (!row) break;
    const text = row.translateToString(true);
    if (row.isWrapped && current && text) {
      current.rowStarts.push(current.text.length);
      current.rows.push(y);
      current.text += text;
      continue;
    }
    current = { rows: [y], rowStarts: [0], text };
    lines.push(current);
  }
  return lines;
}

/**
 * Cell column whose character cluster starts at `charIndex`, or -1 when the
 * index is past the row end. Wide characters and surrogate pairs advance the
 * string index by their cluster length while occupying several cells, so
 * zero-width follower cells can never host a match start.
 */
export function cellColumnForIndex(line: RowLineLike, charIndex: number): number {
  let consumed = 0;
  for (let x = 0; x < line.length; x += 1) {
    const chars = line.getChars(x);
    if (chars.length === 0) continue;
    if (consumed >= charIndex) return x;
    if (consumed < charIndex && consumed + chars.length > charIndex) return x;
    consumed += chars.length;
  }
  return consumed === charIndex ? line.length : -1;
}

export type TerminalSearchMatch = {
  /** Index into the logical-line list. */
  line: number;
  /** Buffer row that contains the match start. */
  row: number;
  /** Cell column of the match start within `row`. */
  column: number;
  /** Cells to highlight from `column` (clipped to the row). */
  length: number;
  preview: string;
};

export type SearchOptions = { caseSensitive?: boolean; maxMatches?: number };

/** Find query occurrences across logical lines, mapped back to buffer cells. */
export function findMatches(buffer: BufferLike, lines: LogicalLine[], query: string, options: SearchOptions = {}): TerminalSearchMatch[] {
  const maxMatches = options.maxMatches ?? 500;
  const needle = options.caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];
  const matches: TerminalSearchMatch[] = [];
  for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
    const line = lines[index];
    const haystack = options.caseSensitive ? line.text : line.text.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at >= 0 && matches.length < maxMatches) {
      const match: TerminalSearchMatch = { line: index, row: line.rows[0], column: 0, length: 0, preview: previewOf(line.text, at, needle.length) };
      // Locate the buffer row and cell column holding the match start.
      let rowIndex = line.rowStarts.length - 1;
      for (let r = 0; r < line.rowStarts.length; r += 1) {
        if (at >= line.rowStarts[r]) rowIndex = r; else break;
      }
      match.row = line.rows[rowIndex];
      const rowTextLength = (line.rowStarts[rowIndex + 1] ?? line.text.length) - line.rowStarts[rowIndex];
      const localIndex = at - line.rowStarts[rowIndex];
      const rowLine = buffer.getLine(match.row);
      const localEnd = Math.min(localIndex + needle.length, rowTextLength);
      if (rowLine) {
        match.column = cellColumnForIndex(rowLine, localIndex);
        const endColumn = cellColumnForIndex(rowLine, localEnd);
        match.length = endColumn >= 0 ? Math.max(1, endColumn - match.column) : Math.max(1, rowLine.length - match.column);
      }
      matches.push(match);
      at = haystack.indexOf(needle, at + Math.max(1, needle.length));
    }
  }
  return matches;
}

function previewOf(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 24);
  const body = text.slice(start, Math.min(text.length, at + length + 32));
  return `${start > 0 ? "…" : ""}${body}${at + length < text.length ? "…" : ""}`;
}

export type ExportOptions = {
  sessionId: string;
  exportedAt: string;
  truncated: boolean;
  /** Hard content bound; the export notes when it clipped the buffer. */
  maxChars?: number;
};

/** Retained-buffer text export with provenance header. */
export function exportRetainedLog(buffer: BufferLike, options: ExportOptions): { content: string; clipped: boolean } {
  const lines = buildLogicalLines(buffer);
  const maxChars = options.maxChars ?? 2_000_000;
  const header = [
    `# Knorvia terminal log`,
    `# session: ${options.sessionId}`,
    `# exported: ${options.exportedAt}`,
    `# truncated: ${options.truncated ? "true (older output exceeded retention; this file holds only the retained buffer)" : "false"}`,
  ].join("\n");
  let content = header;
  let clipped = false;
  for (const line of lines) {
    if (content.length + line.text.length + 1 > maxChars) { clipped = true; break; }
    content += `\n${line.text}`;
  }
  if (clipped || options.truncated) {
    // The trailer states exactly what the file does and does not contain.
    content += `\n${clipped ? "# note: export clipped at the size bound" : "# note: end of retained buffer"}`;
  }
  return { content, clipped };
}
