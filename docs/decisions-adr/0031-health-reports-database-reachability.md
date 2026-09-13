# ADR-0031 — /health reports database reachability

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-13
- **Owner:** Samuel Chan
- **Amends:** ADR-0021 (the `/health` response shape: this ADR adds a
  field alongside the `build` field ADR-0021 introduced)

Next free ADR number as of this PR: checked `origin/main` (highest
`0028-manual-railway-apply-uses-the-cli.md`) and every open PR's changed
files (`gh pr list --state open --json files`), which carry
`0029-ingest-stats-line-and-error-logging.md` (#279) and
`0030-rest-tick-by-tier.md` (#284/#285/#286, a stacked series sharing one
file) — so `0031` is the next free number.

## Context

An operator watching `/health` (or Railway's own healthcheck, which polls
the same endpoint) could not tell a dead database from an idle,
session-less api process: both answered `{"ok":true,...}` with no signal
that reads to Postgres were failing. Architecture review 2026-09-13
(finding V5) also found that the fan-out's and projector's own counters
(viewers, push rate, bytes per push per format, slow-client drops, cursor
lag) reached nobody unless someone tailed the log for a rare line.

## Decision

- `/health` gains `db: "ok" | "unreachable"`, from one cached `SELECT 1`
  refreshed every 30 s, never run per request. `ok` at the top level of
  the response stays `true` while the process is serving — the projector
  keeps its fold regardless of the database's reachability (degrade, do
  not die); `db` is informational only and never gates `ok`.
- Every 60 s the api logs one structured line, `api: last 60s`, with
  fields `viewers`, `delta_viewers`, `pushes`, `state_bytes_gz` (summed),
  `delta_bytes_gz` (summed), `slow_drops`, `cursor`, `caught_up`,
  `session_key`, `build` — the same shape and cadence as ingest's own
  `mqtt: last 60s` / `ingest: last 60s` line (ADR-0022, ADR-0029), so one
  log query reads every service. The four counters live in `Fanout` and
  are read and reset in one step by `statsSnapshot()`; the rest are live
  gauges read fresh each time from the fan-out and the session
  lifecycle's `health()`.

## Consequences

- One lightweight query (`SELECT 1`) every 30 s per api process — ADR-0001
  invariant 2 ("Postgres is touched per event and per join, never per
  viewer per tick") permits this: it is a fixed per-process interval, not
  a per-viewer or per-tick cost, so it does not reintroduce the scaling
  problem that invariant guards against.
- Railway's healthcheck (which polls `/health`) never restarts the api
  purely for a database outage — a dead database degrades reads, it does
  not make the running process itself unhealthy.
- An operator (or a log query) can read viewer counts, push volume, bytes
  per format, drops and cursor lag once a minute without a metrics stack,
  closing architecture review finding V5 for the api side.

ADRs affected: 0021, 0031: `/health` gains `db` and the api logs a stats
line; 0031 amends 0021's response shape.
