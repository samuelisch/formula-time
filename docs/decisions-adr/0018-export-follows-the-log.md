# ADR-0018 — Export follows the log: a session is re-exported when its events are newer than its export

Status: Proposed
Date: 2026-09-10
Amends: ADR-0009 §2 (export once) and §3 (regenerate only a missing file)

## Context

ADR-0009 §2 makes an export happen once: "for every `sessions` row with
`status = 'finished'` that has no `exports` row" the exporter writes the
file and inserts the `exports` row. ADR-0009 §3, "Disk is a cache, the
database is the record.", regenerates a file only when it is missing from
disk, always with the row's existing `exported_at`. Neither path revisits a
session once it has an `exports` row.

Issue #165 gives ingest a way to reload a session's events. After a reload,
the `exports` row already exists, so ADR-0009 §2 never re-runs and ADR-0009
§3 never fires (the file is still on disk). The owner's report of
2026-09-10, replaying session 11361 after a reload, showed only position
changes: the served file was the stale, endpoint-ordered export from before
the reload, not the reloaded log.

## Decision

The exporter's tick considers a session stale when it has an `exports` row
and `events` holds at least one row received after that row's
`exported_at`, for that `session_key`. A stale session is re-exported
exactly like a new one: compute `exported_at = now()` once, read the
events by `seq`, write the file atomically, then `UPDATE exports SET
exported_at, path` in one statement. One query per tick finds both kinds
of candidate, as two halves unioned: `sessions` with no `exports` row
(new -- no need to look at `events` at all), and `sessions` with an
`exports` row where `events` has a row received after `exported_at`
(stale, an `EXISTS` per `exports` row, not a `GROUP BY` aggregate over the
whole table). It runs every 5 s, not per viewer and not per tick of the
projector (invariant 2 untouched); `exports` holds only finished,
already-exported sessions (a few rows), so the stale half is a few short,
per-session scans. `events_session_key_source_time_idx` (`session_key,
source_time`) narrows each such scan to that session's rows via its
leading column; it does not cover `received_at` itself, so within one
session's rows the check still has to look at `received_at` row by row.

Serving is unchanged: `etag` already encodes `exported_at`; `cache-control:
public, max-age=31536000, immutable` stays, because the URL becomes
versioned on the web side (#167: the replay fetches
`/api/races/:key?v=<exported_at epoch ms>`); the route ignores `v`.

`GET /api/races` is unchanged; its `exported_at` is what the web uses as
`v`.

## Consequences

- A reload makes a new version of the file within one tick.
- Old browser caches are busted by the versioned URL, not by the immutable
  cache-control header changing.
- `exported_at` in the index is now the file's version, not a one-time
  stamp: a viewer that already has a race's index entry cached must refetch
  the index to notice a later `exported_at`.

ADRs affected: 0018: the exporter re-exports a session whose events are newer than its export, amending ADR-0009 §2 (export once) and §3 (regenerate only a missing file)
