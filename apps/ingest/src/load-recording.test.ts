// Unit test (issue #63 deliverable "Unit test"): a tiny fixture recording
// dir (two endpoints, three rows, one duplicate) drives `loadRecordings()`
// against in-memory fakes for both `SessionsDb` and `EventWriterDb` — no
// Postgres. Pins: the fake writer receives the static-entry-list `drivers`
// events before the raw-file rows, in file order; the session is upserted
// `finished` regardless of its window.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ENTRY_LIST_2026 } from "./openf1/entry-list.js";
import type { RawRecord } from "./openf1/types.js";
import { loadRecordings } from "./load-recording.js";
import type { LoaderDb } from "./load-recording.js";

function fakeDb(): LoaderDb & {
  sessions: Map<string, unknown>;
  insertOrder: string[];
} {
  const sessions = new Map<string, unknown>();
  const events = new Map<string, unknown>();
  const insertOrder: string[] = [];
  return {
    sessions,
    insertOrder,
    session: {
      async upsert(args) {
        const key = args.where.sessionKey.toString();
        const row = sessions.has(key) ? { sessionKey: args.where.sessionKey, ...args.update } : args.create;
        sessions.set(key, row);
        return row;
      },
    },
    event: {
      async createMany(args) {
        let count = 0;
        for (const row of args.data) {
          if (events.has(row.eventId)) continue;
          events.set(row.eventId, row);
          insertOrder.push(row.eventId);
          count += 1;
        }
        return { count };
      },
    },
  };
}

const SESSION_JSON = {
  session: {
    session_key: 9999,
    session_type: "Race",
    session_name: "Race",
    date_start: "2026-01-01T13:00:00+00:00",
    date_end: "2026-01-01T15:00:00+00:00",
    meeting_key: 1,
    circuit_key: 39,
    country_name: "Italy",
  },
  discovered_at: "2026-01-01T12:57:00.000Z",
};

function jsonlLine(payload: RawRecord): string {
  return `${JSON.stringify({ received_at: "2026-01-01T13:00:01.000Z", payload })}\n`;
}

describe("loadRecordings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "load-recording-test-"));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(path.join(dir, "session.json"), JSON.stringify(SESSION_JSON));
    // Two endpoints, three unique rows, one duplicate (issue #63's unit test spec).
    await writeFile(
      path.join(dir, "raw", "position.jsonl"),
      jsonlLine({ session_key: 9999, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }) +
        jsonlLine({ session_key: 9999, driver_number: 1, date: "2026-01-01T13:00:02Z", x: 2, y: 2 }),
    );
    const weatherRow: RawRecord = { session_key: 9999, date: "2026-01-01T13:00:01Z", air_temperature: 20 };
    await writeFile(
      path.join(dir, "raw", "weather.jsonl"),
      jsonlLine(weatherRow) + jsonlLine(weatherRow), // exact duplicate
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the fake writer receives the drivers events then the rows in file order", async () => {
    const db = fakeDb();
    const totals = await loadRecordings([dir], db, { now: () => Date.parse("2026-06-01T00:00:00Z"), onLog: () => {} });

    // 22 static entry-list drivers + 2 position rows + 1 deduped weather row.
    expect(totals).toEqual({ inserted: 25, skipped: 0 });
    expect(db.insertOrder).toHaveLength(25);
    expect(db.insertOrder.slice(0, ENTRY_LIST_2026.length).every((id) => id.startsWith("drivers:"))).toBe(true);
    expect(db.insertOrder.slice(ENTRY_LIST_2026.length, ENTRY_LIST_2026.length + 2).every((id) => id.startsWith("position:"))).toBe(
      true,
    );
    expect(db.insertOrder[ENTRY_LIST_2026.length + 2]!.startsWith("weather:")).toBe(true);
  });

  test("the session is upserted finished, regardless of its window", async () => {
    const db = fakeDb();
    // `now` is far outside the session's window — computeSessionStatus alone
    // would say "finished" anyway here, so pin it inside the window instead
    // to prove the override, not the window, is what wins.
    await loadRecordings([dir], db, { now: () => Date.parse("2026-01-01T14:00:00Z"), onLog: () => {} });

    const row = db.sessions.get("9999") as Record<string, unknown>;
    expect(row["status"]).toBe("finished");
  });

  test("a second load of the same recording inserts zero new rows", async () => {
    const db = fakeDb();
    const first = await loadRecordings([dir], db, { onLog: () => {} });
    expect(first.inserted).toBe(25);

    const second = await loadRecordings([dir], db, { onLog: () => {} });
    expect(second).toEqual({ inserted: 0, skipped: 25 });
  });
});
