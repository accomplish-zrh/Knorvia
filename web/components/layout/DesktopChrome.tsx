"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isKnorviaDesktop,
  syncDesktopChrome,
} from "@/lib/desktop-shell";
import {
  getStoredTheme,
  getSystemTheme,
  subscribeToThemeChanges,
} from "@/lib/theme";
import {
  applyWindowFrostToDocument,
  readStoredWindowFrost,
  subscribeToWindowFrost,
} from "@/lib/window-frost";

/**
 * Desktop window chrome that lives outside any route shell.
 *
 * Marks the document as a frameless desktop surface, keeps the Windows
 * caption-button overlay in lockstep with the canvas color, and draws
 * min/max/close only on platforms that do not overlay native buttons.
 */
export default function DesktopChrome() {
  const { t } = useTranslation();
  // Desktop preload runs before any page JS, so the lazy initializer sees the
  // final chrome shape — no effect-body setState needed for the one-shot read.
  const [customCaption, setCustomCaption] = useState(() => {
    if (typeof window === "undefined") return false;
    const chrome = window.knorviaDesktop?.chrome;
    return Boolean(chrome && !chrome.captionOverlay && !chrome.trafficLights);
  });
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isKnorviaDesktop()) return;
    const applyChrome = () => {
      const theme = getStoredTheme() ?? getSystemTheme();
      const frost = readStoredWindowFrost();
      applyWindowFrostToDocument(frost);
      syncDesktopChrome(theme, frost.enabled);
    };
    applyChrome();
    const stopTheme = subscribeToThemeChanges(applyChrome);
    const stopFrost = subscribeToWindowFrost(applyChrome);
    const chrome = window.knorviaDesktop?.chrome;
    if (!chrome) {
      return () => {
        stopTheme();
        stopFrost();
      };
    }
    const syncMaximized = (value: boolean) => {
      setMaximized(value);
      document.documentElement.toggleAttribute("data-window-maximized", value);
    };
    void chrome.windowIsMaximized?.().then((value) => {
      if (typeof value === "boolean") syncMaximized(value);
    });
    const stopState = chrome.onWindowState?.((state) => {
      syncMaximized(Boolean(state?.maximized));
    });
    return () => {
      stopTheme();
      stopFrost();
      stopState?.();
    };
  }, []);

  if (!customCaption) return null;

  const chrome = window.knorviaDesktop?.chrome;
  const captionBtn =
    "flex h-full w-[46px] items-center justify-center text-[13px] leading-none text-[var(--foreground)] hover:bg-black/10 dark:hover:bg-white/10";

  return (
    <div
      data-desktop-window-controls=""
      className="desktop-no-drag fixed right-0 top-0 z-[210] flex h-[var(--desktop-titlebar-height,36px)]"
    >
      <button
        type="button"
        aria-label={t("Minimize")}
        className={captionBtn}
        onClick={() => chrome?.windowMinimize()}
      >
        –
      </button>
      <button
        type="button"
        aria-label={maximized ? t("Restore") : t("Maximize")}
        className={captionBtn}
        onClick={() => chrome?.windowMaximize()}
      >
        {maximized ? "❐" : "□"}
      </button>
      <button
        type="button"
        aria-label={t("Close")}
        className={`${captionBtn} hover:bg-[#e81123] hover:text-white`}
        onClick={() => chrome?.windowClose()}
      >
        ✕
      </button>
    </div>
  );
}
