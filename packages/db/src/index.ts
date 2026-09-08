// @formula-time/db — the Prisma schema, its migrations, and the generated
// client. Node-only (ADR-0004): `packages/domain` and `apps/web` never import
// this package.
//
// The package exposes the client and nothing else. Table ownership
// (ADR-0001 seam 3 — ingest writes `sessions` and `events`, api writes `polls`
// and `votes`) is a convention the services keep; it is not encoded here.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

// Every generated type: the four models, both enums, and the `Prisma`
// namespace (input types, `Prisma.JsonValue`, error classes).
export * from "./generated/prisma/client.js";

/**
 * Build a PrismaClient over the pooled connection.
 *
 * Prisma 7 has no Rust query engine and no `datasource.url` in the schema: the
 * connection is supplied at construction time through a driver adapter. That is
 * why this factory exists rather than a bare `new PrismaClient()`.
 *
 * @param url The pooled connection string (ADR-0004 `DATABASE_URL`). Defaults
 *   to `process.env.DATABASE_URL`. `DATABASE_DIRECT_URL` is for Prisma Migrate
 *   only and is never used at runtime.
 *
 * Callers own the lifecycle: one client per process, `$disconnect()` on
 * shutdown. The ingest writer passes a URL carrying its single-connection pool
 * setting so inserts commit in `seq` order.
 */
export function createDb(url?: string): PrismaClient {
  const connectionString = url ?? process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "createDb: no connection string. Pass one, or set DATABASE_URL in the environment.",
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
