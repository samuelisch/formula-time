import { defineConfig } from "vitest/config";

// Integration tests: *.integration.test.ts, run against the real Postgres
// from docker-compose (DATABASE_URL). Dedup and vote upsert live here.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.integration.test.ts", "apps/*/src/**/*.integration.test.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://formula:formula@localhost:5432/formula_time",
    },
  },
});
