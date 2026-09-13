import test from "node:test";
import assert from "node:assert/strict";

import {
  appendSearchPage,
  searchCoversEverything,
  searchQueryChanged,
  type ProjectSearchPage,
} from "../lib/native-project-context";

function page(overrides: Partial<ProjectSearchPage> = {}): ProjectSearchPage {
  return {
    workspace: { id: "ws", cwd: "/tmp/p" },
    searchId: "ps-000001",
    query: { text: "needle", mode: "both", caseSensitive: false },
    matches: [],
    page: { index: 0, nextCursor: null, done: true },
    coverage: {
      scannedFiles: 1, scannedDirectories: 1, matchedFiles: 0, skippedBinary: 0,
      skippedLarge: 0, skippedSymlink: 0, ignoredEntries: 0, unreadable: 0,
      bytesScanned: 0, otherEntries: 0,
    },
    matchedTotal: 0,
    matchedLimitReached: false,
    ...overrides,
  };
}

test("searchQueryChanged: only a parameter that defines the search invalidates it", () => {
  const key = { workspaceId: "ws", threadId: undefined, text: "needle", mode: "both" as const, caseSensitive: false };
  assert.equal(searchQueryChanged(undefined, key), true, "no previous key means a new search");
  assert.equal(searchQueryChanged(key, { ...key }), false);
  assert.equal(searchQueryChanged(key, { ...key, text: "other" }), true);
  assert.equal(searchQueryChanged(key, { ...key, mode: "content" }), true);
  assert.equal(searchQueryChanged(key, { ...key, caseSensitive: true }), true);
  assert.equal(searchQueryChanged(key, { ...key, workspaceId: "ws2" }), true);
  assert.equal(searchQueryChanged(key, { ...key, threadId: "t1" }), true);
});

test("appendSearchPage: dedupes, appends, and keeps the displayed rows bounded", () => {
  const existing = [
    { path: "a.txt", name: "a.txt", kind: "file" as const, line: 1 },
  ];
  const first = appendSearchPage(existing, page({
    matches: [
      { path: "a.txt", name: "a.txt", kind: "file", line: 1 },
      { path: "b.txt", name: "b.txt", kind: "file", line: 4, column: 3, snippet: "needle" },
    ],
    matchedTotal: 2,
  }));
  assert.equal(first.rows.length, 2, "duplicate path+line must not be added twice");
  assert.equal(first.dropped, 0);

  const flood = Array.from({ length: 400 }, (_, index) => ({
    path: `f${index}.txt`, name: `f${index}.txt`, kind: "file" as const,
  }));
  const bounded = appendSearchPage([], page({ matches: flood, matchedTotal: 400 }), 300);
  assert.equal(bounded.rows.length, 300, "display stays capped");
  assert.equal(bounded.dropped, 100, "overflow is counted, not hidden");
  assert.equal(bounded.total, 400);
});

test("appendSearchPage: a late page for another search can corrupt nothing by itself", () => {
  const fromSearchA = [{ path: "a.txt", name: "a.txt", kind: "file" as const }];
  const pageB = page({ searchId: "ps-000002", matches: [{ path: "b.txt", name: "b.txt", kind: "file" }] });
  const merged = appendSearchPage(fromSearchA, pageB);
  assert.equal(merged.rows.length, 2);
  // The component guards with a generation counter; the model only merges.
});

test("searchCoversEverything: zero results may only be reported once coverage is complete", () => {
  assert.equal(searchCoversEverything(true, false), true, "done scan covers everything");
  assert.equal(searchCoversEverything(false, true), true, "limit stop is an honest complete answer");
  assert.equal(searchCoversEverything(false, false), false, "partial scan must not claim zero");
});
