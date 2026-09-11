import { defineConfig, devices } from "@playwright/test";

// WEB_PORT comes from scripts/db-env.sh, exported by this package's own
// test:e2e script before Playwright starts, so this config and the
// scripts/e2e-stack.sh child it spawns always agree on the port -- two
// worktrees' e2e runs never fight over 5173. API_PORT is not read here:
// Playwright only ever talks to the web dev server, which proxies to the
// api itself (vite.config.ts); it never calls the api directly.
const webPort = process.env.WEB_PORT ?? "5173";
const webBaseUrl = `http://localhost:${webPort}`;

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
    baseURL: webBaseUrl,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "../../scripts/e2e-stack.sh start",
    url: webBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 5 * 60 * 1000,
  },
});
