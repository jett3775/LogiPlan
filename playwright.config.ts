import { defineConfig, devices } from "@playwright/test";
import { loadEnvFile } from "node:process";

const hasExplicitDatabaseUrl = Boolean(process.env.DATABASE_URL);
const isCi = Boolean(process.env.CI);

if (!isCi && !hasExplicitDatabaseUrl) {
  try {
    loadEnvFile(".env");
  } catch {
    // Local non-isolated E2E may run without a root .env file.
  }
}

export default defineConfig({
  testDir: "./apps/web/tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: {
      mode: "retain-on-failure",
      snapshots: false,
      sources: false,
    },
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "chromium-1280",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "firefox-smoke",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4173`,
    cwd: "apps/web",
    env: process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {},
    url: "http://127.0.0.1:4173/api/health/live",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
