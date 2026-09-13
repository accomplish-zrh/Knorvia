import test from "node:test";
import assert from "node:assert/strict";
import { clearStoredDraft, clearSubmittedDraft, draftFingerprint, DRAFT_HISTORY_LIMIT, historyPreview, loadStoredDraft, restoreDraft, saveDraft } from "../lib/native-composer-draft";

type Store = Record<string, string>;
const storageOf = (store: Store = {}) => ({
  getItem: (key: string) => key in store ? store[key] : null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  key: (index: number) => Object.keys(store)[index] ?? null,
  get length() { return Object.keys(store).length; },
});

const draft = (text: string) => ({ text, attachments: [], goal: null });

test("two windows writing different content from the same version keep both drafts recoverable", () => {
  const store: Store = {};
  const storage = storageOf(store);
  const first = saveDraft(storage, "k", draft("window A long draft"), { expectedVersion: 0 });
  assert.ok(first.ok && !first.conflict);
  // Window B loaded the same version 0 and saves different content.
  const second = saveDraft(storage, "k", draft("window B different draft"), { expectedVersion: 0 });
  assert.ok(second.ok && second.conflict);
  const stored = loadStoredDraft(storage, "k");
  assert.equal(stored.current?.text, "window B different draft");
  assert.equal(stored.history.at(-1)?.text, "window A long draft");
  // Restoring the preserved branch brings window A's content back.
  const restore = restoreDraft(storage, "k", stored.history.at(-1)!);
  assert.ok(restore.ok);
  assert.equal(loadStoredDraft(storage, "k").current?.text, "window A long draft");
});

test("same-content concurrent saves are not conflicts and never wipe the newer draft", () => {
  const store: Store = {};
  const storage = storageOf(store);
  saveDraft(storage, "k", draft("same text"), { expectedVersion: 0 });
  const again = saveDraft(storage, "k", draft("same text"), { expectedVersion: 0 });
  assert.ok(again.ok && !again.conflict && again.otherDraft === null);
  assert.equal(loadStoredDraft(storage, "k").current?.text, "same text");
});

test("legacy plain-string drafts migrate instead of being lost", () => {
  const storage = storageOf({ "knorvia-native-draft:task": "old plain draft" });
  const stored = loadStoredDraft(storage, "knorvia-native-draft:task");
  assert.equal(stored.current?.text, "old plain draft");
});

test("legacy text, Goal and attachments migrate together without writing during load", () => {
  const goal = { criteria: "keep the original outcome", constraints: "original constraint" };
  const attachments = [{ name: "notes.txt", content: "original attachment" }];
  const values = { k: "original text", "k:goal": JSON.stringify(goal), "k:attachments": JSON.stringify(attachments) };
  const before = JSON.stringify(values);
  const storage = storageOf(values);
  const current = loadStoredDraft(storage, "k").current;
  assert.equal(current?.text, "original text");
  assert.deepEqual(current?.goal, goal);
  assert.deepEqual(current?.attachments, attachments);
  assert.equal(JSON.stringify(values), before, "reading legacy data must not mutate it");
  assert.ok(current);
  assert.equal(saveDraft(storage, "k", current).ok, true);
  assert.deepEqual(loadStoredDraft(storage, "k").current?.attachments, attachments);
  clearStoredDraft(storage, "k");
  assert.equal(loadStoredDraft(storage, "k").current, null, "sent legacy fields must not revive after clearing");
  assert.ok(loadStoredDraft(storage, "k").history.length > 0, "explicit clear keeps recovery history");
});

test("valid new-format drafts never revive stale split-key fields", () => {
  const storage = storageOf({ "k:goal": JSON.stringify({ criteria: "stale", constraints: "stale" }), "k:attachments": JSON.stringify([{ name: "stale.txt", content: "stale" }]) });
  assert.equal(saveDraft(storage, "k", draft("modern text")).ok, true);
  const current = loadStoredDraft(storage, "k").current;
  assert.equal(current?.text, "modern text");
  assert.equal(current?.goal, null);
  assert.deepEqual(current?.attachments, []);
});

test("legacy JSON-looking text stays verbatim and split-only drafts remain recoverable", () => {
  for (const text of ['"quoted text"', '{"text":"literal JSON","attachments":[]}']) {
    assert.equal(loadStoredDraft(storageOf({ k: text }), "k").current?.text, text);
  }
  const goal = { criteria: "goal only", constraints: "keep" };
  const attachments = [{ name: "only.txt", content: "attachment only" }];
  const current = loadStoredDraft(storageOf({ "k:goal": JSON.stringify(goal), "k:attachments": JSON.stringify(attachments) }), "k").current;
  assert.equal(current?.text, "");
  assert.deepEqual(current?.goal, goal);
  assert.deepEqual(current?.attachments, attachments);
});

test("denied getItem never throws or permits an unverified overwrite", () => {
  let writes = 0;
  const storage = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { writes += 1; }, removeItem: () => {} };
  assert.doesNotThrow(() => loadStoredDraft(storage, "k"));
  assert.deepEqual(saveDraft(storage, "k", draft("keep in memory")), { ok: false, reason: "unavailable" });
  assert.equal(writes, 0);
});

test("storage failures are reported, never reported as saved", () => {
  const failing = {
    getItem: () => null,
    setItem: (_key: string, value: string) => { if (value.length > 5) { const error = new Error("too big"); error.name = "QuotaExceededError"; throw error; } },
    removeItem: () => {},
  };
  const outcome = saveDraft(failing, "k", draft("a long draft body that exceeds the fake limit"));
  assert.deepEqual(outcome, { ok: false, reason: "quota" });
  assert.equal(saveDraft(undefined, "k", draft("x")).ok, false);
});

test("history is bounded and deduplicated by content with spacing", () => {
  const store: Store = {};
  const storage = storageOf(store);
  let version = 0;
  for (let round = 0; round < DRAFT_HISTORY_LIMIT + 10; round++) {
    const outcome = saveDraft(storage, "k", draft(`round ${round}`), { expectedVersion: version });
    assert.ok(outcome.ok);
    version = outcome.ok ? outcome.version : version;
  }
  const stored = loadStoredDraft(storage, "k");
  assert.equal(stored.history.length, DRAFT_HISTORY_LIMIT);
  assert.equal(stored.history.at(-1)?.text, `round ${DRAFT_HISTORY_LIMIT + 8}`);
  // Immediate same-content resave within spacing adds no duplicate entry.
  saveDraft(storage, "k", draft(`round ${DRAFT_HISTORY_LIMIT + 9}`), { expectedVersion: version });
  assert.ok(loadStoredDraft(storage, "k").history.length <= DRAFT_HISTORY_LIMIT);
});

test("clearing only happens through an explicit call; restore keeps other history intact", () => {
  const store: Store = {};
  const storage = storageOf(store);
  saveDraft(storage, "k", draft("first"), { expectedVersion: 0 });
  saveDraft(storage, "k", draft("second"), { expectedVersion: 1 });
  const before = loadStoredDraft(storage, "k").history.length;
  clearStoredDraft(storage, "k");
  const after = loadStoredDraft(storage, "k");
  assert.equal(after.current, null);
  assert.equal(after.history.length, before + 1);
  assert.match(historyPreview({ ...draft("line one\nline two"), version: 1, savedAt: 0, label: "" }), /line one line two/);
  assert.equal(draftFingerprint(draft("a")), draftFingerprint(draft("a")));
  assert.notEqual(draftFingerprint(draft("a")), draftFingerprint(draft("b")));
});
