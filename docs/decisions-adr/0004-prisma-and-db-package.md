# ADR-0004 — Prisma as the database client, in a Node-only `packages/db`

- **Status:** Accepted
- **Date:** 2026-09-08
- **Owner:** Samuel Chan
- **Amends:** ADR-0002 (toolchain). Migrations stay numbered SQL files
  applied by the deploy pipeline (ADR-0001 seam contract 1); Prisma Migrate
  is what emits and applies them.

## Context

Two Node services share one Postgres. The stored model is four tables with
one writer each (HLD §4). The queries that matter are few: an insert that
ignores duplicates, a cursor read ordered by `seq`, a vote upsert on a
composite key, and one export read per finished race. Load is a handful of
statements per second; the invariants (DB touched per event and per join,
never per viewer per tick) keep it there.

The candidates were hand-written SQL over a driver (`postgres`/`pg`),
Drizzle, and Prisma. Hand-written SQL was the first pick for
transparency. The owner chose Prisma: the project is not query-heavy, does
not need Postgres-specific tricks, and the constraints that carry the
design live in the schema either way.

## Decision

- **Prisma** is the database client for `apps/ingest` and `apps/api`.
- Schema, migrations, and the generated client live in **`packages/db`**
  (`@formula-time/db`), a Node-only workspace package. `packages/domain` and
  `apps/web` never import it.
- The stored model is the four tables of HLD §4: `sessions`, `events`,
  `polls`, `votes`. Poll options are a Json column (polls are created from
  templates, options are fixed at creation; the option-exists check is in
  the api vote handler). `Session.status` and `Poll.status` are enums.
  `polls.locks_at_lap` is an integer: v1 polls are snapshot-resolvable at a
  lap, and the lock lap is computed from the poll template.
- The design-bearing statements map as follows and need no raw SQL:
  `createMany({ skipDuplicates: true })` for the event writer's
  `ON CONFLICT DO NOTHING`; `upsert` on `(poll_id, viewer_id)` for votes;
  `findMany` on `seq > cursor` ordered by `seq` for the projector.
- **Migrations**: `prisma migrate dev` in development; `prisma migrate
  deploy` in the deploy pipeline before the services start. Migration SQL
  is committed.
- **Connections**: the ingest writer runs with `connection_limit=1` on its
  `DATABASE_URL` so a single connection inserts in order (seq order equals
  commit order; the cursor cannot skip a late commit). Behind a
  transaction-mode pooler (managed Postgres default) the URL carries
  `pgbouncer=true`.
- Raw SQL remains available (`$queryRaw`) if a statement ever needs it;
  none does today.

## Consequences

- `prisma generate` is a build step for `packages/db`; the generated client
  is not committed.
- Integration tests (ADR-0002) run against the real Postgres in
  `docker-compose.yml` through the same client.
- The `db/migrations/` folder from the scaffold is removed; Prisma's
  `packages/db/prisma/migrations/` is the numbered-SQL home.
- Switching clients later is a one-package change; the schema constraints
  are the design and survive the swap.
