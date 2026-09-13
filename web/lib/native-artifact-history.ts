/**
 * Artifact version browsing and local text diff (B03).
 *
 * The daemon exposes single revisions (`artifact/content` with `revisionId`,
 * each revision carrying `parentIds`) but no history endpoint. The list is
 * therefore a bounded client-side walk: it stops cleanly on a cycle, a broken
 * link, or the depth bound, and reports what it did NOT see instead of
 * claiming complete history. Diffs are computed locally between two loaded
 * texts; `parseUnifiedDiff` remains a parser for existing unified diffs and
 * is not used as a generator.
 */

export type ArtifactRevisionMeta = { id: string; createdAt?: string | null; parentIds?: string[] | null };

export type ReadRevision = (revisionId: string) => Promise<ArtifactRevisionMeta>;

export type RevisionChain = {
  /** Newest first; index 0 is the revision the walk started from. */
  revisions: ArtifactRevisionMeta[];
  /** The walk reached a revision with no parents. */
  complete: boolean;
  /** The walk stopped at `maxDepth` before reaching the root. */
  truncated: boolean;
  /** A parent loop was hit; the walk stopped to stay bounded. */
  cycle: boolean;
  /** A revision could not be read; the chain is a prefix of history. */
  brokenAt?: string;
};

/** Walk newest → oldest over `parentIds` with a bounded depth. */
export async function walkRevisionChain(read: ReadRevision, startId: string, maxDepth = 20): Promise<RevisionChain> {
  const revisions: ArtifactRevisionMeta[] = [];
  const visited = new Set<string>([startId]);
  let cursor: string | undefined = startId;
  for (let depth = 0; depth < maxDepth && cursor; depth += 1) {
    let meta: ArtifactRevisionMeta;
    try {
      meta = await read(cursor);
    } catch {
      return { revisions, complete: false, truncated: false, cycle: false, brokenAt: cursor };
    }
    if (!meta || meta.id !== cursor || !Array.isArray(meta.parentIds) || meta.parentIds.some(id => typeof id !== "string" || !id)) return { revisions, complete: false, truncated: false, cycle: false, brokenAt: cursor };
    revisions.push(meta);
    const parent = Array.isArray(meta.parentIds) && meta.parentIds.length > 0 ? meta.parentIds[0] : undefined;
    if (!parent) return { revisions, complete: true, truncated: false, cycle: false };
    if (visited.has(parent)) return { revisions, complete: false, truncated: false, cycle: true };
    visited.add(parent);
    cursor = parent;
  }
  return { revisions, complete: false, truncated: true, cycle: false };
}

export type DiffRow = { kind: "same" | "add" | "remove"; text: string; before?: number; after?: number };

export type DiffResult = { rows: DiffRow[]; truncated: boolean; same: boolean };

/** Render cap: a diff beyond this stays honest about being partial. */
export const DIFF_MAX_ROWS = 2000;
/** LCS cells bound (before-prefix/suffix trimming shrinks real texts first). */
const DIFF_LCS_LIMIT = 1200;

function trimCommonPrefix(before: string[], after: string[]): { before: string[]; after: string[]; head: DiffRow[] } {
  const head: DiffRow[] = [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  for (let index = 0; index < start; index += 1) head.push({ kind: "same", text: before[index], before: index + 1, after: index + 1 });
  return { before: before.slice(start), after: after.slice(start), head };
}

function trimCommonSuffix(before: string[], after: string[]): { before: string[]; after: string[]; tail: DiffRow[] } {
  const tail: DiffRow[] = [];
  let end = 0;
  while (end < before.length && end < after.length && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  const beforeTail = before.slice(before.length - end);
  for (let index = 0; index < end; index += 1) tail.push({ kind: "same", text: beforeTail[index], before: before.length - end + index + 1, after: after.length - end + index + 1 });
  return { before: before.slice(0, before.length - end), after: after.slice(0, after.length - end), tail };
}

/** Line diff over two loaded texts (never a unified-diff generator). */
export function diffTextLines(beforeText: string, afterText: string, maxRows = DIFF_MAX_ROWS): DiffResult {
  maxRows = Number.isFinite(maxRows) ? Math.min(DIFF_MAX_ROWS, Math.max(1, Math.floor(maxRows))) : DIFF_MAX_ROWS;
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const same = beforeText === afterText;
  if (same) return { rows: after.slice(0, maxRows).map((text, index) => ({ kind: "same" as const, text, after: index + 1, before: index + 1 })), truncated: after.length > maxRows, same };
  const { before: b2, after: a2, head } = trimCommonPrefix(before, after);
  const { before: b3, after: a3, tail } = trimCommonSuffix(b2, a2);
  const rows: DiffRow[] = [];
  let truncated = false;
  if (b3.length === 0) {
    for (const text of a3) rows.push({ kind: "add", text });
  } else if (a3.length === 0) {
    for (const text of b3) rows.push({ kind: "remove", text });
  } else if (b3.length * a3.length <= DIFF_LCS_LIMIT * DIFF_LCS_LIMIT) {
    // Bounded LCS table over the trimmed middles.
    const table: number[][] = Array.from({ length: b3.length + 1 }, () => new Array(a3.length + 1).fill(0));
    for (let i = b3.length - 1; i >= 0; i -= 1) {
      for (let j = a3.length - 1; j >= 0; j -= 1) {
        table[i][j] = b3[i] === a3[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < b3.length && j < a3.length) {
      if (b3[i] === a3[j]) { rows.push({ kind: "same", text: b3[i] }); i += 1; j += 1; }
      else if (table[i + 1][j] >= table[i][j + 1]) { rows.push({ kind: "remove", text: b3[i] }); i += 1; }
      else { rows.push({ kind: "add", text: a3[j] }); j += 1; }
    }
    while (i < b3.length) { rows.push({ kind: "remove", text: b3[i] }); i += 1; }
    while (j < a3.length) { rows.push({ kind: "add", text: a3[j] }); j += 1; }
  } else {
    // Too large for a real diff: present it as an honest whole-file change.
    truncated = true;
    for (const text of b3) rows.push({ kind: "remove", text });
    for (const text of a3) rows.push({ kind: "add", text });
  }
  const numbered = numberRows([...head, ...rows, ...tail]);
  if (numbered.length > maxRows) return { rows: numbered.slice(0, maxRows), truncated: true, same: false };
  return { rows: numbered, truncated, same: false };
}

function numberRows(rows: DiffRow[]): DiffRow[] {
  let before = 0, after = 0;
  return rows.map(row => {
    if (row.kind === "remove") { before += 1; return { ...row, before }; }
    if (row.kind === "add") { after += 1; return { ...row, after }; }
    before += 1; after += 1;
    return { ...row, before, after };
  });
}
