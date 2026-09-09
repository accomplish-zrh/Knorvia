"use strict";

/**
 * Desktop window geometry + optional system backdrop.
 *
 * A framed Win32 window keeps an opaque non-client caption. Hide that so
 * the renderer owns the surface to the top edge (titleBarOverlay / traffic
 * lights). Frost then paints a system backdrop (Windows acrylic, macOS
 * under-window vibrancy) so wallpaper and other apps show through.
 *
 * Windows 11 DWM only offers ~8px. Restored windows clip the HWND to
 * 16px with SetWindowRgn (see win32-corners.js). Do not use
 * `transparent: true` on Win32 — layered windows cannot unmaximize.
 * macOS already rounds natively.
 */

const TITLEBAR_HEIGHT = 36;
const WINDOW_CORNER_RADIUS = 16;
const PALETTES = require("./window-appearance").palettes;
const paletteFor = (theme, dark = false) => PALETTES[Object.hasOwn(PALETTES, theme) ? theme : dark ? "dark" : "snow"];

const OVERLAY = {
  light: { color: PALETTES.snow.colors.bg, symbolColor: PALETTES.snow.colors.ink },
  dark: { color: PALETTES.dark.colors.bg, symbolColor: PALETTES.dark.colors.ink },
  glass: { color: "#00000000", symbolColor: PALETTES.glass.colors.ink },
};

const MATERIALS = new Set(["none", "mica", "acrylic", "tabbed", "auto"]);

function overlayForColorScheme(dark) {
  const palette = dark ? OVERLAY.dark : OVERLAY.light;
  return { color: palette.color, symbolColor: palette.symbolColor, height: TITLEBAR_HEIGHT };
}

function overlayForTheme(theme, dark, frost = false) {
  const colors = paletteFor(theme, dark).colors;
  const overlay = { color: colors.bg, symbolColor: colors.ink, height: TITLEBAR_HEIGHT };
  if (frost) return { color: "#00000000", symbolColor: overlay.symbolColor, height: TITLEBAR_HEIGHT };
  return overlay;
}

function opaqueBackgroundForTheme(theme, dark) {
  return paletteFor(theme, dark).colors.bg;
}

function windowMaterialForFrost(frost, theme, platform) {
  if (frost) {
    if (platform === "win32") {
      return { material: "acrylic", backgroundColor: "#00000000", vibrancy: null };
    }
    if (platform === "darwin") {
      return { material: "none", backgroundColor: "#00000000", vibrancy: "under-window" };
    }
    return { material: "none", backgroundColor: opaqueBackgroundForTheme(theme, false), vibrancy: null };
  }
  return {
    material: "none",
    backgroundColor: opaqueBackgroundForTheme(theme, theme === "dark"),
    vibrancy: null,
  };
}

function windowMaterialForTheme(theme, platform, frost = false) {
  return windowMaterialForFrost(frost, theme, platform);
}

function browserWindowChrome(platform, { dark = false, glass = false, frost = false, theme = null } = {}) {
  const resolvedTheme = theme || (glass ? "glass" : (dark ? "dark" : "snow"));
  const useFrost = Boolean(frost || glass);
  const material = windowMaterialForFrost(useFrost, resolvedTheme, platform);
  if (platform === "darwin") {
    const chrome = {
      // Layered so Glass can be turned on at runtime (vibrancy needs it).
      transparent: true,
      backgroundColor: material.backgroundColor,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 12 },
      hasShadow: true,
    };
    if (useFrost) {
      chrome.vibrancy = "under-window";
      chrome.visualEffectState = "active";
    }
    return chrome;
  }
  if (platform === "win32") {
    const chrome = {
      // Not layered: maximize/restore stay native. 16px comes from
      // SetWindowRgn; acrylic still uses backgroundMaterial.
      backgroundColor: material.backgroundColor,
      titleBarStyle: "hidden",
      titleBarOverlay: overlayForTheme(resolvedTheme, dark, useFrost),
      hasShadow: true,
      roundedCorners: true,
      maximizable: true,
      backgroundMaterial: useFrost ? "acrylic" : "none",
    };
    return chrome;
  }
  return {
    backgroundColor: material.backgroundColor,
    frame: false,
    autoHideMenuBar: true,
  };
}

function sanitizeOverlay(payload) {
  if (!payload || typeof payload !== "object") return null;
  const overlay = {};
  if (typeof payload.color === "string" && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(payload.color)) {
    overlay.color = payload.color;
  }
  if (typeof payload.symbolColor === "string" && /^#([0-9a-fA-F]{6})$/.test(payload.symbolColor)) {
    overlay.symbolColor = payload.symbolColor;
  }
  return overlay.color || overlay.symbolColor ? overlay : null;
}

function sanitizeMaterial(value) {
  return typeof value === "string" && MATERIALS.has(value) ? value : null;
}

function sanitizeBackgroundColor(value) {
  if (typeof value !== "string") return null;
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value : null;
}

function sanitizeVibrancy(value) {
  return value === "under-window" ? "under-window" : null;
}

function applyWindowMaterial(win, platform, payload) {
  if (!win || win.isDestroyed?.()) return;
  const backgroundColor = sanitizeBackgroundColor(payload?.backgroundColor);
  const material = sanitizeMaterial(payload?.material) || "none";
  const vibrancy = sanitizeVibrancy(payload?.vibrancy);
  if (backgroundColor) {
    try { win.setBackgroundColor(backgroundColor); } catch { /* older Electron */ }
  }
  if (platform === "win32" && typeof win.setBackgroundMaterial === "function") {
    try { win.setBackgroundMaterial(material); } catch { /* Windows 10 / policy */ }
  }
  if (platform === "darwin" && typeof win.setVibrancy === "function") {
    try { win.setVibrancy(vibrancy); } catch { /* unsupported vibrancy */ }
  }
}

function fromMainWindow(event, mainWindow) {
  return Boolean(mainWindow && event?.sender === mainWindow.webContents);
}

module.exports = {
  TITLEBAR_HEIGHT,
  WINDOW_CORNER_RADIUS,
  OVERLAY,
  overlayForColorScheme,
  overlayForTheme,
  windowMaterialForFrost,
  windowMaterialForTheme,
  browserWindowChrome,
  sanitizeOverlay,
  sanitizeMaterial,
  sanitizeBackgroundColor,
  applyWindowMaterial,
  fromMainWindow,
};
