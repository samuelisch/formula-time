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
//
// Dedup fix (review round 1): `RaceStateReducer`'s own duplicate-event
// detection (`seenEventIds`) is private reducer state, not part of
// `RaceState` -- it is not in a keyframe's snapshot. A `foldAt` that built a
// fresh reducer from a keyframe snapshot and then replayed events past a
// duplicate would therefore re-apply it (a fresh reducer has never "seen"
// it), diverging from a full fold's single continuous reducer, which skips
// it. Fix: dedup `events` once at load, by `event_id`, keeping the first
// occurrence in `seq` order, and fold/scrub that one list everywhere -- no
// duplicate ever reaches any reducer, so `anomalies.duplicate_events` is
// always 0 on a replay (there is no duplicate left to count), unlike the
// live projector's fold.
//
// Null-source truncation rule (review round 1): "the state at
// `targetSourceMs`" applies events in `seq` order up to, but not including,
// the first event whose `source_time` is non-null and exceeds the target;
// every null-source event before that boundary applies, none after it does.
// `truncationBoundary` computes that index; `foldAt` and (in tests) the
// full-fold-truncated reference both call it, so the two can never disagree
// about where the cut falls.
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
 * Normalizes the session row before it becomes `state.session`: the export
 * file's `session_key` travels as a JSON number (`apps/api/src/export/exporter.ts`
 * `buildDoc`), but the live projector's `sessionAsRawRecord()` sends it
 * `.toString()`'d -- "session_key travels as a string, same as everywhere
 * else this service puts a bigint on the wire" -- so a folded `RaceState`
 * would otherwise disagree with a live one on this field's type (ADR-0009
 * §5 "must stay identical to the server's"). Every other field
 * (`total_laps`, `circuit_key`, ...) is already the same shape both ways.
 */
function normalizedSessionRow(session: RawRecord): RawRecord {
  const sessionKey = session["session_key"];
  if (typeof sessionKey !== "number") return session;
  return { ...session, session_key: String(sessionKey) };
}

/** The first occurrence of each `event_id`, in `seq` order -- see the "Dedup fix" header note. */
function dedupeEvents(events: RaceEvent[]): RaceEvent[] {
  const seen = new Set<string>();
  const deduped: RaceEvent[] = [];
  for (const raceEvent of events) {
    if (seen.has(raceEvent.event_id)) continue;
    seen.add(raceEvent.event_id);
    deduped.push(raceEvent);
  }
  return deduped;
}

/**
 * The index of the first event in `events`, scanning from `fromIndex`, whose
 * `source_time` is non-null and exceeds `targetSourceMs` -- see the
 * "Null-source truncation rule" header note. Events at indices
 * `[fromIndex, boundary)` are the ones that apply for `targetSourceMs`;
 * `events.length` means every remaining event applies.
 */
export function truncationBoundary(events: RaceEvent[], targetSourceMs: number, fromIndex = 0): number {
  for (let index = fromIndex; index < events.length; index += 1) {
    const eventMs = sourceMillis(events[index]!.source_time);
    if (eventMs !== null && eventMs > targetSourceMs) return index;
  }
  return events.length;
}

/**
 * Folds `events` (in `seq` order, deduped by `event_id`) onto `session` into
 * a `FoldedRace`: the final state, keyframes for scrubbing, and lap markers
 * for the transport bar. Pure given its inputs; the only side effect is
 * yielding to the event loop between chunks.
 */
export async function foldRace(rawEvents: RaceEvent[], rawSession: RawRecord): Promise<FoldedRace> {
  const events = dedupeEvents(rawEvents);
  const session = normalizedSessionRow(rawSession);
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
 * with the events after it re-applied up to `truncationBoundary` (the
 * "Null-source truncation rule" header note). Synchronous -- bounded by one
 * keyframe interval's worth of events, never the whole race. `folded.events`
 * is already deduped (by `foldRace`), so no duplicate `event_id` can reach
 * the fresh reducer built here.
 */
export function foldAt(folded: FoldedRace, targetSourceMs: number): RaceState {
  const keyframe = keyframeBefore(folded, targetSourceMs);
  const state = structuredClone(keyframe.state);
  const reducer = new RaceStateReducer(state);

  const boundary = truncationBoundary(folded.events, targetSourceMs, keyframe.eventIndex);
  for (let index = keyframe.eventIndex; index < boundary; index += 1) {
    reducer.apply(folded.events[index]!);
  }

  return reducer.snapshot();
}
