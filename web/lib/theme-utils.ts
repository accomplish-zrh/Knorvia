/**
 * Theme utilities for common scenarios
 * Use these helper functions for theme-related logic in components
 */

import { setTheme, THEMES, isTheme, isDarkTheme, type Theme } from "./theme";

/**
 * Toggle theme between light and dark
 */
export function toggleTheme(currentTheme: Theme): Theme {
  const order = THEMES;
  const idx = order.indexOf(currentTheme);
  const newTheme = order[(idx + 1) % order.length];
  setTheme(newTheme);
  return newTheme;
}

/**
 * Set theme to light mode
 */
export function setLightTheme(): void {
  setTheme("light");
}

/**
 * Set theme to dark mode
 */
export function setDarkTheme(): void {
  setTheme("dark");
}

/**
 * Get CSS class for theme-aware styling
 */
export function getThemeClass(theme: Theme): string {
  if (isDarkTheme(theme)) return "dark";
  if (theme === "glass") return "theme-glass";
  if (theme === "snow") return "theme-snow";
  return "";
}

/**
 * Get contrast color for theme
 */
export function getTextColorForTheme(theme: Theme): string {
  return isDarkTheme(theme)
    ? "text-slate-100 dark:text-slate-100"
    : "text-slate-900 dark:text-slate-900";
}

/**
 * Get background color for theme
 */
export function getBackgroundForTheme(theme: Theme): string {
  return isDarkTheme(theme) ? "dark:bg-slate-800" : "bg-white";
}

/**
 * Watch theme changes via localStorage events
 */
export function onThemeChange(callback: (theme: Theme) => void): () => void {
  const handleStorageChange = (e: StorageEvent) => {
    if (
      e.key === "knorvia-theme" &&
      isTheme(e.newValue)
    ) {
      callback(e.newValue);
    }
  };

  window.addEventListener("storage", handleStorageChange);

  // Return cleanup function
  return () => {
    window.removeEventListener("storage", handleStorageChange);
  };
}
