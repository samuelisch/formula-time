// Unit test (issue #63 deliverable "Unit test"): a tiny fixture recording
// dir (two endpoints, three rows, one duplicate) drives `loadRecordings()`
// against in-memory fakes for both `SessionsDb` and `EventWriterDb` — no
// Postgres. Pins: the fake writer receives the static-entry-list `drivers`
// events before the raw-file rows, in file order; the session is upserted
// `finished` regardless of its window; a malformed sibling session doesn't
// lose the others' rows (round 1 fix); a live session is refused, never
// written (ADR-0010); the session is upserted `upcoming`, then its events
// are written, then it is updated to `finished`, in that order, and a
// writer failure leaves it `upcoming` (issue #71).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ENTRY_LIST_2026 } from "./openf1/entry-list.js";
import type { RawRecord } from "./openf1/types.js";
import { loadRecordings } from "./load-recording.js";
import type { LoaderDb } from "./load-recording.js";

function fakeDb(): LoaderDb & {
  sessions: Map<string, { status?: string; [key: string]: unknown }>;
  insertOrder: string[];
  // Records every `session.upsert` (as `upsert:<status>`) and every
  // `event.createMany` (as `events:<row count>`) call, in call order — how
  // the issue #71 tests pin the upcoming -> events -> finished sequence.
  callLog: string[];
  flags: { failEvents: boolean };
} {
  const sessions = new Map<string, { status?: string; [key: string]: unknown }>();
  const events = new Map<string, unknown>();
  const insertOrder: string[] = [];
  const callLog: string[] = [];
  const flags = { failEvents: false };
  return {
    sessions,
    insertOrder,
    callLog,
    flags,
    session: {
      async upsert(args) {
        const key = args.where.sessionKey.toString();
        const row = sessions.has(key) ? { sessionKey: args.where.sessionKey, ...args.update } : args.create;
        sessions.set(key, row);
        callLog.push(`upsert:${String(row.status)}`);
        return row;
      },
      async findUnique(args) {
        const key = args.where.sessionKey.toString();
        const row = sessions.get(key);
        return row ? { status: row.status } : null;
      },
    },
    event: {
      async createMany(args) {
        if (flags.failEvents) {
          throw new Error("fake writer failure");
        }
        callLog.push(`events:${args.data.length}`);
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

function sessionJson(fields: { sessionKey: number; dateStart: string; dateEnd: string }): string {
  return JSON.stringify({
    session: {
      session_key: fields.sessionKey,
      session_type: "Race",
      session_name: "Race",
      date_start: fields.dateStart,
      date_end: fields.dateEnd,
      circuit_key: 39,
      country_name: "Italy",
    },
    discovered_at: "2026-01-01T12:57:00.000Z",
  });
}

function jsonlLine(payload: RawRecord): string {
  return `${JSON.stringify({ received_at: "2026-01-01T13:00:01.000Z", payload })}\n`;
}

const FAR_PAST_NOW = Date.parse("2025-01-01T00:00:00Z"); // before any fixture session's window
const FAR_FUTURE_NOW = Date.parse("2026-06-01T00:00:00Z"); // after any fixture session's window

describe("loadRecordings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "load-recording-test-"));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      sessionJson({ sessionKey: 9999, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
    );
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
    expect(totals).toEqual({ inserted: 25, skipped: 0, sessionsAttempted: 1, sessionsSkipped: 0 });
    expect(db.insertOrder).toHaveLength(25);
    expect(db.insertOrder.slice(0, ENTRY_LIST_2026.length).every((id) => id.startsWith("drivers:"))).toBe(true);
    expect(db.insertOrder.slice(ENTRY_LIST_2026.length, ENTRY_LIST_2026.length + 2).every((id) => id.startsWith("position:"))).toBe(
      true,
    );
    expect(db.insertOrder[ENTRY_LIST_2026.length + 2]!.startsWith("weather:")).toBe(true);
  });

  test("the session is upserted finished via the override, not the naturally-computed status", async () => {
    const db = fakeDb();
    // `now` is well before the session's window (`computeSessionStatus`
    // alone would say "upcoming") — proving the `{ status: "finished" }`
    // override, not the natural computation, is what lands. Pinning `now`
    // *inside* the window instead would now hit the ADR-0010 live guard and
    // refuse the session entirely (covered separately below).
    await loadRecordings([dir], db, { now: () => FAR_PAST_NOW, onLog: () => {} });

    const row = db.sessions.get("9999");
    expect(row?.status).toBe("finished");
  });

  test("a second load of the same recording inserts zero new rows", async () => {
    const db = fakeDb();
    const first = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });
    expect(first.inserted).toBe(25);

    const second = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });
    expect(second).toEqual({ inserted: 0, skipped: 25, sessionsAttempted: 1, sessionsSkipped: 0 });
  });
});

// Issue #71: the loader upserted `finished` first (to satisfy the events FK)
// and streamed events afterwards, so the api's exporter (ADR-0009 §2) could
// export the session — once, immutably — before any event existed. Fix:
// upsert `upcoming` first, write and drain every event, then update to
// `finished`; a failure part-way leaves the row `upcoming`.
describe("loadRecordings: issue #71 — upcoming, then events, then finished", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "load-recording-status-order-test-"));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      sessionJson({ sessionKey: 9401, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
    );
    await writeFile(
      path.join(dir, "raw", "position.jsonl"),
      jsonlLine({ session_key: 9401, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the fake db sees the upsert with upcoming, then the events, then the update to finished, in that order", async () => {
    const db = fakeDb();
    const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });

    expect(totals.sessionsSkipped).toBe(0);
    const upsertCalls = db.callLog.filter((entry) => entry.startsWith("upsert:"));
    expect(upsertCalls).toEqual(["upsert:upcoming", "upsert:finished"]);

    const upcomingIndex = db.callLog.indexOf("upsert:upcoming");
    const finishedIndex = db.callLog.indexOf("upsert:finished");
    const firstEventsIndex = db.callLog.findIndex((entry) => entry.startsWith("events:"));
    expect(upcomingIndex).toBeGreaterThanOrEqual(0);
    expect(firstEventsIndex).toBeGreaterThan(upcomingIndex);
    expect(finishedIndex).toBeGreaterThan(firstEventsIndex);

    expect(db.sessions.get("9401")?.status).toBe("finished");
  });

  test("a writer failure leaves the row upcoming and posts no finished update", async () => {
    const db = fakeDb();
    db.flags.failEvents = true;
    const logs: string[] = [];
    const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: (line) => logs.push(line) });

    expect(db.sessions.get("9401")?.status).toBe("upcoming");
    expect(db.callLog).toEqual(["upsert:upcoming"]);
    expect(totals.sessionsSkipped).toBe(1);
    expect(logs.some((line) => line.includes("9401") && line.toLowerCase().includes("upcoming"))).toBe(true);
  });
});

describe("loadRecordings: ADR-0010 — refuses a live session, writes nothing for it", () => {
  test("a session whose own recorded window contains `now` is refused", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "load-recording-live-window-test-"));
    try {
      await writeFile(
        path.join(dir, "session.json"),
        sessionJson({ sessionKey: 9201, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
      );
      const db = fakeDb();
      const logs: string[] = [];
      const totals = await loadRecordings([dir], db, {
        now: () => Date.parse("2026-01-01T14:00:00Z"), // squarely inside the window
        onLog: (line) => logs.push(line),
      });

      expect(totals.inserted).toBe(0);
      expect(totals.sessionsSkipped).toBe(1);
      expect(db.sessions.has("9201")).toBe(false);
      expect(logs).toContain("load: refused 9201: session is live; the live ingest service owns it");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a session already marked live in the database is refused even though its own window has closed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "load-recording-live-db-test-"));
    try {
      await writeFile(
        path.join(dir, "session.json"),
        sessionJson({ sessionKey: 9301, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
      );
      const db = fakeDb();
      // Simulate the live ingest service's row: the loader must defer to it
      // even though FAR_FUTURE_NOW is long past this recording's own window.
      db.sessions.set("9301", { status: "live" });

      const logs: string[] = [];
      const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: (line) => logs.push(line) });

      expect(totals.inserted).toBe(0);
      expect(totals.sessionsSkipped).toBe(1);
      expect(db.sessions.get("9301")?.status).toBe("live"); // untouched, not overwritten to finished
      expect(logs).toContain("load: refused 9301: session is live; the live ingest service owns it");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadRecordings: a malformed sibling session doesn't lose the others' rows (round 1 fix)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "load-recording-root-test-"));

    const goodDir = path.join(rootDir, "9101");
    await mkdir(path.join(goodDir, "raw"), { recursive: true });
    await writeFile(
      path.join(goodDir, "session.json"),
      sessionJson({ sessionKey: 9101, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
    );
    await writeFile(
      path.join(goodDir, "raw", "position.jsonl"),
      jsonlLine({ session_key: 9101, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }),
    );

    const badDir = path.join(rootDir, "9102");
    await mkdir(path.join(badDir, "raw"), { recursive: true });
    await writeFile(
      path.join(badDir, "session.json"),
      sessionJson({ sessionKey: 9102, dateStart: "not-a-date", dateEnd: "2026-01-01T15:00:00+00:00" }),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("the good session's rows reach the fake writer; the summary reports one skipped session; nothing throws", async () => {
    const db = fakeDb();
    const logs: string[] = [];
    const totals = await loadRecordings([rootDir], db, {
      now: () => Date.parse("2026-06-01T00:00:00Z"),
      onLog: (line) => logs.push(line),
    });

    // 22 static entry-list drivers + 1 position row for session 9101 only —
    // 9102's rows were never even read (it fails before that point).
    expect(totals.inserted).toBe(23);
    expect(totals.skipped).toBe(0);
    expect(totals.sessionsAttempted).toBe(2);
    expect(totals.sessionsSkipped).toBe(1);

    expect(db.sessions.has("9101")).toBe(true);
    expect(db.sessions.has("9102")).toBe(false);

    expect(logs.some((line) => line === "load: summary inserted=23 skipped=0 skipped_sessions=1")).toBe(true);
    expect(logs.some((line) => line.startsWith("load: session skipped 9102:") && line.includes("date_start"))).toBe(
      true,
    );
  });
});
