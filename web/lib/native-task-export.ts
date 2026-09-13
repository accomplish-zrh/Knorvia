/**
 * Offline task export over the existing paginated thread RPC.
 *
 * One `thread/read` head snapshot fixes the cutoff (the newest durable Item
 * visible at export start). Both walks move older-ward
 * (`beforeItemSeq`/`beforeTurnId`), so messages that arrive mid-export are
 * never chased. Every page merges by record id, a cursor that fails to
 * advance fails the export instead of looping, and hard page bounds guarantee
 * termination. A partial walk is always reported as `incomplete`/`cancelled`
 * — it must never present itself as full.
 *
 * By default raw tool payloads and secret-shaped fields are not exported.
 */
import { type Item, type ThreadSnapshot, type Turn } from "./native-workbench-state";

export type TaskExportStatus = "complete" | "incomplete" | "cancelled" | "failed";
export type TaskExportFormat = "markdown" | "json";

export type TaskExportArtifactRef = {
  id: string;
  title: string;
  type: string;
  /** `payload` = referenced by an exported item; `title` = same-workspace output with the task's title. */
  matchedBy: "payload" | "title";
};

export type TaskExportProgress = {
  phase: "items" | "turns" | "references" | "compose";
  fetchedItems: number;
  fetchedTurns: number;
  pages: number;
};

export type TaskExportResult = {
  status: TaskExportStatus;
  reason: string;
  requestedAt: string;
  finishedAt: string;
  cutoff: { requestedAt: string; newestItemSeq: number | null };
  thread: { id: string; title: string; workspaceId: string; status: string; createdAt: string; updatedAt: string; revision?: number };
  items: Item[];
  turns: Turn[];
  artifactRefs: TaskExportArtifactRef[];
  /** Same-workspace outputs whose title equals the task title. NOT claimed as task outputs. */
  unverifiedTitleMatches: TaskExportArtifactRef[];
  attachments: { name: string; itemId: string }[];
  stats: { itemPages: number; turnPages: number; duplicateItems: number; duplicateTurns: number };
  completeness: { itemsComplete: boolean; turnsComplete: boolean; bounded: boolean };
  redaction: { includeRawPayloads: boolean };
};

export type TaskExportOptions = {
  threadId: string;
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /** Poll between pages; a poll that returns false stops the walk as `cancelled`. */
  shouldContinue?: () => boolean;
  onProgress?: (progress: TaskExportProgress) => void;
  /** Embed full tool/user-input payloads (secret-shaped keys still stripped). */
  includeRawPayloads?: boolean;
  limits?: Partial<typeof DEFAULT_EXPORT_LIMITS>;
};

const DEFAULT_EXPORT_LIMITS = {
  itemPages: 200,
  turnPages: 200,
  /** Hard cap on retained records even if pages keep returning new ids. */
  maxItems: 100_000,
  maxTurns: 20_000,
};

const SECRET_KEY = /key|token|secret|password|authorization|credential|api[-_]?key/i;
const RAW_PAYLOAD_KINDS = new Set(["userMessage", "agentMessage", "reasoning", "error"]);

function fail(reason: string): never {
  throw new Error(reason);
}

function maxItemSeq(items: Item[]): number | null {
  return items.reduce<number | null>((max, item) => typeof item.seq === "number" && (max === null || item.seq > max) ? item.seq : max, null);
}

/** Strip secret-shaped fields anywhere in a payload clone. */
export function stripSecretFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(entry => stripSecretFields(entry)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = stripSecretFields(entry);
    }
    return out as unknown as T;
  }
  return value;
}

/** Default export keeps narrative text; tool/user-input raw payloads stay out. */
export function redactExportItem(item: Item, includeRawPayloads: boolean): Item {
  const payload = item.payload ?? {};
  if (!includeRawPayloads && !RAW_PAYLOAD_KINDS.has(item.kind)) {
    return { ...item, payload: { redacted: true, reason: "raw tool payload excluded by default" } };
  }
  return { ...item, payload: stripSecretFields(payload) };
}

function collectAttachments(items: Item[]): { name: string; itemId: string }[] {
  const out: { name: string; itemId: string }[] = [];
  for (const item of items) {
    const candidates = item.payload?.attachments ?? item.payload?.files;
    if (!Array.isArray(candidates)) continue;
    for (const entry of candidates) {
      const name = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string"
        ? (entry as Record<string, unknown>).name as string : null;
      if (name) out.push({ name, itemId: item.id });
    }
  }
  return out;
}

function collectArtifactRefs(items: Item[]): TaskExportArtifactRef[] {
  const refs = new Map<string, TaskExportArtifactRef>();
  for (const item of items) {
    const candidates: unknown[] = [item.payload?.artifact, item.payload?.artifactId, ...(Array.isArray(item.payload?.artifacts) ? item.payload.artifacts : [])];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        refs.set(candidate, { id: candidate, title: "", type: "", matchedBy: "payload" });
      } else if (candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).id === "string") {
        const artifact = candidate as Record<string, unknown>;
        refs.set(artifact.id as string, {
          id: artifact.id as string,
          title: typeof artifact.title === "string" ? artifact.title : "",
          type: typeof artifact.type === "string" ? artifact.type : "",
          matchedBy: "payload",
        });
      }
    }
  }
  return [...refs.values()];
}

type PageWalk = { records: (Item | Turn)[]; complete: boolean; bounded: boolean; pages: number; duplicates: number };

/**
 * Walk one cursor chain older-ward starting from the head snapshot. Returns
 * merged records plus whether the chain truly ended within the page budget.
 */
async function walkPages({ head, kind, threadId, request, shouldContinue, limits, progress, emit }: {
  head: ThreadSnapshot;
  kind: "items" | "turns";
  threadId: string;
  request: TaskExportOptions["request"];
  shouldContinue?: () => boolean;
  limits: typeof DEFAULT_EXPORT_LIMITS;
  progress: TaskExportProgress;
  emit: () => void;
}): Promise<PageWalk> {
  const isItems = kind === "items";
  const maxPages = isItems ? limits.itemPages : limits.turnPages;
  const hardCap = isItems ? limits.maxItems : limits.maxTurns;
  const completeAfter = (page: ThreadSnapshot) => (isItems ? page.hasMoreItems === false : page.hasMoreTurns === false);
  const cursorOf = (page: ThreadSnapshot): number | string | null | undefined => (isItems ? page.itemsNextCursor : page.turnsNextCursor);
  const recordsOf = (page: ThreadSnapshot) => (isItems ? page.items ?? [] : page.turns ?? []) as (Item | Turn)[];

  const records = new Map<string, Item | Turn>();
  let duplicates = 0;
  let complete = completeAfter(head);
  let cursor = cursorOf(head);
  let previousCursor: number | string | null | undefined = undefined;
  let bounded = false;
  let pages = 1;
  const absorb = (incoming: (Item | Turn)[]) => {
    for (const record of incoming) {
      if (records.has(record.id)) { duplicates += 1; continue; }
      records.set(record.id, record);
    }
  };
  absorb(recordsOf(head));
  if (isItems) progress.fetchedItems = records.size; else progress.fetchedTurns = records.size;
  progress.pages = pages;
  emit();
  while (!complete && records.size < hardCap) {
    if (shouldContinue && !shouldContinue()) return { records: [...records.values()], complete: false, bounded: false, pages, duplicates };
    if (cursor === null || cursor === undefined) break;
    if (cursor === previousCursor) fail(`${kind} cursor did not advance; export stopped instead of looping`);
    previousCursor = cursor;
    if (pages >= maxPages) { bounded = true; break; }
    const params = isItems
      ? { id: threadId, beforeItemSeq: cursor as number, itemLimit: 500 }
      : { id: threadId, beforeTurnId: cursor as string, turnLimit: 500 };
    const page = await request<ThreadSnapshot>("thread/read", params);
    pages += 1;
    absorb(recordsOf(page));
    complete = completeAfter(page);
    cursor = cursorOf(page);
    if (isItems) progress.fetchedItems = records.size; else progress.fetchedTurns = records.size;
    progress.pages = pages;
    emit();
  }
  const ordered = [...records.values()].sort((a, b) => {
    // Item seq is numeric; a string compare would rank 99 above 950.
    if (isItems) return ((a as Item).seq ?? 0) - ((b as Item).seq ?? 0);
    return String((a as Turn).createdAt).localeCompare(String((b as Turn).createdAt)) || a.id.localeCompare(b.id);
  });
  return { records: ordered, complete, bounded: bounded || records.size >= hardCap, pages, duplicates };
}

function threadMeta(head: ThreadSnapshot): TaskExportResult["thread"] {
  return {
    id: head.id, title: head.title, workspaceId: head.workspaceId,
    status: head.status, createdAt: head.createdAt, updatedAt: head.updatedAt, revision: head.revision,
  };
}

/** Export one task's full durable timeline with fixed-cutoff semantics. */
export async function exportTaskHistory(options: TaskExportOptions): Promise<TaskExportResult> {
  const limits = { ...DEFAULT_EXPORT_LIMITS, ...options.limits };
  const { threadId, request } = options;
  const includeRawPayloads = options.includeRawPayloads === true;
  const requestedAt = new Date().toISOString();
  const progress: TaskExportProgress = { phase: "items", fetchedItems: 0, fetchedTurns: 0, pages: 0 };
  const keepGoing = () => (options.shouldContinue ? options.shouldContinue() : true);
  const cancelled = () => keepGoing() === false;

  const head = await request<ThreadSnapshot>("thread/read", { id: threadId, itemLimit: 500, turnLimit: 500 });
  // Fixed cutoff: the newest durable Item visible at export start. The walk
  // only moves older-ward, so later arrivals are out of scope by design.
  const cutoff = { requestedAt, newestItemSeq: maxItemSeq(head.items ?? []) };

  try {
    const emit = () => options.onProgress?.({ ...progress });
    const itemsWalk = await walkPages({ head, kind: "items", threadId, request, shouldContinue: keepGoing, limits, progress, emit });
    if (cancelled()) return cancelledResult(requestedAt, head, itemsWalk.records as Item[], [], includeRawPayloads);
    const items = (itemsWalk.records as Item[])
      // Keep the cutoff honest even when a page read raced a concurrent append.
      .filter(item => cutoff.newestItemSeq === null || item.seq <= cutoff.newestItemSeq);

    progress.phase = "turns";
    const turnsWalk = await walkPages({ head, kind: "turns", threadId, request, shouldContinue: keepGoing, limits, progress, emit });
    if (cancelled()) return cancelledResult(requestedAt, head, items, turnsWalk.records as Turn[], includeRawPayloads);
    const turns = turnsWalk.records as Turn[];

    progress.phase = "references";
    // Ownership comes only from verifiable in-item references. A same-title
    // output in the same workspace may belong to a different task, so it is
    // reported separately as an UNVERIFIED candidate, never as a reference.
    const artifactRefs = collectArtifactRefs(items);
    let unverifiedTitleMatches: TaskExportArtifactRef[] = [];
    try {
      if (cancelled()) return cancelledResult(requestedAt, head, items, turns, includeRawPayloads);
      const workspaceArtifacts = await request<{ id: string; title: string; type: string }[]>("artifact/list", { workspaceId: head.workspaceId });
      // Cancellation is honoured through the references phase too: a cancelled
      // export must never come back labelled complete.
      if (cancelled()) return cancelledResult(requestedAt, head, items, turns, includeRawPayloads);
      unverifiedTitleMatches = workspaceArtifacts
        .filter(artifact => typeof artifact?.title === "string" && artifact.title === head.title
          && !artifactRefs.some(ref => ref.id === artifact.id))
        .map(artifact => ({
          id: artifact.id,
          title: typeof artifact.title === "string" ? artifact.title : "",
          type: typeof artifact.type === "string" ? artifact.type : "",
          matchedBy: "title" as const,
        }));
    } catch { /* references are best-effort; the timeline export stands on its own */ }
    if (cancelled()) return cancelledResult(requestedAt, head, items, turns, includeRawPayloads);

    const redacted = items.map(item => redactExportItem(item, includeRawPayloads));
    const complete = itemsWalk.complete && turnsWalk.complete;
    progress.phase = "compose";
    return {
      status: complete ? "complete" : "incomplete",
      reason: complete ? "" : itemsWalk.bounded ? `item pages exceeded the ${limits.itemPages}-page safety bound`
        : turnsWalk.bounded ? `turn pages exceeded the ${limits.turnPages}-page safety bound`
        : "the task index did not report a complete tail during this export",
      requestedAt,
      finishedAt: new Date().toISOString(),
      cutoff,
      thread: threadMeta(head),
      items: redacted,
      turns,
      artifactRefs,
      unverifiedTitleMatches,
      attachments: collectAttachments(redacted),
      stats: {
        itemPages: itemsWalk.pages, turnPages: turnsWalk.pages,
        duplicateItems: itemsWalk.duplicates, duplicateTurns: turnsWalk.duplicates,
      },
      completeness: { itemsComplete: itemsWalk.complete, turnsComplete: turnsWalk.complete, bounded: itemsWalk.bounded || turnsWalk.bounded },
      redaction: { includeRawPayloads },
    };
  } catch (error) {
    return {
      status: "failed",
      reason: `export walk failed: ${(error as Error).message}`,
      requestedAt,
      finishedAt: new Date().toISOString(),
      cutoff: { requestedAt, newestItemSeq: null },
      thread: threadMeta(head),
      items: [],
      turns: [],
      artifactRefs: [],
      unverifiedTitleMatches: [],
      attachments: [],
      stats: { itemPages: 0, turnPages: 0, duplicateItems: 0, duplicateTurns: 0 },
      completeness: { itemsComplete: false, turnsComplete: false, bounded: false },
      redaction: { includeRawPayloads },
    };
  }
}

function partialBase(requestedAt: string, head: ThreadSnapshot, items: Item[], turns: Turn[], includeRawPayloads: boolean): TaskExportResult {
  return {
    status: "failed",
    reason: "",
    requestedAt,
    finishedAt: new Date().toISOString(),
    cutoff: { requestedAt, newestItemSeq: maxItemSeq(items) },
    thread: threadMeta(head),
    items: items.map(item => redactExportItem(item, includeRawPayloads)),
    turns,
    artifactRefs: collectArtifactRefs(items),
    unverifiedTitleMatches: [],
    attachments: [],
    stats: { itemPages: 0, turnPages: 0, duplicateItems: 0, duplicateTurns: 0 },
    completeness: { itemsComplete: false, turnsComplete: false, bounded: false },
    redaction: { includeRawPayloads: includeRawPayloads === true },
  };
}

function cancelledResult(requestedAt: string, head: ThreadSnapshot, items: Item[], turns: Turn[], includeRawPayloads: boolean): TaskExportResult {
  return {
    ...partialBase(requestedAt, head, items, turns, includeRawPayloads),
    status: "cancelled",
    reason: "the export was cancelled before the timeline tail was reached",
  };
}

const STATUS_BANNER: Record<TaskExportStatus, string> = {
  complete: "",
  incomplete: "> ⚠️ **Incomplete export.** The walk stopped before the durable tail; do not treat this file as the full task history.\n",
  cancelled: "> ⚠️ **Cancelled export.** This partial timeline was kept because the export was cancelled; it is not the full task history.\n",
  failed: "> ⚠️ **Failed export.** The walk could not finish; the partial content below was retained for inspection.\n",
};

/** Full Markdown rendering: metadata, completeness banner, then turn-by-turn items. */
export function composeTaskExportMarkdown(result: TaskExportResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.thread.title}`);
  lines.push("");
  lines.push(`- Task ID: \`${result.thread.id}\``);
  lines.push(`- Project: \`${result.thread.workspaceId}\``);
  lines.push(`- Status: ${result.thread.status}`);
  lines.push(`- Created: ${result.thread.createdAt} · Updated: ${result.thread.updatedAt}`);
  lines.push(`- Exported: ${result.finishedAt} (cutoff ${result.cutoff.requestedAt}, newest item seq ${result.cutoff.newestItemSeq ?? "n/a"})`);
  lines.push(`- Coverage: ${result.items.length} items across ${result.turns.length} turns; items complete: ${result.completeness.itemsComplete ? "yes" : "NO"}; turns complete: ${result.completeness.turnsComplete ? "yes" : "NO"}`);
  lines.push(result.redaction.includeRawPayloads
    ? "- Redaction: raw payloads embedded (secret-shaped fields stripped)"
    : "- Redaction: raw tool payloads excluded by default");
  lines.push("");
  lines.push(STATUS_BANNER[result.status]);
  if (result.artifactRefs.length > 0) {
    lines.push(`## Artifact references (${result.artifactRefs.length})`);
    for (const ref of result.artifactRefs) {
      lines.push(`- ${ref.title || "(untitled)"} — \`${ref.id}\` ${ref.type ? `(${ref.type}) ` : ""}[matched by ${ref.matchedBy}]`);
    }
    lines.push("");
  }
  if (result.attachments.length > 0) {
    lines.push(`### Attachment references (${result.attachments.length})`);
    for (const attachment of result.attachments) lines.push(`- ${attachment.name} (item \`${attachment.itemId}\`)`);
    lines.push("");
  }
  const itemsByTurn = new Map<string, Item[]>();
  for (const item of result.items) {
    const bucket = itemsByTurn.get(item.turnId) ?? [];
    bucket.push(item);
    itemsByTurn.set(item.turnId, bucket);
  }
  lines.push(`## Timeline (${result.turns.length} turns)`);
  const renderItem = (item: Item): void => {
    const note = item.payload && (item.payload as Record<string, unknown>).redacted ? "_(raw payload not exported)_" : "";
    if (typeof item.payload?.text === "string" && item.payload.text) {
      lines.push("");
      lines.push(`**${item.kind}** (${item.status})`);
      lines.push("");
      lines.push(item.payload.text);
    } else {
      lines.push(`- **${item.kind}** (${item.status}) ${note}`.trimEnd());
    }
  };
  for (const turn of result.turns) {
    lines.push("");
    lines.push(`### Turn \`${turn.id}\` — ${turn.status} · ${turn.createdAt}`);
    for (const item of itemsByTurn.get(turn.id) ?? []) renderItem(item);
  }
  // A partial walk can hold items whose turns were never reached. They stay
  // in the file — dropping them would hide read content from the user.
  const exportedTurnIds = new Set(result.turns.map(turn => turn.id));
  const orphans = result.items.filter(item => !exportedTurnIds.has(item.turnId));
  if (orphans.length > 0) {
    lines.push("");
    lines.push(`### Items without an exported turn (${orphans.length})`);
    lines.push("");
    lines.push("_The walk stopped before reaching these items' turns; partial exports never hide read content._");
    for (const item of orphans) renderItem(item);
  }
  if (result.unverifiedTitleMatches.length > 0) {
    lines.push("");
    lines.push(`### Unverified same-title outputs (${result.unverifiedTitleMatches.length})`);
    for (const ref of result.unverifiedTitleMatches) lines.push(`- ${ref.title} — \`${ref.id}\` (not claimed as this task's output; ownership unverified)`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Structured JSON rendering (stable field order, machine readable). */
export function composeTaskExportJson(result: TaskExportResult): string {
  return JSON.stringify({
    format: "knorvia-task-export",
    version: 1,
    status: result.status,
    reason: result.reason,
    requestedAt: result.requestedAt,
    finishedAt: result.finishedAt,
    cutoff: result.cutoff,
    completeness: result.completeness,
    redaction: result.redaction,
    thread: result.thread,
    stats: result.stats,
    artifactRefs: result.artifactRefs,
    unverifiedTitleMatches: result.unverifiedTitleMatches,
    attachments: result.attachments,
    turns: result.turns,
    items: result.items,
  }, null, 2) + "\n";
}
