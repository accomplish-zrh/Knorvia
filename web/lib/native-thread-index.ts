import type { Thread } from "./native-workbench-state";

export type ThreadIndexPage = { threads: Thread[]; nextCursor: string | null };
type Request = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

/** Read the complete searchable catalog through bounded requests. Rendering
 * and task timelines remain separate: index rows never carry timeline Items.
 * The caller can render progress and cancel an obsolete connection's walk.
 */
export async function readPagedThreadIndex(request: Request, workspaceIds: string[], options: {
  isCurrent: () => boolean;
  onPage: (rows: Thread[]) => void;
}): Promise<Thread[] | null> {
  const rows = new Map<string, Thread>();
  for (const workspaceId of workspaceIds) {
    let afterId: string | undefined;
    const seen = new Set<string>();
    do {
      if (!options.isCurrent()) return null;
      const page = await request<ThreadIndexPage>("thread/list", { workspaceId, limit: 100, ...(afterId ? { afterId } : {}) });
      if (!options.isCurrent()) return null;
      if (!page || !Array.isArray(page.threads) || page.threads.length > 100
        || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
        throw new Error("The runtime returned an invalid task history page");
      }
      for (const row of page.threads) {
        if (!row || typeof row.id !== "string" || row.workspaceId !== workspaceId) {
          throw new Error("A task history page belongs to a different project");
        }
        const previous = rows.get(row.id);
        rows.set(row.id, previous ? newerThread(previous, row) : row);
      }
      options.onPage(sortThreads([...rows.values()]));
      const cursor = page.nextCursor;
      if (cursor === null) break;
      if (!cursor || seen.has(cursor) || (afterId !== undefined && cursor <= afterId)) {
        throw new Error("The task history cursor did not advance");
      }
      seen.add(cursor);
      afterId = cursor;
    } while (true);
  }
  return sortThreads([...rows.values()]);
}

function newerThread(current: Thread, incoming: Thread): Thread {
  if (current.revision > incoming.revision || current.updatedAt > incoming.updatedAt) return current;
  const currentTurn = current.activeTurn ?? current.lastTurn;
  const incomingTurn = incoming.activeTurn ?? incoming.lastTurn;
  if (currentTurn && (!incomingTurn || currentTurn.createdAt > incomingTurn.createdAt)) return current;
  return incoming;
}

function sortThreads(rows: Thread[]): Thread[] {
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

/** Late pages must not erase a newer rename or a newly admitted task. */
export function mergeThreadIndex(current: Thread[], incoming: Thread[], preserveIds: ReadonlySet<string> = new Set()): Thread[] {
  const rows = new Map(current.map(row => [row.id, row]));
  for (const row of incoming) {
    const previous = rows.get(row.id);
    rows.set(row.id, previous ? preserveIds.has(row.id) ? previous : newerThread(previous, row) : row);
  }
  return sortThreads([...rows.values()]);
}
