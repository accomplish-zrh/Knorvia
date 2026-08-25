/**
 * Theme persistence utilities
 * Handles light/dark theme with localStorage fallback and system preference detection
 */

export type Theme =
  | "light"
  | "dark"
  | "glass"
  | "snow"
  | "ocean-glass"
  | "aurora-glass"
  | "rose-glass";

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
    if (
      stored === "light" ||
      stored === "dark" ||
      stored === "glass" ||
      stored === "snow" ||
      stored === "ocean-glass" ||
      stored === "aurora-glass" ||
      stored === "rose-glass"
    ) {
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

  html.classList.remove(
    "dark",
    "theme-glass",
    "theme-snow",
    "theme-ocean-glass",
    "theme-aurora-glass",
    "theme-rose-glass",
  );

  if (theme === "dark") {
    html.classList.add("dark");
  } else if (theme === "glass") {
    html.classList.add("dark", "theme-glass");
  } else if (theme === "ocean-glass") {
    html.classList.add("dark", "theme-ocean-glass");
  } else if (theme === "aurora-glass") {
    html.classList.add("dark", "theme-aurora-glass");
  } else if (theme === "rose-glass") {
    html.classList.add("dark", "theme-rose-glass");
  } else if (theme === "snow") {
    html.classList.add("theme-snow");
  }

  // Native translucency (desktop shell): glass themes ask the main process
  // for the acrylic backdrop; everything else restores the opaque backing.
  import("@/lib/native-glass")
    .then(({ applyNativeGlassForTheme }) => applyNativeGlassForTheme(theme))
    .catch(() => {});
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
  applyThemeToDocument(theme);
  saveThemeToStorage(theme);
  notifyThemeChange(theme);
}
