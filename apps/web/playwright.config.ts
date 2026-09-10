import { defineConfig, devices } from "@playwright/test";

// e2e config (ADR-0002: Playwright, chromium only). `webServer` runs
// scripts/e2e-stack.sh, which brings up the whole rehearse-race stack
// (compose Postgres, the drip simulator, ingest, the api, the web dev
// server) and blocks until the api and web are both answering -- so by the
// time Playwright's own `url` check succeeds, every part is already live.
// `webServer.cwd` is unset, so Playwright spawns it from this file's own
// directory (apps/web), which is why the command's path climbs two levels
// back to the repo root.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "../../scripts/e2e-stack.sh start",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 5 * 60 * 1000,
  },
});
