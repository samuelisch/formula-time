# ADR-0003 — Package names: `packages/domain` and `apps/api`

- **Status:** Accepted
- **Date:** 2026-09-08
- **Owner:** Samuel Chan
- **Amends:** ADR-0002 (repository layout). ADR-0002 stays accepted; only
  the two names below change.

## Context

ADR-0002 named the workspace `apps/{ingest,app,web}` and `packages/shared`.
Two of those names describe the wrong thing. `shared` says who imports the
package, not what it holds, which is how such a package becomes a junk
drawer. `app` is ambiguous next to `apps/` and in conversation ("the app"
can mean the product, the process, or the folder).

## Decision

- `packages/shared` → `packages/domain` (`@formula-time/domain`). It holds
  the domain model: RaceState and event types, the reducer, wire schemas,
  poll rules. Browser-safe; imports no `node:*` module. Single-consumer code
  does not go here.
- `apps/app` → `apps/api` (`@formula-time/api`). Vocabulary: **`api` is the
  "app service" of ADR-0001** — projector, poll module, fan-out, route
  handler, exporter, one process. ADR-0001's text is unchanged; where it
  says "app service", the directory is `apps/api`.
- `apps/ingest`, `apps/web`, and the rest of ADR-0002 are unchanged.
- The Node-only database package decided alongside this (Prisma schema,
  migrations, generated client, shared by ingest and api) is a separate
  decision and gets its own ADR.

## Consequences

- Layout is now `apps/{ingest,api,web}`, `packages/domain`; a
  `packages/db` follows with its ADR.
- Root scripts: `dev:domain`, `dev:api`, `dev:ingest`, `dev:web`.
- References updated in `AGENTS.md`, the seam-reviewer agent, the HLD and
  PRD drafts, and issues #3–#5. ADR-0002 is not edited.
