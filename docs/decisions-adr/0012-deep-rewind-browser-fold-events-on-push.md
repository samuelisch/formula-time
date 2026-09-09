# ADR-0012 — Deep rewind is a browser fold: state pushes carry the events applied that tick

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-09
- **Owner:** Samuel Chan
- **Supersedes:** nothing
- **Amends:** ADR-0001 §3 (the "Deep rewind on live" row: "Keep the POC's
  server-side interim session; browser fold is the target" — the browser
  fold is now the build, no server-side interim session is built in this
  app) and §4 (seam contracts: the push shape gains `events`; the paged
  event log route from issue #102 is the join read)

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
   seq order; `[]` when the tick applied nothing new (including the join
   snapshot itself — the state is the fold, the events are already in the
   log a client backfills separately). `seq` stays the projector cursor
   after applying them, as today.
2. **Rebuild.** The late-commit detector's rebuild (HLD §7 "Fold": never
   patch in place, always re-fold) pushes `events: []` with `rebuilt: true`
   — a rebuild re-folds rows already accounted for (plus the late one), not
   new events for a client's timeline to append. A client that sees
   `rebuilt: true` must discard its timeline and backfill again from the
   paged log route.
3. **Client reconstruction (issue #102, the paged read).** A client
   backfills `GET /api/races/:key/events` pages from 0 until a short page,
   then appends the `events` of every push whose events it has not seen,
   deduped by `event_id`. The overlap between the last backfilled page and
   the first pushes received while backfilling is expected and harmless.
4. **Both wire formats carry it.** PR #109's delta frame is not a
   pass-through of the pushed payload — it is built field-by-field from the
   previous and current `RaceState`. `events`/`rebuilt` are threaded through
   it exactly like `polls` already is, so a delta-format socket sees
   `events` on every push, same as a legacy `state`-format socket.

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
  this adds a few KB per push — measured in the PR that introduced this
  ADR.

## References

- ADR-0001 §2 (invariant 2: Postgres touched per event and per join, never
  per viewer per tick), §3 (the "Deep rewind on live" row this amends), §4
  (seam contracts, build order).
- ADR-0011 (delta pushes: the two wire formats this ADR's point 4 threads
  `events`/`rebuilt` through).
- Issue #97 (the superseded head-poll design), issue #102 (the paged event
  log route this ADR's client reconstruction depends on), issue #114 (this
  PR).
