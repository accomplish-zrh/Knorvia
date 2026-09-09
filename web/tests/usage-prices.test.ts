import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateRows,
  estimateDatedRows,
  estimateTurnCost,
  parsePriceTable,
  priceForModel,
  type PriceTable,
} from "../lib/usage-prices";

const TABLE: PriceTable = {
  version: 1,
  updatedAt: "2026-09-08",
  prices: [
    {
      model: "fixture-model",
      currency: "USD",
      effectiveFrom: "2026-01-01",
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
      outputPerMTok: 2,
    },
  ],
};

test("cost uses subset semantics and only known buckets", () => {
  // input 1_000_000 with 200_000 cached and 100_000 written, output 500_000:
  // Normalized input includes both read and write caches:
  // 0.7*1 + 0.2*0.1 + 0.1*1.25 + 0.5*2 = 1.845
  const estimate = estimateTurnCost(
    { model: "fixture-model", inputTokens: 1_000_000, cachedInputTokens: 200_000, cacheWriteInputTokens: 100_000, outputTokens: 500_000 },
    TABLE,
    "2026-09-08",
  );
  assert.deepEqual(estimate, { amount: 1.845, currency: "USD" });
});

test("untrusted price files reject malformed dates, negative rates and duplicates", () => {
  for (const entry of [{ ...TABLE.prices[0], inputPerMTok: -1 }, { ...TABLE.prices[0], effectiveFrom: "2026-02-31" }, { ...TABLE.prices[0], currency: {} }, null]) {
    assert.equal(parsePriceTable(JSON.stringify({ ...TABLE, prices: [entry] })), null);
  }
  assert.equal(parsePriceTable(JSON.stringify({ ...TABLE, prices: [TABLE.prices[0], TABLE.prices[0]] })), null);
});

test("dated provider estimates preserve unknowns and subscription boundaries", () => {
  const row = { model: "fixture-model", providerId: "p1", day: "2026-01-02", cacheKnown: true, completeness: "known", inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
  const table = { ...TABLE, prices: [...TABLE.prices, { ...TABLE.prices[0], providerId: "p1", effectiveFrom: "2026-06-01", inputPerMTok: 2 }] };
  assert.deepEqual(estimateDatedRows([row, { ...row, day: "2026-07-01" }], table), { amount: 3, currency: "USD" });
  assert.deepEqual(estimateDatedRows([row, { ...row, cacheKnown: false }], table), { amount: null, reason: "unknown-cache" });
  assert.deepEqual(estimateDatedRows([{ ...row, completeness: "partial" }], table), { amount: null, reason: "unknown-usage" });
  assert.deepEqual(estimateDatedRows([{ ...row, billingKind: "subscription" }], table), { amount: null, reason: "subscription" });
  assert.equal(estimateTurnCost({ ...row, cachedInputTokens: 900_000, cacheWriteInputTokens: 200_000 }, table, row.day).amount, null);
});

test("missing prices stay unknown instead of guessed zeros", () => {
  const missing = estimateTurnCost(
    { model: "unlisted-model", inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2 },
    TABLE,
    "2026-09-08",
  );
  assert.equal(missing.amount, null);
  assert.equal((missing as { reason: string }).reason, "no-price");
  // cached tokens present but no cached price configured: unknown, not input-priced
  const partial = estimateTurnCost(
    { model: "fixture-model", inputTokens: 500, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 0 },
    { version: 1, updatedAt: "x", prices: [{ model: "fixture-model", currency: "USD", effectiveFrom: "2026-01-01", inputPerMTok: 1 }] },
    "2026-09-08",
  );
  assert.equal(partial.amount, null);
  assert.equal((partial as { reason: string }).reason, "missing-price:cachedInput");
});

test("future prices never apply and newer effective entries win", () => {
  const future: PriceTable = {
    version: 2,
    updatedAt: "2026-09-08",
    prices: [
      ...TABLE.prices,
      { model: "fixture-model", currency: "EUR", effectiveFrom: "2027-01-01", inputPerMTok: 9 },
    ],
  };
  assert.equal(priceForModel(future, "fixture-model", "2026-09-08")?.currency, "USD");
  assert.equal(priceForModel(future, "fixture-model", "2027-06-01")?.currency, "EUR");
});

test("rows aggregate honestly and parse rejects junk tables", () => {
  const rows = estimateRows(
    [
      { model: "fixture-model", inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 },
      { model: "unknown-model", inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 },
    ],
    TABLE,
    "2026-09-08",
  );
  assert.deepEqual(rows[0].estimate, { amount: 1, currency: "USD" });
  assert.equal(rows[1].estimate.amount, null);
  assert.equal(parsePriceTable("not json"), null);
  assert.equal(parsePriceTable("{}"), null);
  assert.ok(parsePriceTable(JSON.stringify(TABLE)));
  assert.ok(parsePriceTable(JSON.stringify({ ...TABLE, updatedAt: "2026-09-09T10:20:30+08:00" })));
});
