# ADR-0041 — Request log diet, poll write failures at error, a session-row refresh guarded by caught-up

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-23
- **Owner:** Samuel Chan
- **Amends:** ADR-0033 (`updateSession()`'s decision reads "publishes once,
  immediately, with `events: []`" with no precondition; it now publishes
  only once the projector has finished its catch-up fold — before that,
  the catch-up tick's own publish already carries the refreshed row).
  ADR-0022 (`LOG_LEVEL` is introduced there as ingest's config name; the
  api now reads the same name, the same way, for its own logger).

## Context

Measured 2026-09-22 on main at 9e83fe0:

- `Fastify({ logger: true })` logs `incoming request` and `request
  completed` at info for every request. During the Spanish GP 442 of the
  961 most recent lines were those two messages (2026-09-13); idle, it is
  115 of the last 2,000 (`railway logs -s api -n 2000`), almost all
  `/health` probes. The api had no way to change its level; ingest already
  honours `LOG_LEVEL` (`apps/ingest/src/log.ts`, ADR-0022).
- `PollModuleLogger` had only `info`; a lock or resolve write that did not
  land logged through it, so it was invisible to a query for error level.
  The write is retried on the next tick regardless — the evidence was what
  was missing.
- `RaceStateProjector.updateSession()` called `this.publish([])`
  unconditionally. During a restart's re-fold (160 ms on a full race,
  longer on a slow database), a lifecycle check's session-row refresh
  landing in that window pushed the partial, not-yet-caught-up state to
  every socket — the board would jump backwards for one push.

## Decision

1. `main.ts` builds Fastify with `logger: { level: process.env.LOG_LEVEL
   ?? "info" }` and `disableRequestLogging: true`. An `onResponse` hook
   logs one `warn` line (`method`, `url`, `statusCode`, `reqId`) for a
   response with status ≥ 400, and nothing for 2xx/3xx. The SSE route is
   hijacked and never reaches `onResponse`; its joins are already counted
   in the stats line's `viewers`.
2. `PollModuleLogger` gains `error(msg, fields)`; `logWriteFailure` calls
   it with `{ error }` instead of interpolating the error into an info
   line. `main.ts` wires both methods to `app.log`.
3. `RaceStateProjector.updateSession()` still replaces the session row and
   the reducer's state unconditionally, but calls `this.publish([])` only
   when the projector has already reached caught-up. Before that, the
   reducer it just refreshed is exactly what the catch-up tick's own
   publish will carry, so no separate publish is needed or wanted.

## Consequences

- An operator reading the api's log on race day sees the stats line, the
  errors, and the lifecycle events — not one line per probe. `LOG_LEVEL`
  is a seam-4 config name (ADR-0001 §4, extended by ADR-0022 for ingest);
  the api now reads it the same way, default `info`.
- A poll write that did not land is findable in a query for error level;
  `msg` (`"poll write failed"`) is unchanged in shape from ADR-0022's
  convention of a static message plus structured fields.
- A session-row refresh during a restart's re-fold window updates the
  fold but never pushes a partial state to a connected viewer; once
  caught up, a refresh still reaches every viewer within one lifecycle
  check, as ADR-0033 already promised.
- The late-commit detector's rebuild (`runDetector()`) already re-applies
  the projector's current session row before swapping in its freshly
  folded reducer (ADR-0033's fourth consequence); that path is unaffected,
  since `updateSession()`'s own publish guard only changes when the
  *out-of-tick* publish fires, not whether the session row itself is kept
  current.

## References

- ADR-0001 §4 (seam-4 config names, `LOG_LEVEL` among them).
- ADR-0022 (ingest's pino logger and `LOG_LEVEL`, amended here to cover
  the api too).
- ADR-0033 (the session-row refresh this ADR adds the caught-up
  precondition to).
- Issue #357.
