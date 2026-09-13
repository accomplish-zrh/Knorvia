/**
 * Library multi-select batch operations (B02).
 *
 * A batch freezes the selection (id, path, sha256) when the operation starts.
 * Every per-file call carries `expectedId`/`expectedSha256` so the daemon
 * (desktop/personal-library.js compatibility contract) rejects a file that
 * was renamed, replaced, or edited between selection and execution instead of
 * silently operating on the wrong file. Results are per item: successes stay
 * done, conflicts and failures stay retryable, and retries never repeat a
 * succeeded item.
 */

export type BulkEntry = { id: string; path: string; name: string; sha256: string; folder?: boolean };
export type BulkKind = "move" | "trash" | "restore";
export type BulkTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type BulkItemStatus = "pending" | "running" | "done" | "conflict" | "failed" | "skipped";
export type BulkItem = { entry: BulkEntry; status: BulkItemStatus; detail?: string; target?: string };

export const BULK_CONFLICT_MESSAGE = /同名|已存在|冲突|conflict/i;

export function isBulkConflict(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code;
  if (code === -32005 || code === -32006) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return BULK_CONFLICT_MESSAGE.test(message);
}

/** Per-item destination: a folder prefix plus the frozen file name. */
export function bulkTargetPath(entry: BulkEntry, kind: BulkKind, destination: string): string {
  if (kind === "trash" || !destination.trim()) return entry.path;
  const base = destination.trim().replace(/\/+$/, "");
  return `${base}/${entry.name}`;
}

export type BulkState = {
  kind: BulkKind;
  items: BulkItem[];
  running: boolean;
  done: number;
  failed: number;
};

export class LibraryBulkOperation {
  private state: BulkState;
  private readonly listeners = new Set<() => void>();
  private stopped = false;

  constructor(private readonly transport: BulkTransport, kind: BulkKind, entries: BulkEntry[], private destination = "") {
    // Freeze the selection: later library refreshes must not change what the
    // identity guards compare against.
    this.state = { kind, items: entries.map(entry => ({ entry: { ...entry }, status: "pending" as const })), running: false, done: 0, failed: 0 };
  }

  getSnapshot = (): BulkState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<BulkState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private counts(items: BulkItem[]) {
    return {
      items,
      done: items.filter(item => item.status === "done").length,
      failed: items.filter(item => item.status === "conflict" || item.status === "failed").length,
    };
  }

  /** Stop before the next item; the in-flight request is allowed to settle. */
  cancel() {
    this.stopped = true;
  }

  async run() {
    if (this.state.running) return;
    this.stopped = false;
    this.publish({ running: true });
    try {
      for (let index = 0; index < this.state.items.length; index++) {
        if (this.stopped) break;
        const item = this.state.items[index];
        if (item.status !== "pending") continue;
        this.publish({ ...this.counts(this.state.items), items: this.state.items.map((entry, at) => at === index ? { ...entry, status: "running" as const } : entry) });
        try {
          const target = await this.runItem(item);
          this.state.items[index] = { ...item, status: "done", detail: undefined, target: target ?? undefined };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.state.items[index] = { ...item, status: isBulkConflict(error) ? "conflict" : "failed", detail: message };
        }
        this.publish({ ...this.counts(this.state.items) });
      }
      if (this.stopped) {
        this.state.items = this.state.items.map(item => item.status === "pending" ? { ...item, status: "skipped" as const } : item);
        this.publish({ ...this.counts(this.state.items) });
      }
    } finally {
      this.publish({ running: false });
    }
  }

  private async runItem(item: BulkItem): Promise<string | undefined> {
    const entry = item.entry;
    if (this.state.kind === "move") {
      const to = bulkTargetPath(entry, "move", this.destination);
      const result = await this.transport("library/move", { from: entry.path, to, expectedId: entry.id, expectedSha256: entry.sha256 }) as { path?: string } | undefined;
      return result?.path ?? to;
    }
    if (this.state.kind === "trash") {
      await this.transport("library/trash", { path: entry.path, expectedId: entry.id, expectedSha256: entry.sha256 });
      return undefined;
    }
    const to = bulkTargetPath(entry, "restore", this.destination);
    await this.transport("library/restore", { id: entry.id, path: to });
    return to;
  }

  /**
   * Re-run only the items that did not succeed; done items are never repeated.
   * A new destination (for example after a conflict) may be supplied.
   */
  async retryFailed(destination?: string) {
    if (destination !== undefined) this.destination = destination;
    this.state.items = this.state.items.map(item => ["conflict", "failed", "skipped"].includes(item.status) ? { ...item, status: "pending" as const, detail: undefined } : item);
    this.publish({ ...this.counts(this.state.items) });
    await this.run();
  }
}
