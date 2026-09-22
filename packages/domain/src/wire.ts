// The wire shapes the api builds and the web reads over HTTP and SSE,
// declared once (issue: a review rule, not the compiler, used to keep the
// api's builders and the web's copies in step). Types only -- no runtime
// code, per the package's own browser-safe rule.
import type { JsonPatchOp } from "./patch.js";
import type { PollPublic } from "./polls.js";
import type { RaceState } from "./race-state.js";
import type { RaceEvent, RawRecord } from "./types.js";

/**
 * The full-state SSE push (`event: state`) and `GET /api/live/snapshot`'s
 * body: one serialized `RaceState` plus poll tallies, built once per tick
 * and sent unchanged to every socket of this format (ADR-0001 §1).
 */
export interface StatePush {
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
   * Optional so a push from an older api build still parses.
   */
  events?: RaceEvent[];
  /**
   * Set when the server rebuilt `RaceState` from the fold after a
   * late-commit alarm; or a deflate error made the fan-out skip a frame,
   * so the next push it actually delivers carries this instead (that
   * skipped tick's `events` reached no one); or a push was rejected before
   * it ever reached the fan-out, so the next push built carries this for
   * the same reason; or the client's own delta-stream gap detection marks
   * the push that resolves it -- all four mean the same thing to a
   * client's deep-rewind timeline: discard it and re-backfill.
   */
  rebuilt?: boolean;
}

/**
 * The delta SSE push (`event: delta`, ADR-0013 "Wire" point 1): an RFC 6902
 * JSON Patch from the `RaceState` at `base_seq` to the `RaceState` at
 * `seq`. `events` and `rebuilt` carry through exactly like on a
 * `StatePush`.
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

/** The `event: status` SSE frame, sent to a socket that joins before the first push has landed. */
export interface StatusFrame {
  catching_up: boolean;
}

/** A session's lifecycle stage, as stored (`sessions.status`) and served. */
export type SessionStatus = "upcoming" | "live" | "finished";

/** `GET /api/races`'s entry shape, one per exported session (ADR-0009 §4, ADR-0026). */
export interface RaceIndexEntry {
  session_key: number;
  name: string;
  country: string;
  date_start: string;
  date_end: string;
  total_laps: number | null;
  exported_at: string;
  meeting_name: string | null;
  circuit_short_name: string | null;
  location: string | null;
}

/**
 * `GET /api/races/:session_key/events`'s response: one page of the event
 * log, `seq`-ordered. `next_seq` is `null` only when `events` is empty
 * (nothing past `since_seq` yet); otherwise it is the last returned row's
 * `seq`, the next page's `since_seq`.
 */
export interface RaceEventsPage {
  session_key: string;
  status: SessionStatus;
  events: RaceEvent[];
  next_seq: number | null;
}

/**
 * The exported race file's body (ADR-0009 §1, ADR-0026). `session` stays a
 * `RawRecord`, not the exporter's own narrower session shape, because the
 * browser fold (`foldRace`, `createTimeline`) reads any session metadata as
 * one, the same as the live push's `state.session`.
 */
export interface RaceFile {
  schema: 1;
  exported_at: string;
  session: RawRecord;
  events: RaceEvent[];
}
