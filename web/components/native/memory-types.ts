/** Shared memory record types (extracted from MemoryView for B03 tooling). */

export type SourceRef = { kind: string; id: string; note?: string };
export type Relation = { targetId: string; relationType: string; inferred: boolean };

export type MemoryRecord = {
  id: string;
  revision: number;
  scope: { owner: string; workspace: string; bot: string; conversation: string };
  sharedScopes?: Array<{ owner: string; workspace: string; bot: string; conversation: string }>;
  kind: string;
  content: string;
  sourceRefs: SourceRef[];
  relation?: Relation;
  createdAtMs: number;
  validFromMs: number;
  validToMs?: number | null;
  status: string;
  mergedInto?: string | null;
  pinned: boolean;
  useCount: number;
  lastUsedAtMs?: number | null;
  recordedAtMs: number;
};

export type MemoryRevisionEvent = {
  currentStatus?: string;
  currentRevision?: number;
  currentPinned?: boolean;
  record: MemoryRecord;
  action: string;
  actor: string;
  atMs: number;
  note?: string | null;
};

export type RecallTrace = {
  id: string;
  atMs: number;
  query: string;
  hits: Array<{ recordId: string; revision: number; score: number; matchedTerms: string[]; reasons: string[] }>;
};
