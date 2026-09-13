# ADR-0029 — Ingest's stats line and error-level logging

Status: Accepted
Date: 2026-09-13
Amends: ADR-0022 (the lane and writer callback gains an optional level and fields argument; failures log at level error through the same logger; the per-minute stats line replaces the MQTT lane's own line)

## Context

The MQTT lane alone reported a per-minute line (`mqtt: last 60s messages= rows= dropped=`); the REST lane and the writer had no equivalent. The writer reported its failures through `console.error`, built from a formatted string with no fields, bypassing the structured logger ADR-0022 introduced entirely.

## Decision

1. One line per minute from `main.ts`, `ingest: last 60s`, with fields `rest_polls`, `rest_rows`, `rest_errors`, `mqtt_messages`, `mqtt_rows`, `mqtt_dropped`, `writer_inserted`, `writer_skipped`, `writer_failures`, `queue_depth`, `session_key`, `build`. Each lane and the writer expose a `takeStats()` that returns and resets its own counters since the previous call. The MQTT lane's own per-minute line and its internal timer are removed in favor of this one line.
2. The injected `log` callback gains an optional second argument, `{ level?: "info" | "error"; fields?: Record<string, number | string> }`. Every call written against the old single-argument shape stays valid, defaulting to `level: "info"` with no extra fields. `main.ts` dispatches `logger[level]({ lane, ...fields, ...countFields(message) }, message)`.
3. Every `console.error` in `writer/writer.ts` and `main.ts` becomes this call at `level: "error"`, with the relevant counts passed as fields. `openf1/auth.ts`'s `expires_in` warning moves to the same injected-log pattern, wired by `main.ts`. `console.*` remains only in the CLI tools (`sim/`, `load-recording.ts`, `fetch-race.ts`).

## Consequences

- One line to grep in a deploy check (`ingest: last 60s`) instead of two, carrying every lane's and the writer's health in one place.
- A failure line always carries its counts as structured fields, queryable the same way a routine line's counts already are.
- ADR-0022's Consequences named the `console.error` conversions "the next candidate for the same logger" — this ADR is that candidate, done.
