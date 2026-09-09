/**
 * Theme persistence utilities
 * Handles light/dark theme with localStorage fallback and system preference detection
 */

import palettes from "./appearance-palettes.json";

// The renderer, first paint, native caption and loading window share one palette.
export const THEME_PALETTES = palettes;
export type Theme = keyof typeof THEME_PALETTES;
export const THEMES = Object.keys(THEME_PALETTES) as Theme[];
export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && Object.hasOwn(THEME_PALETTES, value);
}
export function isDarkTheme(theme: Theme): boolean { return THEME_PALETTES[theme].dark; }

export const THEME_STORAGE_KEY = "knorvia-theme";

type ThemeChangeListener = (theme: Theme) => void;
const themeListeners = new Set<ThemeChangeListener>();

/**
 * Subscribe to theme changes
 */
export function subscribeToThemeChanges(
  listener: ThemeChangeListener,
): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

/**
 * Notify all listeners of theme change
 */
function notifyThemeChange(theme: Theme): void {
  themeListeners.forEach((listener) => listener(theme));
}

/**
 * Get the stored theme from localStorage
 */
export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) {
      return stored;
    }
  } catch (e) {
    // Silently fail - localStorage may be disabled
  }

  return null;
}

/**
 * Save theme to localStorage
 */
export function saveThemeToStorage(theme: Theme): boolean {
  if (typeof window === "undefined") return false;

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch (e) {
    // Silently fail - localStorage may be disabled or full
    return false;
  }
}

/**
 * Get system preference for theme.
 * Light systems get "snow" (the pure-white Default theme); dark systems
 * get "dark". Must stay in sync with the inline ThemeScript fallback.
 */
export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "snow";

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "snow";
}

/**
 * Apply theme to document
 */
export function applyThemeToDocument(theme: Theme): void {
  if (typeof document === "undefined") return;

  const html = document.documentElement;
  const palette = THEME_PALETTES[theme];
  html.dataset.theme = theme;
  html.style.colorScheme = palette.dark ? "dark" : "light";
  for (const [token, color] of Object.entries(palette.colors)) {
    html.style.setProperty(`--kn-theme-${token}`, color);
  }

  html.classList.remove("dark", "theme-glass", "theme-snow");

  if (palette.dark) {
    html.classList.add("dark");
  } else if (theme === "glass") {
    html.classList.add("theme-glass");
  } else if (theme === "snow") {
    html.classList.add("theme-snow");
  }
}

/**
 * Initialize theme on app startup
 * Priority: localStorage > system preference (snow on light systems, dark on dark)
 */
export function initializeTheme(): Theme {
  // Check localStorage first
  const stored = getStoredTheme();
  if (stored) {
    applyThemeToDocument(stored);
    return stored;
  }

  // Fall back to system preference
  const systemTheme = getSystemTheme();
  applyThemeToDocument(systemTheme);
  saveThemeToStorage(systemTheme);
  return systemTheme;
}

/**
 * Set theme and persist it
 */
export function setTheme(theme: Theme): void {
  // The old Glass theme implicitly enabled frost. Preserve that only during
  // migration; choosing a colour must never switch the window effect on/off.
  if (typeof window !== "undefined") {
    try {
      if (localStorage.getItem("knorvia-window-frost") === null) {
        localStorage.setItem("knorvia-window-frost", String(getStoredTheme() === "glass"));
      }
    } catch { /* storage is optional */ }
  }
  applyThemeToDocument(theme);
  saveThemeToStorage(theme);
  notifyThemeChange(theme);
}
