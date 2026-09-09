import assert from "node:assert/strict";
import test from "node:test";
import { appendFileReferences, parseUnifiedDiff } from "../lib/native-project-context";

test("diff line numbers follow multiple hunks without treating file headers as edits", () => {
  const lines = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,2 +8,2 @@\n context\n-old\n+new\n@@ -30,0 +31,2 @@\n+first\n+second\n");
  assert.deepEqual(lines.filter(line => line.kind === "add").map(line => [line.after, line.text]), [[9, "new"], [31, "first"], [32, "second"]]);
  assert.deepEqual(lines.filter(line => line.kind === "remove").map(line => [line.before, line.text]), [[9, "old"]]);
});

test("content resembling a diff header remains content inside a hunk", () => {
  const lines = parseUnifiedDiff("@@ -1 +1 @@\n--- text\n+++ text\n\\ No newline at end of file\n");
  assert.equal(lines[1].kind, "remove");
  assert.equal(lines[1].text, "-- text");
  assert.equal(lines[2].kind, "add");
  assert.equal(lines[2].text, "++ text");
  assert.equal(lines[3].kind, "meta");
});

test("new files start at line one and references preserve quotes and unicode paths", () => {
  const lines = parseUnifiedDiff("--- /dev/null\n+++ b/资料.txt\n@@ -0,0 +1,1 @@\n+你好\n");
  assert.deepEqual(lines.at(-1), { kind: "add", text: "你好", after: 1 });
  assert.equal(appendFileReferences("Review this\n", ['资料/"draft".md', "name\npart.txt"]), 'Review this\n@"资料/\\"draft\\".md"\n@"name\\npart.txt"');
});
