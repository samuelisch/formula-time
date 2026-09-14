---
name: load-race
description: Load a past recording into the deployed (Railway) database by running the ingest loader inside the ingest container over railway ssh.
---

# Load a recording into production

## Overview

Railway's Postgres has no public TCP proxy, so the loader
(`apps/ingest/src/load-recording.ts`, `pnpm ingest:load` locally) cannot be
pointed at the deployed `DATABASE_URL` from a laptop. It has to run inside
the `ingest` container instead, over `railway ssh`: stream a tarball of the
recording in, run the already-built loader there, then verify through the
api's export routes (ADR-0009). This is how the Dutch and Italian GPs were
loaded into production on 2026-09-08.

A future `pnpm ingest:fetch-race <session_key>` will pull a race straight
from OpenF1 the same way — inside the container, over `railway ssh` — once
that command exists; until then this skill's tarball-and-load path is the
only way to get a race into the deployed database.

## Prerequisites

- The loader's build (`apps/ingest/dist/load-recording.js`) must be on
  `main` and already deployed to the `ingest` service — this procedure
  runs the code that is already in the container image, it does not ship
  new code.
- The recording lives at `recordings/<key>` locally (a POC recording:
  `session.json`, `raw/<endpoint>.jsonl`).
- A local SSH key registered with Railway, and a host alias for the
  `ingest` service. One-time setup, skip if `~/.ssh/config` already has a
  `Host railway-ingest` block:

  ```
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C formula-time
  ```

  ```
  railway ssh keys add -k ~/.ssh/id_ed25519.pub -n formula-time
  ```

  ```
  railway ssh config -s ingest --alias railway-ingest
  ```

  This writes a `Host railway-ingest` block into `~/.ssh/config`. The
  first connection through it needs
  `-o StrictHostKeyChecking=accept-new` to accept the container's host
  key (only needed once per container instance; a redeploy can require it
  again).

## Steps

1. Pack the recording (one or more keys) into a tarball:

   ```
   tar -czf /tmp/recordings.tgz -C recordings <key> [<key> ...]
   ```

2. Stream it into the container, extract it, and run the loader there in
   one `ssh` call — the container's working directory is the app root and
   `DATABASE_URL` is already set there, so the loader needs no extra
   config:

   ```
   ssh railway-ingest 'mkdir -p /tmp/recordings && tar -xzf - -C /tmp/recordings && node apps/ingest/dist/load-recording.js /tmp/recordings/<key>' < /tmp/recordings.tgz
   ```

   Add `-o StrictHostKeyChecking=accept-new` before `railway-ingest` if
   this is the first connection to the current container instance. Pass
   every `<key>` from step 1, space-separated, as extra arguments to
   `load-recording.js` to load them all in one call.

## Verify

3. Confirm the race is listed — allow the api's exporter one 5 s tick
   after the loader finishes:

   ```
   curl -s https://api-production-8fbf2.up.railway.app/api/races
   ```

   The response should include an entry for `<key>`.

4. Confirm the export actually has events, not just a session row:

   ```
   curl -s --compressed https://api-production-8fbf2.up.railway.app/api/races/<key> | head -c 300
   ```

   Expect `"schema":1` and a non-empty `events` array. `--compressed` is
   required — the route serves pre-gzipped bytes with
   `content-encoding: gzip` (ADR-0009 §4) and `curl` will print garbage
   without it.

## Cleanup

5. Remove the tarball's extracted copy from the container:

   ```
   ssh railway-ingest 'rm -rf /tmp/recordings'
   ```

   Not strictly necessary — `/tmp` inside the container is gone on the
   next deploy anyway — but leaves nothing behind if this container
   instance stays up a while.

## Reload a race

A race already loaded with events in the wrong `seq` order (for example,
one loaded before the received_at-ordering fix landed) can be fixed in
place with `--replace`, instead of wiping the session by hand: it deletes
the session's `events` rows and reruns the normal insert path as one
transaction, so a failed insert leaves the old rows untouched. The
recording must already be on the container (steps 1-2 above); add the
flag before the recording paths:

```
ssh railway-ingest 'node apps/ingest/dist/load-recording.js --replace /tmp/recordings/<key>'
```

The loader logs one verify line per session after every load, replaced or
not: `load: verify <key> rows=<n> endpoint_runs=<r>
source_time_backsteps=<b>`. `endpoint_runs` is the decisive signal:
`endpoint_runs` equal to the number of OpenF1 endpoints (8) is the broken,
endpoint-grouped shape `--replace` fixes; a correctly interleaved race has
far more (measured on a full Italian GP: `endpoint_runs=1057`). Don't
judge health from `source_time_backsteps` alone — it's present on a
healthy load too (OpenF1 batches arrive slightly out of order; measured on
the same race, `source_time_backsteps=1004` correctly interleaved vs. 625
endpoint-grouped) and does not by itself separate a healthy load from a
broken one. `--replace` writes newer `events` rows than the session's
`exports` row reflects; per ADR-0018, the api's exporter treats that
session as stale and re-exports it automatically on its own 5 s tick, no
separate step. Confirm the new export landed:

```
curl -s https://api-production-8fbf2.up.railway.app/api/races | grep '"session_key":<key>'
```

`exported_at` should be later than it was before the reload. The owner
runs the actual production reload of an affected race, not an agent.

## Common mistakes

- Running this before the loader build has actually been deployed to
  `ingest`: it runs whatever `apps/ingest/dist/load-recording.js` already
  is in the running container image, not the code on disk locally.
- Checking `/api/races/:key` immediately after the loader exits, before
  the exporter's next 5 s tick — the entry (or its events) may not be
  there yet; re-check a few seconds later.
- An empty `events` array that persists past a re-check is the exporter
  racing the loader — fixed by #74 (the loader holds the session at
  `upcoming` until every event has landed, then flips it to `finished`).
  If it recurs, the deployed loader predates #74.
- Loading a session that is still live (inside its ±30 min live window):
  the loader refuses it and writes nothing (ADR-0010) — the live `ingest`
  service owns that session, not the loader.
- Forgetting `--compressed` on the second `curl` and reading the raw
  gzip bytes as if the request had failed.

## Verify a deploy

After any deploy that touches a service, before loading or reloading a race:

```
railway deployment list -s <service>
railway logs -s <service> | tail -50
```

The newest deployment reads SUCCESS and the tail shows no repeated failure line. A repeated line is the fault to fix first; a load on top of a broken service only hides it.

For the `ingest` service specifically, also confirm the per-minute stats line is flowing:

```
railway logs -s ingest | grep "ingest: last 60s"
```

At least one line should appear within a couple of minutes of the deploy, carrying `rest_polls`, `rest_rows`, `rest_errors`, `mqtt_messages`, `mqtt_rows`, `mqtt_dropped`, `writer_inserted`, `writer_skipped`, `writer_failures`, `queue_depth`, and `session_key`. No line at all means the process crashed before its first interval tick, or the interval itself broke — check `railway logs -s ingest | tail -50` for the actual fault.

Also confirm the recording volume is actually writable (ADR-0036: the deployed `ingest` process runs as uid 0 via `RAILWAY_RUN_UID=0` because Railway mounts `/data` root:root):

```
railway ssh -s ingest -- cat /proc/1/status | grep '^Uid:'
railway ssh -s ingest -- ls -la /data
railway logs -s ingest | grep "recording root"
```

The `railway ssh` shell is itself root, so `id` over `railway ssh` says nothing about the service — `/proc/1/status` is the main process's real uid. Expect `Uid:` all zeros, a `live-logs` entry under `/data` owned by `root`, and the `is writable` line. A `NOT writable` line means `RAILWAY_RUN_UID=0` has not been applied to the service.

## Copy a recording out

The ingest service's jsonl recordings live on a Railway volume mounted at
`/data` (`LIVE_LOG_DIR=/data/live-logs`), so a recording survives a
redeploy — but nothing is backed up automatically. The REST lane logs
`recording closed <session_key> rows=<n> path=<dir>` once, when a followed
session's live window closes; that line is the signal a recording is
complete and worth copying off before it is needed (to `pnpm ingest:load`
it elsewhere, or to replay it with the drip simulator).

```
railway ssh -s ingest -- tar -czf - /data/live-logs/<key> > recordings-<key>.tgz
```

`tar -xzf recordings-<key>.tgz` extracts it locally, under the same
`data/live-logs/<key>` path the container used.

Nothing under `/data/live-logs` is deleted automatically. Once a
recording has been copied out and verified, remove it from the volume by
hand:

```
railway ssh -s ingest -- rm -rf /data/live-logs/<key>
```

## Dump a recording

The jsonl recording on the volume is one source of a recording; the
database is another, and always has every row a finished session ever
wrote, even when the volume's own copy is gone or was never captured (a
redeploy between sessions, a disk that was unmounted, or the gap #289
describes). `apps/ingest/src/dump-recording.ts` (`pnpm ingest:dump`
locally) reads a session's `sessions` row and every `events` row back out
of Postgres and writes them in the same recording layout the loader and
the drip simulator both read. Same reason as the loader: Railway's
Postgres has no public proxy, so this runs inside the `ingest` container
too, over `railway ssh`, then streams the directory back as a tarball
instead of a `railway ssh` file copy:

```
railway ssh -s ingest -- node apps/ingest/dist/dump-recording.js 11369 --out /tmp/rec
```

```
railway ssh -s ingest -- tar -czf - -C /tmp rec > recordings-11369.tgz
```

`tar -xzf recordings-11369.tgz` extracts it locally as `rec/`, ready for
`pnpm ingest:load`, `pnpm sim --recording`, or the round-trip check
`load-recording --replace` gives: the dump reproduces the same `event_id`
set, in the same `received_at` order, as the session it came from. An
unknown `session_key` refuses with one log line and writes nothing; an
`--out` directory already carrying `polls.jsonl` (a real recording) is
refused the same way unless `--force` is passed.
