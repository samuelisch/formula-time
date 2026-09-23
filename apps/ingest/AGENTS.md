# apps/ingest — local conventions

Issue label: `ingest`. An agent working here picks `ready` issues labelled
`ingest` (`gh issue list --label ready --label ingest --search "sort:created-asc"`) and nothing else.

## Purpose

The only process that talks to OpenF1. Sole writer of the `sessions` and
`events` tables (and the entry list, via the writer); writes nothing else.
See `README.md` for how: the pipeline, the rules, the entry list, config,
commands, log lines.

## Where the facts are

- The pipeline (discovery → selection → REST/MQTT/entry list → normalise →
  queue → writer): `README.md` → `## The pipeline`.
- Cadences, windows, caps, batch sizes, MQTT numbers: `README.md` →
  `## Rules`.
- The entry-list fetch schedule: `README.md` → `## The entry list`.
- Environment variables and their defaults: `README.md` →
  `## Configuration`.
- The CLI commands and what each refuses: `README.md` → `## Commands`.
- Every log line prefix the service emits: `README.md` →
  `## What the log lines mean`.
- OpenF1 API quirks (free-tier lockout, token lifetime, date filters,
  mutating rows): `README.md` → `## OpenF1 facts`.
- Vocabulary shared across the repo: [`../../docs/glossary.md`](../../docs/glossary.md).

## Rules that are not in the README

- Never run a second OpenF1 REST consumer (the POC recorder, a local
  ingest on the live source) while the deployed ingest is live: the rate
  limit is per account and a second consumer trips it on every tier.
- The single-writer guarantee (ADR-0007) holds per `session_key`, not just
  per process (ADR-0010): the live service owns every session inside its
  live window; `ingest:load` and `ingest:fetch-race` own only sessions
  whose window has closed, and refuse a session that is still live.
- A new season's circuits are added to `circuits.ts`'s `CIRCUITS` table,
  and its entry list to `openf1/entry-list.ts`, before that season's first
  race — a missing entry means `total_laps` stays null (no polls open for
  that race) and the drivers fetch has no fallback to fall back to.
- `ingest:load`/`ingest:fetch-race` flip a loaded session to `finished`
  only after every one of its events has landed, never before: the
  exporter publishes the moment a session turns `finished` (ADR-0009 §2),
  so flipping it earlier would export an empty race.

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
  devDependencies. The image runs as a non-root user (uid 1001), and the
  deployed `ingest` service overrides that with `RAILWAY_RUN_UID=0` because
  Railway mounts the volume `root:root` (ADR-0036); `api` and local runs are
  unaffected.
- Config is read from the platform secret store only, never from files in
  the image (variable names and defaults: README `## Configuration`).
  `RAILWAY_RUN_UID` is a Railway platform variable set in
  `.railway/railway.ts`, not read by `config.ts`.
- Logging: `src/log.ts` exports a pino logger with base fields `service:
  "ingest"` and `build` (`RAILWAY_GIT_COMMIT_SHA`, else `"unknown"`), JSON
  only (no pretty printing — Railway shows JSON fine). The REST lane, the
  MQTT lane, the writer, and `OpenF1Auth` each report through their
  `log(message, opts?)` callback (`LaneLog`); `main.ts` wires each to
  `logger[level]({ lane, ...fields, ...countFields(message) }, message)`
  (line prefixes and fields: README `## What the log lines mean`).
- Each lane and the writer expose a `takeStats()` that returns its
  counters since the previous call and resets them; `main.ts` composes
  them into the one per-minute line, `ingest: last 60s` (README `## What
  the log lines mean`).
