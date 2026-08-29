import type { Theme } from "@/lib/theme"

/** True when the UI is running inside the Knorvia desktop shell. */
export function isKnorviaDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.knorviaDesktop)
}

export function isWindowsDesktop(): boolean {
  return isKnorviaDesktop() && /Windows/i.test(navigator.userAgent)
}

export const DESKTOP_TITLEBAR_HEIGHT = 36
/** Restored-window radius. DWM's own curve is ~8px; CSS clips to this. */
export const WINDOW_CORNER_RADIUS = 16

export type TitleBarOverlayColors = {
  color: string
  symbolColor: string
}

/** Caption-button overlay colors that match the current theme canvas. */
export function titleBarOverlayForTheme(
  theme: Theme,
  frost = false,
): TitleBarOverlayColors {
  const solid = (() => {
    switch (theme) {
      case "dark":
        return { color: "#1a1918", symbolColor: "#e8e4de" }
      case "glass":
        return { color: "#eaf2f8", symbolColor: "#10151c" }
      case "light":
        return { color: "#fdfcf9", symbolColor: "#1c1816" }
      case "snow":
      default:
        return { color: "#ffffff", symbolColor: "#0d0d0d" }
    }
  })()
  if (!frost) return solid
  return { color: "#00000000", symbolColor: solid.symbolColor }
}

export type DesktopWindowMaterial = {
  material: "none" | "mica" | "acrylic" | "tabbed" | "auto"
  backgroundColor: string
  vibrancy: "under-window" | null
}

/** System backdrop. Frost is independent of the colour theme. */
export function windowMaterialForFrost(
  frost: boolean,
  theme: Theme,
  platform = typeof navigator === "undefined" ? "win32" : navigator.platform,
): DesktopWindowMaterial {
  if (frost) {
    if (/darwin|mac/i.test(platform)) {
      return { material: "none", backgroundColor: "#00000000", vibrancy: "under-window" }
    }
    if (/win/i.test(platform)) {
      return { material: "acrylic", backgroundColor: "#00000000", vibrancy: null }
    }
    return { material: "none", backgroundColor: "#fdfcf9", vibrancy: null }
  }
  const backgroundColor =
    theme === "dark" ? "#1a1918" : theme === "snow" ? "#ffffff" : theme === "glass" ? "#eaf2f8" : "#fdfcf9"
  return { material: "none", backgroundColor, vibrancy: null }
}

/** @deprecated use windowMaterialForFrost */
export function windowMaterialForTheme(
  theme: Theme,
  platform = typeof navigator === "undefined" ? "win32" : navigator.platform,
): DesktopWindowMaterial {
  return windowMaterialForFrost(false, theme, platform)
}

export function applyDesktopChromeAttribute(): string | null {
  if (!isKnorviaDesktop()) return null
  const platform = window.knorviaDesktop?.chrome?.platform ?? "unknown"
  document.documentElement.setAttribute("data-desktop-chrome", platform)
  return platform
}

export function syncDesktopTitleBarOverlay(theme: Theme, frost = false): void {
  const chrome = window.knorviaDesktop?.chrome
  if (!chrome?.captionOverlay || !chrome.setTitleBarOverlay) return
  chrome.setTitleBarOverlay(titleBarOverlayForTheme(theme, frost))
}

export function syncDesktopWindowMaterial(theme: Theme, frost = false): void {
  const chrome = window.knorviaDesktop?.chrome
  if (!chrome?.setWindowMaterial) return
  chrome.setWindowMaterial(windowMaterialForFrost(frost, theme, chrome.platform))
}

export function syncDesktopChrome(theme: Theme, frost = false): void {
  applyDesktopChromeAttribute()
  syncDesktopTitleBarOverlay(theme, frost)
  syncDesktopWindowMaterial(theme, frost)
}
