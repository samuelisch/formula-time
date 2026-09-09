import type { RaceEvent, RaceState } from "@formula-time/domain";

export type PollTemplateKind = "winner" | "podium";
export type PollLifecycleStatus = "open" | "locked" | "resolved" | "void";

export interface PollOptionPublic {
  id: string;
  label: string;
}

export interface PollPublic {
  poll_id: string;
  kind: PollTemplateKind;
  question: string;
  options: PollOptionPublic[];
  locks_at_lap: number;
  status: PollLifecycleStatus;
  tally: Record<string, number>;
  total_votes: number;
  winning_option_ids: string[] | null;
}

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
   * this push, in `seq` order (issue #114); `[]` on a tick with none,
   * including the join snapshot -- the state is the fold, the events are
   * already in the log a client backfills via `GET
   * /api/races/:session_key/events`. Optional so a push from an api still
   * on the pre-#114 shape still parses; `apps/web/src/live/timeline.ts`
   * treats a missing field as `[]`.
   */
  events?: RaceEvent[];
  /**
   * Set when this push is a rebuild-from-log after a late-commit alarm
   * (issue #114): `events` is `[]` regardless, and a client timeline
   * built from the stream must be discarded and re-backfilled, since the
   * rebuild may have changed rows the client already folded.
   */
  rebuilt?: boolean;
}

export type Connection = "connecting" | "open" | "reconnecting";

/** The POC's anchor axis for delay: source time when available, else the send time. */
export function axisOf(push: LivePush): number {
  const sourceMillis = push.state.latest_source_time === null ? NaN : Date.parse(push.state.latest_source_time);
  return Number.isFinite(sourceMillis) ? sourceMillis : push.sent_at;
}
