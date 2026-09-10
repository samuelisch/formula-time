# apps/ingest — local conventions

Issue label: `ingest`. An agent working here picks `ready` issues labelled
`ingest` (`gh issue list --label ready --label ingest --search "sort:created-asc"`) and nothing else.

The only process that talks to OpenF1. Sole writer of the `sessions` and
`events` tables (and the entry list, via the writer below); writes nothing
else.

## What this service owns

- Two lanes always on, no failover logic: REST (cadence unchanged from the
  POC, the safety net) and MQTT (the eight named timing topics only, never
  `v1/#`; exactly one connection; re-subscribe on every `connect`).
- Row identity, transport-independent: strip every `_`-prefixed vendor
  field, canonicalize ISO timestamps to epoch-ms (offset-less = UTC), hash.
  REST and MQTT twins produce the same `event_id`.
- Single writer: both lanes feed one in-process queue; one connection
  (`createDb(url, { max: 1 })`) drains it in arrival order, in batches of
  at most 100, with `event.createMany({ skipDuplicates: true })` — so `seq`
  order equals commit order (ADR-0007 §1). The guarantee holds per
  `session_key`, not just per process (ADR-0010 §1): the live service owns
  every session inside its live window, and the loader/`fetch-race` below
  own only sessions whose window has closed.
- The entry list: fetched live per session — at session selection
  (`drivers?session_key=`, retried every 5 min until it returns rows),
  again 5 minutes before the session starts, and meeting-wide from the
  first session's start onward (`drivers?meeting_key=`, retried every
  30 min, only while that meeting's race session's window hasn't closed) —
  falling back to a static, hardcoded 2026 roster (`openf1/entry-list.ts`)
  whenever the live fetch returns nothing. Every path emits through the
  same writer with endpoint `drivers`.
- Always on: discovers sessions itself, captures during a session window.
  The jsonl recording is still written — it is the irreplaceable artefact,
  not a stopgap.
- The drip simulator (`src/sim/`, `pnpm sim`) and the `rehearse-race` skill
  that runs the whole local stack against it: replays a recording through
  the unmodified REST lane via `LIVE_SOURCE`, no network involved.

## Loading a past race

The live REST lane only polls a session inside its ±30 min window
(`pickLiveSession`), so `LIVE_SOURCE=<old recording>` discovers a past
session and upserts it, but never fetches its rows — historical races need
an explicit load instead: `DATABASE_URL=... pnpm ingest:load <recording-dir>
[<recording-dir> ...]`, each dir a POC recording (`session.json`,
`raw/<endpoint>.jsonl`) or a root holding several. It lifts the same
in-process path (file fetcher → normalizer → queue → writer) into a
command. First the ADR-0010 guard: a session that is still live, or whose
window has not closed, is refused and nothing is written for it — the live
service owns it instead. Otherwise the session is upserted `upcoming`
first; every endpoint's rows are merged into `received_at` order across
endpoints, not one endpoint fully before the next, and written and
drained; and only then is the row updated to `finished` regardless of the
window — set last because the api's exporter exports the moment a session
turns `finished` (ADR-0009 §2), so flipping it before the events land
would let the exporter export an empty race. Idempotent: a second run
inserts 0.

That command only reaches a local Postgres. Railway's Postgres has no
public TCP proxy, so loading a recording into the deployed database means
running this same loader inside the `ingest` container instead, over
`railway ssh` — the procedure, prerequisites, and verification curls are
in `.claude/skills/load-race/SKILL.md`.

`DATABASE_URL=... [OPENF1_LOGIN=... OPENF1_PASSWORD=...] pnpm
ingest:fetch-race <session_key> [<session_key> ...]` pulls a finished
historical session straight from OpenF1 instead of replaying a recording —
one endpoint request at a time, rate-limited and retried on a 429 or 5xx —
ordered for emission by `source_time` (a laps row placed at its end, not
its start, so a scrub mid-lap can never reveal its final time; a stints
row placed at its lap's start). It shares the loader's write path
(`upcoming` → events → `finished`, the ADR-0010 guard, idempotency) and
also writes the fetched rows as a recording under
`LIVE_LOG_DIR/<session_key>/raw/<endpoint>.jsonl` plus `session.json`, so
the session can be loaded again later without OpenF1.

## OpenF1 facts that shape this code

- The free tier locks out during any live session.
- The sponsor bearer token expires in 3600 s: refresh before expiry and on
  every reconnect.
- The live API rejects all date filters; a 404 there means no data yet, not
  an error.
- Live rows mutate in place — identity hashing exists because of this.
- Never run two OpenF1 consumers against the same account at once.

## Conventions

- ESM everywhere: relative imports end in `.js` even from `.ts` files
  (NodeNext).
- One TypeScript at the root; this package builds via `tsc -b`; `pnpm
  typecheck` at the root must pass.
- Unit tests are `*.test.ts` next to the source, vitest, in-memory fakes
  only. Integration tests are `*.integration.test.ts` and need Postgres
  from the root `docker-compose.yml` (`DATABASE_URL`). Playwright is e2e
  only and lives elsewhere.
- `@formula-time/domain` is browser-safe (tsconfig enforces `types: []`,
  `lib: ["ES2022"]`): it holds types and the reducer, not identity
  hashing. Ingest code must not add `node:*` imports to the domain
  package.
- Config is read from the platform secret store only, never from files in
  the image: `DATABASE_URL`, `OPENF1_LOGIN`, `OPENF1_PASSWORD`,
  `LIVE_SOURCE`, `LIVE_LOG_DIR` (the jsonl recording's directory, default
  `./live-logs`), `MQTT_ENABLED` (default `true` when `OPENF1_LOGIN` is
  set, else `false` — the free tier has no MQTT).
- Vocabulary, defined once for the whole repo: *fold* — reduce over the
  event log into RaceState; ingest appends to that log but never folds
  it. *projector*/*authority* — the class name and the role it plays
  (exactly one, holds folded RaceState in memory); lives in apps/api.
  *push* — one serialized RaceState + poll tallies written to every
  socket; also apps/api. *lock* — the state a poll is in before it
  resolves; polls themselves are an apps/api concern, not ingest's.
