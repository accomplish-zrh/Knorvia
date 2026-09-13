import test from "node:test";
import assert from "node:assert/strict";
import { isStructuredFile, jsonNodePath, jsonNodeSource, searchJsonNodes, parseCsv, parseJsonPreview, JSON_MAX_NODES } from "../lib/native-data-preview";

test("CSV parses quoted delimiters, escaped quotes, embedded newlines, BOM, and CRLF", () => {
  const text = "\uFEFFname,notes\r\n\"A,\"\"B\"\"\",\"line1\nline2\"\r\nplain,\"has, comma\"\r\n";
  const table = parseCsv(text);
  assert.deepEqual(table.headers, ["name", "notes"]);
  assert.deepEqual(table.rows[0], ["A,\"B\"", "line1\nline2"]);
  assert.deepEqual(table.rows[1], ["plain", "has, comma"]);
  assert.equal(table.truncated, false);
  assert.equal(table.delimiter, ",");
});

test("empty columns, duplicate headers, and TSV detection survive verbatim", () => {
  const table = parseCsv("a,,a\n1,,3\n", { delimiter: "," });
  assert.deepEqual(table.headers, ["a", "", "a"]);
  assert.deepEqual(table.rows[0], ["1", "", "3"]);
  const tsv = parseCsv("x\ty\n1\t2\n");
  assert.equal(tsv.delimiter, "\t");
  assert.deepEqual(tsv.rows[0], ["1", "2"]);
});

test("a dangling quote or row overflow is reported as truncated, never silently repaired", () => {
  assert.equal(parseCsv("a,b\n\"open").truncated, true);
  const bounded = parseCsv("a,b\n1,2\n3,4\n5,6\n", { maxRows: 3 });
  assert.equal(bounded.rows.length, 2); // 3 parsed rows = header + 2 data rows
  assert.equal(bounded.truncated, true);
});

test("JSON keeps long number lexemes verbatim instead of rounding them", () => {
  const result = parseJsonPreview('{"id": 9007199254740993, "pi": 3.14, "neg": -12e-3}');
  assert.equal(result.valid, true);
  const entries = result.root?.entries ?? [];
  assert.equal(entries[0].node.value, "9007199254740993");
  assert.equal(entries[1].node.value, "3.14");
  assert.equal(entries[2].node.value, "-12e-3");
});

test("nested arrays and objects resolve to stable copy paths", () => {
  const result = parseJsonPreview('{"a": {"b": [1, {"c": "x"}]}}');
  assert.equal(result.valid, true);
  const a = result.root?.entries?.[0].node;
  const b = a?.entries?.[0].node;
  const second = b?.entries?.[1].node;
  assert.equal(second?.entries?.[0].node.value, "x");
  assert.equal(jsonNodePath(["a", "b", 1, "c"]), "$.a.b[1].c");
});

test("JSON search and local source copy retain punctuation keys and exact number lexemes", () => {
  const text = '\uFEFF{"a.b": { "[0]": 9007199254740993 }, "a": {"b": ["needle"]}}';
  const root = parseJsonPreview(text).root!;
  const matches = searchJsonNodes(root, '9007199').matches;
  assert.equal(jsonNodePath(matches[0].path), '$["a.b"]["[0]"]');
  assert.equal(jsonNodeSource(text, matches[0].node), '9007199254740993');
  assert.equal(jsonNodeSource(text, root.entries![0].node), '{ "[0]": 9007199254740993 }');
  assert.equal(jsonNodePath(searchJsonNodes(root, 'needle').matches[0].path), '$.a.b[0]');
  assert.equal(searchJsonNodes(parseJsonPreview('[1,1,1]').root, '1', 2).truncated, true);
});

test("escaped strings, duplicate source paths and raw control characters fail honestly", () => {
  assert.equal(parseJsonPreview('"'+ '\\u0061'.repeat(10)+'"', {maxString: 5}).valid, false);
  assert.equal(parseJsonPreview('"'+ '\\n'.repeat(10)+'"', {maxString: 5}).valid, false);
  assert.equal(parseJsonPreview('"raw\tcontrol"').valid, false);
  assert.match(parseJsonPreview('{"a":1,"a":2}').error ?? '', /ambiguous/);
});

test("CSV stops at whole-row and wide-row bounds on large input", () => {
  const parsed = parseCsv('name,value\n'+'row,data\n'.repeat(100000));
  assert.equal(parsed.rows.length, 999);
  assert.equal(parsed.truncated, true);
  assert.equal(parseCsv(','.repeat(100000)).truncated, true);
  assert.equal(parseCsv('a\n"'+ 'x'.repeat(100000)+'"').truncated, true);
});

test("truncated or invalid JSON explains where it broke instead of faking a tree", () => {
  const truncated = parseJsonPreview('{"a": [1, 2');
  assert.equal(truncated.valid, false);
  assert.match(truncated.error ?? "", /line 1/);
  const trailing = parseJsonPreview('{"ok": true} oops');
  assert.equal(trailing.valid, false);
  assert.match(trailing.error ?? "", /未预期|unexpected/i);
});

test("hostile or oversized content stays inert and bounded", () => {
  const script = parseJsonPreview('{"html": "<script>alert(1)</script>"}');
  assert.equal(script.valid, true);
  // The value is preserved exactly as data; rendering stays text-only.
  assert.equal(script.root?.entries?.[0].node.value, "<script>alert(1)</script>");
  const many: string[] = [];
  for (let index = 0; index < JSON_MAX_NODES + 10; index++) many.push("1");
  const big = parseJsonPreview(`[${many.join(",")}]`);
  assert.equal(big.valid, false);
  assert.match(big.error ?? "", /line 1/);
});

test("file kinds route correctly", () => {
  assert.equal(isStructuredFile("data.csv"), "csv");
  assert.equal(isStructuredFile("data.TSV"), "tsv");
  assert.equal(isStructuredFile("trace.json"), "json");
  assert.equal(isStructuredFile("notes.md"), null);
});
