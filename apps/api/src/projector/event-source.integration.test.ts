// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`.
//
// Pins `readAfter`'s row identity against a real database with two sessions'
// rows interleaved in `seq` (the shape a live session and a concurrent
// historical load/backfill produce): the `(session_key, seq)` index changes
// which access path Postgres picks, never which rows a session's own read
// returns. This test would fail exactly the same way whichever index (or
// none) answers the query.
import { createDb, type PrismaClient } from "@formula-time/db";
import { afterAll, beforeAll, expect, test } from "vitest";

import { prismaEventSource } from "./event-source.js";

const db: PrismaClient = createDb();

const SESSION_A = 9_000_003n;
const SESSION_B = 9_000_004n;

async function wipe(): Promise<void> {
  await db.event.deleteMany({ where: { sessionKey: { in: [SESSION_A, SESSION_B] } } });
  await db.session.deleteMany({ where: { sessionKey: { in: [SESSION_A, SESSION_B] } } });
}

beforeAll(async () => {
  await wipe();
  await db.session.createMany({
    data: [
      {
        sessionKey: SESSION_A,
        name: "Event Source Integration Test Grand Prix A",
        country: "Testland",
        circuitKey: 1,
        dateStart: new Date("2026-09-08T12:00:00.000Z"),
        dateEnd: new Date("2026-09-08T14:00:00.000Z"),
        totalLaps: 60,
        status: "finished",
      },
      {
        sessionKey: SESSION_B,
        name: "Event Source Integration Test Grand Prix B",
        country: "Testland",
        circuitKey: 2,
        dateStart: new Date("2026-09-08T12:00:00.000Z"),
        dateEnd: new Date("2026-09-08T14:00:00.000Z"),
        totalLaps: 60,
        status: "finished",
      },
    ],
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("readAfter returns only the requested session's own rows, in seq order, with other sessions interleaved between them", async () => {
  // Alternate inserts across the two sessions so their `seq` values
  // interleave -- the shape a live session's ingest and a concurrent
  // historical load produce, and the shape a plain scan on `seq` has to
  // filter through to answer one session's read.
  const expectedAIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const sessionKey = i % 2 === 0 ? SESSION_A : SESSION_B;
    const eventId = `${sessionKey === SESSION_A ? "a" : "b"}-${i}`;
    await db.event.create({
      data: {
        eventId,
        sessionKey,
        endpoint: "drivers",
        payload: { driver_number: i },
      },
    });
    if (sessionKey === SESSION_A) expectedAIds.push(eventId);
  }

  const source = prismaEventSource(db);

  // A cursor partway through session A's own rows: only the later half of
  // `expectedAIds` should come back, session B's interleaved rows never
  // among them.
  const cursorRow = await db.event.findFirstOrThrow({
    where: { eventId: expectedAIds[4] },
    select: { seq: true },
  });
  const rows = await source.readAfter(SESSION_A, cursorRow.seq, 100);

  expect(rows.map((row) => row.eventId)).toEqual(expectedAIds.slice(5));
  expect(rows.every((row) => row.endpoint === "drivers")).toBe(true);
});
