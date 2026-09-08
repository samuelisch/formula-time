import type { RaceState } from "@formula-time/domain";

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
}

export type Connection = "connecting" | "open" | "reconnecting";

/** The POC's anchor axis for delay: source time when available, else the send time. */
export function axisOf(push: LivePush): number {
  const sourceMillis = push.state.latest_source_time === null ? NaN : Date.parse(push.state.latest_source_time);
  return Number.isFinite(sourceMillis) ? sourceMillis : push.sent_at;
}
