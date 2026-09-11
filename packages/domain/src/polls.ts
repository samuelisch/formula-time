// The poll wire types, shared by the api (which builds them) and the web
// app (which only reads them). One definition; neither side copies it.

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
