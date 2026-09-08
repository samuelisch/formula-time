// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`.
//
// It pins the two design-bearing statements of ADR-0004 against a real
// database, because both rest on constraints only Postgres enforces:
//
//   1. The event writer's `ON CONFLICT (event_id) DO NOTHING`, expressed as
//      `createMany({ skipDuplicates: true })`. Ingest's two lanes (REST and
//      MQTT) produce the same `event_id` for the same row, so the same event
//      is inserted twice by design and must land once.
//   2. The vote upsert on the composite key `(poll_id, viewer_id)`. A re-vote
//      before lock is an upsert, not a new row.

import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { createDb } from "./index.js";

const db = createDb();

// One session and one poll to hang the foreign keys off. Fixed keys, so a
// re-run cleans up after the previous one.
const SESSION_KEY = 9_000_001n;
const POLL_ID = "poll-integration-test";
const VIEWER_ID = "00000000-0000-4000-8000-000000000001";

async function wipe(): Promise<void> {
  // Children first: the foreign keys are ON DELETE RESTRICT.
  await db.vote.deleteMany({ where: { pollId: POLL_ID } });
  await db.poll.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.event.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeAll(async () => {
  await wipe();
});

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
      totalLaps: 72,
      status: "live",
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("the same event inserted twice lands once (createMany skipDuplicates)", async () => {
  const event = {
    eventId: "event-integration-test",
    sessionKey: SESSION_KEY,
    endpoint: "position",
    sourceTime: new Date("2026-09-08T12:30:00.000Z"),
    payload: { driver_number: 1, position: 1 },
  };

  const first = await db.event.createMany({ data: [event], skipDuplicates: true });
  expect(first.count).toBe(1);

  // The REST/MQTT twin: identical id, arriving again.
  const second = await db.event.createMany({ data: [event], skipDuplicates: true });
  expect(second.count).toBe(0);

  const rows = await db.event.findMany({ where: { sessionKey: SESSION_KEY } });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.eventId).toBe("event-integration-test");
  // `seq` is BIGSERIAL: the row that landed has one, and the skipped insert
  // did not produce a second.
  expect(typeof rows[0]?.seq).toBe("bigint");
});

test("two votes for the same (pollId, viewerId) leave one row with the second option", async () => {
  await db.poll.create({
    data: {
      pollId: POLL_ID,
      sessionKey: SESSION_KEY,
      question: "Who leads at lap 30?",
      options: [
        { id: "opt-a", label: "Driver A" },
        { id: "opt-b", label: "Driver B" },
      ],
      locksAtLap: 30,
      status: "open",
    },
  });

  const vote = (optionId: string) =>
    db.vote.upsert({
      where: { pollId_viewerId: { pollId: POLL_ID, viewerId: VIEWER_ID } },
      create: { pollId: POLL_ID, viewerId: VIEWER_ID, optionId },
      update: { optionId },
    });

  await vote("opt-a");
  await vote("opt-b");

  const rows = await db.vote.findMany({ where: { pollId: POLL_ID } });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.viewerId).toBe(VIEWER_ID);
  expect(rows[0]?.optionId).toBe("opt-b");
});
