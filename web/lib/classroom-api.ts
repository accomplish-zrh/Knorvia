/** Typed client for the /api/v1/classroom backend (OpenMAIC-inspired lessons). */

import { apiFetch, apiUrl } from "@/lib/api";

export interface ClassroomAgentProfile {
  id: string;
  name: string;
  role: "teacher" | "classmate";
  persona: string;
  color: string;
  allowed_actions?: string[];
  priority?: number;
}

export interface ClassroomQuizQuestion {
  id: string;
  type: "single" | "multiple" | "short";
  question: string;
  options?: string[];
  answer?: string;
  analysis?: string;
  points?: number;
}

export type ClassroomAction =
  | { type: "speech"; agent_id: string; text: string }
  | { type: "quiz_trigger" }
  | { type: "discussion"; prompt?: string };

/** Structured spec of an interactive widget (fixed at outline time). */
export interface ClassroomWidget {
  widget_type: "simulation" | "diagram";
  concept: string;
  key_variables?: string[];
  diagram_type?: "flow" | "hierarchy";
  nodes?: { id: string; label: string; parent_id?: string }[];
}

export interface ClassroomScene {
  id: string;
  order: number;
  type: "slide" | "quiz" | "discussion" | "interactive";
  title: string;
  key_points: string[];
  objective?: string;
  actions: ClassroomAction[];
  questions?: ClassroomQuizQuestion[];
  html?: string;
  narration?: string[];
  widget?: ClassroomWidget | null;
}

export interface ClassroomOutline {
  id: string;
  type: "slide" | "quiz" | "discussion" | "interactive";
  title: string;
  key_points: string[];
  objective?: string;
  minutes?: number;
  order: number;
  widget?: ClassroomWidget | null;
}

export interface ClassroomDocument {
  id: string;
  title: string;
  topic: string;
  language: string;
  created_at: number;
  version: number;
  style_id?: string;
  agent_profiles: ClassroomAgentProfile[];
  outlines: ClassroomOutline[];
  scenes: ClassroomScene[];
}

/** Teaching-style skill pack entry from GET /api/v1/classroom/styles. */
export interface ClassroomStyle {
  id: string;
  title: string;
  description: string;
  title_en?: string;
  description_en?: string;
}

export interface ClassroomCard {
  id: string;
  title: string;
  topic: string;
  language: string;
  scene_count: number;
  created_at: number;
}

/** OpenMAIC-style generation progress event. */
export interface GenerationProgress {
  step:
    | "initializing"
    | "generating_outlines"
    | "generating_scenes"
    | "outline_repaired"
    | "scene_degraded"
    | "completed"
    | "error";
  message?: string;
  scenes_generated?: number;
  total_scenes?: number;
  diagnostics?: string[];
  remaining?: string[];
  scene_id?: string;
  scene_title?: string;
  reason?: string;
}

export interface DiscussionState {
  turn_count: number;
  summaries: { agent_id: string; content: string; turn: number }[];
}

export interface DiscussionTurnResult {
  next: string;
  text?: string;
  state: DiscussionState;
}

export interface GradeResult {
  question_id: string;
  correct: boolean;
  given: string;
  answer?: string;
  analysis?: string;
  comment?: string;
}

function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    return res
      .json()
      .catch(() => ({}))
      .then((body) => {
        const detail = (body as { detail?: string }).detail;
        throw new Error(
          typeof detail === "string" ? detail : `Request failed: ${res.status}`,
        );
      });
  }
  return res.json() as Promise<T>;
}

export async function listClassrooms(): Promise<ClassroomCard[]> {
  const data = await json<{ classrooms: ClassroomCard[] }>(
    await apiFetch(apiUrl("/api/v1/classroom"), { cache: "no-store" }),
  );
  return data.classrooms;
}

/** Teaching-style skill packs selectable at generation time. */
export async function fetchClassroomStyles(): Promise<ClassroomStyle[]> {
  const data = await json<{ styles: ClassroomStyle[] }>(
    await apiFetch(apiUrl("/api/v1/classroom/styles"), { cache: "no-store" }),
  );
  return data.styles;
}

export async function getClassroom(id: string): Promise<ClassroomDocument> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/classroom/${encodeURIComponent(id)}`),
      { cache: "no-store" },
    ),
  );
}

/** Conditional refresh: returns {unchanged:true} when revision matches. */
export async function getClassroomIfChanged(
  id: string,
  revision: number,
): Promise<ClassroomDocument | { id: string; version: number; unchanged: true }> {
  return json(
    await apiFetch(
      apiUrl(
        `/api/v1/classroom/${encodeURIComponent(id)}?revision=${revision}`,
      ),
      { cache: "no-store" },
    ),
  );
}

/** Apply one atomic edit transaction; resolves with the updated document. */
export async function patchClassroom(
  classroomId: string,
  ops: Record<string, unknown>[],
): Promise<ClassroomDocument> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/classroom/${encodeURIComponent(classroomId)}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops }),
      },
    ),
  );
}

export async function deleteClassroom(id: string): Promise<void> {
  await apiFetch(
    apiUrl(`/api/v1/classroom/${encodeURIComponent(id)}`),
    { method: "DELETE" },
  );
}

/** Parse one `event:`/`data:` block stream. Returns the block type + payload. */
async function* readSse(response: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventLine = block
        .split("\n")
        .find((line) => line.startsWith("event:"));
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (dataLine) {
        yield {
          event: eventLine?.slice(6).trim() || "message",
          data: dataLine.slice(5).trim(),
        };
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/** POST /generate — creates a durable job, returns its id immediately. */
export interface ClassroomJobEvent {
  ts: number;
  type: "progress" | "done" | "error";
  data: Record<string, unknown>;
}

export interface ClassroomJobSnapshot {
  job_id: string;
  status: "pending" | "running" | "done" | "failed";
  topic: string;
  payload: {
    topic?: string;
    minutes?: number;
    language?: string;
    kb_name?: string;
    persona_names?: string[];
    style_id?: string;
  };
  events: ClassroomJobEvent[];
  result_classroom_id?: string;
  error?: string;
  created_at: number;
  updated_at: number;
}

export async function startClassroomGeneration(payload: {
  topic: string;
  minutes: number;
  language: string;
  /** Organic tie-ins: ground in a KB, seat saved personas as classmates. */
  kb_name?: string;
  persona_names?: string[];
  /** Teaching-style skill pack (""/undefined = default behavior). */
  style_id?: string;
}): Promise<{ job_id: string }> {
  return json(
    await apiFetch(apiUrl("/api/v1/classroom/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function getClassroomJob(
  jobId: string,
): Promise<ClassroomJobSnapshot> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/classroom/jobs/${encodeURIComponent(jobId)}`),
      { cache: "no-store" },
    ),
  );
}

/**
 * Follow one generation job to completion: snapshot first (replays every
 * stored event — this is also the reconnect path after refresh/error),
 * then the live SSE stream (skipping already-applied replay), retrying
 * transient stream drops up to three times. Resolves with the done payload.
 */
export async function followClassroomJob(
  jobId: string,
  onProgress: (progress: GenerationProgress) => void,
  signal?: AbortSignal,
): Promise<{ id: string; title: string }> {
  let result: { id: string; title: string } | null = null;
  let failure = "";
  const apply = (type: string, data: Record<string, unknown>) => {
    if (type === "progress") {
      onProgress(data as unknown as GenerationProgress);
    } else if (type === "done") {
      result = data as unknown as { id: string; title: string };
    } else if (type === "error") {
      failure = String((data as { message?: string }).message || "Generation failed");
    }
  };

  for (let attempt = 0; attempt < 3 && !result && !failure; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
    // Snapshot: the authoritative event history so far (reconnect-safe).
    const snapshot = await getClassroomJob(jobId);
    for (const event of snapshot.events) {
      apply(event.type, event.data);
    }
    if (result || failure) break;
    if (snapshot.status === "failed") {
      failure = snapshot.error || "Generation failed";
      break;
    }
    if (snapshot.status === "done") {
      failure = "Generation ended without a result";
      break;
    }

    const response = await fetch(
      apiUrl(`/api/v1/classroom/jobs/${encodeURIComponent(jobId)}/events`),
      { signal },
    );
    if (!response.ok) continue; // transient — resync via snapshot next loop
    const replayed = snapshot.events.length;
    let consumed = 0;
    try {
      for await (const block of readSse(response)) {
        consumed += 1;
        if (consumed <= replayed) continue; // server replays from the start
        const data = JSON.parse(block.data) as Record<string, unknown>;
        apply(block.event, data);
        if (block.event === "done" || block.event === "error") break;
      }
    } catch {
      // Stream dropped mid-generation — the retry loop resyncs.
      if (signal?.aborted) throw new Error("Aborted");
    }
    // Stream ended without a terminal event: loop around and resync.
  }
  if (result) return result;
  throw new Error(failure || "Generation ended without a result");
}

/**
 * One stateless discussion turn: the server picks the next speaker and
 * streams their line; the returned state round-trips into the next call.
 */
export async function discussionTurn(
  classroomId: string,
  payload: {
    scene_id: string;
    scene_title: string;
    scene_key_points: string[];
    seed_prompt: string;
    transcript: { agent_id: string; text: string }[];
    summaries: DiscussionState["summaries"];
    turn_count: number;
    pending_question: string;
    quiz_results: GradeResult[];
    user_message: string;
  },
  handlers: {
    onAgentStart?: (agentId: string) => void;
    onDelta?: (agentId: string, text: string) => void;
  },
  signal?: AbortSignal,
): Promise<DiscussionTurnResult> {
  const response = await fetch(
    apiUrl(`/api/v1/classroom/${encodeURIComponent(classroomId)}/discussion`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
  );
  if (!response.ok) throw new Error(`Discussion failed: ${response.status}`);
  let result: DiscussionTurnResult | null = null;
  for await (const block of readSse(response)) {
    if (block.event === "agent_start") {
      handlers.onAgentStart?.(
        (JSON.parse(block.data) as { agent_id: string }).agent_id,
      );
    } else if (block.event === "text_delta") {
      const delta = JSON.parse(block.data) as { agent_id: string; text: string };
      handlers.onDelta?.(delta.agent_id, delta.text);
    } else if (block.event === "done") {
      result = JSON.parse(block.data) as DiscussionTurnResult;
    }
  }
  if (!result) throw new Error("Discussion turn ended without a result");
  return result;
}

/** Two-tier quiz grading (objective local, short-answer LLM). */
export async function gradeQuizScene(
  classroomId: string,
  sceneId: string,
  answers: Record<string, string>,
): Promise<GradeResult[]> {
  const data = await json<{ results: GradeResult[] }>(
    await apiFetch(
      apiUrl(`/api/v1/classroom/${encodeURIComponent(classroomId)}/grade`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene_id: sceneId, answers }),
      },
    ),
  );
  return data.results;
}

/** Push graded quiz answers into the question bank (题库) for review. */
export async function saveClassroomQuestions(
  classroomId: string,
  sceneId: string,
  entries: {
    question_id: string;
    user_answer: string;
    is_correct: boolean;
  }[],
  onlyWrong = true,
): Promise<{ saved: number }> {
  const data = await json<{ saved: number }>(
    await apiFetch(
      apiUrl(
        `/api/v1/classroom/${encodeURIComponent(classroomId)}/save-questions`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene_id: sceneId, only_wrong: onlyWrong, entries }),
      },
    ),
  );
  return data;
}

/** Save the lesson's outline cards into a Notebook (default: "AI 课堂"). */
export async function exportClassroomToNotebook(
  classroomId: string,
  notebookId = "",
): Promise<{ notebook_id: string }> {
  const params = notebookId ? `?notebook_id=${encodeURIComponent(notebookId)}` : "";
  return json(
    await apiFetch(
      apiUrl(
        `/api/v1/classroom/${encodeURIComponent(classroomId)}/export-notebook${params}`,
      ),
      { method: "POST" },
    ),
  );
}
