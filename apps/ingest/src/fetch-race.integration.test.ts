// Integration test: needs the real Postgres from the
// throwaway container on port 5441 (not the
// docker-compose one at 5433 — this is deliberately a separate, disposable
// database). Pins the facts only Postgres enforces: a fake-fetcher session
// ends `finished`, its events land in the expected `seq` order (drivers
// first, then the lap/stint ordering rule), and a second run inserts 0
// (DB-level dedup via `event.createMany({ skipDuplicates: true })`).

import { afterAll, beforeEach, expect, test } from "vitest";

import { createDb } from "@formula-time/db";

import { fetchRaces } from "./fetch-race.js";
import type { Fetcher, RawRecord } from "./openf1/types.js";

const db = createDb(undefined, { max: 1 });

const SESSION_KEY = 9_000_005n;
const SESSION_KEY_NUM = Number(SESSION_KEY);

async function wipe(): Promise<void> {
  await db.event.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeEach(async () => {
  await wipe();
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

// A tiny fixture: 2 drivers, 1 lap (with lap_duration, so its order key is
// date_start + lap_duration), 1 stint (joined to that lap's date_start —
// lands before the lap itself), 2 position rows straddling the lap's
// adjusted order key.
const SESSION_DATE_START = "2026-01-01T13:00:00+00:00";
const SESSION_DATE_END = "2026-01-01T15:00:00+00:00";
const LAP_DATE_START = "2026-01-01T13:10:00Z";

function fixtureFetcher(): Fetcher {
  const byEndpoint: Record<string, RawRecord[]> = {
    sessions: [
      {
        session_key: SESSION_KEY_NUM,
        session_type: "Race",
        session_name: "Race",
        date_start: SESSION_DATE_START,
        date_end: SESSION_DATE_END,
        circuit_key: 39,
        country_name: "Italy",
      },
    ],
    drivers: [
      { session_key: SESSION_KEY_NUM, driver_number: 1, full_name: "Driver One" },
      { session_key: SESSION_KEY_NUM, driver_number: 2, full_name: "Driver Two" },
    ],
    position: [
      { session_key: SESSION_KEY_NUM, driver_number: 1, date: "2026-01-01T13:10:30Z", x: 1, y: 1 }, // +30s: before the lap's order key
      { session_key: SESSION_KEY_NUM, driver_number: 1, date: "2026-01-01T13:11:30Z", x: 2, y: 2 }, // +90s: after the lap's order key (date_start + 60s duration = +60s)
    ],
    laps: [
      {
        session_key: SESSION_KEY_NUM,
        driver_number: 1,
        lap_number: 1,
        date_start: LAP_DATE_START,
        lap_duration: 60, // order key: LAP_DATE_START + 60s
      },
    ],
    stints: [{ session_key: SESSION_KEY_NUM, driver_number: 1, lap_start: 1, compound: "SOFT" }], // joins to the lap above -> order key LAP_DATE_START (before the lap itself)
  };
  return async (url: string): Promise<unknown> => {
    const endpoint = new URL(url).pathname.split("/").at(-1) ?? "";
    return byEndpoint[endpoint] ?? [];
  };
}

test(
  "a fetched session ends finished, its events land in the expected seq order, and a second run inserts 0",
  async () => {
    const fetcher = fixtureFetcher();
    const now = () => Date.parse("2026-06-01T00:00:00Z"); // well after the session's window

    const first = await fetchRaces([SESSION_KEY_NUM], db, fetcher, { now, onLog: () => {} });
    // 2 drivers + 2 position + 2 laps (start + complete) + 1 stint.
    expect(first).toMatchObject({ inserted: 7, sessionsAttempted: 1, sessionsSkipped: 0, sessionsNotFound: 0 });

    const session = await db.session.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });
    expect(session.status).toBe("finished");

    const rows = await db.event.findMany({
      where: { sessionKey: SESSION_KEY },
      orderBy: { seq: "asc" },
    });
    expect(rows).toHaveLength(7);
    // drivers first (2); order keys: the lap's start row and the stint both
    // land at LAP_DATE_START (13:10:00, the lap's raw date_start) and tie —
    // the start row wins the tie because "laps" precedes "stints" in
    // RECORDING_ENDPOINT_ORDER; then position1 = 13:10:30, the lap's
    // complete row = LAP_DATE_START + 60s duration = 13:11:00, position2 = 13:11:30.
    expect(rows.map((row) => row.endpoint)).toEqual([
      "drivers",
      "drivers",
      "laps",
      "stints",
      "position",
      "laps",
      "position",
    ]);

    // Row count per lap is two where date_start and lap_duration both
    // exist: a start row and a complete row, with distinct `source_time`s.
    const lapRows = rows.filter((row) => row.endpoint === "laps");
    expect(lapRows).toHaveLength(2);

    // The start row's *stored* `source_time` is the lap's raw `date_start`;
    // the complete row's is the same adjusted instant (date_start +
    // lap_duration) as its order key — not the raw `date_start` — or the
    // browser fold's scrub could reveal the lap's final time before the lap
    // actually finished.
    const lapTimes = lapRows.map((row) => row.sourceTime?.toISOString()).sort();
    expect(lapTimes).toEqual([
      "2026-01-01T13:10:00.000Z", // start row: LAP_DATE_START
      "2026-01-01T13:11:00.000Z", // complete row: LAP_DATE_START + 60s
    ]);

    const second = await fetchRaces([SESSION_KEY_NUM], db, fetcher, { now, onLog: () => {} });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(7);

    const countAfterSecond = await db.event.count({ where: { sessionKey: SESSION_KEY } });
    expect(countAfterSecond).toBe(7);
  },
  30_000,
);
