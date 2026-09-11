# apps/api — AGENTS.md

Issue labels: `api` (this service, `packages/domain`, and root tooling:
.railway, .github, scripts, docker-compose, .claude). An agent working
here picks `ready` issues with that label and nothing else.

`api` is the "app service" of ADR-0001, named by ADR-0003: one process, one
deploy unit. This file adds local convention on top of the root
`AGENTS.md`; it restates nothing there. Vocabulary used below: *fold*
(reduce over the event log), *projector*/*authority* (the class / the role
— exactly one), *push* (one serialized RaceState + tallies sent to every
socket), *lock* (a poll's pre-resolve state, not "close").

## What this service owns

One process holding:
- **The projector** — folds the event log into one in-memory RaceState.
  Polls Postgres with `WHERE seq > $cursor ORDER BY seq` every 250 ms;
  restart runs the same query from cursor 0. A row below the
  already-applied cursor forces a full rebuild — never an in-place apply.
- **The poll module** — locks and resolves polls from the fold; holds
  tallies in memory; reloads them from `votes` on start.
- **The polls-by-race read route** — `GET /api/races/:session_key/polls`
  (`polls/routes.ts`, querying `pollsBySession` in `polls/poll-read.ts`)
  reads `polls`/`votes` straight from Postgres for any race, live or
  historical; it never touches the poll module's in-memory state.
- **The events-by-race read route** — `GET /api/races/:session_key/events`
  (`routes/races.ts`) pages the `events` log by `seq` for any session, live
  included, reusing the projector's own select (`projector/event-source.ts`).
- **The fan-out** — one `JSON.stringify` + one gzip for the full `state`
  push, unconditionally, every push (joins of either format and `GET
  /api/live/snapshot` need it on demand regardless of legacy-socket
  count); a delta socket (`?format=delta`, ADR-0013) additionally gets a
  hand-written JSON Patch `delta` each tick — one more serialize+gzip pass,
  built only while a delta socket is attached — keyframed back to `state`
  every 200th push. Identical bytes to every socket of the same format. A
  vote never triggers a push. Every push, `state` or `delta` alike, also
  carries `events` (the `RaceEvent` rows the projector applied that tick,
  `[]` on a catch-up or rebuild tick) and, only on a rebuild's push,
  `rebuilt: true` (ADR-0014) — a client folds them into its own deep-rewind
  timeline; the fan-out itself does not interpret either field.
- **The SSE route handler** — attaches the socket to the fan-out for
  whichever session the projector currently folds (live, the next
  upcoming, or, with neither, the most recent finished one, per
  `pickSession`); it never touches state itself.
- **The exporter** — session finished, not yet exported, and holding at
  least one event whose endpoint is not `drivers` (timing data to replay):
  write the immutable file once. Idempotent; retried by the same check. A
  finished session with only `drivers` events (or none) is skipped, logged
  once per process, and re-checked on later ticks. An already-exported
  session is stale, and re-exported the same way, once its events log holds
  a row received after the export's timestamp — a reload is picked up on
  the next tick rather than served stale forever.

This service is the sole writer of `polls` and `votes`. It reads `sessions`
and `events`; it never writes `events`. Vote acknowledgement: acknowledge
to the browser only after the `votes` insert commits. Dedup is the primary
key `(poll_id, viewer_id)`; a re-vote before lock is an upsert, not a new
row.

ADR-0009: `exports` is a fifth table, written only by the api (the
exporter). It does not write `sessions` — `sessions.exported_at` was
dropped in the same migration that added `exports`. ADR-0018: `exported_at`
is the file's version, not a one-time stamp — it moves on a re-export, and
the route's etag and the web's cache-busting `?v=` both key off it.

`apps/api/src/export/prune-exports.ts` is a one-off maintenance command,
not part of the running service: it removes `exports` rows (and their
files) written before the exporter required a timing event, i.e. rows for
finished sessions whose only ingest activity was the `drivers` endpoint.
Run it inside the api container after a build, `node
apps/api/dist/export/prune-exports.js`, which only logs what it would
delete; add `--apply` to actually delete the file and the row for each
affected session. It never touches a session that has any non-`drivers`
event.

Fastify handles routing, cookies, and validation. The SSE route is
hand-written on the raw response — compression middleware would gzip per
viewer, which the fan-out design forbids.

## The five invariants, as they bind here

1. One shared, serialize-once stream per live race — since ADR-0013, read
   as serialize once per wire format in use, never per viewer.
2. Postgres is touched per event and per join, never per viewer per tick.
3. Row identity is transport-independent; this service consumes that
   identity, it does not construct it (ingest does).
4. Never patch a late-arriving row into RaceState — rebuild from the fold.
5. Anything with stakes settles server-side: a vote is real only once its
   insert commits, never on the client's say-so.

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
- Config is read from the platform secret store, never from files in the
  image: `DATABASE_URL`, `PORT`, `CORS_ORIGIN`, `NODE_ENV`, `EXPORT_DIR`
  (default `./exports`, ADR-0009 §2). `OPENF1_LOGIN`/`OPENF1_PASSWORD`/
  `LIVE_SOURCE` are ingest's config, not read here.
- `GET /health` answers the session lifecycle's health plus `build`: the
  running process's git SHA, read as `GIT_SHA ?? RAILWAY_GIT_COMMIT_SHA ??
  "unknown"`. `GIT_SHA` is an explicit override for local runs and tests;
  `RAILWAY_GIT_COMMIT_SHA` is a variable Railway already injects into the
  running container at runtime, no Dockerfile plumbing needed.
  `release.yml`'s smoke job polls this to prove a release actually
  redeployed the new build, not the old one.
- The `viewer_id` cookie's attributes come from one helper,
  `viewerCookieOptions(env)` (`polls/viewer-identity.ts`), so `routes.ts`
  and the raw fallback string `resolveViewerId` builds can never drift
  (ADR-0015). `env === "production"` gets `SameSite=None; Secure`, needed
  for the cookie to travel between the split origins (ADR-0008); anything
  else gets `SameSite=Lax`, not `Secure`, because dev runs over plain http
  and a browser drops a `SameSite=None` cookie that is not `Secure`.
  `POST /api/vote` also checks `Origin` against the same `CORS_ORIGIN`
  allowlist the cors plugin uses (`originAllowed` in `cors.ts`) — the CSRF
  guard `SameSite=Lax` used to give for free.
