/** Client-side 502 / timeout classification for auto-retry. */

const RETRYABLE_PATTERN =
  /\b(502|503|504)\b|bad gateway|gateway timeout|timed out|timeout|temporarily unavailable/i;

export const EXTRA_GENERATION_RETRIES = 2;

export function isRetryableGenerationError(
  content: string | null | undefined,
  metadata?: Record<string, unknown> | null,
): boolean {
  const status = metadata?.status;
  const reason = String(metadata?.reason || "");
  if (reason === "regenerate_busy" || reason === "nothing_to_regenerate" || reason === "cancelled") {
    return false;
  }
  if (status === "cancelled" || status === "rejected") return false;
  const haystack = `${content || ""} ${JSON.stringify(metadata || {})}`;
  return RETRYABLE_PATTERN.test(haystack);
}

export function nextAutoRetryCount(used: number, extra = EXTRA_GENERATION_RETRIES): number | null {
  if (used >= extra) return null;
  return used + 1;
}

export type RetryBudgetEvent =
  | {
      type: "error";
      content?: string | null;
      metadata?: Record<string, unknown> | null;
    }
  | { type: "done"; status?: string | null };

/**
 * Pure budget for the WS ``error`` then ``done`` pair the turn runtime emits.
 *
 * A retryable terminal error consumes one extra. The following ``done`` with
 * ``failed`` must not reset the count — otherwise every 502 looks like the
 * first failure and auto-retry never stops. Completed/cancelled turns clear.
 */
export function reduceRetryBudget(
  used: number,
  event: RetryBudgetEvent,
  extra = EXTRA_GENERATION_RETRIES,
): { used: number; shouldRetry: boolean } {
  const current = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  if (event.type === "done") {
    const status = String(event.status || "completed").toLowerCase();
    if (status === "failed") {
      return { used: current, shouldRetry: false };
    }
    return { used: 0, shouldRetry: false };
  }
  if (!isRetryableGenerationError(event.content, event.metadata)) {
    return { used: current, shouldRetry: false };
  }
  const next = nextAutoRetryCount(current, extra);
  if (next == null) {
    return { used: current, shouldRetry: false };
  }
  return { used: next, shouldRetry: true };
}
