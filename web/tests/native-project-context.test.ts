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

// --- B04: structured per-project task context --------------------------------

import { parseProjectContexts, withProjectContextFile, withoutProjectContextFiles, PROJECT_CONTEXT_LIMIT } from "../lib/native-project-context";

test("project context picks up several files in a row, dedupes, and caps the list", () => {
  let map = parseProjectContexts(null);
  for (const path of ["package.json", "tsconfig.json", "package.json"]) map = withProjectContextFile(map, "p1", path);
  assert.deepEqual(map.p1, ["package.json", "tsconfig.json"]);
  for (let index = 0; index < PROJECT_CONTEXT_LIMIT + 5; index++) map = withProjectContextFile(map, "p1", `src/file${index}.ts`);
  assert.equal(map.p1.length, PROJECT_CONTEXT_LIMIT);
  assert.equal(map.p1.includes("package.json"), false);
});

test("context stays per project, so switching projects never mixes files", () => {
  let map = parseProjectContexts(JSON.stringify({ p1: ["package.json"] }));
  map = withProjectContextFile(map, "p2", "README.md");
  assert.deepEqual(map.p1, ["package.json"]);
  assert.deepEqual(map.p2, ["README.md"]);
  const reparsed = parseProjectContexts(JSON.stringify(map));
  assert.deepEqual(reparsed.p1, ["package.json"]);
  assert.deepEqual(reparsed.p2, ["README.md"]);
});

test("cleanup after a send removes exactly the submitted paths and nothing else", () => {
  const map = parseProjectContexts(JSON.stringify({ p1: ["a.ts", "b.ts", "c.ts"] }));
  const next = withoutProjectContextFiles(map, "p1", ["b.ts"]);
  assert.deepEqual(next.p1, ["a.ts", "c.ts"]);
  const emptied = withoutProjectContextFiles(next, "p1", ["a.ts", "c.ts"]);
  assert.equal("p1" in emptied, false);
  assert.deepEqual(withoutProjectContextFiles(map, "p1", []).p1, ["a.ts", "b.ts", "c.ts"]);
});

test("corrupted or hostile stored context is dropped instead of trusted", () => {
  assert.deepEqual(parseProjectContexts("not json"), {});
  assert.deepEqual(parseProjectContexts(JSON.stringify({ p1: "nope", p2: [42, null, "ok.ts", ""], p3: ["x".repeat(2000)] })), { p2: ["ok.ts"] });
});

// --- B08: bounded current-directory scan --------------------------------------

import { mergeDirectoryPage, scanDirectoryPages, type DirectoryPage } from "../lib/native-project-context";

const scope = { id: "ws-1", cwd: "D:/proj" };
const dirPage = (entries: string[], nextCursor: string | null, workspace = scope, path = "src"): DirectoryPage => ({
  workspace, path, truncated: nextCursor !== null, entries: entries.map(name => ({ name, path: `${path}/${name}`, kind: "file" as const })), nextCursor,
});

test("a continuation page merges only within the same workspace and folder", () => {
  const current = dirPage(["a.ts", "b.ts"], "cursor-1");
  const sameScope = mergeDirectoryPage(current, dirPage(["b.ts", "c.ts"], null));
  assert.deepEqual(sameScope?.entries.map(entry => entry.name), ["a.ts", "b.ts", "c.ts"]);
  const otherProject = mergeDirectoryPage(current, dirPage(["x.ts"], null, { id: "ws-2", cwd: "D:/other" }));
  assert.equal(otherProject, null);
  const otherFolder = mergeDirectoryPage(current, dirPage(["x.ts"], null, scope, "docs"));
  assert.equal(otherFolder, null);
});

test("a bounded scan finds a match beyond the first page and stops there", async () => {
  const current = dirPage(["f1.ts", "f2.ts"], "c1");
  const pages: Record<string, DirectoryPage> = {
    c1: dirPage(Array.from({ length: 200 }, (_, i) => `g${i}.ts`), "c2"),
    c2: dirPage(["f3.ts", "target.ts"], "c3"),
  };
  const fetched: string[] = [];
  const outcome = await scanDirectoryPages(async cursor => { fetched.push(cursor); return pages[cursor]; }, current, { matches: entry => entry.name === "target.ts" });
  assert.equal(outcome.matched, true);
  assert.deepEqual(fetched, ["c1", "c2"]);
  assert.ok(outcome.directory?.entries.some(entry => entry.name === "target.ts"));
  assert.equal(outcome.directory?.nextCursor, "c3");
});

test("the page bound stops the scan without ever claiming the folder is empty", async () => {
  let n = 0;
  const outcome = await scanDirectoryPages(async cursor => { n += 1; return dirPage([`x${n}.ts`], `c${n}`); }, dirPage(["s.ts"], "c1"), { maxPages: 3 });
  assert.equal(n, 3);
  assert.equal(outcome.matched, false);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.directory?.nextCursor, "c3");
});

test("cancellation keeps the scanned entries and is reported as cancelled, not absence", async () => {
  let calls = 0;
  const outcome = await scanDirectoryPages(async cursor => { calls += 1; return dirPage([`x${calls}.ts`], `c${calls}`); }, dirPage(["s.ts"], "c1"), { maxPages: 10, isCancelled: () => calls >= 2 });
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.directory?.entries.length, 3);
});

test("a stale-scope page aborts the walk and leaves the caller's directory untouched", async () => {
  const current = dirPage(["s.ts"], "c1");
  const outcome = await scanDirectoryPages(async () => dirPage(["x.ts"], null, { id: "ws-9", cwd: "D:/elsewhere" }), current, {});
  assert.equal(outcome.staleScope, true);
  assert.equal(outcome.directory, current);
});
