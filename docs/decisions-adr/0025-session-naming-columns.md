# ADR-0025 — `sessions` gains `meeting_name`, `circuit_short_name`, `location`

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-12
- **Owner:** Samuel Chan
- **Amends:** ADR-0004 (the stored model's `Session` shape) and HLD §4 (the
  `sessions` columns); ADR-0009 §1 (the export's `session` object) and §4
  (the races index) — see "API-side exposure" below.

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
  `writeSessionThroughLoader` in `apps/ingest/src/load-recording.ts`) each
  build the map for the one session they write, reusing it for both the
  `upcoming` and `finished` upserts of that session. `fetch-race` fetches
  `meetings?meeting_key=` live. The loader tries two sources in order:
  first its recording's own `raw/meetings.jsonl` (present whenever the
  session was captured live, or fetched via `fetch-race`, after this
  feature shipped — the REST lane routes its own meetings fetch through
  the same `onNewRows` → jsonl-recorder path every other endpoint uses);
  when that file is absent or empty (an older recording), it falls back to
  one live `meetings?meeting_key=` call through the same OpenF1 client
  `fetch-race` uses, only when OpenF1 credentials are configured in the
  environment. With neither source available, it logs one line and leaves
  `meeting_name` null for that run.
- Every source that returns more than one row (a shared/root-mode
  recording, an unexpected API response) is filtered to the row whose own
  `meeting_key` matches the session's before its `meeting_name` is taken —
  never the first row blindly.

`upsertSession`'s `update` merges rather than replaces: a naming column
this run has no answer for (an empty map entry, or a raw row missing
`circuit_short_name`/`location`) is left out of the `update` payload
entirely, so it never overwrites a value an earlier run already found with
`null`. A rerun (or a `--replace` reload) with a real answer still fills or
corrects the column on an already-existing row — it just never blanks one.

A missing `meeting_key`, a failed meetings fetch, or a response with no
usable `meeting_name` all resolve to `null`, the same as any other
unavailable field — never a guess.

## API-side exposure

The three columns also surface, nullable, wherever a session is already
described to a client or exported, unchanged in shape otherwise:

- `GET /api/races` — each entry gains `meeting_name`, `circuit_short_name`,
  `location`.
- The export's `session` object (ADR-0009 §1) gains the same three fields.
- The live push's `state.session` (the SSE `state`/`delta` frames) gains
  them too.

No new resource, no new schema version — additive fields on the session
object everywhere it already appears, null until a write populates them.

## Consequences

- Two rounds in the same country are now distinguishable in the stored
  model, the races index, the export, and the live push by `meeting_name`
  (and by `circuit_short_name`, which differs between them even though
  `country` doesn't).
- One extra OpenF1 request per discovery tick (REST lane) and per session
  written (loader, `fetch-race`) — within the existing rate budget for all
  three call sites; the loader's live fallback adds at most one more,
  and only when its recording lacks `raw/meetings.jsonl` and credentials
  are configured.
- A row written before this feature shipped, or loaded from a recording
  that predates it, keeps `meeting_name` null until some run supplies an
  answer (a rerun, `--replace`, or the loader's live fallback) — the
  owner's planned re-run (shared with the lap-row-normalisation work,
  issue #244) is what actually populates it for sessions already in the
  database, not this migration by itself.
