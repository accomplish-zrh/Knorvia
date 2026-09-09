/**
 * Frozen spreadsheet selection for the next chat send.
 *
 * The draft-card preview reports the selected range here; ``sendMessage``
 * takes it (read-once) and attaches it to ``start_turn`` as
 * ``office_selection``. The backend freezes the value for the whole turn and
 * rejects agent batches that drift outside it, so this is a user-intent
 * channel, never a tool-input path.
 *
 * The slot is module-level, so it is tagged with the session that set it: a
 * selection made in one conversation must not be consumed by a message sent
 * in another.
 */

import type { OfficeSelection } from "@/lib/office-draft";

type PendingSelection = {
  selection: OfficeSelection;
  sessionId: string;
};

let pending: PendingSelection | null = null;

export function setPendingOfficeSelection(
  selection: OfficeSelection | null,
  sessionId = "",
): void {
  pending = selection ? { selection, sessionId } : null;
}

/** Read the selection once. A selection owned by another session is left in
 * place for that session instead of being consumed or cleared. */
export function takePendingOfficeSelection(
  sessionId?: string,
): OfficeSelection | null {
  if (!pending) return null;
  if (
    sessionId !== undefined &&
    pending.sessionId &&
    pending.sessionId !== sessionId
  ) {
    return null;
  }
  const taken = pending;
  pending = null;
  return taken.selection;
}

/** Drop the selection, but only if it belongs to ``sessionId`` (or is unscoped). */
export function clearPendingOfficeSelection(sessionId = ""): void {
  if (!pending) return;
  if (sessionId && pending.sessionId && pending.sessionId !== sessionId) return;
  pending = null;
}
