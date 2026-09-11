import { describe, expect, it } from "vitest";
import { DOMAIN_PACKAGE } from "./index.js";
import type { PollOptionPublic, PollPublic } from "./index.js";

describe("domain package", () => {
  it("exports its name", () => {
    expect(DOMAIN_PACKAGE).toBe("@formula-time/domain");
  });

  it("exports the poll wire types", () => {
    const option: PollOptionPublic = { id: "a", label: "A" };
    const poll: PollPublic = {
      poll_id: "race:winner",
      kind: "winner",
      question: "Who wins?",
      options: [option],
      locks_at_lap: 1,
      status: "open",
      tally: {},
      total_votes: 0,
      winning_option_ids: null,
    };
    expect(poll.kind).toBe("winner");
  });
});
