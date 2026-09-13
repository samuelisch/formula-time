# ADR-0033 — A session row refresh publishes once, outside the tick cycle

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-13
- **Owner:** Samuel Chan
- **Supersedes:** nothing
- **Amends:** ADR-0014 point 2 (the two named exceptions to a genuine new
  tick that publish `events: []` — catch-up and rebuild — gain a third:
  a session-row refresh outside either. ADR-0013 point 1's delta patch
  "computed once per tick on the server" is untouched: a row refresh
  carries no patch computation, only the session field of the pushed
  state, so it does not conflict with "once per tick" for the delta
  payload itself.)

## Context

Live during the Spanish GP (2026-09-13, 13:04 UTC, four minutes after
lights out): `GET /api/races/11369/events?limit=1` reported the `sessions`
row `status: "live"` while `GET /api/live/snapshot` reported
`state.session.status: "upcoming"` — the projector had folded the session
row once, at construction, and never again, so every viewer on `/live` saw
the pre-race banner for the whole race. The fix (issue #287) makes the
session lifecycle's `runCheck` compare the fields that travel on the wire
on every check and, on any difference, hand the projector the fresh row.

## Decision

The projector's `updateSession()` publishes once, immediately, with
`events: []`, whenever the lifecycle check finds a wire-visible field of
the session row has changed (`status`, `total_laps`, `meeting_name`,
`circuit_short_name`, `location`, `date_start`, `date_end`) — on the
lifecycle's own 5 s check interval, not the projector's 250 ms tick. This
is a third trigger for an out-of-tick `events: []` publish, alongside
ADR-0014 point 2's catch-up and rebuild; like both of those, it is a state
correction, not new events for a client's timeline, so it never sets
`rebuilt: true` and never publishes the fields that changed as `events`.
The poll module receives the same refresh (`total_laps`, `meeting_name`)
so a late `total_laps` (the circuits table case) opens polls on its next
fold without a restart.

## Consequences

- At most one extra push per lifecycle check that finds the session row
  changed — bounded by the check's own 5 s interval, not by push volume;
  a session in steady state (no field changing) adds no push.
- A viewer sees a status flip, or any other refreshed field, within one
  lifecycle check (≤ 5 s) instead of waiting for an api restart.
- Polls read the same refresh in memory, no extra Postgres write: `total_laps`
  arriving late no longer requires a restart to open polls.
- The late-commit detector's rebuild must re-apply the projector's current
  session row immediately before swapping its freshly folded reducer in,
  so a refresh that lands while a rebuild is in flight is never reverted
  by the swap (`apps/api/src/projector/projector.ts`'s `runDetector`).

## References

- ADR-0001 §2 invariant 1 (one shared serialize-once stream per live
  race — this refresh still serializes once, on the lifecycle's own
  interval, never per viewer).
- ADR-0013 point 1 (the delta patch's "once per tick" language, untouched
  by this ADR).
- ADR-0014 point 2 (the two out-of-tick `events: []` exceptions this ADR
  adds a third to).
- Issue #287 (the Spanish GP stale-row incident and this PR).
