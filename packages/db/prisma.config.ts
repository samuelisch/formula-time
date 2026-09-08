import { defineConfig } from "prisma/config";

// Prisma 7 removed `url`/`directUrl` from `schema.prisma`; the connection
// string for the CLI lives here instead (ADR-0005 amends ADR-0004's mechanism;
// the two-connection decision itself is unchanged).
//
// This `datasource.url` is read by Prisma Migrate / introspection ONLY, and it
// is `DATABASE_DIRECT_URL`: the direct, non-pooled connection. Migrations take
// a session-level advisory lock and run DDL, neither of which a
// transaction-mode pooler supports.
//
// It is required, with NO fallback to the pooled `DATABASE_URL`. Falling back
// would run `migrate deploy` through the pooler and fail part-way through the
// DDL; failing here instead names the missing secret.
//
// The runtime client never reads this file. It takes the pooled `DATABASE_URL`
// through the driver adapter in `src/index.ts`.
//
// No `.env` is committed and none is loaded here: config comes from the
// environment only.

/**
 * Read as a getter, not a constant, so the requirement binds only the commands
 * that actually connect. The CLI loads this file for every command, `prisma
 * generate` included — and generate runs in `pnpm build` and `pnpm typecheck`,
 * which must work on a machine with no database and no secrets. A top-level
 * throw would break both. This throws when Migrate reaches for the URL, which
 * is exactly when the secret is genuinely needed.
 */
function requireDirectUrl(): string {
  const directUrl = process.env["DATABASE_DIRECT_URL"];
  if (!directUrl) {
    throw new Error(
      "DATABASE_DIRECT_URL is required for Prisma Migrate (ADR-0004: direct, non-pooled)",
    );
  }
  return directUrl;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    get url(): string {
      return requireDirectUrl();
    },
  },
});
