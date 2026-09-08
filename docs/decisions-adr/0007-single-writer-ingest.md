# ADR-0007 — Single-writer ingest: one queue, one connection, seq order equals commit order

Status: Accepted
Date: 2026-09-08

## Context

`events.seq` is assigned at insert time but a row becomes visible to readers only when its transaction commits. With more than one writer connection, a row with seq 100 can become visible after a row with seq 101. A projector whose cursor has passed 101 never reads 100. ADR-0001 §2 invariant 4 forbids patching such a row into running state.

## Decision

1. Both ingest lanes (REST, and MQTT when it lands) feed one in-process queue. One `PrismaClient` created with `createDb(url, { max: 1 })` (ADR-0005) drains it, inserting in arrival order in batches of at most 100 with `createMany({ skipDuplicates: true })`. Ingest never updates an `events` row.
2. Because there is exactly one connection, `seq` order equals commit order, and a cursor that reads `WHERE seq > $cursor ORDER BY seq` cannot skip a committed row.
3. The projector keeps a late-commit detector (re-read a window behind the cursor; an unseen `event_id` below the cursor forces a full rebuild). It is an alarm that must never fire under this decision.
4. ADR-0001 seam 4's config names gain `LIVE_LOG_DIR`: the directory for the jsonl recording (default `./live-logs`), read from the platform secret store like the others.

## Consequences

- Ingest throughput is bounded by one connection; the measured live rate (~27 requests/min, tens of rows per poll) is far below it.
- A second ingest process against the same database would break the guarantee. Exactly one `ingest` service runs (ADR-0001 §1).
- The detector's rebuild path is exercised only by tests until something violates this ADR.
