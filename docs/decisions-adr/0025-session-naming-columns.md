# ADR-0025 — `sessions` gains `meeting_name`, `circuit_short_name`, `location`

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-12
- **Owner:** Samuel Chan
- **Amends:** ADR-0004 (the stored model's `Session` shape) and HLD §4 (the
  `sessions` columns).

## Context

A race is currently named by `country` and `circuit_key` alone. 2026 puts
two rounds in the same country: Spain at Barcelona-Catalunya in June
(session 11307) and at Madring, Madrid in September (session 11369). Both
read "Spain · Race" today — nothing in the stored row distinguishes them,
and nothing names the Grand Prix itself. Owner ask, 2026-09-12: "put the
actual grand prix name as the race, and description on where, and all
that."

Measured 2026-09-12 against OpenF1: `GET /v1/sessions?year=2026` rows carry
`circuit_short_name` (e.g. "Monza"), `location` ("Monza"), `country_name`,
`meeting_key`. `GET /v1/meetings?meeting_key=1293` carries `meeting_name`
("Italian Grand Prix"), `meeting_official_name`, `circuit_short_name`,
`location`. The session row never carries the Grand Prix name itself; it
lives only on the separate `meetings` resource, joined by `meeting_key`.

## Decision

`sessions` gains three nullable text columns, one Prisma migration:
`meeting_name`, `circuit_short_name`, `location`. Nullable so an existing
row, or a discovery tick whose meetings fetch failed, still writes —
nothing here is a precondition for a session to exist.

`sessionFieldsFromRaw` (`apps/ingest/src/writer/sessions.ts`) fills
`circuit_short_name` and `location` straight from the raw `sessions` row.
`meeting_name` is joined from a caller-supplied `meeting_key ->
meeting_name` map, since the session row never carries it:

- The REST lane (`apps/ingest/src/openf1/rest-lane.ts`) fetches
  `meetings?year=<year>` once per discovery tick, alongside the `sessions`
  snapshot, and caches the resulting map in memory; a fetch failure keeps
  the previous tick's map rather than clearing it.
- The recording loader and `fetch-race` (both funnel through the shared
  `writeSessionThroughLoader` in `apps/ingest/src/load-recording.ts`) fetch
  `meetings?meeting_key=` once per session they write, reusing the same
  one-entry map for both the `upcoming` and `finished` upserts of that
  session.

`upsertSession`'s `update` includes all three fields, so a rerun (or a
`--replace` reload) fills them on an already-existing row once a map entry
is available — no backfill migration needed, only a rerun.

A missing `meeting_key`, a failed meetings fetch, or a response with no
usable `meeting_name` all resolve to `null`, the same as any other
unavailable field — never a guess.

## Consequences

- Two rounds in the same country are now distinguishable in the stored
  model by `meeting_name` (and by `circuit_short_name`, which differs
  between them even though `country` doesn't).
- One extra OpenF1 request per discovery tick (REST lane) and per session
  written (loader, `fetch-race`) — within the existing rate budget for all
  three call sites.
- Existing rows backfill only when rewritten: the owner's planned
  `--replace` re-run (shared with the lap-row-normalisation work, issue
  #244) is what actually populates `meeting_name` for sessions already in
  the database, not this migration by itself.
