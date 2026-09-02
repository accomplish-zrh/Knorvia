import type { StreamEvent } from "@/lib/unified-ws";

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function statusFromMeta(meta: Record<string, unknown>): number {
  for (const key of ["status_code", "http_status", "status"]) {
    const raw = meta[key];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** 502 / timeout (and close cousins) that should auto-retry before the Retry button. */
export function isTransientFailure(event: StreamEvent | null | undefined): boolean {
  if (!event || event.type !== "error") return false;
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  if (meta.turn_terminal === false) return false;
  const reason = String(meta.reason || "").toLowerCase();
  if (reason === "regenerate_busy" || reason === "nothing_to_regenerate") return false;
  if (reason === "cancelled" || String(meta.status || "") === "cancelled") return false;
  const status = statusFromMeta(meta);
  if (TRANSIENT_STATUS.has(status)) return true;
  const blob = `${event.content || ""} ${reason} ${JSON.stringify(meta)}`.toLowerCase();
  if (blob.includes("502") || blob.includes("bad gateway")) return true;
  if (
    blob.includes("timeout") ||
    blob.includes("timed out") ||
    blob.includes("deadline exceeded")
  ) {
    return true;
  }
  return false;
}

export const MAX_TRANSIENT_AUTO_RETRIES = 2;
