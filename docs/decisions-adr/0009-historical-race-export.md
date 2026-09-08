# ADR-0009 — Historical races: one immutable export per finished session, served by the api, folded in the browser

Status: Accepted
Date: 2026-09-08
Amends: ADR-0004 (the stored model gains a fifth table, `exports`, written only by the api; `sessions.exported_at` is dropped)

## Context

Viewers want to watch past races with the timing board, scrub through them, and use broadcast alignment on them. HLD §7 already fixes the shape: "**Export** = once, when `status = finished` and `exported_at IS NULL`; idempotent; retried by the same check. No separate job." and the planning ground rule "finished races are immutable file exports (DB = system of record, files = distribution format, browser folds them, CDN-able). Never served by folding out of Postgres per request." ADR-0001 §2 invariant 2 forbids touching the database per viewer per tick.

The target home for those files is object storage, which we do not have yet. The owner decided on 2026-09-08 to ship without it.

## Decision

1. **Format.** One file per session, `<session_key>.json.gz`: gzip of
   ```json
   { "schema": 1,
     "exported_at": "…",
     "session": { "session_key": 11361, "name": "Race", "country": "Italy", "circuit_key": 39,
                  "date_start": "…", "date_end": "…", "total_laps": 53, "status": "finished" },
     "events": [ { "event_id": "…", "endpoint": "position", "source_time": "…|null", "payload": { } } ] }
   ```
   `events` is every row of `events` for the session in `seq` order, exactly the four fields the fold reads (`RaceEvent` in `packages/domain`). Nothing else: drivers are events (HLD §7), polls are not part of a race export.
2. **Producer.** The api's exporter, on the same 5 s lifecycle tick that picks the session: for every `sessions` row with `status = 'finished'` that has no `exports` row, compute `exported_at = now()` once, read the events once, write the file to `EXPORT_DIR` (default `./exports`) atomically (temp file, then rename), then insert the `exports` row with that same `exported_at`. The one timestamp is embedded in the file, stored in the row, and used by the etag; they cannot diverge. Idempotent; a failure leaves no `exports` row and the next tick retries. `EXPORT_DIR` joins the seam-4 config names.
   **Table ownership holds.** ADR-0004 and HLD §4 give every table exactly one writer, and ingest owns `sessions`. So the api does not write `sessions`: the export record lives in a fifth table, `exports (session_key bigint primary key references sessions, exported_at timestamptz not null, path text not null)`, written only by the api. The `sessions.exported_at` column from HLD §4 is dropped in the same migration; two writers on one row (ingest's upsert and the exporter) was the footgun this avoids.
3. **Disk is a cache, the database is the record.** Railway's disk is ephemeral. If a request finds an `exports` row but the file missing, the api regenerates the file once (same code path, same embedded `exported_at`, logged) and serves it. That is one read per session per process lifetime, not per viewer.
4. **Serving.** Two routes under the client prefix:
   - `GET /api/races` → the sessions that have an `exports` row, joined to `sessions`: `[{ session_key, name, country, date_start, date_end, total_laps, exported_at }]`, sorted by `date_start` descending.
   - `GET /api/races/:session_key` → the file as `application/json` with `content-encoding: gzip` (pre-compressed bytes, never re-encoded), `cache-control: public, max-age=31536000, immutable`, `etag: "<session_key>-<exported_at epoch ms>"` from the `exports` row; 404 when there is no `exports` row.
   Serving reads the file, not Postgres.
5. **Consumer.** The browser fetches the file, folds it with the shared reducer from `packages/domain`, and owns playback: scrub, play at a chosen speed, and broadcast alignment on top. No server-side replay session exists in the app (the POC's per-tab replay stays in the POC).

## Consequences

- One JSON array per race is enough for v1 (a race is ~28k events, a few MB gzipped). Keyframe + chunk files (HLD §7 "Rewind tiers") come later in the same format family; the index route is where they would be listed.
- When object storage arrives, the exporter writes there instead of `EXPORT_DIR` and `GET /api/races/:session_key` becomes a redirect, which is what `apps/api/AGENTS.md` already says of the route handler: "Finished: redirect to the export." The file format and the browser do not change.
- Netlify's CDN does not cache api responses; the browser's cache does, via the immutable headers. Acceptable for now.
- Loading a past race means running ingest's replay against the deployed database once; the exporter picks it up on the next tick.
- `EXPORT_DIR`'s output is not repo content: `/exports/` is gitignored alongside `/recordings/`.
