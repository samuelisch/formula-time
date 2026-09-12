# ADR-0026 — The export document and the races index carry the session's naming fields

Status: Accepted
Date: 2026-09-12
Amends: ADR-0009 (§1 the export document's `session` object, §4 the `GET /api/races` entry shape)

## Context

ADR-0009 §1 and §4 name the export document's `session` object and the `/api/races` entry shape verbatim. ADR-0025 added `meeting_name`, `circuit_short_name`, `location` to the stored `sessions` row so a race can be named by its Grand Prix and circuit, not just `country` and `circuit_key`. ADR-0025 amends only ADR-0004 and HLD §4 (the stored columns); it does not touch ADR-0009's wire shapes, which this ADR does.

## Decision

Both wire shapes ADR-0009 names, and the live push's `state.session` (`sessionAsRawRecord()` in `apps/api/src/projector/projector.ts`), carry the same three fields as `string | null`, always present, never omitted:

- The export document's `session` object (ADR-0009 §1) gains `meeting_name`, `circuit_short_name`, `location`.
- The `GET /api/races` entry (ADR-0009 §4) gains the same three fields.

The export `schema` stays `1`: the change is additive and nullable, so a file written before this change is read as if the three fields were `null` — no existing reader breaks, and no migration of already-written files is needed.

## Consequences

- The web reads `meeting_name`, `circuit_short_name`, `location` from any of the three surfaces (export file, races index, live push) with the same null rule.
- A re-export after a reload (the owner's `--replace` re-run, ADR-0025) carries the fields once ingest has filled them.
- No reader of an old export file breaks: the three fields are additive and nullable, so an old file simply reads as `null` on all three.
