"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

const changedEvent = "knorvia-ui-preference";
const fallback = new Map<string, string>();
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changedEvent, listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(changedEvent, listener); };
}
function read(key: string) {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return localStorage.getItem(key) ?? ""; }
  catch { return fallback.get(key) ?? ""; }
}

/** Read the latest snapshot on writes, including updates from other windows. */
export function useLocalPreference<T>(key: string, parse: (raw: string) => T) {
  const raw = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), () => "");
  const value = useMemo(() => parse(raw), [raw, parse]);
  const update = useCallback((change: (current: T) => T) => {
    const next = JSON.stringify(change(parse(read(key))));
    fallback.set(key, next);
    try { localStorage.setItem(key, next); fallback.delete(key); } catch { /* Keep this window usable when storage is unavailable. */ }
    window.dispatchEvent(new Event(changedEvent));
  }, [key, parse]);
  return [value, update] as const;
}
