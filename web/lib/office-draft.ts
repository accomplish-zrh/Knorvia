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
  url: string;
};

export type OfficeDraftRef = {
  draftId: string;
  files: OfficeDraftFile[];
  status: OfficeDraftStatus;
};

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
    files.push({ name, url: firstText(row.url) });
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
    seen.set(draftId, {
      draftId,
      status,
      files: files.length ? files : previous?.files || [],
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
  return {
    draftId: firstText(payload.draft_id, draftId),
    status: asStatus(payload.status),
    files: asFiles(payload.files),
  };
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
  const id = firstText(payload.draft_id, draftId);
  if (!id) return null;
  return {
    draftId: id,
    status: asStatus(payload.status),
    files: asFiles(payload.files),
  };
}
