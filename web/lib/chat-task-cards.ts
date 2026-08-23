/**
 * Pull long-running task ids out of a chat turn's stream events so the
 * message can show the same progress cards Image Studio / research / book
 * already use on their own pages.
 */

import type { StreamEvent } from "@/lib/unified-ws";

export type StudioJobRef = {
  jobId: string;
  projectId: string;
};

export type VideoStudioJobRef = {
  jobId: string;
  projectId: string;
  openUrl: string;
};

export type VideoStudioProjectRef = {
  projectId: string;
  openUrl: string;
  action: string;
  shotCount: number;
};

const VIDEO_STUDIO_PROJECT_ACTIONS = new Set([
  "plan_episode",
  "analyze_script",
  "apply_production",
]);

function metaOf(event: StreamEvent): Record<string, unknown> {
  return (event.metadata ?? {}) as Record<string, unknown>;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return "";
}

export function collectStudioJobRefs(events: StreamEvent[]): StudioJobRef[] {
  const seen = new Map<string, StudioJobRef>();
  for (const event of events) {
    const meta = metaOf(event);
    const jobId = String(meta.studio_job_id || "").trim();
    if (!jobId) continue;
    const projectId = String(meta.studio_project_id || "").trim();
    const prev = seen.get(jobId);
    if (!prev || (projectId && !prev.projectId)) {
      seen.set(jobId, { jobId, projectId });
    }
  }
  return [...seen.values()];
}

/**
 * Video tool results are streamed with their payload under
 * `metadata.tool_metadata`. Older/synthetic events may expose the same fields
 * directly, so accept both shapes and coalesce repeated progress events.
 */
export function collectVideoStudioJobRefs(
  events: StreamEvent[],
): VideoStudioJobRef[] {
  const seen = new Map<string, VideoStudioJobRef>();
  for (const event of events) {
    const meta = metaOf(event);
    const toolMeta = recordOf(meta.tool_metadata);
    const jobId = firstText(
      meta.video_studio_job_id,
      toolMeta.video_studio_job_id,
    );
    if (!jobId) continue;
    const projectId = firstText(
      meta.video_studio_project_id,
      toolMeta.video_studio_project_id,
    );
    const openUrl = firstText(meta.open_url, toolMeta.open_url);
    const previous = seen.get(jobId);
    seen.set(jobId, {
      jobId,
      projectId: projectId || previous?.projectId || "",
      openUrl: openUrl || previous?.openUrl || "",
    });
  }
  return [...seen.values()];
}

export function videoStudioJobHref(ref: VideoStudioJobRef): string {
  const search = new URLSearchParams();
  if (ref.projectId) search.set("project", ref.projectId);
  search.set("job", ref.jobId);
  return `/video-studio?${search.toString()}`;
}

function shotCountOf(meta: Record<string, unknown>, toolMeta: Record<string, unknown>): number {
  const shotIds = meta.shot_ids ?? toolMeta.shot_ids;
  if (Array.isArray(shotIds)) return shotIds.filter(Boolean).length;
  const raw = meta.shot_count ?? toolMeta.shot_count;
  const count = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function collectVideoStudioProjectRefs(
  events: StreamEvent[],
): VideoStudioProjectRef[] {
  const seen = new Map<string, VideoStudioProjectRef>();
  for (const event of events) {
    const meta = metaOf(event);
    const toolMeta = recordOf(meta.tool_metadata);
    const action = firstText(meta.action, toolMeta.action);
    if (!VIDEO_STUDIO_PROJECT_ACTIONS.has(action)) continue;
    const projectId = firstText(
      meta.video_studio_project_id,
      toolMeta.video_studio_project_id,
    );
    if (!projectId) continue;
    const openUrl = firstText(meta.open_url, toolMeta.open_url);
    const shotCount = shotCountOf(meta, toolMeta);
    const key = `${action}:${projectId}`;
    const previous = seen.get(key);
    seen.set(key, {
      projectId,
      action,
      openUrl: openUrl || previous?.openUrl || "",
      shotCount: shotCount || previous?.shotCount || 0,
    });
  }
  return [...seen.values()];
}

export function videoStudioProjectHref(ref: VideoStudioProjectRef): string {
  if (ref.openUrl.startsWith("/video-studio")) return ref.openUrl;
  const search = new URLSearchParams();
  if (ref.projectId) search.set("project", ref.projectId);
  if (ref.action === "analyze_script") search.set("view", "production");
  else search.set("view", "storyboard");
  return `/video-studio?${search.toString()}`;
}

export function collectBookIds(events: StreamEvent[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const meta = metaOf(event);
    const bookId = String(meta.book_id || "").trim();
    if (!bookId || seen.has(bookId)) continue;
    seen.add(bookId);
    ids.push(bookId);
  }
  return ids;
}

export function hasResearchEvents(events: StreamEvent[]): boolean {
  return events.some((event) => {
    if (event.source === "deep_research") return true;
    const meta = metaOf(event);
    return Boolean(meta.research_status_key || meta.research_stage_card);
  });
}

export function latestResearchLabelKey(events: StreamEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const meta = metaOf(event);
    const key = String(meta.research_status_key || "");
    if (key) return key;
    const stage = String(event.stage || "");
    if (
      stage === "researching" ||
      stage === "decomposing" ||
      stage === "reporting" ||
      stage === "rephrasing"
    ) {
      return stage;
    }
  }
  return "";
}
