# ADR-0032 — A skipped or rejected push marks the next one rebuilt

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-13
- **Owner:** Samuel Chan
- **Amends:** ADR-0014 (point 2: `rebuilt: true` is set only on the
  late-commit detector's rebuild push; this ADR adds two new causes,
  making four in total alongside the two `rebuilt`'s own doc already
  named)

Next free ADR number as of this PR: checked `origin/main` (highest
`0031-health-reports-database-reachability.md`) and every open PR's
changed files (`gh pr list --state open --json number,files`), neither of
which added a decisions-adr file — so `0032` is the next free number.

## Context

Found by review of the fan-out's deflate guard (`fanout.ts`'s `deliver()`
already logs and skips a frame on a deflate write error, and
`session-lifecycle.ts`'s subscriber chain already logs and swallows a
rejected `pusher.push()`, both so the process itself never dies): neither
path told a connected client anything. `rebuilt`'s own doc comment
(`StatePush`/`DeltaPush`, `packages/domain/src/wire.ts`) already names two
causes — the server's own late-commit rebuild, and the client's own
delta-stream gap detection marking the push that resolves it — but
ADR-0014's decision text ties `rebuilt: true` strictly to the late-commit
rebuild (its point 2: "the rebuild additionally sets `rebuilt: true`"). A
skipped or rejected push is a different situation with the same
consequence — that tick's `events` reached no connected client — but under
ADR-0014's text alone, nothing signals it. A client that stayed connected
across the gap kept a permanent hole in its deep-rewind timeline; only a
reconnecting client (which always re-backfills) was unaffected.

## Decision

Two new causes, counting alongside the two `rebuilt`'s doc already named
(the late-commit rebuild, the client's own gap detection) as the third
and fourth:

- **Third cause — a fan-out-level skip.** `Fanout.deliver()` remembers a
  deflate-skipped frame (`skippedSinceLastDelivery`) and forces the next
  frame it actually delivers to be a full `state` push carrying
  `rebuilt: true`, overriding whatever the caller set, then clears the
  flag — left set if that next delivery also fails to deflate.
- **Fourth cause — a rejected push.** `session-lifecycle.ts` tracks a
  rejected `pusher.push()` the same way, independently (the fan-out's own
  `skippedSinceLastDelivery` cannot see this: its `push()` swallows every
  internal failure rather than reject, so this path only ever fires for a
  failure upstream of the fan-out, e.g. a poll-fold rejection). A flag
  set only in the subscriber chain's `.catch()`, consumed (read, then
  cleared) only where the next payload is built, reset nowhere else.
  Ticks run on a fixed interval regardless of whether the previous tick's
  push has settled, so if push N is still in flight when N+1's payload is
  built, N+1 goes out without `rebuilt` and N's rejection is only
  observed afterward. The guarantee is precise: the first payload built
  once the rejection *is* observed carries `rebuilt: true` — N+2 at the
  latest, since the tick interval vastly exceeds a promise settling, never
  later — and no payload built after that point goes out without it.
- The forced frame (third cause) is a full `state` push, never a `delta`,
  on both socket formats. This is not because a delta's `patch` would be
  wrong: `diffState` is a full structural diff between the previous and
  current `RaceState`, so it already spans the skipped tick's changes
  correctly. What a patch cannot carry back is the skipped tick's own
  `events` rows (the discrete applied-event log, not derivable from a
  before/after state diff) — the actual reason `rebuilt: true` is needed
  at all. Forcing a full state frame here simply reuses the same fallback
  path the keyframe mechanism already takes (`buildDeltaFrame` returning
  `null`), so every socket format gets identical bytes for that one tick.
- `packages/domain/src/wire.ts`'s `rebuilt` doc comment on `StatePush`
  names both new causes directly, in the same sentence style as the two
  it already carried, since the field's own doc is the seam's source of
  truth for this vocabulary. `apps/web/src/live/timeline.ts` needs no
  change: it already re-backfills on any `rebuilt: true` push.

## Consequences

- A client that stays connected across a skipped or rejected push no
  longer keeps a silent hole in its deep-rewind timeline: the next state
  it receives tells it to discard and re-backfill, the same signal a
  reconnecting client already gets, within one tick interval of the
  failure being observed.
- One extra full `state` push (instead of a `delta`) immediately after a
  skip — a bounded, one-tick cost, not a per-viewer or per-tick one;
  ADR-0001 invariant 2 is unaffected (no extra database read).
- The fan-out and session-lifecycle track this independently by design;
  neither shares state with the other, and each accepts a bounded,
  documented delay (at most one extra tick) rather than a stronger
  cross-layer ordering guarantee that would need one.

## References

- ADR-0014 (deep rewind, `rebuilt`'s original meaning and wire shape).
- `apps/api/src/fanout/fanout.ts` (`Fanout.deliver()`,
  `skippedSinceLastDelivery`), `apps/api/src/session-lifecycle.ts`
  (`wireProjector()`, `skippedSinceLastPush`), `packages/domain/src/wire.ts`
  (`StatePush.rebuilt`'s doc).
