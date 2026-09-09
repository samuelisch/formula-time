import { defineConfig } from "vitest/config";

// Integration tests: *.integration.test.ts, run against the real Postgres
// from docker-compose (DATABASE_URL). Dedup and vote upsert live here.
//
// `pnpm test:integration` runs this through scripts/with-db-env.sh, which
// already sets DATABASE_URL/DATABASE_DIRECT_URL from this worktree's DB_PORT
// (scripts/db-env.sh). The DB_PORT fallback below only matters when this
// config is invoked directly (bypassing the wrapper) with DB_PORT set but not
// DATABASE_URL — e.g. an editor's test runner.
const dbPort = process.env.DB_PORT ?? "5433";
const defaultDatabaseUrl = `postgres://formula:formula@localhost:${dbPort}/formula_time`;

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.integration.test.ts", "apps/*/src/**/*.integration.test.ts"],
    fileParallelism: false,
    env: {
      // Pooled connection, used by the client under test (ADR-0004).
      DATABASE_URL: process.env.DATABASE_URL ?? defaultDatabaseUrl,
      // Direct connection, used by Prisma Migrate only. Locally the
      // docker-compose Postgres is both.
      DATABASE_DIRECT_URL: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? defaultDatabaseUrl,
    },
  },
});
