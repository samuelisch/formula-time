// The incremental fold shared by the replay path (`foldRace.ts`) and the
// live path (`apps/web/src/live/timeline.ts`): a `Timeline` is a running
// fold over an event log -- keyframes, lap markers, and the first/last
// source times seen -- built either in one shot (`foldRace`: create then
// `appendEvents` with the whole file) or across many `appendEvents` calls
// as pages arrive from `GET /api/races/:session_key/events` while a
// session is still live.
//
// Design: a keyframe is taken every `KEYFRAME_EVENT_INTERVAL` events or
// every `KEYFRAME_SOURCE_TIME_MS` of source time, whichever comes first.
// Scrubbing to a target source time (`foldAt`) finds the nearest keyframe
// at or before that time and replays only the events after it, so a scrub
// never re-folds the whole timeline.
//
// A ~28k-event race must not block the UI thread noticeably. Chosen
// strategy: chunked yields with `setTimeout(0)`, not a Web Worker -- the
// whole point of folding in the browser is to reuse `RaceStateReducer`
// unchanged (ADR-0009 §5 "must stay identical to the server's"); a worker
// would need events serialised across `postMessage` and a second Vite
// worker entry/tsconfig, for a fold that (chunked) never blocks a frame for
// more than `CHUNK_SIZE` events' worth of reducer work -- a few
// milliseconds. `foldAt` (the scrub path) stays synchronous: it only ever
// replays up to one keyframe interval's worth of events.
//
// Dedup: `RaceStateReducer`'s own duplicate-event detection
// (`seenEventIds`) is private reducer state, not part of `RaceState` -- it
// is not in a keyframe's snapshot. `appendEvents` dedupes by `event_id`
// against every event already in the timeline (first occurrence, in `seq`
// order, wins) before applying anything, so no duplicate ever reaches a
// reducer -- a scrub that rebuilds a reducer from a keyframe snapshot never
// re-applies one, matching a single continuous fold.
//
// Null-source truncation rule: "the state at `targetSourceMs`" applies
// events in `seq` order up to, but not including, the first event whose
// `source_time` is non-null and exceeds the target; every null-source
// event before that boundary applies, none after it does.
// `truncationBoundary` computes that index; `foldAt` and (in
// `foldRace.test.ts`) the full-fold-truncated reference both call it, so
// the two can never disagree about where the cut falls.
//
// Reconstructing the live fold position: `appendEvents` does not keep a
// persistent `RaceStateReducer` across calls -- doing so would make
// `Timeline` carry hidden, unclonable state, and the live path
// (`live/timeline.ts`) hands a `Timeline` to React state after every page.
// Instead each call rebuilds the reducer from the *last* keyframe already
// recorded and replays the (bounded, at most one keyframe interval's
// worth of) events since it -- exactly what `foldAt` already does for a
// scrub. `Timeline` therefore stays a plain, structurally-inspectable
// value: the same shape as `FoldedRace` minus `finalState`
// (`foldRace.ts` defines `FoldedRace` as `Timeline & { finalState }`), so
// `foldAt` accepts either one unchanged.
import type { RawRecord, RaceEvent, RaceState } from "@formula-time/domain";
import { createInitialState, leaderLap, RaceStateReducer } from "@formula-time/domain";

export const KEYFRAME_EVENT_INTERVAL = 500;
export const KEYFRAME_SOURCE_TIME_MS = 30_000;

/** Events folded per macrotask before yielding to the event loop. */
const CHUNK_SIZE = 200;

export interface Keyframe {
  /** Index into `Timeline.events` of the next event to apply after this keyframe. */
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

export interface Timeline {
  session: RawRecord;
  /** Deduped by `event_id` (first occurrence, in `seq` order), in append order. */
  events: RaceEvent[];
  keyframes: Keyframe[];
  lapMarkers: LapMarker[];
  /** Epoch ms of the first event carrying a source time, or null if none did (yet). */
  firstSourceMs: number | null;
  /** Epoch ms of the last (monotonic) source time reached, or null if none did (yet). */
  lastSourceMs: number | null;
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

/** A fresh `Timeline` for `rawSession`, with the initial (pre-event) keyframe already recorded. */
export function createTimeline(rawSession: RawRecord): Timeline {
  const session = normalizedSessionRow(rawSession);
  const liveState = createInitialState({ sessions: [session], drivers: [] });
  const reducer = new RaceStateReducer(liveState);

  return {
    session,
    events: [],
    keyframes: [{ eventIndex: 0, sourceMs: null, state: reducer.snapshot() }],
    lapMarkers: [],
    firstSourceMs: null,
    lastSourceMs: null,
  };
}

/** The nearest keyframe at or before `targetSourceMs`, defaulting to the initial one. */
function keyframeBefore(timeline: Timeline, targetSourceMs: number): Keyframe {
  let chosen = timeline.keyframes[0]!;
  for (const keyframe of timeline.keyframes) {
    if (keyframe.sourceMs !== null && keyframe.sourceMs <= targetSourceMs) {
      chosen = keyframe;
    }
  }
  return chosen;
}

/**
 * Appends `rawEvents` onto `timeline` in place (mutating its arrays) and
 * returns it: dedupes by `event_id` against everything already on the
 * timeline (and within this same batch), applies each new event through a
 * reducer resumed from the last keyframe, and keeps keyframes/lap markers
 * exactly as a single full fold would (see the header note on
 * reconstructing the live fold position). Chunked: yields to the event
 * loop every `CHUNK_SIZE` applied events, so appending a large page (or the
 * whole file, from `foldRace`) never blocks the UI thread for long.
 */
export async function appendEvents(timeline: Timeline, rawEvents: RaceEvent[]): Promise<Timeline> {
  if (rawEvents.length === 0) return timeline;

  const seen = new Set(timeline.events.map((raceEvent) => raceEvent.event_id));

  const lastKeyframe = timeline.keyframes[timeline.keyframes.length - 1]!;
  const state = structuredClone(lastKeyframe.state);
  const reducer = new RaceStateReducer(state);
  for (let index = lastKeyframe.eventIndex; index < timeline.events.length; index += 1) {
    reducer.apply(timeline.events[index]!);
  }

  let eventsSinceKeyframe = timeline.events.length - lastKeyframe.eventIndex;
  let keyframeSourceMs = lastKeyframe.sourceMs ?? timeline.firstSourceMs;
  let lastMarkedLap = timeline.lapMarkers.length > 0 ? timeline.lapMarkers[timeline.lapMarkers.length - 1]!.lap : 0;
  let firstSourceMs = timeline.firstSourceMs;
  let lastSourceMs = timeline.lastSourceMs;

  let appliedSinceYield = 0;

  for (const raceEvent of rawEvents) {
    if (seen.has(raceEvent.event_id)) continue;
    seen.add(raceEvent.event_id);
    timeline.events.push(raceEvent);

    reducer.apply(raceEvent);
    eventsSinceKeyframe += 1;

    const incoming = sourceMillis(raceEvent.source_time);
    if (incoming !== null) {
      if (firstSourceMs === null) firstSourceMs = incoming;
      if (lastSourceMs === null || incoming >= lastSourceMs) lastSourceMs = incoming;
      if (keyframeSourceMs === null) keyframeSourceMs = incoming;
    }

    // `state` is the object `reducer` mutates in place, so this reads the
    // current leader lap with no clone -- cheap enough to check every event.
    if (lastSourceMs !== null) {
      const currentLap = leaderLap(state);
      if (currentLap > lastMarkedLap) {
        timeline.lapMarkers.push({ lap: currentLap, sourceMs: lastSourceMs });
        lastMarkedLap = currentLap;
      }
    }

    const dueByCount = eventsSinceKeyframe >= KEYFRAME_EVENT_INTERVAL;
    const dueByTime =
      lastSourceMs !== null &&
      keyframeSourceMs !== null &&
      lastSourceMs - keyframeSourceMs >= KEYFRAME_SOURCE_TIME_MS;

    if (dueByCount || dueByTime) {
      timeline.keyframes.push({ eventIndex: timeline.events.length, sourceMs: lastSourceMs, state: reducer.snapshot() });
      eventsSinceKeyframe = 0;
      keyframeSourceMs = lastSourceMs;
    }

    appliedSinceYield += 1;
    if (appliedSinceYield % CHUNK_SIZE === 0) {
      await yieldToEventLoop();
    }
  }

  timeline.firstSourceMs = firstSourceMs;
  timeline.lastSourceMs = lastSourceMs;

  return timeline;
}

/**
 * The race state at `targetSourceMs`: the nearest earlier keyframe, cloned,
 * with the events after it re-applied up to `truncationBoundary` (the
 * "Null-source truncation rule" header note). Synchronous -- bounded by one
 * keyframe interval's worth of events, never the whole timeline.
 * `timeline.events` is already deduped (by `appendEvents`), so no
 * duplicate `event_id` can reach the fresh reducer built here.
 */
export function foldAt(timeline: Timeline, targetSourceMs: number): RaceState {
  const keyframe = keyframeBefore(timeline, targetSourceMs);
  const state = structuredClone(keyframe.state);
  const reducer = new RaceStateReducer(state);

  const boundary = truncationBoundary(timeline.events, targetSourceMs, keyframe.eventIndex);
  for (let index = keyframe.eventIndex; index < boundary; index += 1) {
    reducer.apply(timeline.events[index]!);
  }

  return reducer.snapshot();
}

/** The lap markers recorded so far -- the first source time (epoch ms) the leader reached each lap. */
export function lapMarkers(timeline: Timeline): LapMarker[] {
  return timeline.lapMarkers;
}
