# ADR-0038 — A reconnect resumes the browser timeline from the head seq

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-22
- **Owner:** Samuel Chan
- **Amends:** ADR-0014 (Decision point 3: "A client backfills
  `GET /api/races/:key/events` pages from 0 until a short page"; the
  starting seq now depends on why the backfill runs).

## Context

ADR-0014 makes the browser rebuild its timeline from the paged log route
on every join, and discard and rebuild it on a `rebuilt: true` push. The
hook that does this (`apps/web/src/live/useSessionTimeline.ts`) also
restarted from seq 0 whenever the stream connection left `"open"`. For the
Spanish GP that meant 37,542 events in 8 pages, about 25 MB parsed, per
viewer, and an api restart mid-race made every connected viewer do it at
once with no cache in front of the api.

The log is append-only with one writer per session (ADR-0007, ADR-0010),
so after a plain reconnect the events a client already folded are still
the first `headSeq` rows of the log. Only a `rebuilt` push (a late commit,
a skipped frame, a failed push, or a client-side gap; ADR-0014, ADR-0032)
means those rows can no longer be trusted.

## Decision

1. On the first join and on a push with `rebuilt: true`, the client pages
   from seq 0 until a short page, as ADR-0014 point 3 states.
2. On the stream connection leaving `"open"` while the session is not
   finished, the client keeps its timeline and pages from its current head
   seq until a short page, appending into the same timeline. Pushes that
   arrive during the resume are buffered and appended after the resumed
   pages, deduplicated by `event_id`, exactly as during a first join.
3. A page fetch that fails during a resume retries at the same backoff as
   a first join. `loading` stays false during a resume; `error` is set and
   cleared as before.

## Consequences

- One small request per reconnect instead of the whole log; an api restart
  no longer makes every viewer re-download the race.
- The invariant this rests on is one writer per session and an
  append-only log. A change that lets rows before the head seq change
  without a `rebuilt` push breaks this and must supersede this ADR.
- ADR-0014's point 3 reads as the first-join and `rebuilt` case; the
  reconnect case is this ADR.
