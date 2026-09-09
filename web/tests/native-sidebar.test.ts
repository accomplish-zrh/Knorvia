import assert from "node:assert/strict";
import test from "node:test";
import { organizeThread, parseSidebarPreferences, sidebarDefaults, sortSidebarThreads } from "../lib/native-sidebar";
import type { Thread } from "../lib/native-workbench-state";

test("damaged and older sidebar preferences recover without inventing task membership", () => {
  assert.deepEqual(parseSidebarPreferences("not-json"), sidebarDefaults);
  const value = parseSidebarPreferences(JSON.stringify({ pinned: ["a", "a", 4], sections: [{ id: "s", title: " Delivery ", threadIds: ["a", "b", "b"] }, { id: "t", title: "Later", threadIds: ["b", "c"] }, { id: "s", title: "Duplicate", threadIds: ["d"] }], grouping: "unknown" }));
  assert.deepEqual(value.pinned, ["a"]);
  assert.deepEqual(value.sections, [{ id: "s", title: "Delivery", threadIds: ["b"] }, { id: "t", title: "Later", threadIds: ["c"] }]);
  assert.equal(value.grouping, "project");
});

test("moving between pin, section and default preserves other tasks and leaves input immutable", () => {
  const original = { ...sidebarDefaults, pinned: ["a", "b"], sections: [{ id: "s", title: "Delivery", threadIds: ["c"] }] };
  const moved = organizeThread(original, "a", "s");
  assert.deepEqual(moved.pinned, ["b"]);
  assert.deepEqual(moved.sections[0].threadIds, ["c", "a"]);
  const unassigned = organizeThread(moved, "a", null);
  assert.deepEqual(unassigned.sections[0].threadIds, ["c"]);
  assert.deepEqual(original.pinned, ["a", "b"]);
  assert.strictEqual(organizeThread(moved, "a", "deleted-section"), moved);
});

test("sidebar sorting uses actual timestamps and leaves archived tasks in the source index", () => {
  const make = (id: string, createdAt: string, updatedAt: string, status = "active"): Thread => ({ id, workspaceId: "w", title: id, createdAt, updatedAt, status, revision: 1 });
  const threads = [make("a", "2026-09-05T20:00:00+08:00", "2026-09-06T00:00:00+08:00"), make("b", "2026-09-05T13:00:00Z", "2026-09-05T14:00:00Z"), make("old", "invalid", "invalid"), make("archived", "2026-09-06", "2026-09-06", "archived")];
  assert.deepEqual(sortSidebarThreads(threads, "updated").map(thread => thread.id), ["a", "b", "old"]);
  assert.deepEqual(sortSidebarThreads(threads, "created").map(thread => thread.id), ["b", "a", "old"]);
  assert.equal(threads.length, 4);
});

test("native millisecond timestamps sort together with imported ISO and legacy seconds", () => {
  const make = (id: string, createdAt: string, updatedAt: string): Thread => ({ id, workspaceId: "w", title: id, createdAt, updatedAt, status: "active", revision: 1 });
  const threads = [make("n", "1788681500000ms", "1788681900000ms"), make("a", "1788681700000ms", "1788681700000ms"), make("z", new Date(1788681600000).toISOString(), "1788681600")];
  assert.deepEqual(sortSidebarThreads(threads, "updated").map(thread => thread.id), ["n", "a", "z"]);
  assert.deepEqual(sortSidebarThreads(threads, "created").map(thread => thread.id), ["a", "z", "n"]);
});
