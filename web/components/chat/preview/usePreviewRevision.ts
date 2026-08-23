"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  canWatchPreviewUrl,
  previewRevisionFingerprint,
} from "@/lib/preview-revision";

const POLL_MS = 2500;

/**
 * Watch a served file and bump a revision whenever HEAD says it changed.
 * Lets the preview drawer remount after the agent overwrites the same path.
 */
export function usePreviewRevision(
  url: string | null,
  enabled: boolean,
): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled || !canWatchPreviewUrl(url) || !url) return;
    let cancelled = false;
    let last = "";
    let inFlight = false;
    let controller: AbortController | null = null;

    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await apiFetch(url, {
          method: "HEAD",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const next = previewRevisionFingerprint(response.headers);
        if (!next || next === "||") return;
        if (last && next !== last && !cancelled) {
          setRevision((value) => value + 1);
        }
        last = next;
      } catch {
        /* a missed poll is fine; the next tick retries */
      } finally {
        inFlight = false;
        controller = null;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [url, enabled]);

  return revision;
}
