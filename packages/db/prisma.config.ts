import { defineConfig } from "prisma/config";

// Prisma 7 removed `url`/`directUrl` from `schema.prisma`; connection strings
// for the CLI live here instead (ADR-0004's two-URL split is unchanged, only
// its declaration site moved).
//
// This `datasource.url` is read by Prisma Migrate / introspection ONLY. It is
// `DATABASE_DIRECT_URL`: the direct, non-pooled connection, because migrations
// take a session-level advisory lock and run DDL, which a transaction-mode
// pooler does not support.
//
// The runtime client never reads this file. It takes the pooled
// `DATABASE_URL` through the driver adapter in `src/index.ts`.
//
// No `.env` is committed and none is loaded here: config comes from the
// environment only. Locally, export `DATABASE_DIRECT_URL` before running
// `pnpm db:migrate:dev`.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_DIRECT_URL"] ?? process.env["DATABASE_URL"] ?? "",
  },
});
