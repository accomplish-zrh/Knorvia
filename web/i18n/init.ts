import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

// The English locale is a key==value identity map: i18next renders any
// missing key verbatim, so the 248 KB en/app.json never needs to ship in the
// client bundle. Only the small non-identity overrides file is bundled here.
import enOverrides from "@/locales/en/app.overrides.json";

export type AppLanguage = "en" | "zh";

export function normalizeLanguage(lang: unknown): AppLanguage {
  if (!lang) return "en";
  const s = String(lang).toLowerCase();
  if (s === "zh" || s === "cn" || s === "chinese") return "zh";
  return "en";
}

let _initialized = false;

export function initI18n(language?: unknown) {
  if (_initialized) return i18n;

  const resources: Resource = {
    en: { app: enOverrides },
  };

  i18n.use(initReactI18next).init({
    resources,
    lng: normalizeLanguage(language),
    fallbackLng: "en",
    // Use a single default namespace to keep lookups simple.
    // We intentionally keep keySeparator disabled so keys like "Generating..." remain valid.
    defaultNS: "app",
    ns: ["app"],
    keySeparator: false,
    interpolation: {
      escapeValue: false,
    },
    returnEmptyString: false,
    returnNull: false,
    // Identity-locale trick: an en key with no resource entry renders the
    // key text itself (which IS the English copy).
    parseMissingKeyHandler: (key) => key,
  });

  _initialized = true;
  return i18n;
}

export async function ensureLanguage(language: AppLanguage) {
  if (i18n.hasResourceBundle(language, "app")) return;
  if (language === "zh") {
    const zhApp = (await import("@/locales/zh/app.json")).default;
    i18n.addResourceBundle("zh", "app", zhApp, true, true);
  }
}
