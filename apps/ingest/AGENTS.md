# apps/ingest — local conventions

The only process that talks to OpenF1. Sole writer of the `sessions` and
`events` tables (and the entry list, via the writer below); writes nothing
else.

## What this service owns

- Two lanes always on, no failover logic: REST (cadence unchanged from the
  POC, the safety net) and MQTT (named timing topics only, never `v1/#`;
  exactly one connection; re-subscribe on every `connect`).
- Row identity, transport-independent: strip every `_`-prefixed vendor
  field, canonicalize ISO timestamps to epoch-ms (offset-less = UTC), hash.
  REST and MQTT twins produce the same `event_id`.
- Single writer: both lanes feed one in-process queue; one connection
  inserts in order — `INSERT INTO events … ON CONFLICT (event_id) DO
  NOTHING` — so `seq` order equals commit order.
- The entry list: `drivers` rows fetched from Friday practice onward
  (`drivers?meeting_key=`) and re-fetched at race discovery, through the
  same writer with endpoint `drivers`.
- Always on: discovers sessions itself, captures during a session window.
  The jsonl recording is still written — it is the irreplaceable artefact,
  not a stopgap.

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
  the image: `DATABASE_URL`, `OPENF1_LOGIN`, `OPENF1_PASSWORD`, `PORT`,
  `LIVE_SOURCE`.
- Vocabulary, defined once for the whole repo: *fold* — reduce over the
  event log into RaceState; ingest appends to that log but never folds
  it. *projector*/*authority* — the class name and the role it plays
  (exactly one, holds folded RaceState in memory); lives in apps/api.
  *push* — one serialized RaceState + poll tallies written to every
  socket; also apps/api. *lock* — the state a poll is in before it
  resolves; polls themselves are an apps/api concern, not ingest's.
