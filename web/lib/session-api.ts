import { apiFetch, apiUrl } from "@/lib/api";
import { invalidateClientCache, withClientCache } from "@/lib/client-cache";
import type { LLMSelection, StreamEvent } from "@/lib/unified-ws";

export interface SessionMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  capability?: string;
  events: StreamEvent[];
  attachments: Array<{
    type: string;
    filename?: string;
    base64?: string;
    url?: string;
    mime_type?: string;
    id?: string;
    extracted_text?: string;
    generated?: boolean;
    size_bytes?: number;
  }>;
  metadata?: Record<string, unknown>;
  created_at: number;
  /** Edit-branching: id of the message this row continues. `null` for the
   *  first message in a session. Siblings share the same parent. */
  parent_message_id?: number | null;
}

export interface SessionPreferences {
  capability?: string;
  tools?: string[];
  knowledge_bases?: string[];
  language?: string;
  llm_selection?: LLMSelection | null;
  /** Persistent mastery state associated with this conversation. */
  mastery_path_id?: string;
  /** Session-level persona preference; "" / absent = Default (no persona). */
  persona?: string;
  /** Edit-branching: maps a parent_message_id → the child id currently
   *  shown at that branch point. Missing keys default to the latest
   *  sibling (most recently created child). */
  selected_branches?: Record<string, number>;
}

export interface SessionSummary {
  id: string;
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  last_message: string;
  status?:
    | "idle"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "rejected";
  active_turn_id?: string;
  preferences?: SessionPreferences;
  pinned?: number;
  archived_at?: number | null;
}

export interface SessionSearchHit {
  session_id: string;
  title: string;
  updated_at: number;
  snippet: string;
  match_in: "message" | "title";
}

export interface ActiveTurnSummary {
  id: string;
  turn_id: string;
  session_id: string;
  capability: string;
  status: "running" | "completed" | "failed" | "cancelled" | "rejected";
  error: string;
  created_at: number;
  updated_at: number;
  finished_at?: number | null;
  last_seq: number;
}

export interface SessionDetail {
  id: string;
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  status?:
    | "idle"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "rejected";
  active_turn_id?: string;
  compressed_summary?: string;
  summary_up_to_msg_id?: number;
  preferences?: SessionPreferences;
  messages: SessionMessage[];
  active_turns?: ActiveTurnSummary[];
}

export interface QuizResultItem {
  question_id?: string;
  question: string;
  question_type?: string;
  options?: Record<string, string>;
  user_answer: string;
  correct_answer: string;
  explanation?: string;
  difficulty?: string;
  is_correct: boolean;
}

async function expectJson<T>(response: Response): Promise<T> {
  if (response.status === 401 && typeof window !== "undefined") {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/login?next=${next}`;
    return new Promise(() => {});
  }
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function listSessions(
  limit = 50,
  offset = 0,
  options?: { force?: boolean; includeArchived?: boolean },
): Promise<SessionSummary[]> {
  const includeArchived = options?.includeArchived ?? false;
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (includeArchived) qs.set("include_archived", "true");
  return withClientCache<SessionSummary[]>(
    `sessions:${limit}:${offset}:${includeArchived ? "all" : "active"}`,
    async () => {
      const response = await apiFetch(
        apiUrl(`/api/v1/sessions?${qs.toString()}`),
        {
          cache: "no-store",
        },
      );
      const data = await expectJson<{ sessions: SessionSummary[] }>(response);
      return data.sessions ?? [];
    },
    {
      force: options?.force,
      ttlMs: 15_000,
    },
  );
}

/** Full-history search across every message of every session. */
export async function searchSessions(
  query: string,
  limit = 30,
  signal?: AbortSignal,
): Promise<SessionSearchHit[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const qs = new URLSearchParams({ q: keyword, limit: String(limit) });
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/search?${qs.toString()}`),
    { cache: "no-store", signal },
  );
  const data = await expectJson<{ results: SessionSearchHit[] }>(response);
  return data.results ?? [];
}

/** Flip pinned / archived without touching the title. */
export async function updateSessionFlags(
  sessionId: string,
  flags: { pinned?: boolean; archived?: boolean },
): Promise<SessionDetail> {
  const response = await apiFetch(apiUrl(`/api/v1/sessions/${sessionId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
  const data = await expectJson<{ session: SessionDetail }>(response);
  invalidateClientCache("sessions:");
  return data.session;
}

/** Fetch the full transcript as Markdown or JSON text for download. */
export async function exportSession(
  sessionId: string,
  format: "md" | "json" = "md",
): Promise<{ filename: string; mime_type: string; content: string }> {
  const qs = new URLSearchParams({ format });
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/${sessionId}/export?${qs.toString()}`),
    { cache: "no-store" },
  );
  return expectJson(response);
}

export async function getSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionDetail> {
  const response = await apiFetch(apiUrl(`/api/v1/sessions/${sessionId}`), {
    cache: "no-store",
    signal,
  });
  return expectJson<SessionDetail>(response);
}

export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<SessionDetail> {
  const response = await apiFetch(apiUrl(`/api/v1/sessions/${sessionId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await expectJson<{ session: SessionDetail }>(response);
  invalidateClientCache("sessions:");
  return data.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await apiFetch(apiUrl(`/api/v1/sessions/${sessionId}`), {
    method: "DELETE",
  });
  await expectJson<{ deleted: boolean }>(response);
  invalidateClientCache("sessions:");
}

export async function recordQuizResults(
  sessionId: string,
  answers: QuizResultItem[],
  turnId?: string | null,
): Promise<void> {
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/${sessionId}/quiz-results`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, turn_id: turnId || "" }),
    },
  );
  await expectJson<{ recorded: boolean }>(response);
}

export async function deleteMessage(
  sessionId: string,
  messageId: number,
): Promise<void> {
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/${sessionId}/messages/${messageId}`),
    { method: "DELETE" },
  );
  await expectJson<{ deleted: boolean }>(response);
}

export async function updateBranchSelection(
  sessionId: string,
  selectedBranches: Record<string, number>,
): Promise<void> {
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/${sessionId}/branch-selection`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected_branches: selectedBranches }),
    },
  );
  await expectJson<{ selected_branches: Record<string, number> }>(response);
}
