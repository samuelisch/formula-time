// Integration test (ADR-0002): needs the real Postgres from the root
// docker-compose.yml. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`.
//
// Pins vote-path.ts's conditional upsert against a real database: the
// dedup on (poll_id, viewer_id), and the null a locked poll produces (no
// row, so no RETURNING value) — both facts only Postgres can enforce.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createDb } from "@formula-time/db";

import { upsertVote } from "./vote-path.js";

const db = createDb();

const SESSION_KEY = 9_200_001n;
const POLL_ID = `${SESSION_KEY}:winner`;
const VIEWER_ID = randomUUID();

async function wipe(): Promise<void> {
  await db.vote.deleteMany({ where: { pollId: POLL_ID } });
  await db.poll.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeEach(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: SESSION_KEY,
      name: "Vote Path Integration Test",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 50,
      status: "live",
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

describe("upsertVote against real Postgres", () => {
  test("the same (poll_id, viewer_id) voted twice with different options lands as one row, the later option", async () => {
    await db.poll.create({
      data: {
        pollId: POLL_ID,
        sessionKey: SESSION_KEY,
        question: "Who wins?",
        options: [
          { id: "1", label: "A" },
          { id: "2", label: "B" },
        ],
        locksAtLap: 25,
        status: "open",
      },
    });

    const first = await upsertVote(db, POLL_ID, VIEWER_ID, "1");
    expect(first).toBe("1");
    const second = await upsertVote(db, POLL_ID, VIEWER_ID, "2");
    expect(second).toBe("2");

    const rows = await db.vote.findMany({ where: { pollId: POLL_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.viewerId).toBe(VIEWER_ID);
    expect(rows[0]?.optionId).toBe("2");
  });

  test("voting on a locked poll returns null (no row) and inserts nothing", async () => {
    await db.poll.create({
      data: {
        pollId: POLL_ID,
        sessionKey: SESSION_KEY,
        question: "Who wins?",
        options: [{ id: "1", label: "A" }],
        locksAtLap: 25,
        status: "locked",
      },
    });

    const storedOptionId = await upsertVote(db, POLL_ID, VIEWER_ID, "1");
    expect(storedOptionId).toBeNull();

    const rows = await db.vote.findMany({ where: { pollId: POLL_ID } });
    expect(rows).toHaveLength(0);
  });
});
