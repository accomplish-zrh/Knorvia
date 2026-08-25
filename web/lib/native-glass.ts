"use client";

/**
 * Native window translucency (Hermes-style glass) for the desktop shell.
 *
 * When the active theme is a glass variant AND the shell reports acrylic
 * support, the web app asks the main process to turn on the native
 * backdrop and marks <html data-knorvia-glass> so field surfaces go
 * translucent. Light themes force it off (opaque backing restored).
 */

import { useEffect } from "react";
import { isKnorviaDesktop } from "@/lib/desktop-shell";

type TranslucencyBridge = {
  translucencySupport?: () => { glass: boolean } | undefined;
  setTranslucency?: (state: { mode: "glass" | "clear"; intensity: number }) => void;
};

function bridge(): TranslucencyBridge | null {
  if (!isKnorviaDesktop()) return null;
  return (window as unknown as { knorviaDesktop: TranslucencyBridge }).knorviaDesktop ?? null;
}

export function desktopGlassSupported(): boolean {
  return bridge()?.translucencySupport?.()?.glass === true;
}

/**
 * Sync the native window material with the chosen theme.
 * Call from the theme provider whenever `theme` changes.
 */
export function applyNativeGlassForTheme(theme: string): void {
  const b = bridge();
  if (!b) return;
  const supported = b.translucencySupport?.()?.glass === true;
  const wantsGlass = supported && theme.endsWith("-glass");
  const root = document.documentElement;

  if (wantsGlass) {
    root.setAttribute("data-knorvia-glass", "");
    b.setTranslucency?.({ mode: "glass", intensity: 100 });
  } else {
    root.removeAttribute("data-knorvia-glass");
    // Only touch the native side when it may currently be on.
    if (supported) b.setTranslucency?.({ mode: "clear", intensity: 0 });
  }
}
