import { defineConfig } from "vitest/config";

// Unit tests: every *.test.ts across the workspace, in-memory fakes only.
// Split into two projects because apps/web needs a jsdom environment and
// React Testing Library's setup file; everything else runs in plain node.
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
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
