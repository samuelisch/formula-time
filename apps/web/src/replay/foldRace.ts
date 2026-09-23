// The browser-side fold (ADR-0009 §5): builds the whole race timeline once
// so scrubbing and playback never re-read the network. The incremental
// fold itself -- keyframes, `foldAt`, dedupe, the null-source truncation
// rule -- lives in `timeline.ts`, shared with the live path. This file
// folds the whole event log in one `appendEvents` call.
// See README: Timeline fold.
import type { RawRecord, RaceEvent, RaceState, SessionWire } from "@formula-time/domain";

import {
  appendEvents,
  createTimeline,
  foldAt,
  KEYFRAME_EVENT_INTERVAL,
  KEYFRAME_SOURCE_TIME_MS,
  truncationBoundary,
  type Keyframe,
  type LapMarker,
  type Timeline,
} from "./timeline.ts";

export { foldAt, KEYFRAME_EVENT_INTERVAL, KEYFRAME_SOURCE_TIME_MS, truncationBoundary };
export type { Keyframe, LapMarker };

export interface FoldedRace extends Timeline {
  finalState: RaceState;
}

/**
 * Folds `rawEvents` (in `seq` order, deduped by `event_id`) onto
 * `rawSession` into a `FoldedRace`: the final state, keyframes for
 * scrubbing, and lap markers for the transport bar. Pure given its
 * inputs; the only side effect is yielding to the event loop.
 */
export async function foldRace(rawEvents: RaceEvent[], rawSession: RawRecord | SessionWire): Promise<FoldedRace> {
  // A schema-2 export document's `session` is `SessionWire`, a named
  // interface with no index signature; the spread produces a fresh object
  // literal so `createTimeline` (RawRecord, shared with the live path) accepts it.
  const timeline = createTimeline({ ...rawSession });
  await appendEvents(timeline, rawEvents);
  return {
    ...timeline,
    // Every event applied: no finite target can be exceeded by any event's
    // source time, so `truncationBoundary` always resolves to the whole
    // list (see timeline.ts) -- this is exactly `reducer.snapshot()` after
    // the full fold, reusing `foldAt`'s keyframe + bounded-replay path
    // instead of keeping a second, persistent reducer around for it.
    finalState: foldAt(timeline, Number.POSITIVE_INFINITY),
  };
}
