import { defineConfig } from "vitest/config";

// Unit tests: every *.test.ts across the workspace, in-memory fakes only.
// Split into three projects: apps/web needs a jsdom environment and React
// Testing Library's setup file; everything else runs in plain node. A
// `*.node.test.ts` file under apps/web is the one deliberate exception --
// it runs the real tesseract.js against fixture images, and that library's
// browser-vs-Node detection misfires under jsdom's `window`/`document`
// globals, so it needs the plain node environment despite living in
// apps/web.
export default defineConfig({
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
