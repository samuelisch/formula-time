import { describe, expect, test } from "vitest";

import type { RawRecord } from "../openf1/types.js";
import { computeSessionStatus, upsertSession } from "./sessions.js";
import type { SessionsDb } from "./sessions.js";

function fakeDb(): SessionsDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    session: {
      async upsert(args) {
        const key = args.where.sessionKey.toString();
        if (rows.has(key)) {
          rows.set(key, { sessionKey: args.where.sessionKey, ...args.update });
        } else {
          rows.set(key, args.create);
        }
        return rows.get(key);
      },
    },
  };
}

const RAW_SESSION: RawRecord = {
  session_key: 11361,
  session_name: "Race",
  session_type: "Race",
  country_name: "Italy",
  circuit_key: 39,
  date_start: "2026-09-06T13:00:00+00:00",
  date_end: "2026-09-06T15:00:00+00:00",
};

const START_MS = Date.parse("2026-09-06T13:00:00Z");
const END_MS = Date.parse("2026-09-06T15:00:00Z");

describe("computeSessionStatus", () => {
  const start = new Date(START_MS);
  const end = new Date(END_MS);

  test("more than 30 minutes before date_start -> upcoming", () => {
    expect(computeSessionStatus(start, end, START_MS - 31 * 60 * 1000)).toBe("upcoming");
  });

  test("exactly 30 minutes before date_start -> live (window edge is inclusive)", () => {
    expect(computeSessionStatus(start, end, START_MS - 30 * 60 * 1000)).toBe("live");
  });

  test("inside the session -> live", () => {
    expect(computeSessionStatus(start, end, START_MS + 60 * 1000)).toBe("live");
  });

  test("exactly 30 minutes after date_end -> live (window edge is inclusive)", () => {
    expect(computeSessionStatus(start, end, END_MS + 30 * 60 * 1000)).toBe("live");
  });

  test("more than 30 minutes after date_end -> finished", () => {
    expect(computeSessionStatus(start, end, END_MS + 31 * 60 * 1000)).toBe("finished");
  });
});

describe("upsertSession", () => {
  test("creates a row with fields mapped from the raw OpenF1 record", async () => {
    const db = fakeDb();
    await upsertSession(db, RAW_SESSION, START_MS + 60 * 1000);

    const row = db.rows.get("11361") as Record<string, unknown>;
    expect(row).toMatchObject({
      sessionKey: 11361n,
      name: "Race",
      country: "Italy",
      circuitKey: 39,
      status: "live",
      totalLaps: 53, // circuits.ts: Monza (circuit_key 39) -> 53 laps
    });
  });

  test("unknown circuit_key -> totalLaps null, not a guess", async () => {
    const db = fakeDb();
    await upsertSession(db, { ...RAW_SESSION, circuit_key: 999 }, START_MS + 60 * 1000);

    const row = db.rows.get("11361") as Record<string, unknown>;
    expect(row["totalLaps"]).toBeNull();
  });

  test("upserting twice leaves one row with the later status", async () => {
    const db = fakeDb();
    // Discovered ahead of time: upcoming.
    await upsertSession(db, RAW_SESSION, START_MS - 60 * 60 * 1000);
    expect((db.rows.get("11361") as Record<string, unknown>)["status"]).toBe("upcoming");

    // Same session, now inside its window: live.
    await upsertSession(db, RAW_SESSION, START_MS + 60 * 1000);

    expect(db.rows.size).toBe(1);
    expect((db.rows.get("11361") as Record<string, unknown>)["status"]).toBe("live");
  });
});
