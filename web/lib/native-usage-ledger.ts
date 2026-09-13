/**
 * Per-turn usage ledger (B04) over the paginated `usage/summary` records.
 *
 * The summary aggregates every matching record regardless of paging, so page
 * changes must never mutate the totals; the ledger walks the detail rows with
 * offset paging for the on-screen table and for a complete export. Unknown
 * and partial completeness stay distinct from a real provider-reported zero.
 */

export type UsageLedgerRecord = {
  threadId: string;
  turnId: string;
  parentTurnId?: string;
  turnStatus: string;
  model: string;
  providerId: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  completeness: string;
  recordedAtMs: number;
};

export type UsageRequester = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export type LedgerFetchResult = {
  records: UsageLedgerRecord[];
  total: number;
  pages: number;
  duplicates: number;
  /** Number of expired snapshots that forced a complete walk restart. */
  restarts: number;
  /** True when the walk stopped at the safety bound instead of the chain end. */
  truncated: boolean;
};

export type UsageLedgerPage = {
  records: UsageLedgerRecord[];
  total: number;
  snapshot: string;
  generation: string;
};

export const LEDGER_PAGE_SIZE = 100;

export const DEFAULT_LEDGER_LIMITS = { pageSize: 500, maxPages: 40, maxRecords: 20_000 };

export function ledgerRowKey(record: UsageLedgerRecord): string {
  return `${record.threadId}\u0000${record.turnId}\u0000${record.recordedAtMs}`;
}

type RpcFailure = Error & { code?: unknown; data?: unknown };

function errorData(error: unknown): Record<string, unknown> | undefined {
  const data = (error as RpcFailure | null)?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
}

/** Cold index construction is progress, not an authoritative empty result. */
export function isUsageIndexBuilding(error: unknown): boolean {
  const failure = error as RpcFailure | null;
  const data = errorData(error);
  return failure?.code === -32032
    && data?.retryable === true
    && (failure?.message ?? "").startsWith("usage_index_building:");
}

export const USAGE_INDEX_RETRY_DELAY_MS = 400;

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("usage summary retry cancelled"));
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("usage summary retry cancelled"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * Advance a cold, time-sliced native usage index without surfacing an empty
 * summary. Every attempt reuses one frozen filter object and waits between
 * slices so a rebuild cannot become a renderer-side request loop.
 */
export async function fetchUsageSummaryWithIndexRetry<T>({
  request,
  params,
  signal,
  onBuilding,
  retryDelayMs = USAGE_INDEX_RETRY_DELAY_MS,
  wait = retryDelay,
}: {
  request: UsageRequester;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  onBuilding?: (error: unknown) => void;
  retryDelayMs?: number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<T> {
  const filters = pageFilters(params);
  const requestedDelay = Number.isFinite(retryDelayMs) ? Math.trunc(retryDelayMs) : USAGE_INDEX_RETRY_DELAY_MS;
  const delayMs = Math.max(100, Math.min(5_000, requestedDelay));
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error("usage summary retry cancelled");
    try {
      return await request<T>("usage/summary", filters);
    } catch (error) {
      if (!isUsageIndexBuilding(error) || signal?.aborted) throw error;
      onBuilding?.(error);
      await wait(delayMs, signal);
    }
  }
}

/** A page from this snapshot can no longer be trusted; restart at offset 0. */
export class UsageSnapshotRestartRequiredError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "UsageSnapshotRestartRequiredError";
    this.cause = cause;
  }
}

export function isUsageSnapshotRestartError(error: unknown): boolean {
  if (error instanceof UsageSnapshotRestartRequiredError) return true;
  const failure = error as RpcFailure | null;
  const data = errorData(error);
  const message = failure?.message ?? "";
  return failure?.code === -32005
    || data?.category === "CONFLICT"
    || /usage snapshot.*(?:missing|expired|stale)|(?:missing|expired|stale).*usage snapshot/i.test(message);
}

function pageFilters(params: Record<string, unknown>): Record<string, unknown> {
  const filters = { ...params };
  for (const key of ["offset", "limit", "snapshot", "idempotencyKey"]) delete filters[key];
  return filters;
}

/** One page of the ledger, paged independently of the summary request. */
export async function fetchUsageLedgerPage({ request, params, offset, limit = LEDGER_PAGE_SIZE, snapshot, generation }: {
  request: UsageRequester;
  params: Record<string, unknown>;
  offset: number;
  limit?: number;
  snapshot?: string;
  generation?: string;
}): Promise<UsageLedgerPage> {
  if (offset > 0 && !snapshot) {
    throw new UsageSnapshotRestartRequiredError("usage ledger pagination must restart at offset 0 without a snapshot");
  }
  try {
    const response = await request<{
      records?: UsageLedgerRecord[];
      paging?: { total?: number; snapshot?: string; generation?: string };
    }>("usage/summary", {
      ...pageFilters(params), offset, limit, ...(snapshot ? { snapshot } : {}),
    });
    const paging = response.paging;
    const total = paging?.total;
    if (!paging || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
      || typeof paging.snapshot !== "string" || !paging.snapshot
      || typeof paging.generation !== "string" || !paging.generation) {
      throw new Error("usage/summary returned incomplete paging metadata");
    }
    if (snapshot && paging.snapshot !== snapshot) {
      throw new UsageSnapshotRestartRequiredError("usage snapshot changed during pagination");
    }
    if (generation && paging.generation !== generation) {
      throw new UsageSnapshotRestartRequiredError("usage generation changed during pagination");
    }
    return {
      records: response.records ?? [],
      total,
      snapshot: paging.snapshot,
      generation: paging.generation,
    };
  } catch (error) {
    if (snapshot && isUsageSnapshotRestartError(error)
      && !(error instanceof UsageSnapshotRestartRequiredError)) {
      throw new UsageSnapshotRestartRequiredError("usage snapshot expired during pagination", error);
    }
    throw error;
  }
}

/**
 * Walk every detail page for the current filter set. The summary shown next
 * to it is fetched separately and never depends on this walk.
 */
export async function fetchAllUsageRecords({ request, params, limits = {} }: {
  request: UsageRequester;
  params: Record<string, unknown>;
  limits?: Partial<typeof DEFAULT_LEDGER_LIMITS>;
}): Promise<LedgerFetchResult> {
  const config = { ...DEFAULT_LEDGER_LIMITS, ...limits };
  const filters = pageFilters(params);
  for (let restarts = 0; restarts <= 1; restarts += 1) {
    const seen = new Set<string>();
    const records: UsageLedgerRecord[] = [];
    let duplicates = 0;
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    let pages = 0;
    let snapshot: string | undefined;
    let generation: string | undefined;
    try {
      while (offset < total) {
        if (pages >= config.maxPages || seen.size >= config.maxRecords) {
          return { records, total: Number.isFinite(total) ? total : records.length, pages, duplicates, restarts, truncated: true };
        }
        const page = await fetchUsageLedgerPage({
          request, params: filters, offset, limit: config.pageSize, snapshot, generation,
        });
        pages += 1;
        snapshot ??= page.snapshot;
        generation ??= page.generation;
        total = page.total;
        if (page.records.length === 0 && offset < total) {
          throw new Error(`usage records stopped at offset ${offset} of ${total}; the export would be incomplete`);
        }
        const before = seen.size;
        for (const record of page.records) {
          const key = ledgerRowKey(record);
          if (seen.has(key)) { duplicates += 1; continue; }
          seen.add(key);
          records.push(record);
        }
        offset += page.records.length;
        if (seen.size === before && offset < total) {
          // The server re-served only already-seen rows while claiming more:
          // paging is drifting, so the walk can never reach the reported total.
          return { records, total, pages, duplicates, restarts, truncated: true };
        }
      }
      // Final consistency rule: a complete walk must have covered the total.
      const truncated = records.length < total;
      return { records, total, pages, duplicates, restarts, truncated };
    } catch (error) {
      if (restarts === 0 && isUsageSnapshotRestartError(error)) continue;
      throw error;
    }
  }
  throw new Error("usage snapshot repeatedly expired while exporting");
}

export type CompletenessInfo = { zh: string; en: string; kind: "known" | "partial" | "unknown" | "zero" };

/**
 * A provider-reported zero is a measured fact; missing or partial reports
 * must never render as zero cost.
 */
export function describeCompleteness(record: Pick<UsageLedgerRecord, "completeness" | "totalTokens">): CompletenessInfo {
  if (record.completeness === "known") {
    return record.totalTokens === 0
      ? { zh: "真实零值", en: "True zero", kind: "zero" }
      : { zh: "已回报", en: "Reported", kind: "known" };
  }
  if (record.completeness === "partial") return { zh: "部分回报", en: "Partial", kind: "partial" };
  return { zh: "未回报", en: "Unknown", kind: "unknown" };
}

function iso(ms: number, utc: boolean): string {
  const date = new Date(ms);
  return utc ? date.toISOString() : new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 19);
}

const CSV_COLUMNS: Array<[string, (record: UsageLedgerRecord, utc: boolean) => string | number]> = [
  ["recordedAt", (record, utc) => iso(record.recordedAtMs, utc)],
  ["recordedAtMs", record => record.recordedAtMs],
  ["threadId", record => record.threadId],
  ["turnId", record => record.turnId],
  ["turnStatus", record => record.turnStatus],
  ["model", record => record.model],
  ["providerId", record => record.providerId],
  ["inputTokens", record => record.inputTokens],
  ["cachedInputTokens", record => record.cachedInputTokens],
  ["cacheWriteInputTokens", record => record.cacheWriteInputTokens],
  ["outputTokens", record => record.outputTokens],
  ["reasoningOutputTokens", record => record.reasoningOutputTokens],
  ["totalTokens", record => record.totalTokens],
  ["completeness", record => record.completeness],
];

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Complete CSV for exactly the walked records plus the applied filter set. */
export function ledgerCsv({ records, appliedFilters = {}, utc = false }: {
  records: readonly UsageLedgerRecord[];
  appliedFilters?: Record<string, unknown>;
  utc?: boolean;
}): string {
  const lines: string[] = [];
  lines.push("# knorvia-usage-ledger");
  for (const [key, value] of Object.entries(appliedFilters)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`# ${key}: ${String(value).replaceAll("\n", " ")}`);
  }
  lines.push(CSV_COLUMNS.map(([name]) => name).join(","));
  for (const record of records) {
    lines.push(CSV_COLUMNS.map(([, cell]) => csvCell(cell(record, utc))).join(","));
  }
  lines.push("");
  return lines.join("\n");
}

/** Day bucket for the requested timezone; used by the ledger date inputs. */
export function dayStartToMs(day: string, utc: boolean, endOfDay = false): number {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return Number.NaN;
  return utc
    ? Date.UTC(year, month - 1, date + (endOfDay ? 1 : 0)) - (endOfDay ? 1 : 0)
    : new Date(year, month - 1, date + (endOfDay ? 1 : 0)).getTime() - (endOfDay ? 1 : 0);
}
