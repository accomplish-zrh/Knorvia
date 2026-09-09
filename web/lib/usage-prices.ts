/**
 * Usage price estimation (route C, C14).
 *
 * Estimation is honest by construction: a cost number is produced only
 * when every token bucket involved has a configured, dated price.
 * Anything missing yields "unknown" — never a guessed amount, and
 * subscription quota is never converted into fake cash. Cache semantics
 * follow the ledger: cached input is a subset of input tokens; cache
 * write tokens are billed separately (Anthropic-style) when present.
 */

export interface ModelPrice {
  model: string;
  providerId?: string;
  billingKind?: "api" | "subscription";
  currency: string;
  /** ISO date (YYYY-MM-DD); the latest effective entry wins. */
  effectiveFrom: string;
  /** Per one million tokens. */
  inputPerMTok?: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
  outputPerMTok?: number;
  source?: string;
}

export interface PriceTable {
  version: number;
  updatedAt: string;
  prices: ModelPrice[];
}

export interface UsageBuckets {
  model: string;
  providerId?: string;
  completeness?: string;
  billingKind?: "api" | "subscription" | "unknown";
  /** Total input including cached subset (ledger semantics). */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

export type CostEstimate = { amount: number; currency: string } | { amount: null; reason: string };

export const PRICE_TABLE_STORAGE_KEY = "knorvia-usage-price-table";

export function parsePriceTable(text: string): PriceTable | null {
  try {
    const value = JSON.parse(text) as PriceTable;
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.version) || value.version < 1 ||
      typeof value.updatedAt !== "string" || !validTimestamp(value.updatedAt) || !Array.isArray(value.prices) || value.prices.length > 5000) return null;
    const keys = new Set<string>();
    for (const price of value.prices) {
      if (!price || typeof price !== "object" || typeof price.model !== "string" || !price.model.trim() ||
        typeof price.currency !== "string" || !/^[A-Z]{3}$/.test(price.currency) || !validDate(price.effectiveFrom) ||
        (price.providerId !== undefined && (typeof price.providerId !== "string" || !price.providerId.trim()))) return null;
      for (const key of ["inputPerMTok", "cachedInputPerMTok", "cacheWritePerMTok", "outputPerMTok"] as const) {
        if (price[key] !== undefined && (typeof price[key] !== "number" || !Number.isFinite(price[key]) || price[key]! < 0)) return null;
      }
      const key = JSON.stringify([price.providerId ?? "", price.model, price.effectiveFrom]);
      if (keys.has(key)) return null;
      keys.add(key);
    }
    return value;
  } catch {
    return null;
  }
}

function validDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: string): boolean {
  return validDate(value) || (validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
}

/** Latest price entry for a model whose effective date has arrived. */
export function priceForModel(table: PriceTable | null, model: string, atIsoDate: string, providerId?: string): ModelPrice | null {
  if (!table) return null;
  const entries = table.prices
    .filter(price => price.model === model && price.effectiveFrom <= atIsoDate && (!price.providerId || price.providerId === providerId))
    .sort((a, b) => Number(!!b.providerId) - Number(!!a.providerId) || b.effectiveFrom.localeCompare(a.effectiveFrom));
  return entries[0] ?? null;
}

export function estimateTurnCost(buckets: UsageBuckets, table: PriceTable | null, atIsoDate: string): CostEstimate {
  if (buckets.billingKind === "subscription") return { amount: null, reason: "subscription" };
  if (buckets.billingKind === "unknown") return { amount: null, reason: "unknown-billing" };
  if (buckets.completeness && buckets.completeness !== "known") return { amount: null, reason: "unknown-usage" };
  if (![buckets.inputTokens, buckets.cachedInputTokens, buckets.cacheWriteInputTokens, buckets.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
    buckets.cachedInputTokens + buckets.cacheWriteInputTokens > buckets.inputTokens) return { amount: null, reason: "invalid-usage" };
  const price = priceForModel(table, buckets.model, atIsoDate, buckets.providerId);
  if (!price) return { amount: null, reason: "no-price" };
  if (price.billingKind === "subscription") return { amount: null, reason: "subscription" };
  const currency = price.currency || "USD";
  // The gateway normalizes Anthropic input + cache read + cache write into
  // total input. Both cache buckets must be removed before ordinary pricing.
  const uncachedInput = buckets.inputTokens - buckets.cachedInputTokens - buckets.cacheWriteInputTokens;
  const parts: Array<{ tokens: number; unit?: number; missing: string }> = [
    { tokens: uncachedInput, unit: price.inputPerMTok, missing: "input" },
    { tokens: Math.max(0, buckets.cachedInputTokens), unit: price.cachedInputPerMTok, missing: "cachedInput" },
    { tokens: Math.max(0, buckets.cacheWriteInputTokens), unit: price.cacheWritePerMTok, missing: "cacheWrite" },
    { tokens: Math.max(0, buckets.outputTokens), unit: price.outputPerMTok, missing: "output" },
  ];
  let amount = 0;
  for (const part of parts) {
    if (part.tokens === 0) continue;
    if (part.unit == null || !Number.isFinite(part.unit) || part.unit < 0) return { amount: null, reason: `missing-price:${part.missing}` };
    amount += (part.tokens / 1_000_000) * part.unit;
  }
  return Number.isFinite(amount) ? { amount, currency } : { amount: null, reason: "invalid-amount" };
}

/** Aggregate dated provider rows without hiding unknown usage or currency changes. */
export function estimateDatedRows(rows: Array<UsageBuckets & { day: string; cacheKnown: boolean; cacheWriteKnown?: boolean }>, table: PriceTable | null): CostEstimate {
  if (!rows.length) return { amount: null, reason: "no-usage" };
  let amount = 0;
  let currency = "";
  for (const row of rows) {
    if (!row.cacheKnown) return { amount: null, reason: "unknown-cache" };
    if (row.cacheWriteKnown === false) return { amount: null, reason: "unknown-cache-write" };
    const estimate = estimateTurnCost(row, table, row.day);
    if (estimate.amount == null) return estimate;
    if (currency && currency !== estimate.currency) return { amount: null, reason: "mixed-currency" };
    currency = estimate.currency;
    amount += estimate.amount;
  }
  return { amount, currency };
}

/** Aggregate per-model usage rows into estimates; turns without reported
 * usage are listed as unknown, not folded into a zero. */
export function estimateRows(
  rows: Array<{ model: string; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number }>,
  table: PriceTable | null,
  atIsoDate: string,
): Array<{ model: string; estimate: CostEstimate }> {
  return rows.map(row => ({
    model: row.model,
    estimate: estimateTurnCost(
      {
        model: row.model,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
      },
      table,
      atIsoDate,
    ),
  }));
}
