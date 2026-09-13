import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewReport,
  deliveryVerdict,
  parseCompare,
  requestDiffParams,
  type WorktreeCompare,
} from "../lib/native-worktree-review";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_M = "c".repeat(40);

function compareFixture(overrides: Partial<Record<string, unknown>> = {}): WorktreeCompare {
  return parseCompare("ws1", {
    available: true,
    sourceRef: "HEAD",
    sourceSha: SHA_A,
    targetRef: "feature",
    targetSha: SHA_B,
    mergeBaseSha: SHA_M,
    ahead: 1,
    behind: 2,
    incomingCommits: [{ id: SHA_B, short: "abc1234", author: "kn", atMs: 1, subject: "feature change" }],
    outgoingCommits: [{ id: SHA_A, short: "aaa1111", author: "kn", atMs: 2, subject: "main change" }],
    incomingFiles: [{ path: "shared.txt", status: "M" }],
    outgoingFiles: [{ path: "kept.txt", status: "M" }],
    dirty: { staged: [], unstaged: ["scratch.txt"], untracked: [], truncated: false },
    conflicts: { state: "conflict", files: ["shared.txt"], reason: null },
    ...overrides,
  }) as WorktreeCompare;
}

test("parse keeps only fully-frozen comparisons and honest conflict states", () => {
  const compare = compareFixture();
  assert.equal(compare.available, true);
  assert.equal(compare.mergeBaseSha, SHA_M);
  assert.deepEqual(compare.incomingFiles, [{ path: "shared.txt", status: "M" }]);
  assert.equal(parseCompare("ws1", { available: false }).available, false);
  assert.throws(() => parseCompare("ws1", { available: true, sourceSha: "abc", targetSha: SHA_B }), /freeze both sides/);
  assert.throws(() => parseCompare("ws1", {
    available: true, sourceSha: SHA_A, targetSha: SHA_B,
    conflicts: { state: "maybe" },
  }), /unknown conflict state/);
});

test("verdicts distinguish fast-forward, diverged and up-to-date with gates", () => {
  assert.equal(deliveryVerdict(compareFixture()).kind, "diverged");
  assert.equal(deliveryVerdict(compareFixture()).conflictGate, true);
  assert.equal(deliveryVerdict(compareFixture()).dirty, true);
  const fastForward = deliveryVerdict(compareFixture({ ahead: 0, dirty: { staged: [], unstaged: [], untracked: [], truncated: false }, conflicts: { state: "clean", files: [], reason: null } }));
  assert.equal(fastForward.kind, "fastForward");
  assert.equal(fastForward.conflictGate, false);
  assert.equal(fastForward.dirty, false);
  const upToDate = deliveryVerdict(compareFixture({ behind: 0, incomingCommits: [], incomingFiles: [] }));
  assert.equal(upToDate.kind, "upToDate");
});

test("per-file diffs are bound to the compared files and to frozen SHAs", () => {
  const compare = compareFixture();
  assert.deepEqual(requestDiffParams(compare, "shared.txt"), { baseSha: SHA_M, headSha: SHA_B, path: "shared.txt" });
  assert.throws(() => requestDiffParams(compare, "unrelated.txt"), /not part of this review/);
  const noBase = compareFixture({ mergeBaseSha: null, incomingFiles: [{ path: "x", status: "A" }] });
  assert.equal(requestDiffParams(noBase, "x").baseSha, SHA_A, "unrelated histories fall back to the source SHA");
});

test("the exported report states frozen SHAs, conflicts and never promises a merge", () => {
  const compare = compareFixture();
  const report = buildReviewReport(compare, [{ path: "shared.txt", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-line two\n+feature edit" }]);
  assert.match(report, /`\${0,1}${SHA_A}`?/.source.replace("\\${0,1}", "") ? new RegExp(SHA_A) : /x/);
  assert.ok(report.includes(SHA_A));
  assert.ok(report.includes(SHA_B));
  assert.ok(report.includes("Ahead/Behind: +1 / -2"));
  assert.ok(report.includes("Conflicts: conflict (1 files)"));
  assert.ok(report.includes("1 staged") === false);
  assert.ok(report.includes("never merges"));
  assert.ok(report.includes("### shared.txt"));
  assert.ok(report.includes("+feature edit"));
  const undetermined = buildReviewReport(compareFixture({ conflicts: { state: "undetermined", files: [], reason: "old git" } }));
  assert.ok(undetermined.includes("undetermined — old git"));
});
