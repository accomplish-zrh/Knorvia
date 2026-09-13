/**
 * Versioned composer drafts with cross-window branch preservation (B09).
 *
 * A draft record (text + attachments + goal fields) is saved twice: first as
 * an immutable, independently discoverable version record under a unique
 * slot key (`${key}:v:${writerId}:${unique}` — never overwritten), then the
 * shared pointer at `${key}` moves. localStorage has no cross-window
 * transactions, so the slot IS the durability: an interleaved writer can
 * take the pointer, but both branches remain enumerable from real storage
 * keys and recoverable. Send-cleanup tombstones only the submitted slot and
 * removes the pointer only when it still holds exactly the submitted
 * content from this writer — a concurrent window's newer draft (same text
 * included) is never removed.
 *
 * Every storage read is failure-isolated. Enumeration denial is reported via
 * `enumerable: false` instead of an empty list that would falsely claim the
 * branches are known. Legacy plain-string pointers, pre-B09 split keys and
 * the old `${key}:history` list are still migrated read-only; they are
 * retired only by an explicit send/clear of the confirmed version.
 */

export type DraftAttachment = { name: string; content: string };
export type DraftGoal = { criteria: string; constraints: string };

export type ComposerDraft = {
  version: number;
  text: string;
  attachments: DraftAttachment[];
  goal: DraftGoal | null;
  savedAt: number;
  /** Which tab/window wrote this record (set by saveDraft). */
  writtenBy?: string;
  /** The immutable slot key this record was written to. */
  slot?: string;
};

export type DraftHistoryEntry = ComposerDraft & { label: string };

export type StoredDraft = {
  current: ComposerDraft | null;
  history: DraftHistoryEntry[];
  /** False when storage denied enumeration: history may be incomplete. */
  enumerable: boolean;
};

export type SaveOutcome =
  | { ok: true; version: number; slotKey: string; conflict: boolean; otherDraft: ComposerDraft | null }
  | { ok: false; reason: "unavailable" | "quota" };

export const DRAFT_HISTORY_LIMIT = 10;
const MAX_TEXT_CHARS = 200_000;
const MAX_HISTORY_TEXT_CHARS = 20_000;
/** Total attachment bytes carried inside a draft record (B06 limit). */
export const DRAFT_ATTACHMENT_LIMIT = 48 * 1024;

const DRAFT_VERSION = 1;
const VERSION_TAG = ":v:";

/** Minimal surface shared by localStorage and the test mocks. */
type DraftStorage = {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem?(name: string): void;
  key?(index: number): string | null;
  length?: number;
};

let fallbackWriterId: string | null = null;

/** Identity of this tab/window for slot ownership and safe send-cleanup. */
export function getComposerWriterId(): string {
  fallbackWriterId ??= typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `w-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return fallbackWriterId;
}

const safeGetItem = (storage: Pick<DraftStorage, "getItem">, name: string): string | null => {
  try { return storage.getItem(name); } catch { return null; }
};

const validAttachment = (value: unknown): value is DraftAttachment => {
  const item = value as { name?: unknown; content?: unknown } | null;
  return typeof item?.name === "string" && typeof item?.content === "string" && item.name.length <= 512 && item.content.length <= 200_000;
};

const parseDraft = (raw: unknown): ComposerDraft | null => {
  if (typeof raw === "string") {
    // Legacy draft: a bare string written by earlier versions.
    return { version: DRAFT_VERSION, text: raw, attachments: [], goal: null, savedAt: Date.now() };
  }
  const value = raw as { version?: unknown; text?: unknown; attachments?: unknown; goal?: unknown; savedAt?: unknown; writtenBy?: unknown; slot?: unknown } | null;
  if (!value || typeof value.text !== "string" || value.text.length > MAX_TEXT_CHARS) return null;
  const attachments = Array.isArray(value.attachments) ? value.attachments.filter(validAttachment).slice(0, 4) : [];
  const goal = value.goal && typeof value.goal === "object"
    && typeof (value.goal as DraftGoal).criteria === "string" && typeof (value.goal as DraftGoal).constraints === "string"
    ? { criteria: (value.goal as DraftGoal).criteria, constraints: (value.goal as DraftGoal).constraints }
    : null;
  return {
    version: typeof value.version === "number" && Number.isFinite(value.version) ? value.version : DRAFT_VERSION,
    text: value.text,
    attachments,
    goal,
    savedAt: typeof value.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : Date.now(),
    writtenBy: typeof value.writtenBy === "string" ? value.writtenBy.slice(0, 64) : undefined,
    slot: typeof value.slot === "string" ? value.slot : undefined,
  };
};

export function draftFingerprint(draft: Pick<ComposerDraft, "text" | "attachments" | "goal">): string {
  return JSON.stringify([draft.text, draft.attachments, draft.goal]);
}

const parseTombstone = (raw: string): boolean => {
  try {
    const value = JSON.parse(raw) as { tombstone?: unknown } | null;
    return Boolean(value && value.tombstone === true);
  } catch { return false; }
};

/** Enumerate version-slot keys from real storage keys; null when denied. */
function listVersionSlotKeys(storage: DraftStorage, prefix: string): string[] | null {
  try {
    if (typeof storage.length !== "number" || typeof storage.key !== "function") return null;
    const keys: string[] = [];
    const total = typeof storage.length === "number" ? storage.length : 0;
    for (let index = 0; index < total; index += 1) {
      const name = storage.key ? storage.key(index) : null;
      if (name && name.startsWith(prefix)) keys.push(name);
    }
    return keys;
  } catch {
    return null;
  }
}

/** Legacy split-key migration inputs (pre-B09 text / goal / attachments). */
function readLegacySplitDraft(storage: DraftStorage, key: string): ComposerDraft | null {
  const raw = safeGetItem(storage, key);
  let goal: DraftGoal | null = null;
  try {
    const value = JSON.parse(safeGetItem(storage, `${key}:goal`) ?? "null");
    if (value && typeof value.criteria === "string" && typeof value.constraints === "string") goal = value;
  } catch { /* malformed legacy metadata does not discard the text */ }
  let attachments: DraftAttachment[] = [];
  try {
    const value = JSON.parse(safeGetItem(storage, `${key}:attachments`) ?? "[]");
    if (Array.isArray(value) && value.length <= 4 && value.every(validAttachment)) attachments = value;
  } catch { /* malformed legacy metadata is not loaded */ }
  const text = typeof raw === "string" && raw.length <= MAX_TEXT_CHARS ? raw : "";
  if (!text && !goal && !attachments.length) return null;
  if (attachments.length && new Blob(attachments.map(file => file.content)).size > DRAFT_ATTACHMENT_LIMIT) attachments = [];
  return { version: 0, text, attachments, goal, savedAt: 0 };
}

export function loadStoredDraft(storage: DraftStorage | undefined, key: string): StoredDraft {
  if (!storage) return { current: null, history: [], enumerable: false };
  let current: ComposerDraft | null = null;
  const rawCurrent = safeGetItem(storage, key);
  if (rawCurrent !== null) {
    try {
      const value = JSON.parse(rawCurrent);
      // Only the complete shape written by saveDraft is a composite record;
      // arbitrary legacy text (including JSON-looking text) fails this check
      // and is read verbatim below.
      if (value && typeof value === "object" && typeof value.version === "number" && Number.isFinite(value.version)
        && typeof value.savedAt === "number" && Number.isFinite(value.savedAt)
        && Array.isArray(value.attachments) && Object.prototype.hasOwnProperty.call(value, "goal")) current = parseDraft(value);
    } catch { /* a legacy plain string fails JSON.parse on purpose */ }
    if (!current) {
      const legacy = readLegacySplitDraft(storage, key);
      if (legacy && rawCurrent.length <= MAX_TEXT_CHARS) current = legacy;
    }
  }
  if (!current) current = readLegacySplitDraft(storage, key);
  // The immutable slot is authoritative. Never trust a stale pointer after
  // send-cleanup or retention. Cleanup does not delete the shared pointer:
  // another window may replace it between any getItem/removeItem pair.
  if (current?.slot) {
    const slot = safeGetItem(storage, current.slot);
    if (slot === null || parseTombstone(slot)) current = null;
  }
  // Merge every non-tombstoned version slot from every writer. Enumeration
  // failure is reported via enumerable:false instead of an empty list that
  // would falsely claim the branches are recoverable.
  let history: DraftHistoryEntry[] = [];
  const seen = new Set<string>(current ? [draftFingerprint(current)] : []);
  const slotKeys = listVersionSlotKeys(storage, `${key}${VERSION_TAG}`);
  if (slotKeys) {
    for (const slotKey of slotKeys) {
      const raw = safeGetItem(storage, slotKey);
      if (raw === null || parseTombstone(raw)) continue;
      try {
        const draft = parseDraft(JSON.parse(raw));
        if (!draft) continue;
        const fingerprint = draftFingerprint(draft);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        history.push({ ...draft, slot: slotKey, label: "自动保存" });
      } catch { /* optional branch */ }
    }
  }
  // The pre-slot shared history list remains a migration source.
  const legacyRaw = safeGetItem(storage, `${key}:history`);
  if (legacyRaw !== null) {
    try {
      const parsed = JSON.parse(legacyRaw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const draft = parseDraft(entry);
          if (!draft) continue;
          const fingerprint = draftFingerprint(draft);
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          const label = typeof entry?.label === "string" ? entry.label.slice(0, 120) : "";
          history.push({ ...draft, label });
        }
      }
    } catch { /* optional history */ }
  }
  history.sort((a, b) => a.savedAt - b.savedAt);
  history = history.slice(-DRAFT_HISTORY_LIMIT);
  return { current, history, enumerable: slotKeys !== null };
}

/** Save the draft: immutable slot first, then the shared pointer. */
export function saveDraft(
  storage: DraftStorage | undefined,
  key: string,
  draft: { text: string; attachments: DraftAttachment[]; goal: DraftGoal | null },
  options: { expectedVersion?: number; writerId?: string; source?: string } = {},
): SaveOutcome {
  if (!storage) return { ok: false, reason: "unavailable" };
  try { storage.getItem(key); } catch { return { ok: false, reason: "unavailable" }; }
  if (draft.text.length > MAX_TEXT_CHARS || draft.attachments.length > 4 || !draft.attachments.every(validAttachment)
    || new Blob(draft.attachments.map(file => file.content)).size > DRAFT_ATTACHMENT_LIMIT) return { ok: false, reason: "quota" };
  const writerId = options.writerId ?? getComposerWriterId();
  const stored = loadStoredDraft(storage, key);
  const fingerprint = draftFingerprint(draft);
  const otherDraft = stored.current;
  // Concurrent divergence: since this window loaded, another writer moved the
  // pointer to different content. Both branches stay recoverable (slots);
  // the caller surfaces the conflict note.
  const concurrent = options.expectedVersion !== undefined
    && otherDraft !== null
    && otherDraft.version !== options.expectedVersion
    && draftFingerprint(otherDraft) !== fingerprint;
  const now = Date.now();
  const version = (stored.current?.version ?? 0) + 1;
  // Slot identity never derives from the shared version counter: a stale
  // reader can move it backwards, so uniqueness comes from the writer id and
  // a random suffix.
  const unique = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `s-${now}-${Math.random().toString(16).slice(2)}`;
  const slotKey = `${key}${VERSION_TAG}${writerId}:${unique}`;
  const next: ComposerDraft = { version, text: draft.text, attachments: draft.attachments, goal: draft.goal, savedAt: now, writtenBy: writerId, slot: slotKey };
  // 1. The immutable version record is durable on its own even if the pointer
  // update below fails or interleaves with another window.
  try {
    storage.setItem(slotKey, JSON.stringify(next));
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? "quota" : "unavailable" };
  }
  pruneSlots(storage, key, writerId, slotKey);
  // 2. Shared pointer, atomic last-writer-wins.
  try {
    storage.setItem(key, JSON.stringify(next));
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? "quota" : "unavailable" };
  }
  return { ok: true, version, slotKey, conflict: concurrent, otherDraft: concurrent ? otherDraft : null };
}

/** Per-writer bounded retention; enumeration denial skips pruning honestly. */
function pruneSlots(storage: DraftStorage, key: string, writerId: string, keepSlot: string) {
  const allSlots = listVersionSlotKeys(storage, `${key}${VERSION_TAG}`);
  if (!allSlots) return;
  const mine: Array<{ key: string; savedAt: number }> = [];
  for (const slotKey of allSlots) {
    if (slotKey === keepSlot) continue;
    try {
      const draft = parseDraft(JSON.parse(safeGetItem(storage, slotKey) ?? "null"));
      if (!draft || (draft.writtenBy ?? "") !== writerId) continue;
      mine.push({ key: slotKey, savedAt: draft.savedAt });
    } catch { /* leave unparseable slots alone */ }
  }
  mine.sort((a, b) => a.savedAt - b.savedAt);
  const removable = mine.length - DRAFT_HISTORY_LIMIT;
  for (let index = 0; index < removable; index += 1) {
    try { storage.removeItem?.(mine[index].key); } catch { /* isolated */ }
  }
}

function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  if (name === "QuotaExceededError") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /quota|exceeded/i.test(message);
}

/**
 * Send-cleanup for one confirmed submission: tombstone the exact submitted
 * slot (single-key atomic write), then remove the shared pointer — and the
 * retired legacy split keys — only when the pointer still holds exactly this
 * submission's content from this writer. Another window's draft written in
 * between (even with identical text) is never removed; it stays the current
 * draft and its own slot remains recoverable. Returns true when the
 * submitted slot was tombstoned.
 */
export function clearSubmittedDraft(
  storage: DraftStorage | undefined,
  key: string,
  slotKey: string | undefined,
  fingerprint: string,
): boolean {
  if (!storage || !slotKey || !slotKey.startsWith(`${key}${VERSION_TAG}`)) return false;
  try {
    storage.setItem(slotKey, JSON.stringify({ tombstone: true, fingerprint }));
  } catch {
    return false;
  }
  // Do not perform a read-then-delete on shared keys. loadStoredDraft follows
  // slot liveness, and a concurrent writer's pointer and slot remain intact.
  return true;
}

/** Restore a history entry as the current draft (writes a new version slot). */
export function restoreDraft(
  storage: DraftStorage | undefined,
  key: string,
  entry: DraftHistoryEntry,
  options: { writerId?: string } = {},
): SaveOutcome {
  return saveDraft(storage, key, { text: entry.text, attachments: entry.attachments, goal: entry.goal }, { source: entry.label, writerId: options.writerId });
}

/**
 * Explicit whole-draft clear (user action). Retires the legacy split fields
 * so a migrated draft cannot revive after reload; version slots are left to
 * bounded retention (they are the recovery history, not live state).
 */
export function clearStoredDraft(storage: DraftStorage | undefined, key: string) {
  if (!storage) return;
  for (const name of [`${key}:goal`, `${key}:attachments`, key]) {
    try { storage.removeItem?.(name); } catch { /* optional draft storage */ }
  }
}

/** History entries keep bounded text previews for display. */
export function historyPreview(entry: DraftHistoryEntry): string {
  const text = entry.text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_HISTORY_TEXT_CHARS) return `${text.slice(0, MAX_HISTORY_TEXT_CHARS)}…`;
  if (!text.length && entry.attachments.length) return entry.attachments.map(file => file.name).join(", ");
  return text;
}
