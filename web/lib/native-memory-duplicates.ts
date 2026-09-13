/**
 * Duplicate discovery for the memory workbench (B03).
 *
 * `fetchAllMemoryRecords` walks the store's offset/total pagination to the
 * end of the scope — the fixed 200-row list view must not silently bound
 * duplicate discovery. `findDuplicatePairs` reports only explainable pairs:
 * exact matches after normalization, or token sets with a Jaccard ratio at
 * or above the threshold, always within one conversation scope and always
 * restricted to active records. No model calls are involved.
 */
import type { MemoryRecord } from "@/components/native/memory-types";

export type MemoryScopeQuery = { owner: string; workspace?: string | null; bot?: string | null; conversation?: string | null };

export type FetchAllResult = {
  records: MemoryRecord[];
  total: number;
  pages: number;
  duplicateIds: number;
  truncated: boolean;
};

export type MemoryRequester = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export type DuplicatePair = {
  a: MemoryRecord;
  b: MemoryRecord;
  /** 1 = identical after normalization; otherwise the token Jaccard ratio. */
  similarity: number;
  exact: boolean;
  /** Explanation payload: shared terms (capped) and the ratio in percent. */
  sharedTerms: string[];
};

export const DUPLICATE_JACCARD_THRESHOLD = 0.7;
const SHARED_TERM_SAMPLE = 6;
/** Tokens occurring in more records than this are too common to seed a pair scan. */
const RARE_TOKEN_MAX_RECORDS = 80;
const MAX_PAIRS = 400;

export type DuplicateScanLimits = Partial<typeof DEFAULT_SCAN_LIMITS>;
const DEFAULT_SCAN_LIMITS = { pageSize: 500, maxPages: 40, maxRecords: 20_000 };

/**
 * Walk `memory/list` offset pagination until the reported total is covered.
 * A page that returns nothing while the total claims more is a store
 * inconsistency: fail instead of pretending the scope was fully scanned.
 */
export async function fetchAllMemoryRecords({ scope, request, includeStatuses = ["active", "forgotten", "merged"], limits = {} }: {
  scope: MemoryScopeQuery;
  request: MemoryRequester;
  includeStatuses?: string[];
  limits?: DuplicateScanLimits;
}): Promise<FetchAllResult> {
  const config = { ...DEFAULT_SCAN_LIMITS, ...limits };
  const seen = new Map<string, MemoryRecord>();
  let duplicates = 0;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let pages = 0;
  while (offset < total) {
    if (pages >= config.maxPages || seen.size >= config.maxRecords) {
      return { records: [...seen.values()], total: Number.isFinite(total) ? total : seen.size, pages, duplicateIds: duplicates, truncated: true };
    }
    const page = await request<{ records: MemoryRecord[]; total: number }>("memory/list", {
      scope,
      includeStatuses,
      offset,
      limit: config.pageSize,
    });
    pages += 1;
    total = typeof page.total === "number" ? page.total : seen.size + page.records.length;
    if (page.records.length === 0 && offset < total) {
      throw new Error(`memory/list stopped at offset ${offset} of ${total}; scope scan is incomplete`);
    }
    const before = seen.size;
    for (const record of page.records) {
      if (seen.has(record.id)) { duplicates += 1; continue; }
      seen.set(record.id, record);
    }
    offset += page.records.length;
    if (seen.size === before && offset < total) {
      // Server re-served only already-seen rows while claiming more: paging
      // drift. The scan stays honestly incomplete instead of pretending the
      // scope was fully covered.
      return { records: [...seen.values()], total, pages, duplicateIds: duplicates, truncated: true };
    }
  }
  // A complete scan must have covered the reported total.
  const truncated = seen.size < total;
  return { records: [...seen.values()], total, pages, duplicateIds: duplicates, truncated };
}

/** Normalization that keeps the comparison explainable: case, width, punctuation, spacing. */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

const CJK = /[一-鿿぀-ヿ가-힯]/;

/**
 * Tokens for the similarity ratio: whitespace/punctuation words plus, for
 * unsegmented CJK text, character bigrams — otherwise a whole Chinese
 * sentence is one token and near-duplicates score far below any threshold.
 */
const tokenize = (text: string): string[] => {
  const tokens = new Set<string>();
  for (const raw of text.normalize("NFKC").toLowerCase().split(/[\p{P}\p{S}\s]+/u)) {
    if (!raw) continue;
    tokens.add(raw);
    if (CJK.test(raw)) {
      for (let index = 0; index < raw.length - 1; index += 1) tokens.add(raw.slice(index, index + 2));
    }
  }
  return [...tokens];
};

function scopeKey(record: MemoryRecord): string {
  return [record.scope.owner, record.scope.workspace, record.scope.bot, record.scope.conversation].join("|");
}

function jaccard(a: Set<string>, b: Set<string>): { ratio: number; shared: string[] } {
  let shared = 0;
  const sharedTerms: string[] = [];
  for (const token of a) {
    if (b.has(token)) {
      shared += 1;
      if (sharedTerms.length < SHARED_TERM_SAMPLE) sharedTerms.push(token);
    }
  }
  const union = a.size + b.size - shared;
  return { ratio: union === 0 ? 1 : shared / union, shared: sharedTerms };
}

/**
 * Candidate pairs within one scope. Exact normalized twins are always
 * reported; fuzzy pairs must clear the Jaccard threshold. Pair generation is
 * seeded by rare shared tokens so the scan stays bounded on large scopes.
 */
export function findDuplicatePairs(records: readonly MemoryRecord[], threshold: number = DUPLICATE_JACCARD_THRESHOLD): DuplicatePair[] {
  const eligible = records.filter(record => record.status === "active");
  const byScope = new Map<string, MemoryRecord[]>();
  for (const record of eligible) {
    const key = scopeKey(record);
    const bucket = byScope.get(key) ?? [];
    bucket.push(record);
    byScope.set(key, bucket);
  }
  const pairs: DuplicatePair[] = [];
  for (const bucket of byScope.values()) {
    const prepared = bucket.map(record => {
      const tokens = tokenize(record.content);
      return { record, normalized: normalizeMemoryText(record.content), tokenSet: new Set(tokens) };
    });
    // Inverted index: token → record indices, kept for rare tokens only.
    const inverted = new Map<string, number[]>();
    for (let index = 0; index < prepared.length; index += 1) {
      for (const token of prepared[index].tokenSet) {
        const list = inverted.get(token) ?? [];
        list.push(index);
        inverted.set(token, list);
      }
    }
    const seenPairs = new Set<string>();
    const consider = (i: number, j: number) => {
      const left = prepared[i];
      const right = prepared[j];
      const pairKey = `${left.record.id}\u0000${right.record.id}`;
      if (seenPairs.has(pairKey)) return;
      seenPairs.add(pairKey);
      const exact = left.normalized.length > 0 && left.normalized === right.normalized;
      const { ratio, shared } = jaccard(left.tokenSet, right.tokenSet);
      if (exact || ratio >= threshold) {
        pairs.push({
          a: left.record,
          b: right.record,
          similarity: exact ? 1 : ratio,
          exact,
          sharedTerms: exact ? [] : shared,
        });
      }
    };
    for (const indices of inverted.values()) {
      if (indices.length === 0 || indices.length > RARE_TOKEN_MAX_RECORDS) continue;
      for (let i = 0; i < indices.length; i += 1) {
        for (let j = i + 1; j < indices.length; j += 1) consider(indices[i], indices[j]);
      }
    }
    // Exact twins that share no rare token (e.g. one-word contents) — the
    // normalized bucket catches them regardless of the inverted index.
    const exactBuckets = new Map<string, number[]>();
    for (let index = 0; index < prepared.length; index += 1) {
      if (!prepared[index].normalized) continue;
      const list = exactBuckets.get(prepared[index].normalized) ?? [];
      list.push(index);
      exactBuckets.set(prepared[index].normalized, list);
    }
    for (const indices of exactBuckets.values()) {
      for (let i = 0; i < indices.length; i += 1) {
        for (let j = i + 1; j < indices.length; j += 1) consider(indices[i], indices[j]);
      }
    }
    if (pairs.length >= MAX_PAIRS) break;
  }
  pairs.sort((x, y) => y.similarity - x.similarity || x.a.id.localeCompare(y.a.id));
  return pairs.slice(0, MAX_PAIRS);
}

/**
 * The exact merge request a pair execution sends: the loser merges into the
 * keeper with BOTH revisions the daemon now checks — the source CAS that
 * already existed and the target CAS added so the preview cannot silently
 * apply to a changed target.
 */
export function mergeRequestForPair(loser: MemoryRecord, keeper: MemoryRecord): Record<string, unknown> {
  if (loser.id === keeper.id) throw new Error("cannot merge a record into itself");
  return {
    sourceId: loser.id,
    targetId: keeper.id,
    expectedRevision: loser.revision,
    expectedTargetRevision: keeper.revision,
  };
}
