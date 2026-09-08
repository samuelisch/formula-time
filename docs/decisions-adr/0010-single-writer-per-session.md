# ADR-0010 — The single-writer guarantee is per session; the recording loader writes only finished sessions

Status: Accepted
Date: 2026-09-08
Amends: ADR-0007 (consequence "Exactly one `ingest` service runs" is scoped to the live session)

## Context

ADR-0007 gives ingest one queue and one connection so `seq` order equals commit order and a cursor cannot skip a committed row. The loader added in issue #63 writes past recordings into `sessions` and `events` from its own process and connection, possibly while the live `ingest` service is running. Both readers of `events` are scoped to one session: the projector reads `WHERE session_key = $1 AND seq > $cursor ORDER BY seq` (HLD §7 "Cursor"), and the exporter reads one finished session's rows (ADR-0009 §2). A row of another session committing late with a lower `seq` is never in either query's result set.

## Decision

1. The single-writer guarantee holds per `session_key`: at most one process writes rows for a given session. The live `ingest` service owns every session inside its live window; the loader owns only sessions whose window has closed.
2. The loader refuses a session whose window contains now, or whose `sessions` row is `live`, and writes nothing for it.
3. Two processes writing different sessions at the same time is allowed and does not affect either reader.

## Consequences

- The projector's late-commit detector remains an alarm that must never fire; it is per session, so loader activity cannot trigger it.
- A future writer that fills a live session from a second source (T6 MQTT) must go through the live service's queue, as ADR-0007 already says; this ADR does not loosen that.
- `ADRs affected` lines that cite ADR-0007 for the loader should cite this ADR.
