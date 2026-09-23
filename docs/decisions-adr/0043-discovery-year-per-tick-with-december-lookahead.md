# ADR-0043 — Discovery reads the year per tick, with a December lookahead

- **Status:** Accepted
- **Date:** 2026-09-23
- **Owner:** Samuel Chan
- **Amends:** ADR-0025 (its "once per discovery tick" meetings fetch
  becomes once per year fetched, twice in UTC December), ADR-0040 (its
  "unchanged in behaviour" statement about discovery no longer holds for
  the year and the December double fetch)

## Context

`SessionDiscovery` read the calendar year once, at construction, and used
it for every `sessions?year=` and `meetings?year=` fetch for the life of
the process. The ingest service restarts only on a crash, so a process
started before a year boundary kept polling the old year in January: a
January race would never be discovered until someone redeployed.

## Decision

The year is computed at each discovery fetch: `yearOf(nowMs)` returns
`new Date(nowMs).getUTCFullYear()`. A constructor `year` option stays as a
test override that wins over the clock when set.

In UTC month 11 (December), `refreshSessions` and `refreshMeetingNames`
each fetch both `year` and `year + 1`, and concatenate the rows —
deduplicated by `session_key` for sessions and by `meeting_key` for
meetings — so a January race, and its meeting name, are discovered before
its Friday instead of only after the rollover. Each year fetched is its
own request, counted as its own entry in the discovery stats. Outside
December, and whenever the constructor override is set, exactly one year
is fetched, as before.

Everything else ADR-0025 and ADR-0040 decided — the naming-column join,
the file split between `discovery.ts`, `entry-list-fetches.ts` and
`rest-lane.ts` — stands unchanged.

## Consequences

- One extra `sessions?year=` and one extra `meetings?year=` request per
  minute, for the one month of UTC December.
- A January race is discovered, and upserted, before its Friday practice
  session — the api can open its polls without a redeploy at the year
  boundary.
- The startup coverage line (season coverage check) reads the same
  post-fetch snapshot, so a race pulled in by the December lookahead is
  covered by that check too.
