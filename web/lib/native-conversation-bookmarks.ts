/**
 * Conversation bookmarks and sourced excerpts (B11).
 *
 * A bookmark is local reading metadata: thread/item/turn/seq plus the quoted
 * text and a fingerprint of the source at bookmark time. Nothing is written
 * back to the Kernel, and a note is never presented as the assistant's own
 * words. Excerpts export with their sources; the fingerprint marks exports
 * whose source text changed later.
 */

export type ConversationBookmark = {
  id: string;
  threadId: string;
  itemId: string;
  turnId: string;
  seq: number;
  kind: string;
  /** Quoted source text, bounded at creation time. */
  excerpt: string;
  note: string;
  /** FNV-1a over the source text plus its length. */
  fingerprint: string;
  createdAt: number;
};

export const BOOKMARK_STORAGE_KEY = "knorvia-native-conversation-bookmarks";
export const BOOKMARK_LIMIT = 200;
export const BOOKMARK_EXCERPT_LIMIT = 2000;
export const BOOKMARK_NOTE_LIMIT = 500;

/** Sync change detector; not cryptographic, only "is it still the same text". */
export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}:${text.length}`;
}

const validBookmark = (value: unknown): ConversationBookmark | null => {
  const item = value as Partial<ConversationBookmark> | null;
  if (!item || typeof item !== "object") return null;
  if (typeof item.id !== "string" || typeof item.threadId !== "string" || typeof item.itemId !== "string") return null;
  if (typeof item.excerpt !== "string") return null;
  return {
    id: item.id.slice(0, 64),
    threadId: item.threadId,
    itemId: item.itemId,
    turnId: typeof item.turnId === "string" ? item.turnId : "",
    seq: typeof item.seq === "number" ? item.seq : 0,
    kind: typeof item.kind === "string" ? item.kind : "agentMessage",
    excerpt: item.excerpt.slice(0, BOOKMARK_EXCERPT_LIMIT),
    note: typeof item.note === "string" ? item.note.slice(0, BOOKMARK_NOTE_LIMIT) : "",
    fingerprint: typeof item.fingerprint === "string" ? item.fingerprint : "",
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
  };
};

export function parseBookmarks(raw: string | null | undefined): ConversationBookmark[] {
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(entry => {
    const bookmark = validBookmark(entry);
    return bookmark ? [bookmark] : [];
  }).slice(0, BOOKMARK_LIMIT);
}

export function loadBookmarks(): ConversationBookmark[] {
  if (typeof localStorage === "undefined") return [];
  try { return parseBookmarks(localStorage.getItem(BOOKMARK_STORAGE_KEY)); } catch { return []; }
}

export function saveBookmarks(bookmarks: ConversationBookmark[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try { localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(bookmarks.slice(0, BOOKMARK_LIMIT))); return true; } catch { return false; }
}

export function addBookmark(bookmarks: ConversationBookmark[], entry: { threadId: string; itemId: string; turnId: string; seq: number; kind: string; text: string; excerpt?: string; note?: string }): { list: ConversationBookmark[]; bookmark: ConversationBookmark } {
  const excerpt = (entry.excerpt ?? entry.text).slice(0, BOOKMARK_EXCERPT_LIMIT);
  const duplicate = bookmarks.find(item => item.threadId === entry.threadId && item.itemId === entry.itemId && item.excerpt === excerpt);
  if (duplicate) return { list: bookmarks, bookmark: duplicate };
  const bookmark: ConversationBookmark = {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `bm-${Date.now()}-${bookmarks.length}`,
    threadId: entry.threadId,
    itemId: entry.itemId,
    turnId: entry.turnId,
    seq: entry.seq,
    kind: entry.kind,
    excerpt,
    note: (entry.note ?? "").slice(0, BOOKMARK_NOTE_LIMIT),
    fingerprint: fingerprintText(entry.text),
    createdAt: Date.now(),
  };
  return { list: [bookmark, ...bookmarks].slice(0, BOOKMARK_LIMIT), bookmark };
}

export function removeBookmark(bookmarks: ConversationBookmark[], id: string): ConversationBookmark[] {
  return bookmarks.filter(item => item.id !== id);
}

export function updateBookmarkNote(bookmarks: ConversationBookmark[], id: string, note: string): ConversationBookmark[] {
  return bookmarks.map(item => item.id === id ? { ...item, note: note.slice(0, BOOKMARK_NOTE_LIMIT) } : item);
}

export function bookmarksForThread(bookmarks: ConversationBookmark[], threadId: string): ConversationBookmark[] {
  return bookmarks.filter(item => item.threadId === threadId);
}

export function searchBookmarks(bookmarks: ConversationBookmark[], query: string): ConversationBookmark[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return bookmarks;
  return bookmarks.filter(item => `${item.excerpt} ${item.note}`.toLowerCase().includes(needle));
}

/** Whether the quoted source still matches what was bookmarked. */
export function sourceChanged(bookmark: ConversationBookmark, currentText: string | undefined): boolean | null {
  if (currentText === undefined) return null;
  return fingerprintText(currentText) !== bookmark.fingerprint;
}

export type LocatePlan =
  | { kind: "mounted" }
  | { kind: "paged"; cursor: number }
  | { kind: "unreachable"; reason: "complete-without-match" | "no-history" };

/**
 * How to reach a bookmarked item from the current snapshot: already loaded,
 * reachable through bounded older-page reads, or genuinely unreachable
 * (history complete without a match — the record is gone or out of retention).
 */
export function locatePlan(snapshot: { items: { id: string }[]; hasMoreItems?: boolean; itemsNextCursor?: number | null }, bookmark: ConversationBookmark): LocatePlan {
  if (snapshot.items.some(item => item.id === bookmark.itemId)) return { kind: "mounted" };
  if (snapshot.hasMoreItems === true && typeof snapshot.itemsNextCursor === "number") return { kind: "paged", cursor: snapshot.itemsNextCursor };
  return { kind: "unreachable", reason: snapshot.hasMoreItems === false ? "complete-without-match" : "no-history" };
}

/** Markdown export: every excerpt carries its source coordinates. */
export function exportExcerpts(title: string, bookmarks: ConversationBookmark[]): string {
  const header = `# ${title} — ${bookmarks.length} ${bookmarks.length === 1 ? "excerpt" : "excerpts"}`;
  const body = bookmarks.map(bookmark => {
    const note = bookmark.note ? `\n\n> ${t_note(bookmark.note)}` : "";
    return `## ${new Date(bookmark.createdAt).toLocaleString()}\n\n- source: thread ${bookmark.threadId} · item ${bookmark.itemId} · seq ${bookmark.seq} · ${bookmark.kind}\n- fingerprint: ${bookmark.fingerprint}\n\n${bookmark.excerpt}${note}`;
  });
  return [header, ...body].join("\n\n");
}

const t_note = (note: string) => note.replace(/\n+/g, "\n> ");
