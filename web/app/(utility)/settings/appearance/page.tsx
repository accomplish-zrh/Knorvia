"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppShell } from "@/context/AppShellContext";
import { persistUiSettingsPatch } from "@/components/settings/SettingsContext";
import {
  BUILTIN_WALLPAPERS,
  clearWallpaper,
  chooseBuiltinWallpaper,
  importCustomWallpaper,
  loadDesktopWallpaper,
  saveWallpaper,
  type WallpaperState,
} from "@/lib/wallpaper";

import type { CodeBlockThemeId } from "@/components/common/code-block-themes";
import { CODE_BLOCK_THEME_OPTIONS } from "@/components/common/code-block-themes";
import { Toggle } from "@/components/settings/Toggle";
import { useSettings } from "@/components/settings/SettingsContext";
import { ThemePreviewCard } from "@/components/settings/ThemePreviewCard";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
  selectClass,
  selectOptionClass,
} from "@/components/settings/shared";

const CODE_BLOCK_PREVIEW_SNIPPET = `def fibonacci(n):
    """Generate the first n Fibonacci numbers."""
    a, b = 0, 1
    result = []
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result


# Build a deliberately long summary so the wrapping preference is easy to see
summary = f"First twenty Fibonacci values rendered with the selected syntax theme, line-number setting, and wrapping preference: {', '.join(str(value) for value in fibonacci(20))}"
print(summary)
`;

const RichCodeBlockPreview = dynamic(
  () => import("@/components/common/RichCodeBlock"),
  { ssr: false },
);

export default function AppearanceSettingsPage() {
  const { t } = useTranslation();
  const {
    theme,
    language,
    responseLanguage,
    codeBlockTheme,
    codeBlockShowLineNumbers,
    codeBlockWrapLongLines,
    updateTheme,
    updateLanguage,
    updateResponseLanguage,
    updateCodeBlockTheme,
    updateCodeBlockShowLineNumbers,
    updateCodeBlockWrapLongLines,
  } = useSettings();

  // All code-block values come straight from the settings context (backed by
  // AppShellContext, the single source of truth), so the toggles reflect the
  // current preference without any local mirror state.
  const handleShowLineNumbersChange = (next: boolean) => {
    void updateCodeBlockShowLineNumbers(next);
  };

  const handleWrapLongLinesChange = (next: boolean) => {
    void updateCodeBlockWrapLongLines(next);
  };

  const { windowFrost, setWindowFrost } = useAppShell();
  const frostPersistTimer = useRef<number>(0);
  const wallpaperPersistTimer = useRef<number>(0);
  const [wallpaper, setWallpaper] = useState<WallpaperState>({
    id: "none",
    src: null,
    fit: "cover",
    dim: 32,
  });
  useEffect(() => {
    void loadDesktopWallpaper().then(setWallpaper);
  }, []);
  const persistWallpaper = (next: WallpaperState) => {
    setWallpaper(next);
    window.clearTimeout(wallpaperPersistTimer.current);
    wallpaperPersistTimer.current = window.setTimeout(() => {
      void persistUiSettingsPatch({
        wallpaper_enabled: next.id !== "none",
        wallpaper_source: next.id === "none" ? "none" : next.id,
        wallpaper_fit: next.fit,
        wallpaper_dim: next.dim,
      });
    }, 280);
  };
  const patchWallpaper = (partial: Partial<WallpaperState>) => {
    persistWallpaper(saveWallpaper({ ...wallpaper, ...partial }));
  };
  const persistFrost = (next: Partial<typeof windowFrost>) => {
    const applied = setWindowFrost(next);
    window.clearTimeout(frostPersistTimer.current);
    frostPersistTimer.current = window.setTimeout(() => {
      void persistUiSettingsPatch({
        window_frost: applied.enabled,
        frost_clarity: applied.clarity,
        frost_plates: applied.plates,
      });
    }, 280);
  };

  return (
    <div data-tour="tour-appearance">
      <SettingsPageHeader
        title={t("Appearance")}
        description={t(
          "Tune the visual theme and interface language. Changes apply immediately and are stored in your account.",
        )}
      />

      <SettingSection
        title={t("Language")}
        description={t("Choose the interface language.")}
      >
        <SettingRow
          title={t("Interface language")}
          description={t(
            "Controls navigation, settings, and status text only.",
          )}
          control={
            <div className="flex gap-0.5 rounded-lg bg-[var(--muted)] p-0.5">
              {(["en", "zh"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => updateLanguage(v)}
                  className={`rounded-md px-2.5 py-1 text-[12px] transition-all ${
                    language === v
                      ? "bg-[var(--card)] font-medium text-[var(--foreground)] shadow-sm"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {v === "en" ? t("language.english") : t("language.chinese")}
                </button>
              ))}
            </div>
          }
        />
        <SettingRow
          title={t("Model output language")}
          description={t(
            "Sets the default language for chat and capability responses.",
          )}
          control={
            <div className="flex gap-0.5 rounded-lg bg-[var(--muted)] p-0.5">
              {(["en", "zh"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => updateResponseLanguage(value)}
                  className={`rounded-md px-2.5 py-1 text-[12px] transition-all ${
                    responseLanguage === value
                      ? "bg-[var(--card)] font-medium text-[var(--foreground)] shadow-sm"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {value === "en"
                    ? t("language.english")
                    : t("language.chinese")}
                </button>
              ))}
            </div>
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Theme")}
        description={t(
          "Pick the colour palette and interface style. Each tile previews the theme it applies.",
        )}
      >
        <div className="py-4">
          {/* Order is intentional: Default → Cream → Dark → Glass palette.
              Window frost is a separate control below. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                { id: "snow", label: t("Default") },
                { id: "light", label: t("Cream") },
                { id: "dark", label: t("Dark") },
                { id: "glass", label: t("Glass") },
              ] as const
            ).map(({ id, label }) => (
              <ThemePreviewCard
                key={id}
                theme={id}
                label={label}
                selected={theme === id}
                onSelect={updateTheme}
              />
            ))}
          </div>
          <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--muted-foreground)]/80">
            {t(
              "Default is a clean pure-white theme with a blue accent. Cream is warm and paper-like with a terracotta accent. Dark keeps Cream's warmth on near-black. Glass is a cool mist palette. Frosted glass is a separate control below.",
            )}
          </p>
        </div>
      </SettingSection>


      <SettingSection
        title={t("Wallpaper")}
        description="一张铺满窗口的照片，叠在现有毛玻璃下面。可随时清除，回到原来的样子。"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 py-4">
          {BUILTIN_WALLPAPERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                void chooseBuiltinWallpaper(item.id).then(persistWallpaper);
              }}
              className={`overflow-hidden rounded-lg border text-left transition ${
                wallpaper.id === item.id
                  ? "border-[var(--foreground)] ring-1 ring-[var(--foreground)]"
                  : "border-[var(--border)] hover:border-[var(--foreground)]/40"
              }`}
            >
              <span
                className="block aspect-video w-full bg-cover bg-center"
                style={{ backgroundImage: `url(${item.src})` }}
              />
              <span className="block px-2 py-1.5 text-[11px] text-[var(--muted-foreground)]">
                {t(item.title)}
              </span>
            </button>
          ))}
        </div>
        <SettingRow
          title={t("Custom image")}
          description="上传 png、jpg 或 webp。文件保存在本机，不会写入仓库。"
          control={
            <button
              type="button"
              onClick={() => {
                void importCustomWallpaper().then(persistWallpaper);
              }}
              className="rounded-md bg-[var(--muted)] px-2.5 py-1 text-[12px] font-medium text-[var(--foreground)] hover:bg-[var(--accent)]"
            >
              {t("Choose image")}
            </button>
          }
        />
        <SettingRow
          title={t("Clear wallpaper")}
          description="去掉照片，恢复原来的窗口外观。毛玻璃开关不受影响。"
          control={
            <button
              type="button"
              onClick={() => {
                void clearWallpaper().then(persistWallpaper);
              }}
              className="rounded-md bg-[var(--muted)] px-2.5 py-1 text-[12px] font-medium text-[var(--foreground)] hover:bg-[var(--accent)]"
            >
              {t("Clear")}
            </button>
          }
        />
        <SettingRow
          title={t("Fit")}
          description={t("How the photo fills the window.")}
          control={
            <div className="flex gap-0.5 rounded-lg bg-[var(--muted)] p-0.5">
              {(["cover", "contain"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={wallpaper.id === "none"}
                  onClick={() => patchWallpaper({ fit: value })}
                  className={`rounded-md px-2.5 py-1 text-[12px] transition-all disabled:opacity-40 ${
                    wallpaper.fit === value
                      ? "bg-[var(--card)] font-medium text-[var(--foreground)] shadow-sm"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {value === "cover" ? t("Cover") : t("Contain")}
                </button>
              ))}
            </div>
          }
        />
        <SettingRow
          title={t("Dim")}
          description={t(
            "Darken the photo so panels and text stay readable.",
          )}
          control={
            <label className="flex w-[176px] items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={wallpaper.dim}
                disabled={wallpaper.id === "none"}
                aria-label={t("Dim")}
                onChange={(event) =>
                  patchWallpaper({ dim: Number(event.target.value) })
                }
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--foreground)] disabled:opacity-40"
              />
              <span className="w-8 text-right text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {wallpaper.dim}
              </span>
            </label>
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Window frost")}
        description={t(
          "Use a live frosted backdrop with any colour theme. On the desktop app this shows whatever is behind the window, including other apps.",
        )}
      >
        <SettingRow
          title={t("Frosted glass")}
          description={t(
            "Turns on the system acrylic (or vibrancy) behind the current theme.",
          )}
          control={
            <Toggle
              checked={windowFrost.enabled}
              onChange={(next) => persistFrost({ enabled: next })}
            />
          }
        />
        <SettingRow
          title={t("See-through")}
          description={t(
            "How much of the desktop and other apps show through the canvas. Higher is more transparent.",
          )}
          control={
            <label className="flex w-[176px] items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={windowFrost.clarity}
                disabled={!windowFrost.enabled}
                aria-label={t("See-through")}
                onChange={(event) =>
                  persistFrost({ clarity: Number(event.target.value) })
                }
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--foreground)] disabled:opacity-40"
              />
              <span className="w-8 text-right text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {windowFrost.clarity}
              </span>
            </label>
          }
        />
        <SettingRow
          title={t("Panels")}
          description={t(
            "How solid cards, dialogs, and the composer stay so text keeps contrast.",
          )}
          control={
            <label className="flex w-[176px] items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={windowFrost.plates}
                disabled={!windowFrost.enabled}
                aria-label={t("Panels")}
                onChange={(event) =>
                  persistFrost({ plates: Number(event.target.value) })
                }
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--foreground)] disabled:opacity-40"
              />
              <span className="w-8 text-right text-[11px] tabular-nums text-[var(--muted-foreground)]">
                {windowFrost.plates}
              </span>
            </label>
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Code blocks")}
        description={t(
          "Choose how code snippets look across the app. Changes apply immediately to saved and streamed responses.",
        )}
      >
        <div className="border-t border-[var(--border)]/50 px-1 py-4 first:border-t-0">
          <div className="text-[13.5px] font-medium text-[var(--foreground)]">
            {t("Preview")}
          </div>
          <p className="mb-3 mt-1 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
            {t("Updates live as you change the settings below.")}
          </p>
          <RichCodeBlockPreview
            raw={CODE_BLOCK_PREVIEW_SNIPPET}
            lang="python"
          />
        </div>

        <SettingRow
          title={t("Syntax theme")}
          description={t(
            "Select the Prism theme used for highlighted code blocks.",
          )}
          control={
            <select
              value={codeBlockTheme}
              onChange={(event) =>
                void updateCodeBlockTheme(
                  event.target.value as CodeBlockThemeId,
                )
              }
              className={`${selectClass} min-w-[220px] pr-8`}
            >
              {CODE_BLOCK_THEME_OPTIONS.map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  className={selectOptionClass}
                >
                  {option.label}
                </option>
              ))}
            </select>
          }
        />

        <SettingRow
          title={t("Show line numbers")}
          description={t(
            "Display a gutter with line numbers beside each code block.",
          )}
          control={
            <Toggle
              checked={codeBlockShowLineNumbers}
              onChange={handleShowLineNumbersChange}
            />
          }
        />

        <SettingRow
          title={t("Wrap long lines")}
          description={t(
            "Wrap long code lines instead of forcing horizontal scrolling.",
          )}
          control={
            <Toggle
              checked={codeBlockWrapLongLines}
              onChange={handleWrapLongLinesChange}
            />
          }
        />
      </SettingSection>
    </div>
  );
}
