# @formula-time/db

The Prisma 7 schema, migrations, and the generated client every service
imports. Five tables, one writer each (`prisma/schema.prisma`):

| Table | Owner | Purpose |
|---|---|---|
| `sessions` | ingest | the season calendar: one row per race session, its status, lap total, and naming fields |
| `events` | ingest | the append-only log: one row per OpenF1 payload, keyed by a content-hash `event_id`, ordered by `seq` |
| `polls` | api | the two polls (winner, podium) opened for a session, their options and lock lap |
| `votes` | api | one row per `(poll_id, viewer_id)`, upserted, never duplicated |
| `exports` | api | one row per exported session: where its immutable file lives and when it was written |

## The `events` indexes

`events` carries two composite indexes, both leading on `session_key`:

- `(session_key, seq)` serves the api's projector: `WHERE session_key = ?
  AND seq > cursor ORDER BY seq` (`apps/api/src/projector/event-source.ts`),
  read every 250 ms.
- `(session_key, source_time)` narrows the api's exporter to one session's
  rows before its staleness check (`WHERE session_key = ? AND received_at >
  exported_at`) — the check itself is on `received_at`, not `source_time`,
  so this index only carries the scan to the right session; it does not
  cover `received_at` (`apps/api/src/export/exporter.ts`).

## Key rule

Every primary and foreign key here is a Postgres `bigint` (`session_key`,
`seq`). `BigInt` does not survive `JSON.stringify`, so every service that
puts one on the wire converts it to a string first — never a number
(`apps/api/src/projector/projector.ts`, `apps/api/src/export/exporter.ts`).

## Running a migration

Locally: `pnpm db:up` starts the worktree's own Postgres (a per-worktree
compose project and port, so concurrent worktrees never share a database —
see the root README's "Local ports"), then `pnpm db:migrate:dev` applies
pending migrations and regenerates the client.

On deploy: the api service's `preDeploy` command is `pnpm
db:migrate:deploy` (`.railway/railway.ts`) — it runs once, before the new
build starts serving, against `DATABASE_DIRECT_URL`.

## Connection pools (ADR-0005)

Two separate pool rules, not interchangeable:

- The runtime client (`createDb()`) connects on `DATABASE_URL` through
  `@prisma/adapter-pg`. Ingest's writer passes `{ max: 1 }`
  (`apps/ingest/src/main.ts`) so its connection is the only one that
  inserts into `events` — `seq` order then equals commit order, which the
  api's late-commit detector depends on (`apps/api/src/projector/projector.ts`).
- `DATABASE_DIRECT_URL` is read only by `prisma.config.ts`, and only
  Prisma Migrate consumes it — never the runtime client, and never for
  ordinary reads or writes.

See `../../docs/architecture.md` for how the three services fit together
and `../../docs/glossary.md` for the vocabulary.
