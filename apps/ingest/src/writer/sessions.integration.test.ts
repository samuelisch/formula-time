// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Pins the fact: a `sessions`
// upsert twice -> one row with the later status.

import { afterAll, beforeEach, expect, test } from "vitest";

import { createDb } from "@formula-time/db";

import type { RawRecord } from "../openf1/types.js";
import { upsertSession } from "./sessions.js";

const db = createDb(undefined, { max: 1 });

const SESSION_KEY = 9_000_003n;

const RAW_SESSION: RawRecord = {
  session_key: Number(SESSION_KEY),
  session_name: "Race",
  country_name: "Italy",
  circuit_key: 39,
  date_start: "2026-09-08T12:00:00+00:00",
  date_end: "2026-09-08T14:00:00+00:00",
};

const START_MS = Date.parse("2026-09-08T12:00:00Z");
const END_MS = Date.parse("2026-09-08T14:00:00Z");

async function wipe(): Promise<void> {
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("a sessions upsert twice leaves one row with the later status", async () => {
  // Discovered well ahead of the live window: upcoming.
  await upsertSession(db, RAW_SESSION, START_MS - 60 * 60 * 1000);
  const afterFirst = await db.session.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });
  expect(afterFirst.status).toBe("upcoming");

  // Same session, now inside its window: live.
  await upsertSession(db, RAW_SESSION, START_MS + 60 * 1000);

  const rows = await db.session.findMany({ where: { sessionKey: SESSION_KEY } });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("live");
  expect(rows[0]?.totalLaps).toBe(53); // circuits.ts: Monza (circuit_key 39)
});

test("the window closing moves status to finished", async () => {
  await upsertSession(db, RAW_SESSION, START_MS + 60 * 1000);
  await upsertSession(db, RAW_SESSION, END_MS + 31 * 60 * 1000);

  const row = await db.session.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });
  expect(row.status).toBe("finished");
});
