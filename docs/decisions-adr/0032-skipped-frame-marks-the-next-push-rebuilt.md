# ADR-0032 — A skipped or rejected push marks the next one rebuilt

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-13
- **Owner:** Samuel Chan
- **Amends:** ADR-0014 (point 2: `rebuilt: true` is set only on the
  late-commit detector's rebuild push; this ADR adds a second cause)

Next free ADR number as of this PR: checked `origin/main` (highest
`0031-health-reports-database-reachability.md`) and every open PR's
changed files (`gh pr list --state open --json number,files`), neither of
which added a decisions-adr file — so `0032` is the next free number.

## Context

Found by review of the fan-out's deflate guard (`fanout.ts`'s `deliver()`
already logs and skips a frame on a deflate write error, and
`session-lifecycle.ts`'s subscriber chain already logs and swallows a
rejected `pusher.push()`, both so the process itself never dies): neither
path told a connected client anything. ADR-0014 ties `rebuilt: true`
strictly to the projector's late-commit rebuild (its point 2: "the rebuild
additionally sets `rebuilt: true`"); a skipped or rejected push is a
different situation with the same consequence — that tick's `events`
reached no connected client — but under ADR-0014's text alone, nothing
signals it. A client that stayed connected across the gap keeps a
permanent hole in its deep-rewind timeline; only a reconnecting client
(which always re-backfills) was unaffected.

## Decision

- The fan-out (`Fanout.deliver()`) remembers a skipped frame
  (`skippedSinceLastDelivery`) and forces the next frame it actually
  delivers to be a full `state` push carrying `rebuilt: true`, overriding
  whatever the caller set, then clears the flag — left set if that next
  delivery also fails to deflate. On the delta path the same flag forces
  the next frame to be a full `state` push instead of a `delta`: a delta's
  `base_seq` would still match the previous successfully delivered state,
  but its `patch` would omit the skipped tick's changes.
- `session-lifecycle.ts` mirrors this independently for a rejected
  `pusher.push()` (a failure the fan-out itself cannot see, since
  `push()` resolving is what the fan-out's own skip-tracking depends on):
  a rejected push sets a flag that marks the next payload built for this
  projector `rebuilt: true`, then clears.
- No wire or type change: `rebuilt` (`StatePush`/`DeltaPush`,
  `packages/domain/src/wire.ts`) already carries this meaning to the
  client — its doc already reads "Set when the server rebuilt `RaceState`
  from the fold after a late-commit alarm, **or** the client's own
  delta-stream gap detection marks the push that resolves it -- both mean
  the same thing to a client's deep-rewind timeline: discard it and
  re-backfill." This ADR adds a third server-side cause behind the same
  field and doc; the client (`apps/web/src/live/timeline.ts`) needs no
  change, since it already re-backfills on any `rebuilt: true`.

## Consequences

- A client that stays connected across a skipped or rejected push no
  longer keeps a silent hole in its deep-rewind timeline: the next state
  it receives tells it to discard and re-backfill, the same signal a
  reconnecting client already gets.
- One extra full `state` push (instead of a `delta`) immediately after a
  skip — a bounded, one-tick cost, not a per-viewer or per-tick one; ADR-0001
  invariant 2 is unaffected (no extra database read).
- The fan-out and session-lifecycle track this independently, by design:
  a fan-out-level skip (deflate failure) and a caller-level rejection are
  different failure points, and neither can observe the other's flag
  without a shared mutable channel this ADR does not introduce.

## References

- ADR-0014 (deep rewind, `rebuilt`'s original meaning and wire shape).
- `apps/api/src/fanout/fanout.ts` (`Fanout.deliver()`,
  `skippedSinceLastDelivery`), `apps/api/src/session-lifecycle.ts`
  (`wireProjector()`, `skippedSinceLastPush`).
