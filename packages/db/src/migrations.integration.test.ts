// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:dev`, then
// `pnpm test:integration`.
//
// Pins the sessions-races-only migration (packages/db/prisma/migrations/
// 20260910131441_sessions_races_only) directly, reading its SQL straight off
// disk rather than duplicating it here, so this test always exercises the
// real migration file: seeds two non-race sessions, one with an event row
// and one without, runs the migration SQL, and checks only the eventless
// one is removed — a row with events (or polls) stays, on purpose.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, expect, test } from "vitest";

import { createDb } from "./index.js";

const db = createDb();

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  path.join(moduleDir, "../prisma/migrations/20260910131441_sessions_races_only/migration.sql"),
  "utf8",
);

const NO_EVENTS_KEY = 9_100_001n;
const WITH_EVENTS_KEY = 9_100_002n;

async function wipe(): Promise<void> {
  const keys = { in: [NO_EVENTS_KEY, WITH_EVENTS_KEY] };
  await db.event.deleteMany({ where: { sessionKey: keys } });
  await db.session.deleteMany({ where: { sessionKey: keys } });
}

beforeEach(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: NO_EVENTS_KEY,
      name: "Practice 1",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-01-01T10:00:00.000Z"),
      dateEnd: new Date("2026-01-01T11:00:00.000Z"),
      totalLaps: null,
      status: "finished",
    },
  });
  await db.session.create({
    data: {
      sessionKey: WITH_EVENTS_KEY,
      name: "Practice 1",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-01-01T10:00:00.000Z"),
      dateEnd: new Date("2026-01-01T11:00:00.000Z"),
      totalLaps: null,
      status: "finished",
    },
  });
  await db.event.create({
    data: {
      eventId: "migration-test-event",
      sessionKey: WITH_EVENTS_KEY,
      endpoint: "position",
      sourceTime: new Date("2026-01-01T10:30:00.000Z"),
      payload: { driver_number: 1 },
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("removes a non-race session with no events, and leaves one that has events", async () => {
  await db.$executeRawUnsafe(MIGRATION_SQL);

  const remaining = await db.session.findMany({
    where: { sessionKey: { in: [NO_EVENTS_KEY, WITH_EVENTS_KEY] } },
  });
  expect(remaining.map((row) => row.sessionKey)).toEqual([WITH_EVENTS_KEY]);
});
