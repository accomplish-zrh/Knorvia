import type { StudioOutput } from "@/lib/native-studio";

/**
 * Compare-review slot bookkeeping for committed media outputs (B20).
 *
 * An object URL is owned by one output name within an immutable manifest.
 * A slot that is loading has no URL yet, so a download can never grab the
 * previous output's bytes under the new name, and at most two outputs keep
 * object URLs alive at any moment.
 */

export type MediaSlotStatus = "idle" | "loading" | "ready" | "error";

export type MediaSlot = {
  status: MediaSlotStatus;
  url?: string;
  error?: string;
  /** The bytes loaded but the element failed to decode them. */
  decodeError?: boolean;
  width?: number;
  height?: number;
  duration?: number;
};

/** Keep at most `MEDIA_SLOTS_MAX` materialized outputs, newest first. */
export function pruneSlots(slots: Record<string, MediaSlot>, keep: string[]): { next: Record<string, MediaSlot>; revoked: string[] } {
  const keepSet = new Set(keep);
  const next: Record<string, MediaSlot> = {};
  const revoked: string[] = [];
  // Preserve insertion order so the oldest entries are revoked first.
  for (const name of Object.keys(slots)) {
    if (keepSet.has(name)) next[name] = slots[name];
    else if (slots[name].url) revoked.push(name);
  }
  const overflow = Object.keys(next).length - 2;
  if (overflow > 0) {
    for (const name of Object.keys(next).slice(0, overflow)) {
      if (next[name].url) revoked.push(name);
      delete next[name];
    }
  }
  return { next, revoked };
}

/** Download is only offered when THIS output's bytes are in hand. */
export function downloadAvailable(slot: MediaSlot | undefined): boolean {
  return Boolean(slot?.status === "ready" && slot.url);
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

export function slotMetaLabel(slot: MediaSlot | undefined, fallbackSize: string, t: (zh: string, en: string) => string): string {
  const parts: string[] = [];
  if (slot?.width && slot?.height) parts.push(`${slot.width}×${slot.height}`);
  const duration = formatDuration(slot?.duration);
  if (duration) parts.push(t(`${duration} 时长`, `duration ${duration}`));
  parts.push(fallbackSize);
  return parts.join(" · ");
}

export function sanitizeDownloadName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000]/g, "-");
}

export function describeOutput(output: StudioOutput): string {
  return `${output.name} (${output.mime})`;
}
