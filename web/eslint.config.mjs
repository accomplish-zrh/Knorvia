import nextConfig from "eslint-config-next";
import i18nPlugin from "./eslint/i18n-plugin.mjs";

const config = [
  ...nextConfig,
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    plugins: {
      i18n: i18nPlugin,
    },
    rules: {
      // Migration complete: literal UI text is a hard error now.
      "i18n/no-literal-ui-text": "error",
    },
  },
  {
    // playwright-report/test-results are generated Playwright artifacts (the
    // HTML reporter ships a bundled uiMode*.js that trips rules-of-hooks).
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-knorvia/**",
      ".next-*/**",
      "dist/**",
      "out/**",
      "public/director-desk/**",
      // Director Desk is an independent Vite/React project with its own
      // TypeScript build and Vitest suite. Keep the Next.js lint boundary
      // deterministic instead of applying Next/React-19 rules to React 18.
      "director-desk-src/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
];

export default config;
