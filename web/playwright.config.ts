import { defineConfig, devices } from "@playwright/test";

const BASE_URL =
  process.env.WEB_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:3000";
const SERIAL_MODE = process.env.PW_SERIAL === "1";
const EXECUTABLE_PATH = process.env.PW_EXECUTABLE_PATH;
// PW_NO_PROXY=1 launches Chrome with --no-proxy-server for machines whose
// system proxy intercepts localhost and stalls page.goto on the audit server.
const LAUNCH_ARGS = process.env.PW_NO_PROXY === "1" ? ["--no-proxy-server"] : undefined;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: !SERIAL_MODE,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: SERIAL_MODE ? 1 : undefined,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    launchOptions: {
      executablePath: EXECUTABLE_PATH,
      args: LAUNCH_ARGS,
    },
  },
  webServer: process.env.KNORVIA_UI_FIXTURE_WORKSPACE ? undefined : {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "ui-audit",
      testMatch: "**/*.audit.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "release-smoke",
      testMatch: "**/video-studio.audit.ts",
      grep: /complete workbench|no-model state|director desk/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
