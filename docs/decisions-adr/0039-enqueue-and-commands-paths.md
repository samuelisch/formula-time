# ADR-0039 — The queue-and-record path is `openf1/enqueue.ts`; the command-line tools live under `src/commands/`

- **Status:** Accepted
- **Date:** 2026-09-22
- **Owner:** Samuel Chan
- **Amends:** ADR-0034 (its Decision names the path as `emitRows` and `emitTaggedDriverRows` in `apps/ingest/src/openf1/rest-lane.ts`; the mechanism is unchanged, the names and file are these), ADR-0025 (names the loader as `apps/ingest/src/load-recording.ts`), ADR-0035 (names `apps/ingest/src/dump-recording.ts` in the console-output list).

## Context

On main since a prior PR (squash aef4b48), the one queue-and-record path
lives in `apps/ingest/src/openf1/enqueue.ts`, exporting `enqueueRows` and
`enqueueDriverRows`, their result types `EnqueueRowsResult` and
`EnqueueDriverRowsResult`, and the record callback type `RecordRows`
(`export type RecordRows = (sessionKey: number, endpoint: string,
payloads: RawRecord[]) => Promise<void>`). The three command-line tools —
`load-recording.ts`, `fetch-race.ts`, `dump-recording.ts` — now live under
`apps/ingest/src/commands/`, with their built entry points under
`apps/ingest/dist/commands/` (`apps/ingest/package.json`'s `load`,
`fetch-race`, and `dump` scripts run `node dist/commands/<name>.js`).
ADR-0034 and ADR-0025 still name the pre-move file and function names;
ADR-0035's console-output exemption list still names `dump-recording.ts`
by its old path.

An ADR names code by the path and names true at the date it was written;
a later move leaves that prose pointing at a file or export that no
longer exists, and the root AGENTS.md rule is that an accepted ADR is
never edited, only amended. The review of the move that did the renaming
asked for the record to be brought current rather than left to point at
dead paths, so this ADR is that amendment: it changes no behaviour, wire
shape, or mechanism, only the names and paths a reader follows from the
three ADRs above to the code they describe.

## Decision

- The queue-and-record path is `apps/ingest/src/openf1/enqueue.ts`. It
  exports `enqueueRows` and `enqueueDriverRows`, the result types
  `EnqueueRowsResult` and `EnqueueDriverRowsResult`, and the record
  callback type `RecordRows`. This replaces ADR-0034's `emitRows` /
  `emitTaggedDriverRows` in `apps/ingest/src/openf1/rest-lane.ts` as the
  current name and location of that same mechanism.
- The three command-line tools live under `apps/ingest/src/commands/`:
  `load-recording.ts`, `fetch-race.ts`, `dump-recording.ts`. Their built
  entry points live under `apps/ingest/dist/commands/`. This replaces
  ADR-0025's `apps/ingest/src/load-recording.ts` and ADR-0035's
  `apps/ingest/src/dump-recording.ts` as the current paths.
- Nothing about behaviour, wire shape, or ordering changes. ADR-0034's
  rules — record at enqueue time, both lanes, `received_at` as the queue
  time, a rejected append never stops the lane — hold under the
  `enqueue.ts` names. ADR-0035's exemption list — `sim/`,
  `commands/load-recording.ts`, `commands/fetch-race.ts`,
  `commands/dump-recording.ts` keep console output — holds under the
  `commands/` paths.

## Consequences

- A reader following ADR-0034, ADR-0025, or ADR-0035 to a file now finds
  it through this ADR instead of at the path those ADRs name directly.
- The acceptance grep in ingest issues excludes the `commands/` directory
  (`grep -v "commands/"`) instead of the three file names individually.
- A future move of either the queue-and-record path or the command-line
  tools' directory amends this ADR.
