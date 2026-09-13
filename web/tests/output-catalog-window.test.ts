/** P02/CODEX-0215-B01: bounded windowing keeps every loaded row reachable. */

import test from "node:test";
import assert from "node:assert/strict";

import { clampWindowStart } from "@/components/native/OutputCatalog";

const TOTAL = 2000;
const PAGE_SIZE = 50;
const WINDOW = 400;

/** Simulate the catalog: append pages, render the bounded window only. */
function paginateAll() {
  const rows: { id: number }[] = [];
  let cursor: number | null = null;
  let renderedUnique: Set<number> = new Set();
  let maxDom = 0;
  let guard = 0;
  while ((cursor === null && rows.length === 0) || cursor !== null) {
    if (guard++ > 100) throw new Error("pagination did not terminate");
    // "Load more" fetches the next page (first fetch has no cursor).
    const start: number = cursor ?? 0;
    const page = Array.from({ length: Math.min(PAGE_SIZE, TOTAL - start) }, (_, i) => ({ id: start + i }));
    cursor = start + page.length < TOTAL ? start + page.length : null;
    rows.push(...page);
    // Render the bounded window and record what the DOM would show.
    const windowStart = clampWindowStart(Math.floor((rows.length - page.length) / WINDOW) * WINDOW, rows.length, WINDOW);
    const rendered = rows.slice(windowStart, windowStart + WINDOW);
    maxDom = Math.max(maxDom, rendered.length);
    for (const row of rendered) renderedUnique.add(row.id);
    if (cursor === null) {
      // Final state: page to the very end through the window controls.
      let end = clampWindowStart(rows.length - WINDOW, rows.length, WINDOW);
      const endRendered = rows.slice(end, end + WINDOW);
      for (const row of endRendered) renderedUnique.add(row.id);
      maxDom = Math.max(maxDom, endRendered.length);
      break;
    }
  }
  return { rows, renderedUnique, maxDom };
}

test("all 2,000 rows stay reachable behind a bounded DOM window", () => {
  const { rows, renderedUnique, maxDom } = paginateAll();
  assert.equal(rows.length, TOTAL, "every row is loaded exactly once");
  assert.equal(renderedUnique.size, TOTAL, "every row is reachable in the rendered windows without repeats");
  assert.ok(maxDom <= WINDOW, `the rendered list never exceeds the window (${maxDom})`);
});

test("clampWindowStart keeps a full window inside the loaded rows", () => {
  assert.equal(clampWindowStart(-50, 1000, 400), 0);
  assert.equal(clampWindowStart(0, 300, 400), 0);
  assert.equal(clampWindowStart(700, 1000, 400), 600);
  assert.equal(clampWindowStart(10_000, 1000, 400), 600);
});
