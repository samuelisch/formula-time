# ADR-0014 — Deep rewind is a browser fold: state pushes carry the events applied that tick

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-09
- **Owner:** Samuel Chan
- **Supersedes:** nothing
- **Amends:** ADR-0001 §3 (the "Deep rewind on live" row: "Keep the POC's
  server-side interim session; browser fold is the target" — the browser
  fold is now the build, no server-side interim session is built in this
  app) and §4 (seam contracts: the push shape gains `events`; the paged
  event log route from issue #102 is the join read); ADR-0013 (Decision
  point 1's delta payload shape, frozen verbatim as `{ type: "delta", seq,
  base_seq, sent_at, session_key, patch, polls }`, gains `events` and,
  conditionally, `rebuilt` — point 4 below)

## Context

Owner decision, 2026-09-09, on PR #112: "we fetch the whole events log so
far of the live race, while having SSE append more events to the tail,
while the live replay goes from a deep rewind." This supersedes the
head-poll design in issue #97 (a client polling a head endpoint for new
events) with an append-only stream: the events a client needs are already
riding the push it already holds open, so no second read path, no
per-viewer poll, and Postgres is touched once per join (the paged log
backfill) and never per viewer per tick — the same invariant 2 that
already governs the projector's own cursor.

## Decision

1. **Wire.** Every `state` frame (snapshot or delta, PR #109's two formats)
   gains `events`: the `RaceEvent` rows (`event_id`, `endpoint`,
   `source_time`, `payload` — exactly the export/paging shape, no `seq`
   field) applied by the projector in the tick that produced this push, in
   seq order; `[]` when the tick applied nothing new. `seq` stays the
   projector cursor after applying them, as today.
2. **Fold resets (catch-up and rebuild) never publish a backlog as
   `events`.** Two ticks re-fold rows the projector has already accounted
   for, rather than genuinely new ones arriving live: the tick where a
   projector first reaches caught-up (a brand new projector, or a restart's
   re-fold from cursor 0 — this *is* "the join snapshot": the state it
   produces is the fold, and the rows behind it are already in the log a
   client backfills separately, so publishing them again as `events` would
   contradict that), and the late-commit detector's rebuild (HLD §7 "Fold":
   never patch in place, always re-fold). Both publish `events: []`; the
   rebuild additionally sets `rebuilt: true` (the catch-up tick does not,
   since no client yet has a timeline to invalidate) so a client that
   already holds one discards it and backfills again from the paged log
   route.
3. **Client reconstruction (issue #102, the paged read).** A client
   backfills `GET /api/races/:key/events` pages from 0 until a short page,
   then appends the `events` of every push whose events it has not seen,
   deduped by `event_id`. The overlap between the last backfilled page and
   the first pushes received while backfilling is expected and harmless.
4. **Both wire formats carry it.** ADR-0013's delta frame is built
   field-by-field from the previous and current `RaceState`, never a
   pass-through of the pushed payload — so the fields that shape froze
   (`{ type: "delta", seq, base_seq, sent_at, session_key, patch, polls }`)
   are exactly the fields it is built from, and `events`/`rebuilt` must be
   added there the same way, not inherited for free. `events`/`rebuilt` are
   threaded through it exactly like `polls` already is, so a delta-format
   socket sees `events` on every push, same as a legacy `state`-format
   socket.

## Consequences

- One read per join (the paged backfill), zero per tick: Postgres is
  untouched by this change (invariant 2 unaffected).
- A client's event timeline is a cache it builds itself from the stream;
  it is never an authority — polls and votes are untouched by this ADR.
- A rebuild invalidates a client's timeline via `rebuilt: true`; the client
  re-derives it from a fresh backfill, never patches it in place, mirroring
  the server's own "never patch in place" rule for the fold.
- The POC's server-side interim session (ADR-0001 §3's "Deep rewind on
  live" row) is not built in this app; the browser fold replaces it, as
  ADR-0001 §3 named as the eventual target.
- A tick applies a handful of rows (OpenF1 batches roughly every 4 s), so
  this adds a few KB per push at real, 1x cadence. Measured against a 20x
  replay (`.claude/skills/rehearse-race`, 30 s sample, 46 pushes): median
  frame size rose from 58,861 to 89,391 bytes (uncompressed JSON) with a
  median 100 events per push — a 20x-compressed worst case (real cadence
  batches far fewer rows per 250 ms tick), reported in full in the PR.

## References

- ADR-0001 §2 (invariant 2: Postgres touched per event and per join, never
  per viewer per tick), §3 (the "Deep rewind on live" row this amends), §4
  (seam contracts, build order).
- ADR-0013 (delta pushes: the two wire formats this ADR's point 4 threads
  `events`/`rebuilt` through).
- Issue #97 (the superseded head-poll design), issue #102 (the paged event
  log route this ADR's client reconstruction depends on), issue #114 (this
  PR).
