import test from "node:test";
import assert from "node:assert/strict";
import { buildLogicalLines, cellColumnForIndex, exportRetainedLog, findMatches, type BufferLike, type RowLineLike } from "../lib/native-terminal-search";

/** A plain-text row model: one cell per character, isWrapped per flag. */
const row = (text: string, isWrapped = false): RowLineLike => ({
  length: text.length,
  isWrapped,
  translateToString: (trimRight?: boolean) => (trimRight ? text.replace(/\s+$/, "") : text),
  getChars: (x: number) => text[x] ?? "",
});

const buffer = (rows: RowLineLike[]): BufferLike => ({ height: rows.length, getLine: y => rows[y] });

/** CJK row: each wide char occupies two cells but is one string char. */
const wideRow = (chars: string[], isWrapped = false): RowLineLike => {
  const cells: string[] = [];
  for (const char of chars) {
    cells.push(char);
    // Only the CJK entries in these fixtures are double-cell characters.
    if (/[\u4e00-\u9fff]/.test(char)) cells.push("");
  }
  return {
    length: cells.length,
    isWrapped,
    translateToString: () => chars.join(""),
    getChars: (x: number) => cells[x] ?? "",
  };
};

test("soft-wrapped rows join into logical lines with per-row string offsets", () => {
  const lines = buildLogicalLines(buffer([
    row("first part-"),
    row("continues here", true),
    row("second line"),
  ]));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].rows, [0, 1]);
  assert.equal(lines[0].text, "first part-continues here");
  assert.deepEqual(lines[0].rowStarts, [0, "first part-".length]);
  assert.deepEqual(lines[1].rows, [2]);
});

test("case-insensitive matches map back to buffer rows and cell columns across wraps", () => {
  const rows = [row("TODO start"), row("continued: end of the ToDo marker"), row("plain")];
  const bufferLike = buffer(rows);
  const lines = buildLogicalLines(bufferLike);
  const matches = findMatches(bufferLike, lines, "todo");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].row, 0);
  assert.equal(matches[0].column, 0);
  assert.equal(matches[0].length, 4);
  assert.equal(matches[1].row, 1);
  // "the ToDo" — the match starts after "continued: end of " on the same buffer row.
  assert.equal(matches[1].column, "continued: end of the ".length);
  assert.ok(matches[0].preview.includes("TODO"));
});

test("wide characters keep string indices separate from cell columns", () => {
  // Cells: 中(2) 文(2) a b -> string "中文ab", columns 0,2,4,5.
  const wide = wideRow(["中", "文", "a", "b"]);
  assert.equal(wide.translateToString(), "中文ab");
  assert.equal(cellColumnForIndex(wide, 0), 0);
  assert.equal(cellColumnForIndex(wide, 1), 2);
  assert.equal(cellColumnForIndex(wide, 2), 4);
  assert.equal(cellColumnForIndex(wide, 3), 5);
  const bufferLike = buffer([wide]);
  const lines = buildLogicalLines(bufferLike);
  const matches = findMatches(bufferLike, lines, "文a");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].column, 2);
  assert.equal(matches[0].length, 3);
});

test("a match reaching the row end clips the highlight to the row", () => {
  const rows = [row("abcdef"), row("tail", true)];
  const bufferLike = buffer(rows);
  const lines = buildLogicalLines(bufferLike);
  const matches = findMatches(bufferLike, lines, "abcdef");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].column, 0);
  assert.equal(matches[0].length, 6);
});

test("the match cap bounds the result set", () => {
  const text = "hit ".repeat(100);
  const bufferLike = buffer([row(text)]);
  const lines = buildLogicalLines(bufferLike);
  assert.equal(findMatches(bufferLike, lines, "hit", { maxMatches: 7 }).length, 7);
});

test("an empty query never searches", () => {
  const bufferLike = buffer([row("data")]);
  assert.deepEqual(findMatches(bufferLike, buildLogicalLines(bufferLike), "   "), []);
});

test("the export records session, time, truncation, and only retained text", () => {
  const bufferLike = buffer([row("line one"), row("line two,"), row("kept tail", true)]);
  const { content, clipped } = exportRetainedLog(bufferLike, { sessionId: "sess-9", exportedAt: "2026-09-11T23:00:00.000Z", truncated: true });
  assert.match(content, /# session: sess-9/);
  assert.match(content, /# exported: 2026-09-11T23:00:00\.000Z/);
  assert.match(content, /# truncated: true/);
  assert.match(content, /line one\nline two,kept tail/);
  assert.match(content, /# note: end of retained buffer/);
  assert.equal(clipped, false);
});

test("an oversized export clips honestly at the bound", () => {
  const rows = Array.from({ length: 50 }, (_, index) => row(`row ${index} ${"x".repeat(100)}`));
  const { content, clipped } = exportRetainedLog(buffer(rows), { sessionId: "s", exportedAt: "now", truncated: false, maxChars: 300 });
  assert.equal(clipped, true);
  assert.match(content, /# note: export clipped at the size bound/);
  assert.ok(content.length < 500);
});
