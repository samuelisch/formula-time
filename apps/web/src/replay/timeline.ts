// The incremental fold shared by the replay path (`foldRace.ts`) and the
// live path (`live/useSessionTimeline.ts`): a `Timeline` is a running
// fold over an event log -- keyframes, lap markers, and the first/last
// source times seen -- built either in one shot or across many
// `appendEvents` calls as pages arrive while a session is still live.
// See README: Timeline fold.
import type { RawRecord, RaceEvent, RaceState } from "@formula-time/domain";
import { createInitialState, RaceStateReducer } from "@formula-time/domain";

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
  /**
   * The lap's own start time (epoch ms): the earliest non-null `source_time`
   * among `laps` events for this lap, across drivers -- the leader starts a
   * lap first, so this is the leader's `date_start`.
   */
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

/** `payload.lap_number` from a `laps` event, or null when absent or not a number. */
function lapNumber(payload: RawRecord): number | null {
  const value = payload["lap_number"];
  return typeof value === "number" ? value : null;
}

/**
 * Records `sourceMs` as a candidate start time for `lap`, in place on
 * `markers` (sorted by lap): creates the marker on first sight, lowers it
 * (never raises it) when a later row for the same lap is earlier.
 * See README: Timeline fold.
 */
function recordLapMarker(markers: LapMarker[], lap: number, sourceMs: number): void {
  const index = markers.findIndex((marker) => marker.lap === lap);
  if (index !== -1) {
    if (sourceMs < markers[index]!.sourceMs) {
      markers[index] = { lap, sourceMs };
    }
    return;
  }

  const insertAt = markers.findIndex((marker) => marker.lap > lap);
  if (insertAt === -1) {
    markers.push({ lap, sourceMs });
  } else {
    markers.splice(insertAt, 0, { lap, sourceMs });
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Normalizes the session row before it becomes `state.session`: a
 * schema-1 file (ADR-0041) carries `session_key` as a JSON number, unlike
 * a schema-2 file or the live push, both already a string.
 * See README: Timeline fold.
 */
function normalizedSessionRow(session: RawRecord): RawRecord {
  const sessionKey = session["session_key"];
  if (typeof sessionKey !== "number") return session;
  return { ...session, session_key: String(sessionKey) };
}

/**
 * The index of the first event in `events`, from `fromIndex`, whose
 * `source_time` is non-null and exceeds `targetSourceMs`.
 * See README: Timeline fold.
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
 * Appends `rawEvents` onto `timeline` in place and returns it: dedupes,
 * applies each event, and keeps keyframes/lap markers exactly as a full
 * fold would. Chunked: yields every `CHUNK_SIZE` applied events.
 * See README: Timeline fold.
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

    // A lap's start is only known from a `laps` row that actually carries
    // a `date_start` -- the first lap-1 row for each driver arrives with a
    // null `source_time` while still on the formation lap. Recording
    // straight from `laps` rows keeps the marker tied to the lap it
    // actually describes.
    // See README: Timeline fold.
    if (raceEvent.endpoint === "laps" && incoming !== null) {
      const lap = lapNumber(raceEvent.payload);
      if (lap !== null) {
        recordLapMarker(timeline.lapMarkers, lap, incoming);
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
 * The race state at `targetSourceMs`: the nearest earlier keyframe,
 * cloned, with the events after it re-applied up to `truncationBoundary`.
 * See README: Timeline fold.
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

/** The lap markers recorded so far -- each lap's own start time (epoch ms), the earliest non-null `source_time` seen among its `laps` rows. */
export function lapMarkers(timeline: Timeline): LapMarker[] {
  return timeline.lapMarkers;
}
