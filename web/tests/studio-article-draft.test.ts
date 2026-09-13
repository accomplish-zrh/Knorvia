import test from "node:test";
import assert from "node:assert/strict";

import {
  articleDraftSlot, clearArticleDraft, draftFromProject, draftReplayDecision, draftToMarkdown,
  loadArticleDrafts, makeArticleDraft, readArticleDraft, readArticleDrafts, storeArticleDraft,
  type ArticleDraft, type DraftStorage,
} from "../lib/studio-article-draft";

function memoryStorage(): DraftStorage & { data: Map<string, string>; failWrites: boolean } {
  const data = new Map<string, string>();
  return {
    data,
    failWrites: false,
    getItem(key) { if (this.failWrites) throw new Error("unavailable"); return data.get(key) ?? null; },
    setItem(key, value) { if (this.failWrites) throw new Error("unavailable"); data.set(key, value); },
  };
}

const validDraft = (overrides: Partial<ArticleDraft> = {}): ArticleDraft => ({
  version: 1,
  workspaceId: "ws",
  projectId: "p1",
  baseRevision: 3,
  title: "标题",
  article: "正文".repeat(10),
  audience: "读者",
  narration: "第一段。\n\n第二段。",
  aspect: "16:9",
  scenes: [{ heading: "开场", detail: "画面" }],
  updatedAt: 1728500000000,
  ...overrides,
});

test("readArticleDraft: strict validation drops corrupt or out-of-bounds drafts", () => {
  assert.ok(readArticleDraft(validDraft()));
  assert.equal(readArticleDraft(null), undefined);
  assert.equal(readArticleDraft("json"), undefined);
  assert.equal(readArticleDraft({ ...validDraft(), version: 2 }), undefined);
  assert.equal(readArticleDraft({ ...validDraft(), narration: 42 as never }), undefined);
  assert.equal(readArticleDraft({ ...validDraft(), aspect: "4:3" }), undefined);
  assert.equal(readArticleDraft({ ...validDraft(), scenes: [{ heading: "x", detail: 1 as never }] }), undefined);
  assert.equal(readArticleDraft({ ...validDraft(), article: "x".repeat(60001) }), undefined);
  assert.equal(readArticleDraft({ ...validDraft(), scenes: Array.from({ length: 81 }, () => ({ heading: "h", detail: "d" })) }), undefined);
  assert.equal(readArticleDraft({ ...validDraft(), updatedAt: "yesterday" as never }), undefined);
});

test("store/load roundtrip isolates by workspace and project slot", () => {
  const storage = memoryStorage();
  const ws1 = draftFromProject("ws1", { id: "p1", revision: 3, narration: "", aspect: "16:9", scenes: [] }, { narration: "编辑一", aspect: "16:9", scenes: [] });
  const ws2 = makeArticleDraft("ws2", { title: "另一个工作区" });
  assert.equal(storeArticleDraft(storage, "ws1", ws1).unwritable, false);
  assert.equal(storeArticleDraft(storage, "ws2", ws2).unwritable, false);

  const back1 = loadArticleDrafts(storage, "ws1");
  assert.equal(back1.drafts.length, 1);
  assert.equal(back1.drafts[0].projectId, "p1");
  assert.equal(back1.drafts[0].narration, "编辑一");
  assert.equal(back1.drafts[0].baseRevision, 3, "project drafts carry their base revision");

  const back2 = loadArticleDrafts(storage, "ws2");
  assert.equal(back2.drafts.length, 1);
  assert.equal(back2.drafts[0].projectId, null, "a new-project draft uses the null slot");
  assert.equal(articleDraftSlot(back2.drafts[0]), "new");
});

test("a corrupted store is dropped instead of thrown or applied", () => {
  const storage = memoryStorage();
  storage.data.set("knorvia-studio-article-draft:ws", "{not json");
  assert.deepEqual(loadArticleDrafts(storage, "ws").drafts, []);
  storage.data.set("knorvia-studio-article-draft:ws", JSON.stringify({ version: 1, drafts: [validDraft(), { garbage: true }, "text"] }));
  const drafts = loadArticleDrafts(storage, "ws").drafts;
  assert.equal(drafts.length, 1, "only the valid entry survives");
  // An unreadable value must never come back as a usable draft object.
  assert.equal(readArticleDraft(drafts[0])?.projectId, "p1");
});

test("unwritable storage is reported, never silent", () => {
  const storage = memoryStorage();
  storage.failWrites = true;
  assert.equal(storeArticleDraft(storage, "ws", validDraft()).unwritable, true);
  assert.equal(clearArticleDraft(storage, "ws", "p1").unwritable, true);
  assert.equal(loadArticleDrafts(storage, "ws").unwritable, true);
});

test("draft slots are capped and most-recent-first", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 20; index += 1) {
    storeArticleDraft(storage, "ws", validDraft({ projectId: `p${index}`, updatedAt: index }));
  }
  const drafts = loadArticleDrafts(storage, "ws").drafts;
  assert.equal(drafts.length, 12);
  assert.equal(drafts[0].projectId, "p19", "most recently updated first");
});

test("replay decision: equal base applies, server-ahead keeps both", () => {
  const project = validDraft();
  assert.equal(draftReplayDecision(project, 3), "fast-forward");
  assert.equal(draftReplayDecision(project, 4), "server-ahead");
  assert.equal(draftReplayDecision(makeArticleDraft("ws"), 3), "irrelevant", "new-project drafts have no server side");
  assert.equal(draftReplayDecision(validDraft({ baseRevision: null }), 3), "irrelevant");
});

test("clearArticleDraft removes exactly the slot and can retire the new-project draft", () => {
  const storage = memoryStorage();
  storeArticleDraft(storage, "ws", validDraft({ projectId: "p1" }));
  storeArticleDraft(storage, "ws", validDraft({ projectId: "p2" }));
  storeArticleDraft(storage, "ws", makeArticleDraft("ws", { title: "new" }));
  clearArticleDraft(storage, "ws", "p1");
  let drafts = loadArticleDrafts(storage, "ws").drafts;
  assert.deepEqual(drafts.map(d => articleDraftSlot(d)), ["new", "p2"]);
  clearArticleDraft(storage, "ws", null);
  drafts = loadArticleDrafts(storage, "ws").drafts;
  assert.deepEqual(drafts.map(d => articleDraftSlot(d)), ["p2"]);
});

test("draftToMarkdown renders a readable rescue copy with no binary side effects", () => {
  const text = draftToMarkdown(validDraft({ projectId: "p1", baseRevision: 3 }));
  assert.ok(text.includes("# p1 @ v3"));
  assert.ok(text.includes("## 口播稿"));
  assert.ok(text.includes("第一段。"));
  assert.ok(text.includes("1. 开场"));
});
