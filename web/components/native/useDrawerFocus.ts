"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Keep keyboard navigation inside a modal drawer and restore its trigger. */
export function useDrawerFocus(open: boolean, drawer: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement;
    const focusable = () => Array.from(drawer.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
    (drawer.current?.querySelector<HTMLInputElement>("input") ?? focusable()[0])?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open], .nw-sidebar-menu")) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") {
        const items = focusable();
        if (event.shiftKey && (document.activeElement === items[0] || !drawer.current?.contains(document.activeElement))) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("keydown", keyboard); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open, drawer]);
}
