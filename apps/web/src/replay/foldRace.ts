// The browser-side fold (ADR-0009 §5, issue #57): builds the whole race
// timeline once so scrubbing and playback never re-read the network.
//
// Design: a keyframe is taken every `KEYFRAME_EVENT_INTERVAL` events or every
// `KEYFRAME_SOURCE_TIME_MS` of source time, whichever comes first, exactly as
// the issue specifies. Scrubbing to a target source time (`foldAt`) finds the
// nearest keyframe at or before that time and replays only the events after
// it, so a scrub never re-folds the whole race.
//
// A ~28k-event race must not block the UI thread noticeably (issue #57).
// Chosen strategy: chunked yields with `setTimeout(0)`, not a Web Worker --
// the whole point of folding in the browser is to reuse `RaceStateReducer`
// unchanged (ADR-0009 §5 "must stay identical to the server's"); a worker
// would need the ~28k events serialised across `postMessage` and a second
// Vite worker entry/tsconfig, for a fold that (chunked) never blocks a frame
// for more than `CHUNK_SIZE` events' worth of reducer work -- a few
// milliseconds. `foldAt` (the scrub path) stays synchronous: it only ever
// replays up to one keyframe interval's worth of events.
import type { RawRecord, RaceEvent, RaceState } from "@formula-time/domain";
import { createInitialState, leaderLap, RaceStateReducer } from "@formula-time/domain";

export const KEYFRAME_EVENT_INTERVAL = 500;
export const KEYFRAME_SOURCE_TIME_MS = 30_000;

/** Events folded per macrotask before yielding to the event loop. */
const CHUNK_SIZE = 200;

export interface Keyframe {
  /** Index into `FoldedRace.events` of the next event to apply after this keyframe. */
  eventIndex: number;
  /** `state.latest_source_time` in epoch ms at this keyframe, or null for the initial (pre-event) keyframe. */
  sourceMs: number | null;
  state: RaceState;
}

export interface LapMarker {
  lap: number;
  /** The first source time (epoch ms) the leader reached this lap. */
  sourceMs: number;
}

export interface FoldedRace {
  session: RawRecord;
  events: RaceEvent[];
  keyframes: Keyframe[];
  finalState: RaceState;
  /** Epoch ms of the first event carrying a source time, or null if none did. */
  firstSourceMs: number | null;
  /** Epoch ms of the last (monotonic) source time reached, or null if none did. */
  lastSourceMs: number | null;
  lapMarkers: LapMarker[];
}

function sourceMillis(sourceTime: string | null): number | null {
  if (sourceTime === null) return null;
  const millis = Date.parse(sourceTime);
  return Number.isNaN(millis) ? null : millis;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Folds `events` (in `seq` order) onto `session` into a `FoldedRace`: the
 * final state, keyframes for scrubbing, and lap markers for the transport
 * bar. Pure given its inputs; the only side effect is yielding to the event
 * loop between chunks.
 */
export async function foldRace(events: RaceEvent[], session: RawRecord): Promise<FoldedRace> {
  const liveState = createInitialState({ sessions: [session], drivers: [] });
  const reducer = new RaceStateReducer(liveState);

  const keyframes: Keyframe[] = [{ eventIndex: 0, sourceMs: null, state: reducer.snapshot() }];
  const lapMarkers: LapMarker[] = [];

  let eventsSinceKeyframe = 0;
  // Baseline for the time-based trigger: the source ms as of the most
  // recent keyframe, seeded (without forcing a keyframe) by the first
  // timestamped event so the first 30s window starts from the race's own
  // first timestamp rather than firing a keyframe immediately.
  let keyframeSourceMs: number | null = null;
  let firstSourceMs: number | null = null;
  let latestSourceMs: number | null = null;
  let lastMarkedLap = 0;

  for (let index = 0; index < events.length; index += 1) {
    const raceEvent = events[index]!;
    reducer.apply(raceEvent);
    eventsSinceKeyframe += 1;

    const incoming = sourceMillis(raceEvent.source_time);
    if (incoming !== null) {
      if (firstSourceMs === null) firstSourceMs = incoming;
      if (latestSourceMs === null || incoming >= latestSourceMs) latestSourceMs = incoming;
      if (keyframeSourceMs === null) keyframeSourceMs = incoming;
    }

    // `liveState` is the object `reducer` mutates in place (RaceStateReducer
    // holds the exact reference passed to its constructor), so this reads
    // the current leader lap with no clone -- cheap enough to check every event.
    if (latestSourceMs !== null) {
      const currentLap = leaderLap(liveState);
      if (currentLap > lastMarkedLap) {
        lapMarkers.push({ lap: currentLap, sourceMs: latestSourceMs });
        lastMarkedLap = currentLap;
      }
    }

    const dueByCount = eventsSinceKeyframe >= KEYFRAME_EVENT_INTERVAL;
    const dueByTime =
      latestSourceMs !== null &&
      keyframeSourceMs !== null &&
      latestSourceMs - keyframeSourceMs >= KEYFRAME_SOURCE_TIME_MS;

    if (dueByCount || dueByTime) {
      keyframes.push({ eventIndex: index + 1, sourceMs: latestSourceMs, state: reducer.snapshot() });
      eventsSinceKeyframe = 0;
      keyframeSourceMs = latestSourceMs;
    }

    if ((index + 1) % CHUNK_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  return {
    session,
    events,
    keyframes,
    finalState: reducer.snapshot(),
    firstSourceMs,
    lastSourceMs: latestSourceMs,
    lapMarkers,
  };
}

/** The nearest keyframe at or before `targetSourceMs`, defaulting to the initial one. */
function keyframeBefore(folded: FoldedRace, targetSourceMs: number): Keyframe {
  let chosen = folded.keyframes[0]!;
  for (const keyframe of folded.keyframes) {
    if (keyframe.sourceMs !== null && keyframe.sourceMs <= targetSourceMs) {
      chosen = keyframe;
    }
  }
  return chosen;
}

/**
 * The race state at `targetSourceMs`: the nearest earlier keyframe, cloned,
 * with the events after it re-applied up to (and including) the last one
 * whose source time does not exceed the target. Synchronous -- bounded by
 * one keyframe interval's worth of events, never the whole race.
 */
export function foldAt(folded: FoldedRace, targetSourceMs: number): RaceState {
  const keyframe = keyframeBefore(folded, targetSourceMs);
  const state = structuredClone(keyframe.state);
  const reducer = new RaceStateReducer(state);

  for (let index = keyframe.eventIndex; index < folded.events.length; index += 1) {
    const raceEvent = folded.events[index]!;
    const eventMs = sourceMillis(raceEvent.source_time);
    if (eventMs !== null && eventMs > targetSourceMs) break;
    reducer.apply(raceEvent);
  }

  return reducer.snapshot();
}
