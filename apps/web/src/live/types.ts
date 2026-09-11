import type { JsonPatchOp, PollPublic, RaceEvent, RaceState } from "@formula-time/domain";
export type { PollLifecycleStatus, PollOptionPublic, PollPublic } from "@formula-time/domain";

export interface LivePush {
  type: "state";
  seq: string;
  sent_at: number;
  session_key: string;
  total_laps: number | null;
  state: RaceState;
  polls: PollPublic[];
  /**
   * The `RaceEvent` rows the projector applied in the tick that produced
   * this push, in `seq` order; `[]` on a tick with none, including the
   * join snapshot -- the state is the fold, the events are already in the
   * log a client backfills via `GET /api/races/:session_key/events`.
   * Optional so a push from an older api build still parses;
   * `apps/web/src/live/timeline.ts` treats a missing field as `[]`.
   */
  events?: RaceEvent[];
  /**
   * Set when the client's local event-log timeline
   * (`apps/web/src/live/timeline.ts`'s `useSessionTimeline`) has a hole
   * and must be discarded and re-backfilled. Two causes mean the same
   * thing to that timeline: the server rebuilt RaceState from the log
   * after a late-commit alarm (`events` is `[]` regardless, since the
   * rebuild may have changed rows the client already folded); or the
   * client itself detected a delta-stream gap (`useLiveStream.ts`) and
   * marks the push that resolves it, since the events from the skipped
   * ticks were never delivered either.
   */
  rebuilt?: boolean;
}

/**
 * The delta wire shape (ADR-0013 "Wire" point 1): an RFC 6902 JSON Patch
 * from the RaceState at `base_seq` to the RaceState at `seq`. `events` and
 * `rebuilt` carry through exactly like on a `LivePush` -- see there for
 * what each means; `apps/web/src/live/deltas.ts`'s `applyDelta` folds a
 * `DeltaPush` against a held `LivePush` into the next `LivePush`.
 */
export interface DeltaPush {
  type: "delta";
  seq: string;
  base_seq: string;
  sent_at: number;
  session_key: string;
  patch: JsonPatchOp[];
  polls: PollPublic[];
  events?: RaceEvent[];
  rebuilt?: boolean;
}

export type Connection = "connecting" | "open" | "reconnecting";

/** How `displayed` was chosen: the live edge, the push ring buffer (including the oldest-entry fallback), or synthesised from the browser-side timeline past the buffer. */
export type RewindMode = "edge" | "buffer" | "timeline";

/** The POC's anchor axis for delay: source time when available, else the send time. */
export function axisOf(push: LivePush): number {
  const sourceMillis = push.state.latest_source_time === null ? NaN : Date.parse(push.state.latest_source_time);
  return Number.isFinite(sourceMillis) ? sourceMillis : push.sent_at;
}
