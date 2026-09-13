# ADR-0034 — The jsonl recording is written at emit time, for both lanes

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owner:** Samuel Chan
- **Supersedes:** nothing
- **Amends:** ADR-0025 (the Decision section's sentence "the REST lane
  routes its own meetings fetch through the same `onNewRows` →
  jsonl-recorder path every other endpoint uses" — the meetings row and
  every other endpoint are now recorded by the shared emit path itself,
  under the name `onRecorded`, not a REST-lane-only `onNewRows` wrapper);
  ADR-0007 §4 (names `LIVE_LOG_DIR` as a config seam but says nothing about
  which lane writes the recording or when — this ADR states that
  mechanism for the first time).

## Context

Measured live, 2026-09-13 at 13:45 UTC, 45 minutes into the Spanish GP:
Postgres held about 18,000 rows for session 11369 (health cursor
439,107 → 457,117) while the container's `live-logs/11369/raw/` held 134
lines in total (26 position, 28 intervals, 6 laps). Cause: only the REST
lane's `onNewRows` wrapper called `recorder.appendRows`; the MQTT lane fed
the shared queue but never the recorder. Both lanes dedup through one
shared `LiveNormalizer`, so a row MQTT delivered first was already in the
seen set by the time REST polled it, REST reported `new=0`, and the
recorder never saw the row either. With MQTT winning nearly every row
(349–440 rows a minute against REST's 0), the "irreplaceable artefact" ADR
0007 §4 names was not being written during a live race.

## Decision

`emitRows` and `emitTaggedDriverRows` (`apps/ingest/src/openf1/rest-lane.ts`)
— the one place every lane's newly-normalized rows reach the shared queue,
already the function the MQTT lane called directly rather than keeping its
own emit path — take an optional `onRecorded(sessionKey, endpoint,
payloads): Promise<void>` parameter and call it with exactly the rows they
just queued, once per queued batch, whichever lane reaches them first.
`received_at` on the recorded line is the moment the row was queued, so a
replay reproduces the live order. `main.ts` builds one `onRecorded`
(wrapping `JsonlRecorder.appendRows`) and hands the same instance to both
`RestLane` and `MqttLane`, replacing the REST-only `onNewRows` option
named in ADR-0025.

Each lane wraps the injected callback with its own try/catch: a rejected
append is logged at error level with the endpoint as a field and
swallowed, never allowed to block or stop the lane — the row is already on
the queue by the time recording is attempted, so it stays queued
regardless of whether the write lands. `MqttLane.stop()` awaits any
`handleMessage()` call still in flight (the same idea as the REST lane's
own in-flight-tick tracking) before resolving, so a pending append is not
lost if the process exits immediately after shutdown.

The followed session's own `meetings` row (never queued to `events`) is
unaffected: it keeps recording directly through the REST lane's own
helper, since it never goes through `emitRows`.

## Consequences

- Both ingest lanes now write to the same jsonl recording for every row
  they queue: a row seen by one lane first is recorded exactly once, and
  the other lane's later, deduplicated delivery of the same row is neither
  queued nor recorded again.
- A future reader of ADR-0025 sees `onNewRows` in its own text; this ADR
  is the pointer to the current name (`onRecorded`) and call site
  (`emitRows`/`emitTaggedDriverRows`, not a REST-lane-only wrapper).
- A recorder failure is now visible in the logs (error level, endpoint
  field) instead of silently doing nothing, without changing the ingest
  process's availability: a failing disk write never stops either lane
  from queuing rows for Postgres.
