# ADR-0011 — Delta pushes: snapshot on join, deltas in steady state, gap means snapshot

- **Status:** Accepted
- **Date:** 2026-09-09
- **Owner:** Samuel Chan
- **Supersedes:** nothing
- **Amends:** ADR-0001 (§2 invariant 1 "one shared serialize-once stream per live race" is read as "serialise once per wire format in use, never per viewer"; two formats exist only while the web app migrates from full-state pushes)

## Context

ADR-0001's consequences named this as unavoidable, not optional: "Egress
and full-state payload size (~85 KB × viewers × ~4/s) make deltas the
first post-deploy build item, not an option." Every push already gzips
once per push (`apps/api/AGENTS.md`: "one `JSON.stringify` per push, gzip
once per push, identical bytes to every socket") — gzip alone was the day-1
mitigation (`docs/08-system-designs.md` open call 5: "gzip now, deltas as
the next real build step"); deltas now cut the bytes gzip compresses on
each tick, not the compression step itself.

## Decision

1. **Wire.** A delta push is `{ type: "delta", seq, base_seq, sent_at, session_key, patch, polls }` where `patch` is an RFC 6902 JSON Patch (`add`/`replace`/`remove` only) from the RaceState at `base_seq` to the RaceState at `seq`, computed once per tick on the server; `polls` is the full poll list as today (small). A snapshot is the existing full push `{ type: "state", ... }`. `seq` is the projector cursor, as today.
2. **Join.** A client that opens the stream with `?format=delta` receives one `state` push first (the newest existing), then only `delta` pushes. Every live join is the same (HLD §7 "Join").
3. **Gap.** A client applies a delta only if `base_seq` equals the `seq` it holds; otherwise it fetches `GET /api/live/snapshot` (the newest `state` push as JSON, same bytes the fan-out holds) and resumes. The server never replays history and keeps no per-client state (invariant 1).
4. **Fan-out cost unchanged.** Per tick the server serialises once per format it has sockets for (`state` for legacy sockets, `delta` for delta sockets), gzips each once as a full-flushed block, same bytes to every socket of that format. No per-viewer work (invariant 1). Postgres is untouched by this (invariant 2).
5. **Keyframes.** Every 200th push to delta sockets is a full `state` push instead of a delta, so a client that missed a delta recovers without a fetch within ~50 s at 4 pushes/s.
6. The legacy full-state format is retired when the web migration (issue #108) lands; from then on there is again exactly one stream per live race. Until then the two formats share one fold, one tick, and one gzip block each.

## Consequences

The web app's ring buffer must hold folded states, not pushes; that
migration is the follow-up issue for the web track (issue reference in the
PR that introduced this ADR). Legacy full-state sockets remain until it
lands.

- A third wire format is not allowed; a new format replaces one of the two.

Implementation notes (this PR's judgment calls, not part of the decision
above): the server always keeps and gzips the `state` frame every push,
regardless of whether any legacy socket is attached, because a join (of
either format) and `GET /api/live/snapshot` both need the newest `state`
bytes on demand; the added cost versus today is exactly one more
serialize+gzip pass, and only on ticks where a delta socket is attached
and it isn't a keyframe tick. A diff failure for one tick falls back to a
`state` push for delta sockets that tick and logs once, rather than
dropping the tick or crashing the process.

## References

- ADR-0001 §2 (the five invariants), §4 consequences (the egress line
  quoted above).
- `docs/08-system-designs.md` open call 5 (gzip now, deltas next).
- Issue #89 (api side, this PR). Follow-up: the web migration issue linked
  from the PR.
