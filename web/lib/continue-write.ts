/** Continue-write prompt detection and truncated-reply helpers. */

export const CONTINUE_WRITE_PHRASES = [
  "继续写",
  "接着写",
  "请继续",
  "continue",
  "continue writing",
  "continue the reply",
] as const;

const TRUNCATED_FINISH = new Set(["length", "max_tokens", "max_output_tokens"]);

export function isContinueWritePrompt(text: string | null | undefined): boolean {
  const normalized = String(text || "")
    .trim()
    .replace(/[.。!！?？]+$/u, "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return (CONTINUE_WRITE_PHRASES as readonly string[]).includes(normalized);
}

export function isTruncatedFinishReason(reason: unknown): boolean {
  return TRUNCATED_FINISH.has(String(reason || "").trim().toLowerCase());
}

type EventLike = {
  type?: string;
  content?: string;
  metadata?: Record<string, unknown> | null;
};

export function isTruncatedAssistantMessage(message: {
  role?: string;
  events?: EventLike[] | null;
  metadata?: Record<string, unknown> | null;
} | null | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  const meta = message.metadata;
  if (meta && (meta.truncated === true || isTruncatedFinishReason(meta.finish_reason))) {
    return true;
  }
  for (const event of message.events || []) {
    const eventMeta = event.metadata || {};
    if (eventMeta.output_truncated === true || eventMeta.truncated === true) {
      return true;
    }
    if (isTruncatedFinishReason(eventMeta.finish_reason)) {
      return true;
    }
  }
  return false;
}
