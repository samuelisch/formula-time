import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@formula-time/db";

import { pollsBySession } from "./poll-read.js";

interface FakePollRow {
  pollId: string;
  sessionKey: bigint;
  question: string;
  options: unknown;
  locksAtLap: number;
  status: string;
  winningOptionIds: unknown;
}

interface FakeVoteRow {
  pollId: string;
  optionId: string;
}

// A minimal recording fake standing in for PrismaClient -- only the two
// calls pollsBySession makes (poll.findMany, vote.groupBy), matching the
// makeFakeDb pattern already used in poll-module.test.ts.
function makeFakeDb(pollRows: FakePollRow[], voteRows: FakeVoteRow[]) {
  const calls: string[] = [];
  const db = {
    calls,
    poll: {
      findMany: vi.fn(async ({ where }: { where: { sessionKey: bigint } }) => {
        calls.push("poll.findMany");
        return pollRows.filter((row) => row.sessionKey === where.sessionKey);
      }),
    },
    vote: {
      groupBy: vi.fn(
        async ({ where }: { by: ["pollId", "optionId"]; where: { pollId: { in: string[] } }; _count: true }) => {
          calls.push("vote.groupBy");
          // Nested by pollId then optionId -- no delimiter-joined string
          // key, so there is nothing to split back apart.
          const tallies = new Map<string, Map<string, number>>();
          for (const row of voteRows) {
            if (!where.pollId.in.includes(row.pollId)) continue;
            const byOption = tallies.get(row.pollId) ?? new Map<string, number>();
            byOption.set(row.optionId, (byOption.get(row.optionId) ?? 0) + 1);
            tallies.set(row.pollId, byOption);
          }
          const groups: Array<{ pollId: string; optionId: string; _count: number }> = [];
          for (const [pollId, byOption] of tallies) {
            for (const [optionId, count] of byOption) {
              groups.push({ pollId, optionId, _count: count });
            }
          }
          return groups;
        },
      ),
    },
  };
  return db;
}

const SESSION_KEY = 555n;

function pollRow(overrides: Partial<FakePollRow> & { pollId: string }): FakePollRow {
  return {
    sessionKey: SESSION_KEY,
    question: "Who wins?",
    options: [
      { id: "1", label: "VER" },
      { id: "44", label: "HAM" },
    ],
    locksAtLap: 10,
    status: "open",
    winningOptionIds: null,
    ...overrides,
  };
}

describe("pollsBySession", () => {
  it("returns [] and cacheable: false when the session has no polls", async () => {
    const db = makeFakeDb([], []);

    const result = await pollsBySession(db as unknown as PrismaClient, SESSION_KEY);

    expect(result).toEqual({ polls: [], cacheable: false });
    expect(db.calls).toEqual(["poll.findMany"]);
    // No groupBy for an empty poll set -- nothing to look tallies up for.
    expect(db.calls).not.toContain("vote.groupBy");
  });

  it("groups votes per option, per poll, and reports total_votes as their sum", async () => {
    const db = makeFakeDb(
      [pollRow({ pollId: `${SESSION_KEY}:winner` }), pollRow({ pollId: `${SESSION_KEY}:podium` })],
      [
        { pollId: `${SESSION_KEY}:winner`, optionId: "1" },
        { pollId: `${SESSION_KEY}:winner`, optionId: "1" },
        { pollId: `${SESSION_KEY}:winner`, optionId: "44" },
        { pollId: `${SESSION_KEY}:podium`, optionId: "44" },
      ],
    );

    const result = await pollsBySession(db as unknown as PrismaClient, SESSION_KEY);

    const winner = result.polls.find((p) => p.poll_id === `${SESSION_KEY}:winner`);
    const podium = result.polls.find((p) => p.poll_id === `${SESSION_KEY}:podium`);
    expect(winner?.tally).toEqual({ "1": 2, "44": 1 });
    expect(winner?.total_votes).toBe(3);
    expect(podium?.tally).toEqual({ "44": 1 });
    expect(podium?.total_votes).toBe(1);
    expect(winner?.kind).toBe("winner");
    expect(podium?.kind).toBe("podium");
  });

  it("gives a poll with no votes an empty tally and zero total_votes", async () => {
    const db = makeFakeDb([pollRow({ pollId: `${SESSION_KEY}:winner` })], []);

    const result = await pollsBySession(db as unknown as PrismaClient, SESSION_KEY);

    expect(result.polls).toHaveLength(1);
    expect(result.polls[0]?.tally).toEqual({});
    expect(result.polls[0]?.total_votes).toBe(0);
  });

  it("passes each poll's status and winning_option_ids through unchanged", async () => {
    const db = makeFakeDb(
      [
        pollRow({ pollId: `${SESSION_KEY}:winner`, status: "resolved", winningOptionIds: ["1"] }),
        pollRow({ pollId: `${SESSION_KEY}:podium`, status: "locked" }),
      ],
      [],
    );

    const result = await pollsBySession(db as unknown as PrismaClient, SESSION_KEY);

    const winner = result.polls.find((p) => p.poll_id === `${SESSION_KEY}:winner`);
    const podium = result.polls.find((p) => p.poll_id === `${SESSION_KEY}:podium`);
    expect(winner?.status).toBe("resolved");
    expect(winner?.winning_option_ids).toEqual(["1"]);
    expect(podium?.status).toBe("locked");
    expect(podium?.winning_option_ids).toBeNull();
  });

  it("is cacheable once every poll is resolved or void", async () => {
    const db = makeFakeDb(
      [
        pollRow({ pollId: `${SESSION_KEY}:winner`, status: "resolved" }),
        pollRow({ pollId: `${SESSION_KEY}:podium`, status: "void" }),
      ],
      [],
    );

    const result = await pollsBySession(db as unknown as PrismaClient, SESSION_KEY);

    expect(result.cacheable).toBe(true);
  });

  it("is not cacheable while any poll is still open or locked", async () => {
    const db = makeFakeDb(
      [
        pollRow({ pollId: `${SESSION_KEY}:winner`, status: "resolved" }),
        pollRow({ pollId: `${SESSION_KEY}:podium`, status: "open" }),
      ],
      [],
    );

    const result = await pollsBySession(db as unknown as PrismaClient, SESSION_KEY);

    expect(result.cacheable).toBe(false);
  });
});
