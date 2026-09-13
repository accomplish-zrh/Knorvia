/**
 * Bulk archive/restore planning over the existing thread RPC surface.
 *
 * Selection is frozen (id + revision) when a run starts so every mutating
 * call is guarded by the daemon's `expectedRevision` CAS. Outcomes are
 * per-thread: succeeded / skipped / conflict / failed. Retries only touch
 * entries that did not already succeed, so a completed action is never
 * re-applied after a disconnect recovery.
 */
import { taskStatus, type Thread } from "./native-workbench-state";

export type BulkThreadAction = "archive" | "restore";
export type BulkOutcomeKind = "succeeded" | "skipped" | "conflict" | "failed";

/** A frozen selection row captured when the bulk run is confirmed. */
export type BulkSelectionEntry = { id: string; title: string; revision: number };
export type BulkEntryResult = BulkSelectionEntry & {
  kind: BulkOutcomeKind;
  detail: string;
  /** True when a later retry has a chance to succeed (fresh revision fetch). */
  retryable: boolean;
};
export type BulkRunResult = { results: BulkEntryResult[]; stopped: boolean };

export type BulkRequester = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** ProtocolError conflict category over the JSON-RPC wire. */
export const BULK_CONFLICT_CODE = -32005;

export type BulkIneligibility = "running" | "archived" | "notArchived";

/** Why a thread cannot take this bulk action right now, or null when it can. */
export function bulkIneligibility(thread: Thread, action: BulkThreadAction): BulkIneligibility | null {
  if (action === "archive") {
    if (thread.status === "archived") return "archived";
    if (taskStatus(thread) === "running") return "running";
    return null;
  }
  return thread.status === "archived" ? null : "notArchived";
}

export const bulkIneligibilityReason: Record<BulkIneligibility, { zh: string; en: string }> = {
  running: { zh: "正在运行，已跳过", en: "Running; skipped" },
  archived: { zh: "已在归档中", en: "Already archived" },
  notArchived: { zh: "未归档，无法恢复", en: "Not archived" },
};

/**
 * Freeze the confirmed selection: revisions recorded now become the
 * `expectedRevision` of every mutating call in the run.
 */
export function planBulkRun(threads: Thread[], selectedIds: ReadonlySet<string>, action: BulkThreadAction): {
  entries: BulkSelectionEntry[];
  ineligible: { id: string; title: string; reason: BulkIneligibility }[];
} {
  const entries: BulkSelectionEntry[] = [];
  const ineligible: { id: string; title: string; reason: BulkIneligibility }[] = [];
  for (const thread of threads) {
    if (!selectedIds.has(thread.id)) continue;
    const reason = bulkIneligibility(thread, action);
    if (reason) ineligible.push({ id: thread.id, title: thread.title, reason });
    else entries.push({ id: thread.id, title: thread.title, revision: thread.revision });
  }
  return { entries, ineligible };
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === BULK_CONFLICT_CODE;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Protocol categories whose wire codes are retryable (rate-limit, deadline, resource, transient). */
const RETRYABLE_RPC_CODES = new Set([-32022, -32031, -32032, -32040]);

/**
 * Client-side transport failures (timeouts, socket loss) carry no numeric RPC
 * code; server failures are retryable only in the protocol's retryable set or
 * when the embedded ProtocolError marks them so.
 */
function isRetryableFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "number") return true;
  if (RETRYABLE_RPC_CODES.has(code)) return true;
  const data = (error as { data?: { retryable?: unknown } }).data;
  return data?.retryable === true;
}

async function dispatchOne(
  entry: BulkSelectionEntry,
  action: BulkThreadAction,
  request: BulkRequester,
): Promise<BulkEntryResult> {
  const method = action === "archive" ? "thread/archive" : "thread/unarchive";
  try {
    await request(method, { id: entry.id, expectedRevision: entry.revision });
    return { ...entry, kind: "succeeded", detail: "", retryable: false };
  } catch (error) {
    const detail = errorText(error);
    if (isConflict(error) && /running turn/i.test(detail)) {
      // The daemon refuses to archive while a Turn runs. Not an edit conflict;
      // a later retry after the turn settles can succeed.
      return { ...entry, kind: "skipped", detail, retryable: true };
    }
    if (isConflict(error)) {
      // Concurrent rename/revision change: the frozen revision lost the CAS.
      return { ...entry, kind: "conflict", detail, retryable: true };
    }
    return { ...entry, kind: "failed", detail, retryable: isRetryableFailure(error) };
  }
}

/**
 * Run the frozen plan sequentially. `shouldStop` (checked before every
 * thread) lets a lost connection abort the remaining entries; the returned
 * `stopped` flag marks the run incomplete so the UI keeps the unprocessed
 * rows selected for retry instead of claiming success.
 */
export async function runBulkThreadAction({ entries, action, request, shouldStop }: {
  entries: readonly BulkSelectionEntry[];
  action: BulkThreadAction;
  request: BulkRequester;
  shouldStop?: () => boolean;
}): Promise<BulkRunResult> {
  const results: BulkEntryResult[] = [];
  for (const entry of entries) {
    if (shouldStop?.()) return { results, stopped: true };
    results.push(await dispatchOne(entry, action, request));
  }
  return { results, stopped: false };
}

export type RefreshOutcome =
  | { status: "found"; entry: BulkSelectionEntry }
  | { status: "notFound" }
  | { status: "unavailable"; detail: string };

const NOT_FOUND_CODE = -32004;

/**
 * Fresh revision for a retry. Only a genuine daemon NotFound may declare the
 * thread gone; transport loss and retryable RPC failures are reported as
 * `unavailable` so a temporary disconnect can never retire a retryable row.
 */
export async function refreshBulkEntryRevision(entry: BulkSelectionEntry, request: BulkRequester): Promise<RefreshOutcome> {
  try {
    const snapshot = await request<{ revision: number }>("thread/read", { id: entry.id });
    return { status: "found", entry: { ...entry, revision: snapshot.revision } };
  } catch (error) {
    const detail = errorText(error);
    if (error instanceof Error && (error as { code?: unknown }).code === NOT_FOUND_CODE) {
      return { status: "notFound" };
    }
    return { status: "unavailable", detail };
  }
}

/**
 * Retry failed/conflict/skipped rows after refreshing their revisions.
 * Succeeded rows are never re-dispatched, so recovery cannot repeat a
 * completed action. A refresh that fails for transport/retryable reasons
 * keeps the original row retryable (only real NotFound retires it), and an
 * abort during the refresh phase is reported as `stopped` even when no
 * dispatch happened afterwards.
 */
export async function retryBulkEntries({ previous, action, request, shouldStop, refreshRevision = true }: {
  previous: readonly BulkEntryResult[];
  action: BulkThreadAction;
  request: BulkRequester;
  shouldStop?: () => boolean;
  refreshRevision?: boolean;
}): Promise<BulkRunResult> {
  const byId = new Map(previous.map(result => [result.id, result]));
  const retryable = previous.filter(result => result.kind !== "succeeded" && result.retryable);
  const fresh: BulkSelectionEntry[] = [];
  let stoppedDuringRefresh = false;
  for (const result of retryable) {
    if (shouldStop?.()) { stoppedDuringRefresh = true; break; }
    if (!refreshRevision) { fresh.push(result); continue; }
    const outcome = await refreshBulkEntryRevision(result, request);
    if (outcome.status === "found") {
      fresh.push(outcome.entry);
    } else if (outcome.status === "notFound") {
      byId.set(result.id, { ...result, kind: "failed", detail: "任务不存在，可能已被删除", retryable: false });
    } else {
      // Transient refresh failure: keep the row retryable with the fresh
      // reason so a later reconnect can still retry it.
      byId.set(result.id, { ...result, kind: "failed", detail: outcome.detail, retryable: true });
    }
  }
  const run = stoppedDuringRefresh
    ? { results: [] as BulkEntryResult[], stopped: true }
    : await runBulkThreadAction({ entries: fresh, action, request, shouldStop });
  for (const result of run.results) byId.set(result.id, result);
  return { results: [...byId.values()], stopped: stoppedDuringRefresh || run.stopped };
}

/** Replace retried rows in the displayed list, preserving original order. */
export function mergeBulkResults(previous: readonly BulkEntryResult[], next: readonly BulkEntryResult[]): BulkEntryResult[] {
  const updated = new Map(next.map(result => [result.id, result]));
  return previous.map(result => updated.get(result.id) ?? result)
    .concat(next.filter(result => !previous.some(entry => entry.id === result.id)));
}
