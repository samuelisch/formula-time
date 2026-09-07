import { defineConfig } from "vitest/config";

// Unit tests: every *.test.ts across the workspace, in-memory fakes only.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
  },
});
