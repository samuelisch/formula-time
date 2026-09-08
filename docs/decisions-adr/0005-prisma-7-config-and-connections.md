# ADR-0005 — Prisma 7 connection configuration; amends ADR-0004

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-08
- **Owner:** Samuel Chan
- **Amends:** ADR-0004. The two-connection decision stands; the mechanism named there does not exist in the installed Prisma.

## Context

ADR-0004 said `DATABASE_DIRECT_URL` is "wired to `datasource.directUrl`" and that the ingest writer sets `connection_limit=1` on its URL. Prisma 7.10 removed `url` and `directUrl` from schema files: connection URLs for Migrate live in `prisma.config.ts`, and the runtime client takes a driver adapter (`@prisma/adapter-pg`, which bundles `pg`). Under the `pg` driver, Prisma-URL parameters such as `connection_limit` and `pgbouncer` are inert.

## Decision

- `packages/db/prisma.config.ts` reads `DATABASE_DIRECT_URL` and nothing else; it is required, and Migrate is its only consumer. A missing value fails at load, never falls back to the pooled URL.
- `createDb(url?, pool?)` builds the runtime client on `@prisma/adapter-pg` from `DATABASE_URL` (pooled). Pool size is a `pool.max` option, not a URL parameter.
- The ingest writer's single connection (seq order equals commit order) is `createDb(url, { max: 1 })`. `connection_limit=1` in a URL does nothing and must not be relied on.
- `pgbouncer=true` is not needed under the `pg` driver (unnamed prepared statements are pooler-safe) and is not set.
- The generated client is emitted to `packages/db/src/generated/`, gitignored; root `build` and `typecheck` run `db:generate` first.

## Consequences

- Per-package builds (`pnpm --filter <app> build`) on a fresh clone need `pnpm db:generate` first; use the root scripts.
- The deploy step that runs `prisma migrate deploy` needs the `prisma` CLI installed (a devDependency) and `DATABASE_DIRECT_URL` in the secret store. Deploy track.
- Owner track T3 uses `{ max: 1 }`; ADR-0004's `connection_limit=1` sentence is superseded.
