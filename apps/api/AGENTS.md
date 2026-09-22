# apps/api — AGENTS.md

Issue label: `api` (this service, `packages/domain`, and root tooling:
`.railway`, `.github`, `scripts`, `docker-compose.yml`, `.claude`). An
agent working here picks `ready` issues with that label and nothing else
(`gh issue list --label ready --label api --search "sort:created-asc"`).

## Purpose

`api` is the app service of ADR-0001, named by ADR-0003: one process, one
deploy unit. It folds the served session's events into one state and
pushes it to every browser over one shared SSE stream, and it is the sole
writer of `polls`, `votes` and `exports`.

## Where the facts are

- Which session is served, the tick, poll rules, routes, exports, tables,
  configuration, and what the log lines mean: `apps/api/README.md`.
- The data model, the two `events` indexes, and the connection pools:
  `../../packages/db/README.md`.
- The whole system and the vocabulary every guide uses:
  `../../docs/architecture.md`, `../../docs/glossary.md`.

## The five invariants, as they bind here

1. One shared, serialize-once stream per live race — since ADR-0013, read
   as serialize once per wire format in use, never per viewer.
2. Postgres is touched per event and per join, never per viewer per tick.
3. Row identity is transport-independent; this service consumes that
   identity, it does not construct it (ingest does).
4. Never patch a late-arriving row into RaceState — rebuild from the fold.
5. Anything with stakes settles server-side: a vote is real only once its
   insert commits, never on the client's say-so.

## Rules that are not in the README

- This service is the sole writer of `polls`, `votes` and `exports`; it
  reads `sessions` and `events` and never writes either.
- A wire shape (`StatePush`, `DeltaPush`, the poll shapes, `RaceIndexEntry`,
  `RaceEventsPage`, `RaceFile`) is always built typed against its
  `packages/domain/src/wire.ts` or `polls.ts` export, never a local or
  untyped copy, so the web reading the same shape fails typecheck the
  moment the two disagree.
- The SSE route (`http/routes/live.ts`) is hand-written on the raw
  response; it must never sit behind compression middleware, which would
  gzip per viewer and defeat the fan-out's one-serialize-per-format design.
- `Fastify({ trustProxy })` is always the private address ranges
  (`http/trust-proxy.ts`'s `TRUST_PROXY`), never `true` — `true` would let
  a client forge its own resolved IP and dodge the vote route's per-IP
  rate limit.
- The viewer cookie's attributes come from one helper,
  `viewerCookieOptions()` (`polls/viewer-identity.ts`), so every place
  that sets or reads the cookie agrees.

## Conventions

- ESM everywhere: relative imports end in `.js` even from `.ts` (NodeNext).
- One TypeScript at the repo root; `tsc -b` per package; `pnpm typecheck`
  at the root must pass.
- Unit tests: `*.test.ts` next to the source, vitest, in-memory fakes only.
  Integration tests: `*.integration.test.ts`, need Postgres from
  `docker-compose.yml` (`DATABASE_URL`). Playwright is e2e only.
- `@formula-time/domain` is browser-safe: no `node:*` imports (its
  tsconfig enforces `types: []`, `lib: ["ES2022"]`). Types and the reducer
  live there; identity hashing does not.
- The root `Dockerfile`'s runtime stage ships this package's `dist` output
  and production `node_modules` only — no TypeScript sources, no
  devDependencies — and runs as a non-root user.
