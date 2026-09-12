# apps/ingest — local conventions

Issue label: `ingest`. An agent working here picks `ready` issues labelled
`ingest` (`gh issue list --label ready --label ingest --search "sort:created-asc"`) and nothing else.

The only process that talks to OpenF1. Sole writer of the `sessions` and
`events` tables (and the entry list, via the writer below); writes nothing
else.

## What this service owns

- `circuits.ts`'s `CIRCUITS` table: the static `circuit_key` -> scheduled
  race-lap-count map used to set `sessions.total_laps` at discovery, so the
  poll module knows when the race is done. Each entry's lap count comes
  from an official source (never memory), cited beside the entry. A new
  season's circuits are added to this table before that season's first
  race — a missing entry means `total_laps` stays null and no polls open
  for that race.
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
- Only race sessions are captured (`isRaceSession`, `writer/sessions.ts`:
  `session_name === "Race"`, exact and case-sensitive — a sprint carries
  `session_type: "Race"` but `session_name: "Sprint"`, so the filter is on
  `session_name`). Practice, qualifying and sprint rows are never upserted
  into `sessions` and never added to the REST lane's known-session set, so
  the live REST lane never selects or polls one; the recording loader and
  `fetch-race` refuse one outright (`load: refused <key>: session_name is
  "<name>", only "Race" is loaded`). A `drivers?meeting_key=` row tagged to
  a practice session_key is written nowhere (it hits the same
  not-a-known-session drop every row naming an absent `sessions` row
  already gets). Consequence: the race's entry list is no longer
  guaranteed to exist before the race itself is selected — it now comes
  from that session's own `drivers?session_key=` fetch at selection (30
  minutes before the race), not from Friday's meeting-wide fetch, which
  still runs (grouping a meeting from every row it has seen, practice
  included) but only ever writes the race's own tagged rows.
- `sessions` also carries three nullable naming columns:
  `circuit_short_name` and `location`, filled by `sessionFieldsFromRaw`
  (`writer/sessions.ts`) straight from the raw session row, and
  `meeting_name` (the Grand Prix, e.g. "Spanish Grand Prix" — a country can
  host two rounds a season, so `country`/`circuit_key` alone don't name a
  race), joined from a caller-supplied `meeting_key -> meeting_name` map:
  the REST lane fetches `meetings?year=` once per discovery tick (cached in
  memory, refreshed alongside the sessions snapshot); the recording loader
  and `fetch-race` fetch `meetings?meeting_key=` once per session they
  write. All three default to null when no map entry exists, rather than
  guessing — a rerun of `upsertSession` (or `--replace`) fills them on an
  existing row once the map has an answer.
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
inserts 0. A `--replace` flag (before the recording paths) instead deletes
a session's `events` rows and reruns this same insert path as one
transaction, for fixing a session already loaded with the wrong `seq`
order; the ADR-0010 guard above still applies first.

That command only reaches a local Postgres. Railway's Postgres has no
public TCP proxy, so loading a recording into the deployed database means
running this same loader inside the `ingest` container instead, over
`railway ssh` — the procedure, prerequisites, and verification curls are
in `.claude/skills/load-race/SKILL.md`.

`DATABASE_URL=... [OPENF1_LOGIN=... OPENF1_PASSWORD=...] pnpm
ingest:fetch-race <session_key> [<session_key> ...]` pulls a finished
historical session straight from OpenF1 instead of replaying a recording —
one endpoint request at a time, rate-limited and retried on a 429 or 5xx.
A historical laps row arrives already complete, one row per lap; the live
lane instead sees each lap row twice, once at lap start (durations and
segments still null) and once complete. `fetch-race` reproduces both: a
start row at `date_start` with `lap_duration`, `duration_sector_1..3`,
`i1_speed`, `i2_speed`, `st_speed` and the `segments_sector_*` arrays
nulled, and the complete row at `date_start + lap_duration` so a scrub
mid-lap can never reveal its final time. The two payloads differ, so their
`eventId` differs and both survive `createMany({ skipDuplicates })` — this
is what makes the lap counter, the lap markers and the poll clock flip at
lap start instead of at lap end, matching the live lane. A row missing
`date_start` or `lap_duration` cannot be split and emits only the complete
row, as before. Emission is ordered by `source_time` (the lap rule above;
a stints row placed at its lap's start). It shares the loader's write path
(`upcoming` → events → `finished`, the ADR-0010 guard, idempotency) and
also writes the fetched rows as a recording under
`LIVE_LOG_DIR/<session_key>/raw/<endpoint>.jsonl` plus `session.json`, so
the session can be loaded again later without OpenF1 — that recording
keeps the one raw row per lap actually received from OpenF1; the split
happens only at emission time, not in the recording.

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
- The root `Dockerfile`'s runtime stage ships this package's `dist` output
  and production `node_modules` only — no TypeScript sources, no
  devDependencies — and runs as a non-root user.
- Config is read from the platform secret store only, never from files in
  the image: `DATABASE_URL`, `OPENF1_LOGIN`, `OPENF1_PASSWORD`,
  `LIVE_SOURCE`, `LIVE_LOG_DIR` (the jsonl recording's directory, default
  `./live-logs`), `MQTT_ENABLED` (default `true` when `OPENF1_LOGIN` is
  set, else `false` — the free tier has no MQTT), `LOG_LEVEL` (default
  `info`, read directly by the logger below rather than through `config.ts`).
- Logging: `src/log.ts` exports a pino logger with base fields `service:
  "ingest"` and `build` (`RAILWAY_GIT_COMMIT_SHA`, else `"unknown"`), JSON
  only (no pretty printing — Railway shows JSON fine). The REST lane, the
  MQTT lane and the writer each report through their `log(message)`
  callback; `main.ts` wires each to `logger.info({ lane }, message)` with
  `lane` one of `"rest" | "mqtt" | "writer"`. A message carrying any of
  `messages=`, `rows=`, `dropped=`, `inserted=`, `skipped=`, `new=`,
  `foreign=`, `unknown_session=` also gets those counts as structured
  fields (`countFields()`), so a log query can filter on them instead of
  parsing `msg`.
- Vocabulary, defined once for the whole repo: *fold* — reduce over the
  event log into RaceState; ingest appends to that log but never folds
  it. *projector*/*authority* — the class name and the role it plays
  (exactly one, holds folded RaceState in memory); lives in apps/api.
  *push* — one serialized RaceState + poll tallies written to every
  socket; also apps/api. *lock* — the state a poll is in before it
  resolves; polls themselves are an apps/api concern, not ingest's.
