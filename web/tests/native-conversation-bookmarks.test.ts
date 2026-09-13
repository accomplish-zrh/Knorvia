import test from "node:test";
import assert from "node:assert/strict";
import { addBookmark, bookmarksForThread, exportExcerpts, fingerprintText, locatePlan, parseBookmarks, removeBookmark, searchBookmarks, sourceChanged, updateBookmarkNote, BOOKMARK_LIMIT } from "../lib/native-conversation-bookmarks";
import type { ConversationBookmark } from "../lib/native-conversation-bookmarks";

const bookmark = (overrides: Partial<ConversationBookmark> = {}): ConversationBookmark => ({
  id: "bm1", threadId: "t1", itemId: "i1", turnId: "turn1", seq: 12, kind: "agentMessage",
  excerpt: "the build fails on windows paths", note: "check path handling", fingerprint: fingerprintText("the build fails on windows paths"), createdAt: 1,
  ...overrides,
});

test("fingerprints distinguish content; equal text shares one", () => {
  assert.equal(fingerprintText("abc"), fingerprintText("abc"));
  assert.notEqual(fingerprintText("abc"), fingerprintText("abd"));
  assert.notEqual(fingerprintText("abc"), fingerprintText("abcd"));
});

test("selected excerpts keep a fingerprint of the complete source message", () => {
  const source = "prefix **selected conclusion** suffix";
  const { bookmark: selected } = addBookmark([], { threadId: "t", itemId: "i", turnId: "turn", seq: 9, kind: "userMessage", text: source, excerpt: "selected conclusion" });
  assert.equal(selected.excerpt, "selected conclusion");
  assert.equal(sourceChanged(selected, source), false);
  assert.equal(sourceChanged(selected, source + " updated outside the selection"), true);
  assert.equal(sourceChanged(selected, selected.excerpt), true);
});

test("adding a bookmark quotes bounded text and dedupes identical quotes per item", () => {
  let list: ConversationBookmark[] = [];
  const long = "x".repeat(3000);
  const first = addBookmark(list, { threadId: "t1", itemId: "i9", turnId: "turn", seq: 3, kind: "agentMessage", text: long });
  list = first.list;
  assert.ok(first.bookmark.excerpt.length <= 2000);
  assert.equal(first.bookmark.fingerprint, fingerprintText(long));
  const again = addBookmark(list, { threadId: "t1", itemId: "i9", turnId: "turn", seq: 3, kind: "agentMessage", text: long });
  assert.equal(again.list.length, 1);
  // Same text on a different item is a different source and stays separate.
  const other = addBookmark(list, { threadId: "t1", itemId: "i10", turnId: "turn", seq: 4, kind: "agentMessage", text: long });
  assert.equal(other.list.length, 2);
});

test("locate plans: mounted, bounded paging, and honest unreachable", () => {
  assert.deepEqual(locatePlan({ items: [{ id: "i1" }], hasMoreItems: false }, bookmark()), { kind: "mounted" });
  assert.deepEqual(locatePlan({ items: [{ id: "i2" }], hasMoreItems: true, itemsNextCursor: 40 }, bookmark()), { kind: "paged", cursor: 40 });
  assert.deepEqual(locatePlan({ items: [{ id: "i2" }], hasMoreItems: false, itemsNextCursor: null }, bookmark()), { kind: "unreachable", reason: "complete-without-match" });
  assert.deepEqual(locatePlan({ items: [] }, bookmark()), { kind: "unreachable", reason: "no-history" });
});

test("source changes are flagged by fingerprint, never rewritten silently", () => {
  assert.equal(sourceChanged(bookmark(), "the build fails on windows paths"), false);
  assert.equal(sourceChanged(bookmark(), "the build fails on windows paths (updated)"), true);
  assert.equal(sourceChanged(bookmark(), undefined), null);
});

test("search, notes, and removal never touch other threads or the quoted source", () => {
  const list = [bookmark(), bookmark({ id: "bm2", threadId: "t2", excerpt: "video render tips", note: "" })];
  assert.deepEqual(searchBookmarks(list, "windows").map(item => item.id), ["bm1"]);
  const noted = updateBookmarkNote(list, "bm1", "verified on 2026-09-12");
  assert.equal(noted[0].note, "verified on 2026-09-12");
  assert.equal(noted[1].note, "");
  const kept = removeBookmark(list, "bm1");
  assert.equal(kept.length, 1);
  // The excerpt itself is untouched by note updates.
  assert.equal(noted[0].excerpt, "the build fails on windows paths");
});

test("exports carry thread, item, seq, kind, and fingerprint for every excerpt", () => {
  const markdown = exportExcerpts("Fix build", [bookmark(), bookmark({ id: "bm2", itemId: "i2", seq: 30, note: "" })]);
  assert.match(markdown, /# Fix build — 2 excerpts/);
  assert.match(markdown, /item i1 · seq 12 · agentMessage/);
  assert.match(markdown, /fingerprint: /);
  assert.match(markdown, /> check path handling/);
});

test("stored bookmarks are validated and bounded", () => {
  assert.equal(parseBookmarks("nope").length, 0);
  const parsed = parseBookmarks(JSON.stringify([bookmark(), { id: "bad" }, null]));
  assert.equal(parsed.length, 1);
  const many = Array.from({ length: BOOKMARK_LIMIT + 10 }, (_, index) => bookmark({ id: `bm${index}` }));
  assert.equal(parseBookmarks(JSON.stringify(many)).length, BOOKMARK_LIMIT);
  assert.equal(bookmarksForThread([bookmark(), bookmark({ id: "bm9", threadId: "t2" })], "t2").length, 1);
});
