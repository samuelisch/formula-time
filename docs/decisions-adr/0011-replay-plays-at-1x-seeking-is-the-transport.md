# ADR-0011 — Replay plays at 1×; seeking is the transport

Status: Proposed (accepted when this PR merges)
Date: 2026-09-09
Owner: Samuel Chan
Amends: ADR-0009 §5 (only the clause "play at a chosen speed"; the rest of §5 stands)

## Context

ADR-0009 §5 says the browser, having folded an exported race, "owns playback: scrub, play at a chosen speed, and broadcast alignment on top." Issue #81 unifies the live delay control and the replay transport behind one seam and, in the owner's words from that issue: "remove the timing multiplier" (no 5×/20×; data plays at 1×).

The replay is time-shifted real data, not a simulation a viewer tunes for pacing: every source timestamp already happened at a fixed cadence, and the transport this issue builds (`Race start`, a lap-number jump, ±5 s/±10 s nudges, and lap ticks with snap on the position slider) already gives a viewer every way to get to a point in the race faster than watching it unfold. A 5×/20× multiplier served exactly one purpose -- skipping ahead quickly -- that seeking now serves directly and more precisely (a specific lap or a specific offset, not "keep fast-forwarding until it looks right"). Keeping the multiplier would also mean two ways to move through the timeline with independent, overlapping code paths (`PlaybackClock`'s `speed` and the new `TimeTarget.seekTo`/`nudge`), which is the kind of duplication ADR-0001's seam discipline exists to avoid.

## Decision

1. Replay playback runs at 1× only. There is no speed control in the UI and no `speed`/`setSpeed` in `PlaybackClock` or `useReplayPlayback`.
2. Movement through the timeline other than 1× playback is by seeking: `Race start`, a lap-number jump, and the ±5 s/±10 s nudges all move the position directly (and pause playback) rather than changing its rate.
3. Live and replay share one seam for this, `apps/web/src/transport/TimeTarget.ts` (the `TimeTarget` interface, `TimeTargetProvider`, `useTimeTarget()`), so `TransportBar` is the same component and carries no speed concept for either.

## Consequences

- `PlaybackSpeed`, `PlaybackClock.speed()`/`setSpeed()`, and `ReplayPlayback.speed`/`setSpeed` are removed (issue #81 PR 1); any earlier reference to a 5×/20× control is stale.
- A future "watch at 2× for highlights" request would supersede this ADR, not just add a flag back in -- it would need to say whether it applies to live delay too, since the two now share one seam.
- `ADRs affected` lines for work touching replay playback or the transport seam should cite this ADR in addition to ADR-0009.
