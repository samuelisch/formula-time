// Shared test fixture for the polls slice -- every polls/*.test.ts(x) file
// builds a PollPublic from here rather than repeating the shape.
import type { PollPublic } from "../live/types.ts";

export function makePoll(overrides: Partial<PollPublic> = {}): PollPublic {
  return {
    poll_id: "poll-1",
    kind: "winner",
    question: "Who wins the race?",
    options: [
      { id: "opt-a", label: "Verstappen" },
      { id: "opt-b", label: "Hamilton" },
    ],
    locks_at_lap: 10,
    status: "open",
    tally: { "opt-a": 0, "opt-b": 0 },
    total_votes: 0,
    winning_option_ids: null,
    ...overrides,
  };
}
