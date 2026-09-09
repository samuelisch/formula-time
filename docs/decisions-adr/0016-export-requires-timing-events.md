# ADR-0016 — A session is exported only once it holds timing events; the api may prune its own exports

Status: Accepted
Date: 2026-09-09
Amends: ADR-0009 (§2 "export once when finished" gains a precondition; §2's "written only by the api" already covers the prune command)

## Context

On 2026-09-09 ingest discovery wrote the full 2026 calendar into `sessions` (131 rows, 81 finished). ADR-0009 §2 exported every finished session with no `exports` row, so `GET /api/races` listed 81 sessions, 79 of them holding only `drivers` rows or nothing. ADR-0009 §5 describes the consumer as a viewer replaying a race; a session without timing data cannot be replayed.

## Decision

1. A finished session is exported only when at least one of its events has an endpoint other than `drivers`. A session without timing events is skipped, logged once per process, and re-checked on later ticks, so a later load still exports it.
2. `exports` remains written only by the api. The api's prune command (`apps/api/src/export/prune-exports.ts`) deletes an `exports` row and its file when the session has no timing events; it is run by the owner, never on a schedule.

## Consequences

- `GET /api/races` lists only sessions a viewer can replay.
- A session that later receives timing events (a load, a fetch) is exported on the next tick as before.
