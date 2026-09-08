// @formula-time/db — the Prisma schema, its migrations, and the generated
// client. Node-only (ADR-0004): `packages/domain` and `apps/web` never import
// this package.
//
// The package exposes the client and nothing else. Table ownership
// (ADR-0001 seam 3 — ingest writes `sessions` and `events`, api writes `polls`
// and `votes`) is a convention the services keep; it is not encoded here.
// ADR-0009 amends this: `exports` is a fifth table, written only by the api.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

// Every generated type: the four models, both enums, and the `Prisma`
// namespace (input types, `Prisma.JsonValue`, error classes).
export * from "./generated/prisma/client.js";

/** Connection-pool settings for the underlying `pg` pool (ADR-0005). */
export type DbPoolOptions = {
  /**
   * Maximum connections in the pool.
   *
   * This is the ONLY way to bound the pool. A `connection_limit` parameter in
   * the connection string is inert: it is a Prisma-URL parameter, and under
   * the `pg` driver adapter the string is parsed by `pg-connection-string`,
   * which copies parameters it does not recognise onto the config object where
   * `pg.Pool` ignores them.
   */
  max?: number;
};

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
 * @param pool Pool settings. Pass `{ max: 1 }` for a single connection.
 *
 * The ingest writer needs exactly one connection so that inserts commit in
 * `seq` order and the projector's cursor cannot skip a late commit
 * (ADR-0005). That is `createDb(url, { max: 1 })` — not `connection_limit=1`
 * on the URL, which does nothing here.
 *
 * Callers own the lifecycle: one client per process, `$disconnect()` on
 * shutdown.
 */
export function createDb(url?: string, pool?: DbPoolOptions): PrismaClient {
  const connectionString = url ?? process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "createDb: no connection string. Pass one, or set DATABASE_URL in the environment.",
    );
  }
  // Built conditionally: `exactOptionalPropertyTypes` forbids handing an
  // explicit `undefined` to an optional property.
  const config =
    pool?.max === undefined ? { connectionString } : { connectionString, max: pool.max };
  return new PrismaClient({ adapter: new PrismaPg(config) });
}
