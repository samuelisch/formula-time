import { describe, expect, it } from "vitest";

import { makePoll } from "./pollFixtures.ts";
import { sortPolls } from "./sortPolls.ts";

describe("sortPolls", () => {
  it("orders open, then locked, then resolved, then void", () => {
    const resolved = makePoll({ poll_id: "resolved", status: "resolved" });
    const open = makePoll({ poll_id: "open", status: "open" });
    const voidPoll = makePoll({ poll_id: "void", status: "void" });
    const locked = makePoll({ poll_id: "locked", status: "locked" });

    const sorted = sortPolls([resolved, open, voidPoll, locked]);

    expect(sorted.map((poll) => poll.poll_id)).toEqual(["open", "locked", "resolved", "void"]);
  });

  it("keeps the relative order of polls sharing a status (stable sort)", () => {
    const firstOpen = makePoll({ poll_id: "first-open", status: "open" });
    const secondOpen = makePoll({ poll_id: "second-open", status: "open" });
    const firstResolved = makePoll({ poll_id: "first-resolved", status: "resolved" });
    const secondResolved = makePoll({ poll_id: "second-resolved", status: "resolved" });

    const sorted = sortPolls([firstResolved, firstOpen, secondResolved, secondOpen]);

    expect(sorted.map((poll) => poll.poll_id)).toEqual(["first-open", "second-open", "first-resolved", "second-resolved"]);
  });

  it("does not mutate the input array", () => {
    const polls = [makePoll({ poll_id: "b", status: "locked" }), makePoll({ poll_id: "a", status: "open" })];
    const original = [...polls];

    sortPolls(polls);

    expect(polls).toEqual(original);
  });
});
