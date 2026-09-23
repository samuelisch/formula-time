// The wire shapes the api builds and the web reads over HTTP and SSE,
// declared once so the api's builders and the web's copies cannot drift
// (enforced by review, not the compiler). Types only -- no runtime code,
// per the package's own browser-safe rule.
import type { JsonPatchOp } from "./patch.js";
import type { PollPublic } from "./polls.js";
import type { RaceState } from "./race-state.js";
import type { RaceEvent } from "./types.js";

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
  /** The `RaceEvent` rows the projector applied in the tick that produced
   * this push, in `seq` order; `[]` on a tick with none, including the
   * join snapshot. Optional so a push from an older api build still
   * parses. */
  events?: RaceEvent[];
  /** Set when the server rebuilt `RaceState` after a late-commit alarm,
   * or the fan-out skipped a frame, or a push was rejected upstream of
   * the fan-out (ADR-0032's third and fourth causes), or the client's
   * own gap detection marks the push that resolves it -- all mean the
   * same thing to a client's deep-rewind timeline: discard it and
   * re-backfill. See apps/api/README.md: One tick. */
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

/**
 * The eleven fields a session row carries on every wire surface (the live
 * push's `state.session`, ADR-0026; the export document's `session`,
 * ADR-0009 §1, ADR-0041): `session_key` always a string (ADR-0041), never a
 * JSON number.
 */
export interface SessionWire {
  session_key: string;
  name: string;
  country: string;
  circuit_key: number;
  date_start: string;
  date_end: string;
  total_laps: number | null;
  status: SessionStatus;
  meeting_name: string | null;
  circuit_short_name: string | null;
  location: string | null;
}

/**
 * A session row shaped structurally, not by importing `@formula-time/db`'s
 * `Session` (this package stays browser-safe, no `node:*`): the projector's
 * and the exporter's own row both already satisfy this.
 */
export interface SessionLike {
  sessionKey: bigint | number | string;
  name: string;
  country: string;
  circuitKey: number;
  dateStart: Date | string;
  dateEnd: Date | string;
  totalLaps: number | null;
  status: SessionStatus;
  meetingName: string | null;
  circuitShortName: string | null;
  location: string | null;
}

function isoString(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * The one mapping from a stored session row to `SessionWire` (ADR-0041): the
 * projector's live push and the exporter's export document both call this,
 * so they cannot disagree on a field's name or type the way `session_key`
 * did before this function existed (one a string, the other a JSON number).
 */
export function sessionToWire(session: SessionLike): SessionWire {
  return {
    session_key: String(session.sessionKey),
    name: session.name,
    country: session.country,
    circuit_key: session.circuitKey,
    date_start: isoString(session.dateStart),
    date_end: isoString(session.dateEnd),
    total_laps: session.totalLaps,
    status: session.status,
    meeting_name: session.meetingName,
    circuit_short_name: session.circuitShortName,
    location: session.location,
  };
}

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
 * The exported race file's body (ADR-0009 §1, ADR-0026, ADR-0041). `session`
 * is `SessionWire` (same `sessionToWire` mapping as the live push, ADR-0009
 * §5). `schema` is `2`: a `schema: 1` file carried `session_key` as a JSON
 * number instead; the browser fold reads either
 * (`apps/web/src/replay/timeline.ts` `normalizedSessionRow`).
 */
export interface RaceFile {
  schema: 2;
  exported_at: string;
  session: SessionWire;
  events: RaceEvent[];
}
