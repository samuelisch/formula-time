import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// @formula-time/domain's package.json `exports` point at dist/, so tests
// would otherwise need `tsc -b` before every run. Vitest resolves the
// package from source instead; a domain change is visible to a test
// immediately, and a stale or missing dist can never mask a test result.
// This alias is vitest-only: `pnpm build` and the app builds still resolve
// the package through its `exports`, i.e. from dist. apps/web/vite.config.ts
// carries the matching alias, gated on VITEST, for the builds that a test
// starts itself.
const domainSrc = fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url));

// Unit tests: every *.test.ts across the workspace, in-memory fakes only.
// Split into three projects: apps/web needs a jsdom environment and React
// Testing Library's setup file; everything else runs in plain node. A
// `*.node.test.ts` file under apps/web is the one deliberate exception --
// it runs the real tesseract.js against fixture images, and that library's
// browser-vs-Node detection misfires under jsdom's `window`/`document`
// globals, so it needs the plain node environment despite living in
// apps/web.
export default defineConfig({
  resolve: {
    alias: {
      "@formula-time/domain": domainSrc,
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**", "apps/web/**"],
        },
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**", "apps/web/src/**/*.node.test.ts"],
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
      {
        test: {
          name: "web-node",
          include: ["apps/web/src/**/*.node.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
    ],
  },
});
