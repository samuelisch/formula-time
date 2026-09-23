# ADR-0040 — Discovery and the entry-list fetches have their own files

- **Status:** Accepted
- **Date:** 2026-09-22
- **Owner:** Samuel Chan
- **Amends:** ADR-0025 (its Decision names
  `apps/ingest/src/openf1/rest-lane.ts` as the file that fetches
  `meetings?year=` once per discovery tick and keeps the previous map on a
  failed fetch; that logic now lives in `openf1/discovery.ts` as
  `SessionDiscovery`, unchanged in behaviour)

## Context

`apps/ingest/src/openf1/rest-lane.ts` held three responsibilities in one
844-line class: session discovery (the `sessions?year=` and
`meetings?year=` snapshot, the session keys whose upsert has landed, the
followed session's `meetings` row), the three entry-list drivers fetches
with their retry state, and the tick loop with the session selection and
the weighted rotation. Its test file was the largest in ingest. A reader
sent to the file by an ADR or by the README had to find the one part they
wanted inside all three.

## Decision

The REST lane is three files, each owning its own state:

- `apps/ingest/src/openf1/discovery.ts` — `SessionDiscovery`: the
  `sessions?year=` snapshot, the `meeting_key -> meeting_name` map and the
  raw `meetings?year=` rows, the session keys whose `sessions` upsert has
  landed, the refresh cadence, and the once-per-session recording of the
  followed session's own `meetings` row.
- `apps/ingest/src/openf1/entry-list-fetches.ts` — `EntryListFetches`: the
  selection fetch and its static-list fallback, the pre-race refresh, the
  Friday meeting-wide fetch, and the budget rule of at most one drivers
  fetch per tick.
- `apps/ingest/src/openf1/rest-lane.ts` — `RestLane`: the tick loop, the
  session selection, the weighted rotation, the shared normalizer and
  session key, the recording count and the one `takeStats()`.

`RestLane` constructs the other two and hands them the fetcher, the
callbacks and a stats sink; neither of them imports `rest-lane.ts`. The
public surface `main.ts` and `mqtt-lane.ts` use — `start`, `stop`,
`status`, `getNormalizer`, `takeStats`, `discoverOnce`, `pollOnce` — is
unchanged, and so is every log line.

## Consequences

- A reader following ADR-0025 to the `meetings?year=` fetch finds it in
  `openf1/discovery.ts` through this ADR; ADR-0025's own decision about
  what is fetched, cached and joined is untouched.
- A future move of any of these three responsibilities amends this ADR
  rather than editing it.
- `apps/ingest/README.md`'s rules table, entry-list section and reading
  order name the file that holds each fact, so the same rename discipline
  applies there.
