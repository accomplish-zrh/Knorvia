/** Product projections. Durable snapshots own status; deltas are display-only. */
export type Workspace = { id: string; title: string; cwd?: string | null; revision: number };
export type Turn = { id: string; threadId: string; status: string; createdAt: string; completedAt?: string | null };
export type Item = { id: string; threadId: string; turnId: string; kind: string; status: string; seq: number; payload: Record<string, unknown> };
export type Approval = { id: string; threadId: string; turnId: string; action: string; status: string; digest?: string; target?: Record<string, unknown> };
export type Thread = {
  id: string; workspaceId: string; title: string; status: string; revision: number; goalId?: string | null;
  createdAt: string; updatedAt: string; cwd?: string | null;
  activeTurn?: Turn | null; lastTurn?: Turn | null; pendingApprovals?: Approval[];
  pendingUserInputs?: Item[];
};
/**
 * Client-only bookkeeping for the contiguous chain of server item pages.
 *
 * A live notification can contain an Item newer than the newest fetched page.
 * It must not move this ceiling, otherwise a reconnect would mistake the gap
 * between the page and the notification for already loaded history.
 */
export type ItemHistory = {
  latestPageSeq?: number;
  nextCursor: number | null;
  complete: boolean;
};
export type ThreadSnapshot = Thread & { items: Item[]; turns: Turn[]; pendingApprovals: Approval[]; activeTurn: Turn | null; model?: string | null; reasoningEffort?: string | null; hasMoreItems?: boolean; itemsNextCursor?: number | null; hasMoreTurns?: boolean; turnsNextCursor?: string | null; itemHistory?: ItemHistory };
export type Model = { id: string; model?: string; displayName?: string; description?: string; isDefault?: boolean; supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[] };
export type Artifact = { id: string; workspaceId: string; title: string; type: string; lifecycle: string; currentRevision?: string | null; revision: number; updatedAt: string };
export type ArtifactContent = { content: string; artifact?: Artifact; revision?: { id: string; parentIds?: string[]; createdAt?: string }; revisions?: { id: string; createdAt?: string }[] };
export type Pack = { id: string; name?: string; version: string; publisher?: string; capabilities?: string[]; description?: string };
export type LiveText = { threadId: string; turnId: string; itemId: string; text: string };
export type NativeEvent = { method: string; params?: Record<string, unknown> };

export type SnapshotMergeOptions = {
  /** `older` advances the existing older-page cursor; `notification` keeps it. */
  source?: "latest" | "older" | "notification";
  /** Keep Items and volatile task state changed while this request was in flight. */
  preserveCurrent?: boolean;
};

export function mergeItems(current: Item[], incoming: Item[], { preserveCurrent = false }: Pick<SnapshotMergeOptions, "preserveCurrent"> = {}): Item[] {
  const items = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) {
    if (!preserveCurrent || !items.has(item.id)) items.set(item.id, item);
  }
  return [...items.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function latestItemSeq(items: Item[]): number | undefined { return items.at(-1)?.seq; }

/** Derive pagination state for a raw daemon snapshot. */
export function itemHistory(snapshot: ThreadSnapshot | undefined): ItemHistory | undefined {
  if (!snapshot) return undefined;
  if (snapshot.itemHistory) return snapshot.itemHistory;
  if (snapshot.hasMoreItems === undefined && snapshot.itemsNextCursor === undefined) return undefined;
  return {
    latestPageSeq: latestItemSeq(snapshot.items),
    nextCursor: snapshot.hasMoreItems === false ? null : snapshot.itemsNextCursor ?? null,
    complete: snapshot.hasMoreItems === false,
  };
}

/** Attach pagination state without letting a live Item affect the page chain. */
export function withItemHistory(snapshot: ThreadSnapshot, history: ItemHistory): ThreadSnapshot {
  return {
    ...snapshot,
    itemHistory: history,
    hasMoreItems: history.nextCursor !== null,
    itemsNextCursor: history.nextCursor,
  };
}

/** Whether a newest-page read still needs older pages to join known history. */
export function needsHistoryBridge(page: ThreadSnapshot, known: ItemHistory | undefined): boolean {
  const oldest = page.items[0]?.seq;
  return known?.latestPageSeq !== undefined
    && oldest !== undefined
    && oldest > known.latestPageSeq
    && page.hasMoreItems === true
    && typeof page.itemsNextCursor === "number";
}

export function mergeSnapshot(current: ThreadSnapshot | undefined, snapshot: ThreadSnapshot, options: SnapshotMergeOptions = {}): ThreadSnapshot {
  const source = options.source ?? "latest";
  const preserveCurrent = options.preserveCurrent === true;
  const turns = new Map((current?.turns ?? []).map(turn => [turn.id, turn]));
  for (const turn of snapshot.turns ?? []) {
    if (!preserveCurrent || !turns.has(turn.id)) turns.set(turn.id, turn);
  }
  const currentHistory = itemHistory(current);
  const incomingHistory = itemHistory(snapshot);
  const history = source === "notification"
    ? currentHistory
    : source === "older" && currentHistory
      ? {
          latestPageSeq: currentHistory.latestPageSeq ?? incomingHistory?.latestPageSeq,
          nextCursor: incomingHistory?.nextCursor ?? null,
          complete: incomingHistory?.complete ?? false,
        }
      : incomingHistory ?? currentHistory;
  const volatile: Partial<Pick<ThreadSnapshot, "activeTurn" | "lastTurn" | "pendingApprovals" | "pendingUserInputs">> = preserveCurrent && current
    ? {
        activeTurn: current.activeTurn,
        lastTurn: current.lastTurn !== undefined ? current.lastTurn : snapshot.lastTurn,
        pendingApprovals: current.pendingApprovals,
        pendingUserInputs: current.pendingUserInputs !== undefined ? current.pendingUserInputs : snapshot.pendingUserInputs,
      }
    : {};
  const merged: ThreadSnapshot = {
    ...snapshot,
    ...volatile,
    items: mergeItems(current?.items ?? [], snapshot.items ?? [], { preserveCurrent }),
    turns: [...turns.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    pendingApprovals: preserveCurrent && current ? current.pendingApprovals : snapshot.pendingApprovals ?? [],
    activeTurn: preserveCurrent && current ? current.activeTurn : snapshot.activeTurn ?? null,
  };
  if (history) return withItemHistory(merged, history);
  if (source === "notification" && current) {
    return { ...merged, hasMoreItems: current.hasMoreItems, itemsNextCursor: current.itemsNextCursor };
  }
  return merged;
}

export function reconcileLive(live: LiveText[], snapshot: ThreadSnapshot): LiveText[] {
  const durable = new Set(snapshot.items.map(item => `${item.turnId}:${String(item.payload.kernelItemId ?? "")}`));
  const ended = new Set(snapshot.turns.filter(turn => turn.status !== "running").map(turn => turn.id));
  return live.filter(item => item.threadId !== snapshot.id || (!durable.has(`${item.turnId}:${item.itemId}`) && !ended.has(item.turnId)));
}

export function addDelta(live: LiveText[], event: NativeEvent, snapshot?: ThreadSnapshot): LiveText[] {
  const p = event.params;
  if (event.method !== "turn/event" || p?.kind !== "agentMessage.delta") return live;
  const payload = p.payload as Record<string, unknown> | undefined;
  if (typeof p.threadId !== "string" || typeof p.turnId !== "string" || typeof payload?.itemId !== "string" || typeof payload.text !== "string") return live;
  const turnId = p.turnId, itemId = payload.itemId;
  if (snapshot?.items.some(item => item.turnId === turnId && item.payload.kernelItemId === itemId)) return live;
  if (snapshot?.turns.some(turn => turn.id === turnId && turn.status !== "running")) return live;
  const existing = live.find(item => item.threadId === p.threadId && item.turnId === turnId && item.itemId === itemId);
  // Live text is bounded. Durable Item content will replace it during reconciliation.
  const text = ((existing?.text ?? "") + payload.text).slice(0, 1_048_576);
  const next = { threadId: p.threadId, turnId, itemId, text };
  return existing ? live.map(item => item === existing ? next : item) : [...live, next].slice(-64);
}

export function taskStatus(thread: Thread): string {
  if (thread.pendingUserInputs?.length) return "input";
  if (thread.pendingApprovals?.some(approval => approval.status === "pending")) return "approval";
  if (thread.activeTurn?.status === "running") return "running";
  return thread.lastTurn?.status ?? "ready";
}

export function itemText(item: Item): string {
  if (typeof item.payload.text === "string") return item.payload.text;
  if (typeof item.payload.message === "string") return item.payload.message;
  if (Array.isArray(item.payload.summary)) return item.payload.summary.map(part => typeof part === "string" ? part : String((part as { text?: string })?.text ?? "")).join("\n");
  return "";
}

export function nativeTimestamp(raw: string): number {
  // Rust timestamps use a decimal Unix value followed by `ms`; older stores
  // used plain Unix seconds or milliseconds, and imported data may be ISO.
  const unix = raw.trim().match(/^(\d+)(ms)?$/);
  const value = unix ? Number(unix[1]) * (unix[2] || unix[1].length > 10 ? 1 : 1000) : raw;
  return new Date(value).getTime();
}

export function displayTime(raw: string, locale: string): string {
  const date = new Date(nativeTimestamp(raw));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
