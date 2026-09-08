# apps/api — AGENTS.md

`api` is the "app service" of ADR-0001, named by ADR-0003: one process, one
deploy unit. This file adds local convention on top of the root
`AGENTS.md`; it restates nothing there.

## What this service owns

One process holding:
- **The projector** — folds the event log into one in-memory RaceState.
  Polls Postgres with `WHERE seq > $cursor ORDER BY seq` every 250 ms;
  restart runs the same query from cursor 0. A row below the
  already-applied cursor forces a full rebuild — never an in-place apply.
- **The poll module** — locks and resolves polls from the fold; holds
  tallies in memory; reloads them from `votes` on start.
- **The fan-out** — one `JSON.stringify` per push, gzip once per push,
  identical bytes to every socket. A vote never triggers a push.
- **The SSE route handler** — live: attach the socket to the fan-out.
  Finished: redirect to the export. It never touches state.
- **The exporter** — session finished and not yet exported: write the
  immutable file once. Idempotent; retried by the same check.

This service is the sole writer of `polls` and `votes`. It reads `sessions`
and `events`; it never writes `events`. Vote acknowledgement: acknowledge
to the browser only after the `votes` insert commits. Dedup is the primary
key `(poll_id, viewer_id)`; a re-vote before lock is an upsert, not a new
row.

Fastify handles routing, cookies, static files, and validation. The SSE
route is hand-written on the raw response — compression middleware would
gzip per viewer, which the fan-out design forbids.

## The five invariants, as they bind here

1. One shared, serialize-once stream per live race — never per-viewer work.
2. Postgres is touched per event and per join, never per viewer per tick.
3. Row identity is transport-independent; this service consumes that
   identity, it does not construct it (ingest does).
4. Never patch a late-arriving row into RaceState — rebuild from the fold.
5. Anything with stakes settles server-side: a vote is real only once its
   insert commits, never on the client's say-so.

## Conventions

- ESM everywhere: relative imports end in `.js` even from `.ts` (NodeNext).
- One TypeScript at the repo root; `tsc -b` per package, `pnpm typecheck`
  at the root must pass.
- Unit tests: `*.test.ts` next to the source, vitest, in-memory fakes only.
  Integration tests: `*.integration.test.ts`, need Postgres from
  `docker-compose.yml` (`DATABASE_URL`). Playwright is e2e only.
- `@formula-time/domain` is browser-safe: no `node:*` imports. Types and
  the reducer live there; identity hashing does not.
- Config is read from the platform secret store, never from files in the
  image: `DATABASE_URL`, `OPENF1_LOGIN`, `OPENF1_PASSWORD`, `PORT`,
  `LIVE_SOURCE`.
- Vocabulary: *fold* (reduce over the event log), *projector*/*authority*
  (the class / the role — exactly one), *push* (one serialized RaceState +
  tallies sent to every socket), *lock* (a poll's pre-resolve state, not
  "close").
