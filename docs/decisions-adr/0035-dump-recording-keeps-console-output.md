# ADR-0035 — dump-recording joins the CLI tools that keep console output

Status: Accepted
Date: 2026-09-14
Amends: ADR-0022 (the list of CLI tools exempt from the pino logger gains `dump-recording.ts`), ADR-0029 (§3's closed list `sim/`, `load-recording.ts`, `fetch-race.ts` gains `dump-recording.ts`)

## Context

ADR-0022 moved the ingest service's logging to a pino logger with structured fields, and ADR-0029 finished that move for failures, leaving plain `console.*` output only in the tools a person runs at a terminal: the drip simulator, the recording loader and the race fetcher. Both ADRs name that set as a closed list. `dump-recording.ts` is a new tool of the same kind: an operator runs it over `railway ssh` or locally to write a session back out of Postgres in the recording layout, reads its progress and its usage errors on the terminal, and never runs it as a service. Its output has no lane, no counters a log query would filter on, and no place in Railway's log search.

## Decision

`apps/ingest/src/dump-recording.ts` prints with `console.log` for progress and `console.error` for usage and failure messages, like `load-recording.ts` and `fetch-race.ts`. The exemption list in ADR-0022 and ADR-0029 §3 reads, from this decision on: `sim/`, `load-recording.ts`, `fetch-race.ts`, `dump-recording.ts`. The rule behind the list is unchanged: a process that runs as the ingest service logs through `src/log.ts`; a command a person runs at a terminal prints for that person.

## Consequences

- The acceptance grep used by ingest issues (`grep -rn "console\." apps/ingest/src --include='*.ts' | grep -v "sim/\|load-recording\|fetch-race\|\.test\."`) gains `dump-recording` in its exclusion list.
- A future CLI tool joins the list by amending this ADR; a future service-side module never uses `console.*`.
- `dump-recording.ts` accepts an injected `onLog` callback so tests capture its output without touching the console, the same seam the loader offers.
