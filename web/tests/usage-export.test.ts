import assert from "node:assert/strict";
import test from "node:test";
import { usageCsv, type UsageExportRow } from "../lib/usage-export";

const row: UsageExportRow = { model: "fixture", providerId: "p1", day: "2026-09-09", completeness: "known", cacheKnown: true, turns: 1, inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 105 };
test("CSV preserves disjoint cache buckets and exact scope", () => {
  const text = usageCsv([row], { botId: "b1", conversationId: "room1" });
  assert.ok(text.includes('"100","50","30","20","5","2","105","b1","room1"'));
});
test("CSV uses blank unknowns and neutralizes spreadsheet formulas", () => {
  const text = usageCsv([{ ...row, model: "=EXEC(1)", cacheKnown: false, completeness: "unknown" }]);
  assert.ok(text.includes('"\'=EXEC(1)"'));
  assert.ok(text.includes('"unknown","unknown","1","","","","","","",""'));
  const partialCache = usageCsv([{ ...row, cacheWriteKnown: false }]);
  assert.ok(partialCache.includes('"read-reported/write-unknown","1","100","","30",""'));
});
