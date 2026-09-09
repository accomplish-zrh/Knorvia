/**
 * Office-draft review-card helpers.
 *
 * The chat pipeline stamps draft_id / files / status onto tool_metadata and
 * a follow-up progress event (`trace_kind=office_draft`). The card PATCHes
 * `/api/v1/chat/office-drafts/{id}` to merge or discard.
 */

import { apiFetch } from "@/lib/api";
import type { StreamEvent } from "@/lib/unified-ws";

export type OfficeDraftStatus = "draft" | "ready" | "merged" | "discarded";
export type OfficeDraftAction = "merge" | "discard";

export type OfficeDraftFile = {
  name: string;
  /** Empty when the bytes did not land as a workspace file (library write-back). */
  url: string;
  kind?: string;
  library_entry_id?: string;
};

export type OfficeDiffEntry = {
  sheet: string;
  kind: string;
  target: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type OfficeDiff = {
  entries: OfficeDiffEntry[];
  omittedCount: number;
  truncated: boolean;
};

export type OfficeVerification = {
  reopened: boolean;
  targetReadback: boolean;
  zipStructureValid: boolean;
  untouchedPartsVerified: boolean;
  allowedChangedParts: string[];
  notes: string[];
};

export type OfficeArtifactRef = {
  artifactId: string;
  filename: string;
  kind: string;
  currentRevision: number;
  canUndo: boolean;
  canRedo: boolean;
  originKind?: string;
  originRef?: string;
  currentHash?: string;
  historyLength?: number;
  cursor?: number;
  detachedRevisions?: number[];
  lastDiff?: OfficeDiff | null;
  lastVerification?: OfficeVerification | null;
  calculationRequired?: boolean;
};

export type OfficeDraftRef = {
  draftId: string;
  files: OfficeDraftFile[];
  status: OfficeDraftStatus;
  artifacts?: OfficeArtifactRef[];
};

export type OfficeSelection = {
  draftId: string;
  artifactId: string;
  sheet: string;
  range: string;
  revision: number;
};

export class OfficeDraftApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUSES = new Set<OfficeDraftStatus>([
  "draft",
  "ready",
  "merged",
  "discarded",
]);

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metaOf(event: StreamEvent): Record<string, unknown> {
  return recordOf(event.metadata);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return "";
}

function asStatus(value: unknown): OfficeDraftStatus {
  const text = String(value || "").trim().toLowerCase();
  return STATUSES.has(text as OfficeDraftStatus)
    ? (text as OfficeDraftStatus)
    : "draft";
}

function asDiff(value: unknown): OfficeDiff | null {
  const diff = recordOf(value);
  const rawEntries = Array.isArray(diff.entries) ? diff.entries : null;
  if (!rawEntries) return null;
  const entries: OfficeDiffEntry[] = [];
  for (const item of rawEntries) {
    const row = recordOf(item);
    entries.push({
      sheet: firstText(row.sheet),
      kind: firstText(row.kind),
      target: firstText(row.target),
      before: Object.keys(recordOf(row.before)).length ? recordOf(row.before) : null,
      after: Object.keys(recordOf(row.after)).length ? recordOf(row.after) : null,
    });
  }
  return {
    entries,
    omittedCount: Number(diff.omitted_count ?? diff.omittedCount ?? 0) || 0,
    truncated: Boolean(diff.truncated),
  };
}

function asVerification(value: unknown): OfficeVerification | null {
  const record = recordOf(value);
  if (!Object.keys(record).length) return null;
  return {
    reopened: Boolean(record.reopened),
    targetReadback: Boolean(record.target_readback ?? record.targetReadback),
    zipStructureValid: Boolean(
      record.zip_structure_valid ?? record.zipStructureValid,
    ),
    untouchedPartsVerified: Boolean(
      record.untouched_parts_verified ?? record.untouchedPartsVerified,
    ),
    allowedChangedParts: Array.isArray(record.allowed_changed_parts)
      ? record.allowed_changed_parts.map((part) => String(part))
      : [],
    notes: Array.isArray(record.notes) ? record.notes.map((note) => String(note)) : [],
  };
}

function asArtifacts(value: unknown): OfficeArtifactRef[] {
  if (!Array.isArray(value)) return [];
  const artifacts: OfficeArtifactRef[] = [];
  for (const item of value) {
    const row = recordOf(item);
    const artifactId = firstText(row.artifact_id, row.artifactId);
    if (!artifactId) continue;
    artifacts.push({
      artifactId,
      filename: firstText(row.filename),
      kind: firstText(row.kind),
      currentRevision: Number(row.current_revision ?? row.currentRevision ?? 0) || 0,
      canUndo: Boolean(row.can_undo ?? row.canUndo),
      canRedo: Boolean(row.can_redo ?? row.canRedo),
      originKind: firstText(row.origin_kind, row.originKind) || undefined,
      originRef: firstText(row.origin_ref, row.originRef) || undefined,
      currentHash: firstText(row.current_hash, row.currentHash) || undefined,
      historyLength: Number(row.history_length ?? row.historyLength ?? 0) || 0,
      cursor: Number(row.cursor ?? 0) || 0,
      detachedRevisions: Array.isArray(row.detached_revisions)
        ? row.detached_revisions.map((revision) => Number(revision) || 0)
        : [],
      lastDiff: asDiff(row.last_diff ?? row.lastDiff),
      lastVerification: asVerification(row.last_verification ?? row.lastVerification),
      calculationRequired: Boolean(
        row.calculation_required ?? row.calculationRequired,
      ),
    });
  }
  return artifacts;
}

function asDraft(payload: Record<string, unknown>, fallbackId: string): OfficeDraftRef | null {
  const id = firstText(payload.draft_id, fallbackId);
  if (!id) return null;
  return {
    draftId: id,
    status: asStatus(payload.status ?? payload.draft_status),
    files: asFiles(payload.files),
    artifacts: asArtifacts(payload.artifacts),
  };
}

async function artifactAction(
  draftId: string,
  artifactId: string,
  action: "undo" | "redo",
): Promise<OfficeArtifactRef> {
  const response = await apiFetch(
    `/api/v1/chat/office-drafts/${encodeURIComponent(draftId)}/artifacts/${encodeURIComponent(artifactId)}/${action}`,
    { method: "POST" },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new OfficeDraftApiError(
      response.status,
      detail || `Office draft ${action} failed`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const currentRevision = Number(payload.current_revision ?? 0) || 0;
  const historyLength = Number(payload.history_length ?? 0) || 0;
  const cursor = Number(payload.cursor ?? 0) || 0;
  return {
    artifactId: firstText(payload.artifact_id, artifactId),
    filename: "",
    kind: "",
    currentRevision,
    canUndo: cursor > 0,
    canRedo: cursor < historyLength - 1,
  };
}

/** Human-side strict operation batch. Throws OfficeDraftApiError on 409/422. */
export async function applyOfficeOperations(
  draftId: string,
  artifactId: string,
  baseRevision: number,
  operations: unknown[],
): Promise<Record<string, unknown>> {
  const response = await apiFetch(
    `/api/v1/chat/office-drafts/${encodeURIComponent(draftId)}/artifacts/${encodeURIComponent(artifactId)}/operations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_revision: baseRevision, operations }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new OfficeDraftApiError(
      response.status,
      detail || "Office operation batch failed",
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Open a resolved source (e.g. ``library:<entryId>``) in a fresh v2 draft.
 *
 * ``expectedBaseHash`` is the SHA-256 of the bytes the caller is editing; the
 * server rejects the open with a 409 if the source changed since then.
 */
export async function openOfficeDraftFromSource(
  source: string,
  expectedBaseHash?: string,
): Promise<OfficeDraftRef> {
  const response = await apiFetch("/api/v1/chat/office-drafts/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      expectedBaseHash ? { source, expected_base_hash: expectedBaseHash } : { source },
    ),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new OfficeDraftApiError(
      response.status,
      detail || "Failed to open the office draft",
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const card = recordOf(payload.card ?? payload);
  const draft = asDraft(card, "");
  if (!draft) {
    throw new OfficeDraftApiError(
      response.status,
      "Office draft response was invalid",
    );
  }
  return draft;
}

export async function undoArtifact(
  draftId: string,
  artifactId: string,
): Promise<OfficeArtifactRef> {
  return artifactAction(draftId, artifactId, "undo");
}

export async function redoArtifact(
  draftId: string,
  artifactId: string,
): Promise<OfficeArtifactRef> {
  return artifactAction(draftId, artifactId, "redo");
}

function asFiles(value: unknown): OfficeDraftFile[] {
  if (!Array.isArray(value)) return [];
  const files: OfficeDraftFile[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      files.push({ name: item.trim(), url: "" });
      continue;
    }
    const row = recordOf(item);
    const name = firstText(row.name, row.filename);
    if (!name) continue;
    const kind = firstText(row.kind);
    const entryId = firstText(row.library_entry_id);
    files.push({
      name,
      url: firstText(row.url),
      ...(kind ? { kind } : {}),
      ...(entryId ? { library_entry_id: entryId } : {}),
    });
  }
  return files;
}

/** Pull the latest office-draft card payload out of a turn's stream events. */
export function collectOfficeDrafts(events: StreamEvent[]): OfficeDraftRef[] {
  const seen = new Map<string, OfficeDraftRef>();
  for (const event of events) {
    const meta = metaOf(event);
    const toolMeta = recordOf(meta.tool_metadata);
    const nested = {
      ...recordOf(toolMeta.office_draft),
      ...recordOf(meta.office_draft),
    };
    const draftId = firstText(
      nested.draft_id,
      meta.draft_id,
      toolMeta.draft_id,
    );
    if (!draftId) continue;
    const status = asStatus(
      nested.status ||
        meta.draft_status ||
        toolMeta.draft_status ||
        toolMeta.status,
    );
    const files = asFiles(nested.files || toolMeta.files || meta.files);
    const previous = seen.get(draftId);
    const artifacts = asArtifacts(nested.artifacts || toolMeta.artifacts);
    seen.set(draftId, {
      draftId,
      status,
      files: files.length ? files : previous?.files || [],
      ...(artifacts.length ? { artifacts } : {}),
    });
  }
  return [...seen.values()];
}

export function isOfficeDraftTerminal(status: OfficeDraftStatus): boolean {
  return status === "merged" || status === "discarded";
}

export function canConfirmOfficeDraft(status: OfficeDraftStatus): boolean {
  return status === "draft" || status === "ready";
}

export function canShowOfficeDraftFiles(status: OfficeDraftStatus): boolean {
  return status !== "discarded";
}

/** PATCH the review-card action. Used by OfficeDraftCard button callbacks. */
export async function patchOfficeDraft(
  draftId: string,
  action: OfficeDraftAction,
): Promise<OfficeDraftRef> {
  const response = await apiFetch(
    `/api/v1/chat/office-drafts/${encodeURIComponent(draftId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Office draft ${action} failed`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const draft = asDraft(payload, draftId);
  return draft || { draftId, status: "draft", files: [], artifacts: [] };
}

export async function fetchOfficeDraft(
  draftId: string,
): Promise<OfficeDraftRef | null> {
  const response = await apiFetch(
    `/api/v1/chat/office-drafts/${encodeURIComponent(draftId)}`,
    { skipAuthRedirect: true },
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as Record<string, unknown>;
  return asDraft(payload, draftId);
}
