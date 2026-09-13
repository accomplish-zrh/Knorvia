"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { loadHistoryViews, loadLastLocation, parseLocation, persistLastLocation, readViewIdFromSearch, viewSearch, type HistoryLocation, type HistoryViewConfig } from "@/lib/native-history-views";

const initial: HistoryLocation = { viewId: null, filter: "all", projectId: "all", dateRange: "anytime", query: "", visible: 50 };
const STATE_KEY = "knorviaHistoryLocation";

export function useHistoryLocation(root: RefObject<HTMLDivElement | null>, blocked: boolean, rows: unknown) {
  const [location, setLocation] = useState<HistoryLocation>(initial);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState("");
  const latest = useRef(location); latest.current = location;
  const isBlocked = useRef(blocked); isBlocked.current = blocked;
  const restoring = useRef<HistoryLocation | null>(null);
  const pendingPop = useRef<HistoryLocation | null>(null);
  const readyRef = useRef(false);

  const scroller = () => root.current?.closest<HTMLElement>(".nw-view") ?? document.scrollingElement as HTMLElement;
  const capture = (): HistoryLocation => {
    const el = scroller(), top = el === document.scrollingElement ? 0 : el?.getBoundingClientRect().top ?? 0;
    const rows = root.current?.querySelector(".nw-task-rows")?.children;
    let left = 0, right = rows?.length ?? 0;
    while (rows && left < right) { const middle = Math.floor((left + right) / 2); if (rows[middle].getBoundingClientRect().bottom <= top + 1) left = middle + 1; else right = middle; }
    const row = rows?.[left] as HTMLElement | undefined;
    return { ...latest.current, scrollTop: el?.scrollTop ?? 0,
      anchor: row ? { threadId: row.dataset.historyThread!, offset: row.getBoundingClientRect().top - top } : undefined };
  };
  const write = (value: HistoryLocation, mode: "replaceState" | "pushState" = "replaceState") => {
    persistLastLocation(value);
    try { window.history[mode]({ ...window.history.state, [STATE_KEY]: { path: window.location.pathname, value } }, "", `${window.location.pathname}${viewSearch(value.viewId)}${window.location.hash}`); } catch { /* Session position remains usable when browser history is unavailable. */ }
  };
  const savePosition = () => { if (readyRef.current && !restoring.current && !pendingPop.current) write(capture()); };
  const restore = (value: HistoryLocation) => { restoring.current = value; latest.current = value; setLocation(value); };
  const readEntry = () => {
    const id = readViewIdFromSearch(window.location.search);
    if (!id && new URLSearchParams(window.location.search).has("view")) { setNote("url-invalid"); return loadLastLocation() ?? initial; }
    const entry = window.history.state?.[STATE_KEY];
    const saved = entry?.path === window.location.pathname ? parseLocation(JSON.stringify(entry.value)) : null;
    if (saved && saved.viewId === id) return saved;
    if (id) {
      const view = loadHistoryViews().find(view => view.id === id);
      if (view) return { viewId: view.id, filter: view.filter, projectId: view.projectId, dateRange: view.dateRange, query: view.query, visible: view.visible };
      setNote("url-missing");
    }
    return loadLastLocation() ?? initial;
  };

  useEffect(() => {
    restore(readEntry()); readyRef.current = true; setReady(true);
    const pop = () => {
      setNote("");
      const value = readEntry();
      if (isBlocked.current) { pendingPop.current = value; setNote("bulk-deferred"); return; }
      restore(value);
    };
    window.addEventListener("popstate", pop);
    return () => { window.removeEventListener("popstate", pop); readyRef.current = false; };
    // Entry restoration is mount/pop driven; the refs carry current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!blocked && pendingPop.current) { const value = pendingPop.current; pendingPop.current = null; setNote(""); restore(value); }
  }, [blocked]);
  useLayoutEffect(() => {
    if (!ready) return;
    const value = restoring.current;
    if (!value) { write(capture()); return; }
    const frame = requestAnimationFrame(() => {
      const el = scroller();
      if (!el) return;
      const row = value.anchor ? root.current?.querySelector<HTMLElement>(`[data-history-thread="${CSS.escape(value.anchor.threadId)}"]`) : null;
      if (row && value.anchor) {
        const top = el === document.scrollingElement ? 0 : el.getBoundingClientRect().top;
        el.scrollTop += row.getBoundingClientRect().top - top - value.anchor.offset;
      } else el.scrollTop = value.scrollTop ?? 0;
      if (row || !value.anchor) restoring.current = null;
      write(value);
    });
    return () => cancelAnimationFrame(frame);
    // Reattempt a missing anchor when the actual thread index changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, ready, rows]);
  useEffect(() => {
    let frame = 0;
    const scroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; savePosition(); }); };
    const takeOver = () => { restoring.current = null; };
    const key = (event: KeyboardEvent) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) takeOver(); };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("wheel", takeOver, { passive: true });
    window.addEventListener("keydown", key);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", scroll, true); window.removeEventListener("wheel", takeOver); window.removeEventListener("keydown", key); };
    // The listener intentionally reads the current location through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<HistoryLocation>) => {
    if (isBlocked.current) return;
    const grow = Object.keys(patch).length === 1 && typeof patch.visible === "number" && patch.visible > latest.current.visible;
    const value = grow ? { ...capture(), ...patch } : { ...latest.current, ...patch, anchor: undefined, scrollTop: 0 };
    restore(value);
  };
  const apply = (view: HistoryViewConfig) => {
    if (isBlocked.current) return;
    savePosition();
    const value: HistoryLocation = { viewId: view.id, filter: view.filter, projectId: view.projectId, dateRange: view.dateRange, query: view.query, visible: view.visible, scrollTop: 0 };
    write(value, "pushState"); restore(value); setNote("");
  };
  return { location, note, update, apply, savePosition };
}
