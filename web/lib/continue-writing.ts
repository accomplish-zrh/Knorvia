import type { StreamEvent } from "@/lib/unified-ws";

const TRUNCATED_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
]);

/** True when an assistant bubble ended because generation hit an output cap. */
export function isAssistantOutputTruncated(
  events: StreamEvent[] | undefined | null,
): boolean {
  if (!events?.length) return false;
  for (const event of events) {
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    if (meta.output_truncated === true) return true;
    const finish = String(meta.finish_reason || "").trim().toLowerCase();
    if (TRUNCATED_FINISH_REASONS.has(finish) && meta.call_role === "finish") {
      return true;
    }
  }
  return false;
}
