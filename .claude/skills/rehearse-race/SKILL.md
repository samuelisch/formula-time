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
the green light. The simulator never touches the database, so no export is
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

Terminal 3 — the api, same database export (a new terminal, so it needs its
own):

```
eval "$(scripts/db-env.sh)"
export DATABASE_URL=postgres://formula:formula@localhost:${DB_PORT}/formula_time DATABASE_DIRECT_URL=$DATABASE_URL
pnpm dev:api
```

Terminal 4 — the web app:

```
pnpm dev:web
```

Open `http://localhost:5173`.

## Confirm it is moving

```
curl -s localhost:3000/health
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
