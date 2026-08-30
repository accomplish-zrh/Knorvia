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

export interface ClassroomScene {
  id: string;
  order: number;
  type: "slide" | "quiz" | "discussion";
  title: string;
  key_points: string[];
  objective?: string;
  actions: ClassroomAction[];
  questions?: ClassroomQuizQuestion[];
}

export interface ClassroomOutline {
  id: string;
  type: "slide" | "quiz" | "discussion";
  title: string;
  key_points: string[];
  objective?: string;
  minutes?: number;
  order: number;
}

export interface ClassroomDocument {
  id: string;
  title: string;
  topic: string;
  language: string;
  created_at: number;
  version: number;
  agent_profiles: ClassroomAgentProfile[];
  outlines: ClassroomOutline[];
  scenes: ClassroomScene[];
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
    | "completed"
    | "error";
  message?: string;
  scenes_generated?: number;
  total_scenes?: number;
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

export async function getClassroom(id: string): Promise<ClassroomDocument> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/classroom/${encodeURIComponent(id)}`),
      { cache: "no-store" },
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

/** POST /generate and surface OpenMAIC-style progress + the done payload. */
export async function generateClassroom(
  payload: {
    topic: string;
    minutes: number;
    language: string;
    /** Organic tie-ins: ground in a KB, seat saved personas as classmates. */
    kb_name?: string;
    persona_names?: string[];
  },
  onProgress: (progress: GenerationProgress) => void,
  signal?: AbortSignal,
): Promise<{ id: string; title: string }> {
  const response = await fetch(apiUrl("/api/v1/classroom/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Generation failed: ${response.status}`);
  }
  let result: { id: string; title: string } | null = null;
  for await (const block of readSse(response)) {
    if (block.event === "progress") {
      onProgress(JSON.parse(block.data) as GenerationProgress);
    } else if (block.event === "done") {
      result = JSON.parse(block.data) as { id: string; title: string };
    } else if (block.event === "error") {
      const err = JSON.parse(block.data) as { message?: string };
      throw new Error(err.message || "Generation failed");
    }
  }
  if (!result) throw new Error("Generation ended without a result");
  return result;
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
