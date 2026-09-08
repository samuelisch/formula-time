// Integration test (ADR-0002): needs the real Postgres from the root
// docker-compose.yml. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`.
//
// Exercises pollsBySession against real rows: seed one session with two
// polls and three votes, assert the tallies vote.groupBy produces match
// what the response shape reports (issue #79).
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createDb } from "@formula-time/db";

import { pollsBySession } from "./poll-read.js";

const db = createDb();

const SESSION_KEY = 9_200_001n;

async function wipe(): Promise<void> {
  await db.vote.deleteMany({ where: { pollId: { startsWith: `${SESSION_KEY}:` } } });
  await db.poll.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeEach(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: SESSION_KEY,
      name: "Integration Test Grand Prix",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 10,
      status: "live",
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

describe("pollsBySession against real Postgres", () => {
  test("seeded session with two polls and three votes: shape, tallies, and cacheable", async () => {
    await db.poll.createMany({
      data: [
        {
          pollId: `${SESSION_KEY}:winner`,
          sessionKey: SESSION_KEY,
          question: "Who wins the Testland GP?",
          options: [
            { id: "1", label: "VER" },
            { id: "44", label: "HAM" },
          ],
          locksAtLap: 5,
          status: "open",
        },
        {
          pollId: `${SESSION_KEY}:podium`,
          sessionKey: SESSION_KEY,
          question: "Pick a driver to finish on the podium of the Testland GP",
          options: [
            { id: "1", label: "VER" },
            { id: "44", label: "HAM" },
          ],
          locksAtLap: 5,
          status: "resolved",
          winningOptionIds: ["1", "44"],
          resolvedAt: new Date(),
        },
      ],
    });

    const viewerIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.vote.createMany({
      data: [
        { pollId: `${SESSION_KEY}:winner`, viewerId: viewerIds[0]!, optionId: "1" },
        { pollId: `${SESSION_KEY}:winner`, viewerId: viewerIds[1]!, optionId: "1" },
        { pollId: `${SESSION_KEY}:winner`, viewerId: viewerIds[2]!, optionId: "44" },
      ],
    });

    const grouped = await db.vote.groupBy({
      by: ["pollId", "optionId"],
      where: { pollId: { in: [`${SESSION_KEY}:winner`, `${SESSION_KEY}:podium`] } },
      _count: true,
    });
    const expectedTally: Record<string, Record<string, number>> = {};
    for (const group of grouped) {
      const tally = expectedTally[group.pollId] ?? {};
      tally[group.optionId] = group._count;
      expectedTally[group.pollId] = tally;
    }

    const { polls, cacheable } = await pollsBySession(db, SESSION_KEY);

    expect(polls).toHaveLength(2);
    const winner = polls.find((p) => p.poll_id === `${SESSION_KEY}:winner`);
    const podium = polls.find((p) => p.poll_id === `${SESSION_KEY}:podium`);

    expect(winner?.kind).toBe("winner");
    expect(winner?.status).toBe("open");
    expect(winner?.tally).toEqual(expectedTally[`${SESSION_KEY}:winner`]);
    expect(winner?.total_votes).toBe(3);
    expect(winner?.winning_option_ids).toBeNull();

    expect(podium?.kind).toBe("podium");
    expect(podium?.status).toBe("resolved");
    expect(podium?.tally).toEqual({});
    expect(podium?.total_votes).toBe(0);
    expect(podium?.winning_option_ids).toEqual(["1", "44"]);

    // One poll still "open" -- not every poll of the session is
    // resolved/void yet.
    expect(cacheable).toBe(false);
  });

  test("every poll resolved or void: cacheable is true", async () => {
    await db.poll.createMany({
      data: [
        {
          pollId: `${SESSION_KEY}:winner`,
          sessionKey: SESSION_KEY,
          question: "Who wins the Testland GP?",
          options: [{ id: "1", label: "VER" }],
          locksAtLap: 5,
          status: "resolved",
          winningOptionIds: ["1"],
          resolvedAt: new Date(),
        },
        {
          pollId: `${SESSION_KEY}:podium`,
          sessionKey: SESSION_KEY,
          question: "Pick a driver to finish on the podium of the Testland GP",
          options: [{ id: "1", label: "VER" }],
          locksAtLap: 5,
          status: "void",
        },
      ],
    });

    const { cacheable } = await pollsBySession(db, SESSION_KEY);

    expect(cacheable).toBe(true);
  });

  test("a session with no polls answers { polls: [], cacheable: false }", async () => {
    const result = await pollsBySession(db, SESSION_KEY);

    expect(result).toEqual({ polls: [], cacheable: false });
  });

  test("an unknown session key (no session row either) answers the same, with no lookup on sessions", async () => {
    const result = await pollsBySession(db, 9_999_999_999n);

    expect(result).toEqual({ polls: [], cacheable: false });
  });
});
