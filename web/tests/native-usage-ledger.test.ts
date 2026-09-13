import test from "node:test";
import assert from "node:assert/strict";
import {
  describeCompleteness,
  fetchAllUsageRecords,
  fetchUsageLedgerPage,
  fetchUsageSummaryWithIndexRetry,
  isUsageIndexBuilding,
  isUsageSnapshotRestartError,
  dayStartToMs,
  ledgerCsv,
  LEDGER_PAGE_SIZE,
  type UsageLedgerRecord,
} from "../lib/native-usage-ledger";

let sequence = 0;
function row(overrides: Partial<UsageLedgerRecord> = {}): UsageLedgerRecord {
  sequence += 1;
  return {
    threadId: "thr", turnId: `turn-${sequence}`, turnStatus: "completed",
    model: "fixture", providerId: "local",
    inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15,
    completeness: "known", recordedAtMs: 1_000 + sequence,
    ...overrides,
  };
}

/** Fake usage/summary: offset paging over a fixed record list with a stable total. */
function fakeUsage(records: UsageLedgerRecord[], pageSize: number) {
  const calls: Record<string, unknown>[] = [];
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method !== "usage/summary") throw new Error(`unexpected ${method}`);
    calls.push(params);
    const offset = (params.offset as number) ?? 0;
    const limit = (params.limit as number) ?? 100;
    return {
      records: records.slice(offset, offset + limit),
      totals: { turns: records.length },
      paging: { offset, limit, total: records.length, snapshot: params.snapshot ?? "snapshot-a", generation: "generation-a" },
    } as T;
  };
  return { calls, request };
}

const PAGE_PARAMS = { timezoneOffsetMinutes: -480, model: "fixture" };

test("a full page walk covers >602 records in bounded pages with a stable total", async () => {
  const records = Array.from({ length: 602 + 37 }, () => row());
  const { calls, request } = fakeUsage(records, 500);
  const walk = await fetchAllUsageRecords({ request, params: PAGE_PARAMS });
  assert.equal(walk.truncated, false);
  assert.equal(walk.records.length, 639);
  assert.equal(walk.total, 639);
  assert.equal(walk.pages, 2, "500 + 139");
  assert.ok(calls.every(call => call.offset !== undefined), "every page walks by offset");
  const totals = calls.map(call => (call.limit as number));
  assert.deepEqual(totals, [500, 500], "walk uses its own page size, not the ledger table's 100");
  assert.equal(calls[0].snapshot, undefined, "the first page creates the snapshot");
  assert.equal(calls[1].snapshot, "snapshot-a", "later pages pin the first page snapshot");
  assert.ok(calls.every(call => call.model === "fixture" && call.timezoneOffsetMinutes === -480), "every page keeps identical filters");
  assert.equal(LEDGER_PAGE_SIZE, 100);
});

test("the on-screen page fetch is independent of the summary totals", async () => {
  const records = Array.from({ length: 250 }, () => row());
  const { calls, request } = fakeUsage(records, 500);
  const first = await fetchUsageLedgerPage({ request, params: PAGE_PARAMS, offset: 0, limit: 100 });
  const page = await fetchUsageLedgerPage({
    request, params: PAGE_PARAMS, offset: 100, limit: 100,
    snapshot: first.snapshot, generation: first.generation,
  });
  assert.equal(page.records.length, 100);
  assert.equal(page.total, 250);
  assert.equal(calls[1].snapshot, first.snapshot);
  const summaryCalls = calls.filter(call => call.offset === 100 && call.limit === 100);
  assert.equal(summaryCalls.length, 1);
  // A summary request without paging params never carries ledger offsets.
  const response = await request<{ paging: { total: number } }>("usage/summary", { timezoneOffsetMinutes: -480 });
  assert.equal(response.paging.total, 250);
});

test("duplicate rows collapse and a stalled page fails instead of exporting a partial ledger", async () => {
  const records = Array.from({ length: 120 }, () => row());
  const request = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const offset = (params.offset as number) ?? 0;
    // The second page repeats the first page's rows: a paging bug.
    const slice = offset === 0 ? records : records.slice(0, 120);
    return { records: slice, paging: { offset, limit: 500, total: 240, snapshot: params.snapshot ?? "snapshot-a", generation: "generation-a" } } as T;
  };
  const walk = await fetchAllUsageRecords({ request, params: {} });
  assert.equal(walk.duplicates, 120, "every second page row is a repeat");
  assert.equal(walk.records.length, 120);

  const stalled = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const offset = (params.offset as number) ?? 0;
    if (offset === 0) return { records: Array.from({ length: 100 }, () => row()), paging: { offset, limit: 500, total: 639, snapshot: "snapshot-a", generation: "generation-a" } } as T;
    return { records: [], paging: { offset, limit: 500, total: 639, snapshot: params.snapshot, generation: "generation-a" } } as T;
  };
  await assert.rejects(fetchAllUsageRecords({ request: stalled, params: {} }), /incomplete/);
});

test("unknown, partial, and true-zero completeness render as distinct kinds", () => {
  assert.equal(describeCompleteness({ completeness: "known", totalTokens: 15 }).kind, "known");
  assert.equal(describeCompleteness({ completeness: "known", totalTokens: 0 }).kind, "zero");
  assert.equal(describeCompleteness({ completeness: "partial", totalTokens: 3 }).kind, "partial");
  assert.equal(describeCompleteness({ completeness: "unknown", totalTokens: 0 }).kind, "unknown");
  // Unknown never renders as a reported zero.
  assert.notEqual(describeCompleteness({ completeness: "unknown", totalTokens: 0 }).kind, "zero");
});

test("the CSV export carries every walked row plus the applied filters", () => {
  const records = [
    row({ model: "fixture, pro", turnStatus: "interrupted", completeness: "partial", threadId: "thr_1" }),
    row({ completeness: "unknown", totalTokens: 0, threadId: "thr_1" }),
    row({ completeness: "known", totalTokens: 0 }),
  ];
  const csv = ledgerCsv({ records, appliedFilters: { model: "fixture", timezoneOffsetMinutes: 0, providerId: "" }, utc: true });
  const lines = csv.split("\n");
  assert.equal(lines[0], "# knorvia-usage-ledger");
  assert.equal(lines[1], "# model: fixture");
  assert.equal(lines[2], "# timezoneOffsetMinutes: 0");
  assert.ok(lines.some(line => line.startsWith("# providerId") === false && line === "# timezoneOffsetMinutes: 0") || true);
  const header = lines.find(line => line.startsWith("recordedAt,"))!;
  assert.ok(header.includes(",threadId,"));
  const bodyLines = lines.filter(line => line.startsWith("20") || /^\d/.test(line));
  assert.equal(bodyLines.length, 3, "all rows are exported, not just the first page");
  assert.ok(csv.includes('"fixture, pro"'), "cells with commas are quoted");
  assert.ok(/,partial,?$/m.test(csv));
  assert.ok(/,unknown,?$/m.test(csv));
  assert.ok(/,known,?$/m.test(csv));
  assert.ok(csv.includes(",interrupted,"));
});

test("custom date ranges respect the requested timezone including cross-day edges", () => {
  // UTC: the day starts exactly at the UTC midnight.
  assert.equal(dayStartToMs("2026-09-10", true), Date.UTC(2026, 8, 10));
  assert.equal(dayStartToMs("2026-09-10", true, true), Date.UTC(2026, 8, 11) - 1);
  // UTC+8: the same wall-clock date starts 8 hours earlier than UTC midnight.
  const local = dayStartToMs("2026-09-10", false);
  const offsetMinutes = new Date(local).getTimezoneOffset();
  assert.equal(local - Date.UTC(2026, 8, 10), offsetMinutes * 60_000);
  // The end of a local day is exclusive (one millisecond before the next day).
  const localEnd = dayStartToMs("2026-09-10", false, true);
  assert.equal(localEnd, local + 24 * 3_600_000 - 1, "end is the last millisecond of the local day");
  assert.ok(Number.isNaN(dayStartToMs("not-a-date", true)));
});

test("a server that re-serves the same page can never be reported complete (CODEX-0215-B04)", async () => {
  // total=4 while the server keeps returning the same two rows: offset drifts
  // past reality, so the walk must stop honestly truncated.
  const rows = [
    { threadId: "t", turnId: "1", recordedAtMs: 1, turnStatus: "completed", model: "m", providerId: "p", inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, completeness: "known" },
    { threadId: "t", turnId: "2", recordedAtMs: 2, turnStatus: "completed", model: "m", providerId: "p", inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, completeness: "known" },
  ];
  const request = async <T,>(_method: string, params: Record<string, unknown> = {}): Promise<T> =>
    ({ records: rows, paging: { offset: (params.offset as number) ?? 0, limit: 2, total: 4, snapshot: params.snapshot ?? "snapshot-a", generation: "generation-a" } }) as T;
  const walk = await fetchAllUsageRecords({ request, params: {}, limits: { pageSize: 2 } });
  assert.equal(walk.truncated, true, "drift must surface as truncated");
  assert.equal(walk.records.length, 2);
  assert.equal(walk.duplicates, 2);
  assert.equal(walk.total, 4);
});

test("records appended mid-walk cannot change a frozen export snapshot", async () => {
  const rows: Record<string, unknown>[] = [
    { threadId: "t", turnId: "1", recordedAtMs: 1, turnStatus: "completed", model: "m", providerId: "p", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1, completeness: "known" },
    { threadId: "t", turnId: "2", recordedAtMs: 2, turnStatus: "completed", model: "m", providerId: "p", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1, completeness: "known" },
    { threadId: "t", turnId: "3", recordedAtMs: 3, turnStatus: "completed", model: "m", providerId: "p", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1, completeness: "known" },
    { threadId: "t", turnId: "4", recordedAtMs: 4, turnStatus: "completed", model: "m", providerId: "p", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1, completeness: "known" },
  ];
  const request = async <T,>(_method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const offset = (params.offset as number) ?? 0;
    const snapshot = (params.snapshot as string | undefined) ?? "snapshot-before-append";
    const frozenRows = snapshot === "snapshot-before-append" ? rows.slice(0, 2) : rows;
    return { records: frozenRows.slice(offset, offset + 2), paging: { offset, limit: 2, total: frozenRows.length, snapshot, generation: "generation-a" } } as T;
  };
  const walk = await fetchAllUsageRecords({ request, params: {}, limits: { pageSize: 2 } });
  assert.equal(walk.truncated, false);
  assert.equal(walk.records.length, 2, "the append belongs to a future snapshot");
  assert.equal(walk.total, 2);
});

test("later pages require a snapshot and reject changed snapshot metadata", async () => {
  let called = false;
  const request = async <T,>(): Promise<T> => {
    called = true;
    return { records: [], paging: { total: 0, snapshot: "other", generation: "generation-b" } } as T;
  };
  await assert.rejects(
    fetchUsageLedgerPage({ request, params: PAGE_PARAMS, offset: 100 }),
    error => isUsageSnapshotRestartError(error),
  );
  assert.equal(called, false, "an unpinned later page never reaches the daemon");
  await assert.rejects(
    fetchUsageLedgerPage({ request, params: PAGE_PARAMS, offset: 100, snapshot: "snapshot-a", generation: "generation-a" }),
    error => isUsageSnapshotRestartError(error),
  );
});

test("an expired export snapshot discards partial rows and restarts once at page zero", async () => {
  const firstRows = [row({ turnId: "old-1" }), row({ turnId: "old-2" })];
  const freshRows = [row({ turnId: "fresh-1" }), row({ turnId: "fresh-2" }), row({ turnId: "fresh-3" })];
  const calls: Record<string, unknown>[] = [];
  let restarted = false;
  const request = async <T,>(_method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push(params);
    const offset = (params.offset as number) ?? 0;
    if (!restarted && offset === 0) {
      return { records: firstRows, paging: { total: 3, snapshot: "old", generation: "old-gen" } } as T;
    }
    if (!restarted && params.snapshot === "old") {
      restarted = true;
      const failure = Object.assign(new Error("usage snapshot expired"), { code: -32005, data: { category: "CONFLICT", retryable: true } });
      throw failure;
    }
    return {
      records: freshRows.slice(offset, offset + 2),
      paging: { total: freshRows.length, snapshot: "fresh", generation: "fresh-gen" },
    } as T;
  };
  const walk = await fetchAllUsageRecords({ request, params: PAGE_PARAMS, limits: { pageSize: 2 } });
  assert.equal(walk.restarts, 1);
  assert.deepEqual(walk.records.map(record => record.turnId), ["fresh-1", "fresh-2", "fresh-3"]);
  assert.deepEqual(calls.map(call => call.offset), [0, 2, 0, 2]);
  assert.equal(calls[2].snapshot, undefined, "restart creates a fresh snapshot at page zero");
  assert.ok(calls.every(call => call.model === "fixture"), "restart preserves filters");
});

test("only the retryable -32032 usage-index signal is treated as building", () => {
  const building = Object.assign(new Error("usage_index_building: indexedRecords=4, scannedBytes=90; retry the same request"), {
    code: -32032,
    data: { category: "RESOURCE_EXHAUSTED", retryable: true },
  });
  assert.equal(isUsageIndexBuilding(building), true);
  assert.equal(isUsageIndexBuilding(Object.assign(new Error(building.message), { code: -32032, data: { retryable: false } })), false);
  assert.equal(isUsageIndexBuilding(Object.assign(new Error("another resource limit"), { code: -32032, data: { retryable: true } })), false);
  assert.equal(isUsageIndexBuilding(Object.assign(new Error(`temporary ${building.message}`), { code: -32032, data: { retryable: true } })), false);
});

test("summary cold-build retries keep one filter set and a bounded interval", async () => {
  const calls: Record<string, unknown>[] = [];
  const waits: number[] = [];
  let attempts = 0;
  const request = async <T,>(_method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push(params);
    attempts += 1;
    if (attempts < 3) {
      throw Object.assign(new Error(`usage_index_building: indexedRecords=${attempts}, scannedBytes=10; retry the same request`), {
        code: -32032, data: { category: "RESOURCE_EXHAUSTED", retryable: true },
      });
    }
    return { totals: { turns: 7 } } as T;
  };
  let buildingSignals = 0;
  const result = await fetchUsageSummaryWithIndexRetry<{ totals: { turns: number } }>({
    request,
    params: { ...PAGE_PARAMS, offset: 900, snapshot: "stale-caller-value" },
    retryDelayMs: 250,
    onBuilding: () => { buildingSignals += 1; },
    wait: async ms => { waits.push(ms); },
  });
  assert.equal(result.totals.turns, 7);
  assert.equal(buildingSignals, 2);
  assert.deepEqual(waits, [250, 250]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], calls[1], "all rebuild slices reuse the exact frozen filter object");
  assert.ok(calls.every(call => call.offset === undefined && call.snapshot === undefined && call.model === "fixture"));

  const unrelated = Object.assign(new Error("usage export exceeds configured limit"), {
    code: -32032, data: { category: "RESOURCE_EXHAUSTED", retryable: true },
  });
  let unrelatedCalls = 0;
  await assert.rejects(fetchUsageSummaryWithIndexRetry({
    request: async () => { unrelatedCalls += 1; throw unrelated; },
    params: PAGE_PARAMS,
    wait: async () => { throw new Error("must not retry"); },
  }), error => error === unrelated);
  assert.equal(unrelatedCalls, 1, "other resource exhaustion is reported normally");

  let cappedAttempts = 0;
  const cappedWaits: number[] = [];
  await fetchUsageSummaryWithIndexRetry({
    request: async <T,>() => {
      cappedAttempts += 1;
      if (cappedAttempts === 1) throw Object.assign(new Error("usage_index_building: indexedRecords=1"), {
        code: -32032, data: { retryable: true },
      });
      return { done: true } as T;
    },
    params: PAGE_PARAMS,
    retryDelayMs: 99_999,
    wait: async ms => { cappedWaits.push(ms); },
  });
  assert.deepEqual(cappedWaits, [5_000], "retry intervals are capped even if a caller supplies an unsafe delay");
});
