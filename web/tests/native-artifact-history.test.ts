import test from "node:test";
import assert from "node:assert/strict";
import { diffTextLines, walkRevisionChain, type ArtifactRevisionMeta, type ReadRevision } from "../lib/native-artifact-history";

const chainOf = (links: Record<string, string[]>, createdAt: Record<string, string> = {}) => {
  const read: ReadRevision = async id => {
    if (!(id in links)) throw new Error(`revision ${id} unreadable`);
    const meta: ArtifactRevisionMeta = { id, parentIds: links[id], createdAt: createdAt[id] };
    return meta;
  };
  return read;
};

test("a linear chain walks to the root and reports complete history", async () => {
  const result = await walkRevisionChain(chainOf({ v3: ["v2"], v2: ["v1"], v1: [] }), "v3");
  assert.deepEqual(result.revisions.map(item => item.id), ["v3", "v2", "v1"]);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.cycle, false);
});

test("a cyclic chain stops clearly instead of looping forever", async () => {
  const result = await walkRevisionChain(chainOf({ b: ["a"], a: ["b"] }), "b");
  assert.equal(result.cycle, true);
  assert.equal(result.complete, false);
  assert.ok(result.revisions.length <= 2);
});

test("an unreadable revision keeps the readable prefix and names the broken link", async () => {
  const result = await walkRevisionChain(chainOf({ v3: ["missing"], v1: [] }), "v3");
  assert.deepEqual(result.revisions.map(item => item.id), ["v3"]);
  assert.equal(result.brokenAt, "missing");
  assert.equal(result.complete, false);
});

test("the depth bound truncates the walk and never claims a complete history", async () => {
  const links: Record<string, string[]> = {};
  for (let index = 0; index < 30; index++) links[`r${index}`] = [`r${index + 1}`];
  const result = await walkRevisionChain(chainOf(links), "r0", 5);
  assert.equal(result.revisions.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
});

test("identical texts diff to a same-only result", () => {
  const result = diffTextLines("a\nb\nc", "a\nb\nc");
  assert.equal(result.same, true);
  assert.deepEqual(result.rows.map(row => row.kind), ["same", "same", "same"]);
});

test("additions, removals, and edits carry real before/after content and line numbers", () => {
  const result = diffTextLines("title\nalpha\nbeta\ngamma\nfooter", "title\nalpha\nBETA\ngamma\ndelta\nfooter");
  assert.equal(result.same, false);
  const removes = result.rows.filter(row => row.kind === "remove").map(row => row.text);
  const adds = result.rows.filter(row => row.kind === "add").map(row => row.text);
  assert.deepEqual(removes, ["beta"]);
  assert.deepEqual(adds, ["BETA", "delta"]);
  const betaRow = result.rows.find(row => row.text === "beta");
  assert.equal(betaRow?.before, 3);
  assert.equal(betaRow?.after, undefined);
  const betaNew = result.rows.find(row => row.text === "BETA");
  assert.equal(betaNew?.after, 3);
  const contextRow = result.rows.find(row => row.text === "footer");
  assert.equal(contextRow?.before, 5);
  assert.equal(contextRow?.after, 6);
});

test("an oversized diff is bounded and honestly reported as partial", () => {
  const before = Array.from({ length: 5000 }, (_, index) => `old ${index}`);
  const after = Array.from({ length: 5000 }, (_, index) => `new ${index}`);
  const result = diffTextLines(before.join("\n"), after.join("\n"), 2000);
  assert.equal(result.rows.length, 2000);
  assert.equal(result.truncated, true);
});

test("a changed middle keeps surrounding lines as stable context", () => {
  const result = diffTextLines("one\ntwo\nthree\nfour", "one\ntwo\nTHREE\nfour");
  assert.deepEqual(result.rows.filter(row => row.kind === "same").map(row => row.text), ["one", "two", "four"]);
});
