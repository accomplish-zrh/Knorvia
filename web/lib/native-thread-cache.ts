import type { Thread, ThreadSnapshot } from "@/lib/native-workbench-state";

/**
 * Bounded frontend cache for opened task sessions (B12).
 *
 * The thread index keeps light projections (no item bodies); full snapshots
 * live in a bounded cache that evicts least-recently-touched entries beyond
 * the entry/item budgets while protecting the visible task, explicitly pinned
 * consumers (side chat), and tasks waiting for approval or input. Recovery
 * after a reconnect reads tasks back with a small worker pool, foreground
 * first, and one failing task never blocks the others.
 */

export type CacheEntry = { snapshot: ThreadSnapshot; touchedAt: number; pinned: boolean };
export type ThreadCacheBudget = { maxEntries: number; maxItems: number };

/** Light index projection: durable metadata + activity, no item bodies. */
export function lightThread(snapshot: ThreadSnapshot): Thread {
  return {
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    title: snapshot.title,
    status: snapshot.status,
    revision: snapshot.revision,
    goalId: snapshot.goalId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    cwd: snapshot.cwd,
    activeTurn: snapshot.activeTurn,
    lastTurn: snapshot.lastTurn,
    pendingApprovals: snapshot.pendingApprovals,
    pendingUserInputs: snapshot.pendingUserInputs,
  };
}

export class ThreadCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Monotonic touch clock: same-millisecond touches still order correctly. */
  private clock = 0;

  constructor(private readonly budget: ThreadCacheBudget) {}

  private now(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  get(id: string): ThreadSnapshot | undefined {
    return this.entries.get(id)?.snapshot;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  set(id: string, snapshot: ThreadSnapshot) {
    const existing = this.entries.get(id);
    this.entries.set(id, { snapshot, touchedAt: this.now(), pinned: existing?.pinned ?? false });
  }

  pin(id: string, pinned: boolean) {
    const entry = this.entries.get(id);
    if (entry) entry.pinned = pinned;
  }

  touch(id: string) {
    const entry = this.entries.get(id);
    if (entry) entry.touchedAt = this.now();
  }

  delete(id: string) {
    this.entries.delete(id);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  stats(): { entries: number; items: number } {
    let items = 0;
    for (const entry of this.entries.values()) items += entry.snapshot.items.length;
    return { entries: this.entries.size, items };
  }

  record(): Record<string, ThreadSnapshot> {
    const record: Record<string, ThreadSnapshot> = {};
    for (const [id, entry] of this.entries) record[id] = entry.snapshot;
    return record;
  }

  /** Evict LRU entries until both budgets hold. Returns the evicted ids. */
  evict(protect?: (id: string, entry: CacheEntry) => boolean): string[] {
    const protectedIds = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (entry.pinned || protect?.(id, entry)) protectedIds.add(id);
    }
    const evicted: string[] = [];
    const candidates = [...this.entries.entries()]
      .filter(([id]) => !protectedIds.has(id))
      .sort(([, a], [, b]) => a.touchedAt - b.touchedAt);
    for (const [id] of candidates) {
      const { entries, items } = this.stats();
      if (entries <= this.budget.maxEntries && items <= this.budget.maxItems) break;
      this.entries.delete(id);
      evicted.push(id);
    }
    return evicted;
  }
}

/**
 * Read tasks back with bounded concurrency. `ids` order is the priority
 * order (callers put the visible thread first); failures are reported per
 * task instead of rejecting the whole recovery.
 */
export async function readThreadsBounded(ids: string[], reader: (id: string) => Promise<unknown>, options: { concurrency?: number } = {}): Promise<{ read: string[]; failed: Record<string, string> }> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, Math.max(1, ids.length)));
  const read: string[] = [];
  const failed: Record<string, string> = {};
  let index = 0;
  const workers: Promise<void>[] = [];
  const runNext = async (): Promise<void> => {
    while (index < ids.length) {
      const id = ids[index++];
      try {
        await reader(id);
        read.push(id);
      } catch (error) {
        failed[id] = error instanceof Error ? error.message : String(error);
      }
    }
  };
  for (let worker = 0; worker < concurrency; worker += 1) workers.push(runNext());
  await Promise.all(workers);
  return { read, failed };
}
