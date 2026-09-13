/**
 * Delivery pre-check (B05) over the read-only worktree review RPC.
 *
 * The daemon freezes both sides into full object ids; everything downstream
 * (verdict labels, per-file diffs, the exported report) is derived from those
 * frozen SHAs. Nothing here merges anything: unknown states stay explicitly
 * `undetermined`.
 */

export type ReviewCommit = { id: string; short: string; author: string; atMs: number | null; subject: string };
export type ReviewFile = { path: string; status: string };
export type ReviewDirty = { staged: string[]; unstaged: string[]; untracked: string[]; truncated: boolean };
export type ReviewConflicts = { state: "clean" | "conflict" | "undetermined"; files: string[]; reason: string | null };

export type WorktreeCompare = {
  available: true;
  workspaceId: string;
  sourceRef: string;
  sourceSha: string;
  targetRef: string;
  targetSha: string;
  mergeBaseSha: string | null;
  ahead: number;
  behind: number;
  incomingCommits: ReviewCommit[];
  outgoingCommits: ReviewCommit[];
  incomingFiles: ReviewFile[];
  outgoingFiles: ReviewFile[];
  dirty: ReviewDirty;
  conflicts: ReviewConflicts;
};

export type ReviewUnavailable = { available: false; workspaceId: string };

export const REVIEW_SHA_PATTERN = /^[0-9a-f]{40}$/;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asFiles(value: unknown): ReviewFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map(entry => ({ path: asString(entry.path), status: asString(entry.status) }))
    .filter(entry => entry.path);
}

function asCommits(value: unknown): ReviewCommit[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map(entry => ({
      id: asString(entry.id),
      short: asString(entry.short) || asString(entry.id).slice(0, 10),
      author: asString(entry.author),
      atMs: typeof entry.atMs === "number" ? entry.atMs : null,
      subject: asString(entry.subject),
    }))
    .filter(entry => entry.id);
}

/** Validate the daemon response; throws on shapes that would lie about state. */
export function parseCompare(workspaceId: string, value: unknown): WorktreeCompare | ReviewUnavailable {
  if (!value || typeof value !== "object") throw new Error("compare response was not an object");
  const record = value as Record<string, unknown>;
  if (record.available !== true) return { available: false, workspaceId };
  const sourceSha = asString(record.sourceSha);
  const targetSha = asString(record.targetSha);
  if (!REVIEW_SHA_PATTERN.test(sourceSha) || !REVIEW_SHA_PATTERN.test(targetSha)) {
    throw new Error("compare response did not freeze both sides as full object ids");
  }
  const mergeBase = asString(record.mergeBaseSha);
  const conflictsRecord = (record.conflicts ?? {}) as Record<string, unknown>;
  const state = asString(conflictsRecord.state);
  if (state !== "clean" && state !== "conflict" && state !== "undetermined") {
    throw new Error(`compare response carried an unknown conflict state: ${state || "(empty)"}`);
  }
  return {
    available: true,
    workspaceId,
    sourceRef: asString(record.sourceRef) || "HEAD",
    sourceSha,
    targetRef: asString(record.targetRef),
    targetSha,
    mergeBaseSha: REVIEW_SHA_PATTERN.test(mergeBase) ? mergeBase : null,
    ahead: typeof record.ahead === "number" ? record.ahead : 0,
    behind: typeof record.behind === "number" ? record.behind : 0,
    incomingCommits: asCommits(record.incomingCommits),
    outgoingCommits: asCommits(record.outgoingCommits),
    incomingFiles: asFiles(record.incomingFiles),
    outgoingFiles: asFiles(record.outgoingFiles),
    dirty: {
      staged: asStringArray((record.dirty as Record<string, unknown>)?.staged),
      unstaged: asStringArray((record.dirty as Record<string, unknown>)?.unstaged),
      untracked: asStringArray((record.dirty as Record<string, unknown>)?.untracked),
      truncated: (record.dirty as Record<string, unknown>)?.truncated === true,
    },
    conflicts: {
      state,
      files: asStringArray(conflictsRecord.files),
      reason: typeof conflictsRecord.reason === "string" ? conflictsRecord.reason : null,
    },
  };
}

export type DeliveryVerdict = {
  kind: "fastForward" | "diverged" | "upToDate";
  conflictGate: boolean;
  dirty: boolean;
};

/**
 * Display-only classification. The product never merges: a conflict gate or a
 * dirty source tree just means the user should settle those first.
 */
export function deliveryVerdict(compare: WorktreeCompare): DeliveryVerdict {
  const kind = compare.behind === 0 ? "upToDate"
    : compare.ahead === 0 ? "fastForward"
      : "diverged";
  return {
    kind,
    conflictGate: compare.conflicts.state === "conflict",
    dirty: compare.dirty.staged.length + compare.dirty.unstaged.length + compare.dirty.untracked.length > 0,
  };
}

/**
 * Strict per-file diff binding: only paths this comparison actually reported
 * may be requested, and always between frozen ids. Without a merge base
 * (unrelated histories) the source SHA stands in for the base.
 */
export function requestDiffParams(compare: WorktreeCompare, path: string): { baseSha: string; headSha: string; path: string } {
  const known = compare.incomingFiles.some(file => file.path === path)
    || compare.outgoingFiles.some(file => file.path === path);
  if (!known) throw new Error(`path ${path} is not part of this review`);
  return { baseSha: compare.mergeBaseSha ?? compare.sourceSha, headSha: compare.targetSha, path };
}

const verdictLabel: Record<DeliveryVerdict["kind"], { zh: string; en: string }> = {
  fastForward: { zh: "目标落后于源：可以直接快进合并（当前工具不会替你合并）", en: "The target is behind: a fast-forward would apply (this tool never merges for you)" },
  diverged: { zh: "双方各有提交：需要先合并或变基（当前工具不会替你合并）", en: "Both sides moved: merge or rebase first (this tool never merges for you)" },
  upToDate: { zh: "目标没有领先于源的提交", en: "The target has no commits beyond the source" },
};

/** Exportable markdown report of the frozen review. */
export function buildReviewReport(compare: WorktreeCompare, diffs?: { path: string; diff: string }[]): string {
  const verdict = deliveryVerdict(compare);
  const lines: string[] = [];
  lines.push(`# 交付预检 / Delivery review — ${compare.workspaceId}`);
  lines.push("");
  lines.push(`- 冻结源 / Source: ${compare.sourceRef} → \`${compare.sourceSha}\``);
  lines.push(`- 冻结目标 / Target: ${compare.targetRef} → \`${compare.targetSha}\``);
  lines.push(`- 合并基 / Merge base: ${compare.mergeBaseSha ? `\`${compare.mergeBaseSha}\`` : "(unrelated histories)"}`);
  lines.push(`- 领先/落后 / Ahead/Behind: +${compare.ahead} / -${compare.behind}`);
  lines.push(`- 判定 / Verdict: ${verdictLabel[verdict.kind].en}`);
  lines.push(`- 冲突预判 / Conflicts: ${compare.conflicts.state}${compare.conflicts.files.length ? ` (${compare.conflicts.files.length} files)` : ""}${compare.conflicts.state === "undetermined" ? ` — ${compare.conflicts.reason ?? "unknown"}` : ""}`);
  lines.push(`- 未提交改动 / Dirty: ${compare.dirty.staged.length} staged, ${compare.dirty.unstaged.length} unstaged, ${compare.dirty.untracked.length} untracked${compare.dirty.truncated ? " (list truncated)" : ""}`);
  lines.push("");
  lines.push("## 收入提交 / Incoming commits");
  for (const commit of compare.incomingCommits) lines.push(`- \`${commit.short}\` ${commit.subject} (${commit.author})`);
  if (compare.incomingCommits.length === 0) lines.push("- (none)");
  lines.push("");
  lines.push("## 源侧提交 / Source-only commits");
  for (const commit of compare.outgoingCommits) lines.push(`- \`${commit.short}\` ${commit.subject} (${commit.author})`);
  if (compare.outgoingCommits.length === 0) lines.push("- (none)");
  lines.push("");
  lines.push("## 收入文件 / Incoming files");
  for (const file of compare.incomingFiles) lines.push(`- ${file.status} ${file.path}`);
  if (compare.incomingFiles.length === 0) lines.push("- (none)");
  lines.push("");
  if (diffs?.length) {
    lines.push("## 文件差异 / Per-file diffs");
    for (const entry of diffs) {
      lines.push("");
      lines.push(`### ${entry.path}`);
      lines.push("");
      lines.push("```diff");
      lines.push(entry.diff);
      lines.push("```");
    }
  }
  lines.push("");
  return lines.join("\n");
}
