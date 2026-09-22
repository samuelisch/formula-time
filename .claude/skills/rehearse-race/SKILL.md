---
name: rehearse-race
description: Run the local stack against a recorded race dripped as live: Postgres, simulator, ingest, api, web
---

# Rehearse a race

Rehearses a recorded session as if it were happening now, end to end, with
nothing pointed at the network or at a deployed database. ADR-0001: only
ingest talks to OpenF1 — the simulator reads a recording from disk and
touches no network; it impersonates the recorder, not OpenF1.

Never point any of this at a Railway URL or a deployed `DATABASE_URL`. A
simulated session must only ever land in the local compose Postgres.

The `--recording` directory can come from any of three sources, all in the
same layout (`session.json`, `raw/<endpoint>.jsonl`): a live capture under
`live-logs/<key>`, a POC recording under `recordings/<key>`, or a directory
`pnpm ingest:dump` (`apps/ingest/src/commands/dump-recording.ts`) produced by reading
a finished session back out of Postgres — useful when the disk capture
itself is gone but the database still has the session's rows.

## Run it

Start Postgres:

```
pnpm db:up
```

Apply migrations (this already targets the right port for your worktree —
`pnpm db:migrate:deploy` runs through `scripts/with-db-env.sh`):

```
pnpm db:migrate:deploy
```

Terminal 1 — drip a recording as if it were live, 20x speed, starting near
the green light. The speed compresses the source axis, not the wall clock:
at 20x a "60 s delay" spans 3 real seconds, so any measurement of a time
window (a buffer bound, a delay, a lock) runs at `--speed 1`. The simulator never touches the database, so no export is
needed here:

```
pnpm sim --recording live-logs/11361 --speed 20 --start race
```

`pnpm sim` and `pnpm dev:ingest` both run with `apps/ingest` as their
working directory (same as `LIVE_SOURCE`/`LIVE_LOG_DIR` today), so
`--recording`, `--out-root`, and `LIVE_SOURCE` below are all relative to
`apps/ingest` — put a recording at `apps/ingest/live-logs/11361`.

Terminal 2 — ingest, pointed at the simulator's output directory instead of
OpenF1. Point it at this worktree's compose database first (no pooler
locally; `scripts/db-env.sh` picks the right port for this worktree, so this
is safe to copy-paste into any worktree's terminal):

```
eval "$(scripts/db-env.sh)"
export DATABASE_URL=postgres://formula:formula@localhost:${DB_PORT}/formula_time DATABASE_DIRECT_URL=$DATABASE_URL
LIVE_SOURCE=./live-logs/sim pnpm dev:ingest
```

Terminal 3 — the api. `pnpm dev:api` runs through `scripts/with-db-env.sh`,
which exports this worktree's own `DATABASE_URL` and `API_PORT` (from
`scripts/db-env.sh`), so a fresh terminal needs no manual export here:

```
pnpm dev:api
```

Terminal 4 — the web app. `pnpm dev:web` runs through the same wrapper, so
it picks up this worktree's `WEB_PORT` and proxies `/api` and `/health` to
this worktree's `API_PORT`:

```
pnpm dev:web
```

Open the web app at this worktree's `WEB_PORT` — `http://localhost:5173` in
a plain checkout, or `eval "$(scripts/db-env.sh)"; echo $WEB_PORT` to find it
in any worktree.

## Confirm it is moving

```
eval "$(scripts/db-env.sh)"
curl -s "localhost:${API_PORT}/health"
```

## Confirm the push follows the session row

The projector must pick up a session row that changes under a running api
(status, `total_laps`, the meeting name), not only a new session key. With
the api running, flip the row in this worktree's Postgres and read the
snapshot within 5 s; the status must follow without a restart:

```
eval "$(scripts/db-env.sh)"
docker compose exec postgres psql -U formula -d formula_time -c "UPDATE sessions SET status = 'live' WHERE session_key = 99911353"
curl -s "localhost:${API_PORT}/api/live/snapshot" | grep -o '"status":"[a-z]*"' | head -1
```

Run it twice, a minute apart. It should show the simulator's `session_key`
(default 99911353) and a `cursor` that has risen between the two readings —
that is the ingest queue draining into `events`, which means the projector
has something to fold.

## Reset

Either tear down the database:

```
pnpm db:down
```

or, to keep Postgres up and only drop the simulated session, delete the
simulated session's rows (`sessions` and its `events`) for the sim
`session_key` and re-run the simulator — it refuses to overwrite a
directory that looks like a real recording (one that carries
`polls.jsonl`), so a fresh `--out-root` or `--sim-key` also works.

## Other flags

`--recording <dir>` (default `live-logs/11361`), `--sim-key <n>` (default
99911353), `--out-root <dir>` (default `./live-logs/sim`), `--speed <n>`
(default 1), `--start recording|race` (default `recording`; `race` bursts
the pre-race history instantly and drips from near the green light instead
of waiting through the recorded pre-race at speed 1).
