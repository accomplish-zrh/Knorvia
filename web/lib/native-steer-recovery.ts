import type { Item, ThreadSnapshot } from "@/lib/native-workbench-state";

/**
 * Recovery for a steer attempt whose outcome is unknown.
 *
 * A persisted `userMessage` item carries `payload.clientId`, written by the
 * control plane before forwarding. Only its completed status acknowledges
 * delivery when the RPC response was lost. Only a complete scan
 * of the thread's durable items may conclude "not delivered"; "not on the
 * first screen" proves nothing.
 */
export type SteerReceiptStatus =
  | { state: "received"; itemId: string; turnId: string; seq: number }
  | { state: "absent"; scannedItems: number }
  | { state: "unknown"; reason: string; scannedItems: number };

export type SteerHistoryPage = {
  items: Item[];
  itemsNextCursor: number | null;
  hasMoreItems: boolean;
};

export type SteerPageReader = (beforeItemSeq?: number) => Promise<SteerHistoryPage>;

/** Bounded backward walk: recovery must never enumerate an unbounded thread. */
export const STEER_RECEIPT_MAX_PAGES = 8;

export function isSteerReceipt(item: Item, clientId: string): boolean {
  return item.kind === "userMessage"
    && item.status === "completed"
    && item.payload?.delivered !== false
    && typeof item.payload?.clientId === "string"
    && item.payload.clientId === clientId;
}

export async function locateSteerReceipt(
  readPage: SteerPageReader,
  clientId: string,
  options: { maxPages?: number; startCursor?: number } = {},
): Promise<SteerReceiptStatus> {
  const maxPages = Math.max(1, options.maxPages ?? STEER_RECEIPT_MAX_PAGES);
  let cursor = options.startCursor;
  let scanned = 0;
  let unconfirmed = false;
  const seen = new Set<number>();
  for (let page = 0; page < maxPages; page += 1) {
    let result: SteerHistoryPage;
    try {
      result = await readPage(cursor);
    } catch (error) {
      return { state: "unknown", reason: error instanceof Error ? error.message : String(error), scannedItems: scanned };
    }
    for (const item of result.items ?? []) {
      scanned += 1;
      if (isSteerReceipt(item, clientId)) return { state: "received", itemId: item.id, turnId: item.turnId, seq: item.seq };
      if (item.kind === "userMessage" && item.payload?.clientId === clientId && !["failed", "interrupted", "cancelled"].includes(item.status)) unconfirmed = true;
    }
    if (result.hasMoreItems === true && (typeof result.itemsNextCursor !== "number" || !Number.isFinite(result.itemsNextCursor) || (cursor !== undefined && result.itemsNextCursor >= cursor))) {
      return { state: "unknown", reason: "history cursor did not advance or is missing", scannedItems: scanned };
    }
    if (result.hasMoreItems !== true) {
      return unconfirmed ? { state: "unknown", reason: "The matching instruction is not durably acknowledged yet", scannedItems: scanned } : { state: "absent", scannedItems: scanned };
    }
    if (result.itemsNextCursor === null) return { state: "unknown", reason: "missing history cursor", scannedItems: scanned };
    // A repeated cursor can never reach older history, so delivery stays
    // unknown rather than falsely "absent".
    if (seen.has(result.itemsNextCursor)) return { state: "unknown", reason: "history cursor did not advance", scannedItems: scanned };
    seen.add(result.itemsNextCursor);
    cursor = result.itemsNextCursor;
  }
  return { state: "unknown", reason: `page budget exhausted after ${scanned} items`, scannedItems: scanned };
}

export type SteerAttempt = { id: string; action: { kind: "start" | "steer"; turnId?: string } };

/**
 * Whether a retained steer attempt points at a turn that can still accept it.
 * A finished or replaced turn routes the attempt into recovery instead of
 * retrying `turn/steer` against a dead target forever.
 */
export function steerTurnStillRunning(snapshot: ThreadSnapshot | undefined, attempt: SteerAttempt): boolean {
  if (attempt.action.kind !== "steer" || !attempt.action.turnId) return false;
  if (!snapshot) return false;
  return snapshot.activeTurn?.id === attempt.action.turnId && snapshot.activeTurn.status === "running";
}
