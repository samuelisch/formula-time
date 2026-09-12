// Unit test: a tiny fixture recording
// dir (two endpoints, three rows, one duplicate) drives `loadRecordings()`
// against in-memory fakes for both `SessionsDb` and `EventWriterDb` — no
// Postgres. Pins: the fake writer receives the static-entry-list `drivers`
// events before the raw-file rows, in file order; the session is upserted
// `finished` regardless of its window; a malformed sibling session doesn't
// lose the others' rows; a live session is refused, never
// written (ADR-0010); the session is upserted `upcoming`, then its events
// are written, then it is updated to `finished`, in that order, and a
// writer failure leaves it `upcoming`.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ENTRY_LIST_2026 } from "./openf1/entry-list.js";
import type { RawRecord } from "./openf1/types.js";
import { loadRecordings, verifyCounts } from "./load-recording.js";
import type { LoaderDb } from "./load-recording.js";

// A fake row as stored by `event.createMany`/kept by `deleteMany`: enough
// fields for the tests below plus a `seq` assigned at insertion time (like
// Postgres's `autoincrement`) — reassigned on every fresh insert, including
// a row re-inserted after `--replace` deleted it, so a reload always ends
// with a fresh `seq` range, never the row's old one.
interface FakeEventRow {
  eventId: string;
  sessionKey: unknown;
  endpoint: string;
  sourceTime: Date | null;
  seq: number;
}

function fakeDb(): LoaderDb & {
  sessions: Map<string, { status?: string; [key: string]: unknown }>;
  events: Map<string, FakeEventRow>;
  insertOrder: string[];
  // Records every `session.upsert` (as `upsert:<status>`), every
  // `event.createMany` (as `events:<row count>`), and every
  // `event.deleteMany` (as `deleteMany:<row count>`) call, in call order —
  // how the tests below pin the upcoming -> events -> finished sequence and
  // the --replace delete-before-insert order.
  callLog: string[];
  // `failEvents` fails every `event.createMany` call; `failSessionKeys`
  // fails only batches whose rows belong to one of these session keys —
  // a cross-session queue-poisoning test needs one session's writes to
  // fail forever while a sibling session's succeed.
  flags: { failEvents: boolean; failSessionKeys: Set<string> };
} {
  const sessions = new Map<string, { status?: string; [key: string]: unknown }>();
  const events = new Map<string, FakeEventRow>();
  const insertOrder: string[] = [];
  const callLog: string[] = [];
  const flags = { failEvents: false, failSessionKeys: new Set<string>() };
  let nextSeq = 1;

  async function createMany(args: {
    data: Array<{ eventId: string; sessionKey: unknown; endpoint: string; sourceTime: Date | null }>;
  }): Promise<{ count: number }> {
    const batchKey = args.data[0] ? String(args.data[0].sessionKey) : undefined;
    if (flags.failEvents || (batchKey !== undefined && flags.failSessionKeys.has(batchKey))) {
      throw new Error("fake writer failure");
    }
    callLog.push(`events:${args.data.length}`);
    let count = 0;
    for (const row of args.data) {
      if (events.has(row.eventId)) continue;
      events.set(row.eventId, { ...row, seq: nextSeq });
      nextSeq += 1;
      insertOrder.push(row.eventId);
      count += 1;
    }
    return { count };
  }

  function deleteMany(args: { where: { sessionKey: bigint } }): { count: number } {
    const key = args.where.sessionKey.toString();
    let count = 0;
    for (const [eventId, row] of [...events.entries()]) {
      if (String(row.sessionKey) !== key) continue;
      events.delete(eventId);
      const index = insertOrder.indexOf(eventId);
      if (index !== -1) insertOrder.splice(index, 1);
      count += 1;
    }
    callLog.push(`deleteMany:${count}`);
    return { count };
  }

  return {
    sessions,
    events,
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
      createMany,
      async deleteMany(args) {
        return deleteMany(args);
      },
      async findMany(args) {
        const key = args.where.sessionKey.toString();
        return [...events.values()]
          .filter((row) => String(row.sessionKey) === key)
          .sort((a, b) => a.seq - b.seq)
          .map((row) => ({ endpoint: row.endpoint, sourceTime: row.sourceTime }));
      },
    },
    // A simplified stand-in for Prisma's interactive transaction: `fn` runs
    // directly against the same maps (so `deleteMany`/`createMany` inside
    // it behave exactly as they do outside one), and on a throw the maps
    // are rolled back to a snapshot taken before `fn` ran — same net effect
    // as a real ROLLBACK, without a real database.
    async $transaction(fn) {
      const eventsSnapshot = new Map(events);
      const insertOrderSnapshot = [...insertOrder];
      const nextSeqSnapshot = nextSeq;
      try {
        return await fn({
          event: {
            createMany,
            async deleteMany(args) {
              return deleteMany(args);
            },
          },
        });
      } catch (error) {
        events.clear();
        for (const [key, row] of eventsSnapshot) events.set(key, row);
        insertOrder.length = 0;
        insertOrder.push(...insertOrderSnapshot);
        nextSeq = nextSeqSnapshot;
        throw error;
      }
    },
  };
}

function sessionJson(fields: {
  sessionKey: number;
  dateStart: string;
  dateEnd: string;
  sessionName?: string;
  sessionType?: string;
}): string {
  return JSON.stringify({
    session: {
      session_key: fields.sessionKey,
      session_type: fields.sessionType ?? "Race",
      session_name: fields.sessionName ?? "Race",
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

function jsonlLineAt(receivedAt: string, payload: RawRecord): string {
  return `${JSON.stringify({ received_at: receivedAt, payload })}\n`;
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
    // Two endpoints, three unique rows, one duplicate.
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

  test("the writer's batch progress reaches the same log callback as the loader's own lines", async () => {
    const db = fakeDb();
    const logs: string[] = [];
    await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: (line) => logs.push(line) });

    expect(logs.some((line) => line.startsWith("writer: batch inserted="))).toBe(true);
  });

  test("the session is upserted finished via the override", async () => {
    const db = fakeDb();
    // The ADR-0010 guard refuses any
    // session whose window hasn't closed yet (not only a `live` one), so
    // `now` must be past the window (FAR_FUTURE_NOW) for the load to be
    // accepted at all — a `now` before the window (`computeSessionStatus`
    // would say "upcoming") is refused up front (covered below), not
    // reachable here. The final `{ status: "finished" }` override still runs
    // regardless of the naturally-computed status; with the window closed
    // that computation already agrees, so this pins the override's own
    // behaviour rather than a divergence from it.
    await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });

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

describe("loadRecordings: meeting_name — one meetings?meeting_key= fetch per session", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "load-recording-meeting-name-test-"));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({
        session: {
          session_key: 11307,
          meeting_key: 1250,
          session_type: "Race",
          session_name: "Race",
          date_start: "2026-01-01T13:00:00+00:00",
          date_end: "2026-01-01T15:00:00+00:00",
          circuit_key: 39,
          country_name: "Spain",
        },
        discovered_at: "2026-01-01T12:57:00.000Z",
      }),
    );
    await writeFile(
      path.join(dir, "raw", "meetings.jsonl"),
      jsonlLine({ meeting_key: 1250, meeting_name: "Spanish Grand Prix" }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the session row gets meeting_name from raw/meetings.jsonl", async () => {
    const db = fakeDb();
    await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });

    const row = db.sessions.get("11307");
    expect(row?.["meetingName"]).toBe("Spanish Grand Prix");
  });
});

// Upserting `finished` before events exist would let the api's exporter
// (ADR-0009 §2) export the session — once, immutably — before any event
// existed. So the loader upserts `upcoming` first, writes and drains every
// event, then updates to `finished`; a failure part-way leaves the row
// `upcoming`.
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

  test("a rerun against an already-finished session never demotes it to upcoming (round 1 fix, #74)", async () => {
    const db = fakeDb();
    await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });
    expect(db.sessions.get("9401")?.status).toBe("finished");

    const callsBeforeRerun = db.callLog.length;
    const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });

    const callsDuringRerun = db.callLog.slice(callsBeforeRerun);
    expect(callsDuringRerun).not.toContain("upsert:upcoming");
    expect(db.sessions.get("9401")?.status).toBe("finished");
    expect(totals.sessionsSkipped).toBe(0);
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

  test("round-3 review fix: an upcoming session (window not yet open) is refused too, not only a live one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "load-recording-upcoming-window-test-"));
    try {
      await writeFile(
        path.join(dir, "session.json"),
        sessionJson({ sessionKey: 9501, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
      );
      const db = fakeDb();
      const logs: string[] = [];
      const totals = await loadRecordings([dir], db, {
        now: () => FAR_PAST_NOW, // well before the window even opens: naturally "upcoming"
        onLog: (line) => logs.push(line),
      });

      expect(totals.inserted).toBe(0);
      expect(totals.sessionsSkipped).toBe(1);
      expect(db.sessions.has("9501")).toBe(false);
      expect(logs).toContain("load: refused 9501: window not closed; the live ingest service owns it");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a finished session (window closed) still loads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "load-recording-finished-window-test-"));
    try {
      await writeFile(
        path.join(dir, "session.json"),
        sessionJson({ sessionKey: 9601, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
      );
      const db = fakeDb();
      const logs: string[] = [];
      const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: (line) => logs.push(line) });

      expect(totals.sessionsSkipped).toBe(0);
      expect(db.sessions.get("9601")?.status).toBe("finished");
      expect(logs.some((line) => line.includes("9601") && line.includes("window not closed"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadRecordings: issue #168 — refuses a non-race session, writes nothing for it", () => {
  test("a recording whose session.json says Qualifying is refused before any write", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "load-recording-non-race-test-"));
    try {
      await writeFile(
        path.join(dir, "session.json"),
        sessionJson({
          sessionKey: 9701,
          dateStart: "2026-01-01T13:00:00+00:00",
          dateEnd: "2026-01-01T15:00:00+00:00",
          sessionName: "Qualifying",
          sessionType: "Qualifying",
        }),
      );
      await mkdir(path.join(dir, "raw"), { recursive: true });
      const db = fakeDb();
      const logs: string[] = [];
      const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: (line) => logs.push(line) });

      expect(totals.inserted).toBe(0);
      expect(totals.sessionsSkipped).toBe(1);
      expect(db.sessions.has("9701")).toBe(false);
      expect(db.callLog).toEqual([]); // no upsert, no createMany: refused before any write
      expect(logs).toContain('load: refused 9701: session_name is "Qualifying", only "Race" is loaded');
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

// One shared `queue`/`writer` serves every session
// in a multi-dir load. When a session's `drainAll()` gives up on a
// deterministically failing batch, `EventWriter` requeues it at the FRONT
// of the queue (writer.ts) — so without clearing it, every later session's
// own `drainAll()` call hits that stuck batch first (or gets merged into
// the same batch, since drain isn't session-aware) and is wrongly marked
// skipped for a failure that was never its own.
describe("loadRecordings: round 1 fix — a stuck session's queue doesn't poison a later session", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "load-recording-poison-test-"));

    const dirA = path.join(rootDir, "9701");
    await mkdir(path.join(dirA, "raw"), { recursive: true });
    await writeFile(
      path.join(dirA, "session.json"),
      sessionJson({ sessionKey: 9701, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
    );
    await writeFile(
      path.join(dirA, "raw", "position.jsonl"),
      jsonlLine({ session_key: 9701, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }),
    );

    const dirB = path.join(rootDir, "9702");
    await mkdir(path.join(dirB, "raw"), { recursive: true });
    await writeFile(
      path.join(dirB, "session.json"),
      sessionJson({ sessionKey: 9702, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
    );
    await writeFile(
      path.join(dirB, "raw", "position.jsonl"),
      jsonlLine({ session_key: 9702, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("session A (writer rejects it forever) is skipped for its own reason; session B still commits and finishes", async () => {
    const db = fakeDb();
    db.flags.failSessionKeys.add("9701");
    const logs: string[] = [];
    const totals = await loadRecordings([rootDir], db, {
      now: () => Date.parse("2026-06-01T00:00:00Z"),
      onLog: (line) => logs.push(line),
    });

    expect(totals.sessionsAttempted).toBe(2);
    expect(totals.sessionsSkipped).toBe(1);
    // Only B's 22 entry-list + 1 position rows ever committed — A's batch
    // never succeeded, so it contributes nothing to the total.
    expect(totals.inserted).toBe(23);
    expect(db.insertOrder).toHaveLength(23);

    expect(db.sessions.get("9701")?.status).toBe("upcoming");
    expect(db.sessions.get("9702")?.status).toBe("finished");

    expect(logs.some((line) => line.includes("9701") && line.toLowerCase().includes("writer failed"))).toBe(true);
    expect(logs.some((line) => line.startsWith("load: dropped") && line.includes("9701"))).toBe(true);
  });
});

// A bulk read of a complete recording, read in `RECORDING_ENDPOINT_ORDER`,
// must not emit one endpoint's rows fully before the next — `position`
// (read second) and `laps` (read fourth) interleave in time, so emission
// follows `received_at` across endpoints, not file-read order. This
// fixture's two endpoints interleave in time (position, laps, position,
// laps): the emitted order — same as `db.insertOrder`, since the fake
// writer records rows in the order `event.createMany` receives them — must
// follow `received_at` across endpoints, not group by endpoint.
describe("loadRecordings: issue #77 — emits interleaved-endpoint rows in received_at order", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "load-recording-time-order-test-"));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      sessionJson({ sessionKey: 9501, dateStart: "2026-01-01T13:00:00+00:00", dateEnd: "2026-01-01T15:00:00+00:00" }),
    );
    // Read order (RECORDING_ENDPOINT_ORDER) would put both position rows
    // before both laps rows; received_at order interleaves them instead.
    await writeFile(
      path.join(dir, "raw", "position.jsonl"),
      jsonlLineAt("2026-01-01T13:00:01.000Z", {
        session_key: 9501,
        driver_number: 1,
        date: "2026-01-01T13:00:01Z",
        x: 1,
        y: 1,
      }) +
        jsonlLineAt("2026-01-01T13:00:03.000Z", {
          session_key: 9501,
          driver_number: 1,
          date: "2026-01-01T13:00:03Z",
          x: 3,
          y: 3,
        }),
    );
    await writeFile(
      path.join(dir, "raw", "laps.jsonl"),
      jsonlLineAt("2026-01-01T13:00:02.000Z", {
        session_key: 9501,
        driver_number: 1,
        lap_number: 1,
        date_start: "2026-01-01T13:00:02Z",
      }) +
        jsonlLineAt("2026-01-01T13:00:04.000Z", {
          session_key: 9501,
          driver_number: 1,
          lap_number: 2,
          date_start: "2026-01-01T13:00:04Z",
        }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("position and laps rows are emitted in received_at order, not grouped by endpoint", async () => {
    const db = fakeDb();
    const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });

    // 22 static entry-list drivers + 2 position rows + 2 laps rows.
    expect(totals).toEqual({ inserted: 26, skipped: 0, sessionsAttempted: 1, sessionsSkipped: 0 });

    const afterEntryList = db.insertOrder.slice(ENTRY_LIST_2026.length);
    expect(afterEntryList).toHaveLength(4);
    // received_at: position(01), laps(02), position(03), laps(04).
    expect(afterEntryList.map((id) => id.split(":")[0])).toEqual(["position", "laps", "position", "laps"]);
  });
});

// verifyCounts: the pure function behind the "load: verify ..." log line.
// Hand-built lists, no filesystem/Postgres involved.
describe("verifyCounts", () => {
  test("endpoint-grouped input gives runs equal to the number of endpoints", () => {
    const rows = [
      { endpoint: "drivers", source_time: null },
      { endpoint: "drivers", source_time: null },
      { endpoint: "position", source_time: "2026-01-01T13:00:01Z" },
      { endpoint: "position", source_time: "2026-01-01T13:00:02Z" },
      { endpoint: "intervals", source_time: "2026-01-01T13:00:03Z" },
    ];
    expect(verifyCounts(rows)).toEqual({ rows: 5, endpoint_runs: 3, source_time_backsteps: 0 });
  });

  test("interleaved input gives more runs than the number of endpoints", () => {
    const rows = [
      { endpoint: "position", source_time: "2026-01-01T13:00:01Z" },
      { endpoint: "laps", source_time: "2026-01-01T13:00:02Z" },
      { endpoint: "position", source_time: "2026-01-01T13:00:03Z" },
      { endpoint: "laps", source_time: "2026-01-01T13:00:04Z" },
    ];
    // 2 endpoints, but every row alternates: 4 runs, not 2.
    expect(verifyCounts(rows)).toEqual({ rows: 4, endpoint_runs: 4, source_time_backsteps: 0 });
  });

  test("a source_time earlier than the previous non-null one counts as one backstep", () => {
    const rows = [
      { endpoint: "position", source_time: "2026-01-01T13:00:03Z" },
      { endpoint: "position", source_time: "2026-01-01T13:00:01Z" }, // backstep
      { endpoint: "position", source_time: "2026-01-01T13:00:02Z" }, // still behind 13:00:03, not the row before it
    ];
    expect(verifyCounts(rows).source_time_backsteps).toBe(1);
  });

  test("a null source_time neither counts as a backstep nor resets the comparison", () => {
    const rows = [
      { endpoint: "position", source_time: "2026-01-01T13:00:02Z" },
      { endpoint: "drivers", source_time: null },
      { endpoint: "position", source_time: "2026-01-01T13:00:01Z" }, // backstep against 13:00:02, the last non-null value
    ];
    expect(verifyCounts(rows).source_time_backsteps).toBe(1);
  });

  test("an empty list has zero runs and zero backsteps", () => {
    expect(verifyCounts([])).toEqual({ rows: 0, endpoint_runs: 0, source_time_backsteps: 0 });
  });
});

// --replace: a session whose events were written in the wrong seq order
// (one endpoint's rows fully before the next, instead of interleaved by
// received_at) can be reloaded in place — delete then the normal insert
// path, as one transaction, so a failed insert leaves the old rows
// untouched rather than the session ending up with fewer events than it
// started with.
describe("loadRecordings: --replace reloads a session's events in place", () => {
  let dir: string;
  const SESSION_KEY = 9801n;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "load-recording-replace-test-"));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      sessionJson({
        sessionKey: Number(SESSION_KEY),
        dateStart: "2026-01-01T13:00:00+00:00",
        dateEnd: "2026-01-01T15:00:00+00:00",
      }),
    );
    await writeFile(
      path.join(dir, "raw", "position.jsonl"),
      jsonlLine({ session_key: Number(SESSION_KEY), driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Three rows already in the database, in endpoint order rather than
  // received_at order — the shape an endpoint-grouped load leaves behind.
  // Goes through the fake's own `event.createMany` (not a direct `Map.set`)
  // so its `seq` bookkeeping advances the same way a real insert would —
  // otherwise a reload's freshly-assigned seq values could coincide with
  // these stale ones instead of exceeding them.
  async function seedStaleRows(db: ReturnType<typeof fakeDb>): Promise<void> {
    db.sessions.set(SESSION_KEY.toString(), { status: "finished" });
    await db.event.createMany({
      data: [
        {
          eventId: "stale:1",
          sessionKey: SESSION_KEY,
          endpoint: "position",
          sourceTime: new Date("2026-01-01T13:00:01Z"),
          payload: {},
        },
        {
          eventId: "stale:2",
          sessionKey: SESSION_KEY,
          endpoint: "position",
          sourceTime: new Date("2026-01-01T13:00:02Z"),
          payload: {},
        },
        {
          eventId: "stale:3",
          sessionKey: SESSION_KEY,
          endpoint: "laps",
          sourceTime: new Date("2026-01-01T13:05:00Z"),
          payload: {},
        },
      ],
      skipDuplicates: true,
    });
  }

  function sessionRows(db: ReturnType<typeof fakeDb>) {
    return [...db.events.values()].filter((row) => row.sessionKey === SESSION_KEY);
  }

  test("--replace ends with exactly the recording's rows in received_at order and a fresh seq range", async () => {
    const db = fakeDb();
    await seedStaleRows(db);
    const staleMaxSeq = Math.max(...sessionRows(db).map((row) => row.seq));

    const logs: string[] = [];
    const totals = await loadRecordings([dir], db, {
      now: () => FAR_FUTURE_NOW,
      onLog: (line) => logs.push(line),
      replace: true,
    });

    expect(totals.sessionsSkipped).toBe(0);
    expect(db.events.has("stale:1")).toBe(false);
    expect(db.events.has("stale:2")).toBe(false);
    expect(db.events.has("stale:3")).toBe(false);

    // 22 static entry-list drivers + 1 position row from the recording.
    const rows = sessionRows(db);
    expect(rows).toHaveLength(23);
    expect(rows.every((row) => row.seq > staleMaxSeq)).toBe(true);
    expect(logs).toContain("load: verify 9801 rows=23 endpoint_runs=2 source_time_backsteps=0");
  });

  test("a failed insert inside the transaction leaves the old rows in place", async () => {
    const db = fakeDb();
    await seedStaleRows(db);
    const countBefore = sessionRows(db).length;
    db.flags.failEvents = true;

    const logs: string[] = [];
    const totals = await loadRecordings([dir], db, {
      now: () => FAR_FUTURE_NOW,
      onLog: (line) => logs.push(line),
      replace: true,
    });

    expect(totals.sessionsSkipped).toBe(1);
    expect(sessionRows(db)).toHaveLength(countBefore);
    expect(db.events.has("stale:1")).toBe(true);
    expect(db.events.has("stale:2")).toBe(true);
    expect(db.events.has("stale:3")).toBe(true);
    expect(logs.some((line) => line.includes("9801") && line.includes("rolled back"))).toBe(true);
  });

  test("--replace on a live row deletes nothing and logs the ADR-0010 refusal", async () => {
    const db = fakeDb();
    db.sessions.set(SESSION_KEY.toString(), { status: "live" });
    db.events.set("stale:1", {
      eventId: "stale:1",
      sessionKey: SESSION_KEY,
      endpoint: "position",
      sourceTime: null,
      seq: 1,
    });
    db.insertOrder.push("stale:1");

    const logs: string[] = [];
    const totals = await loadRecordings([dir], db, {
      now: () => FAR_FUTURE_NOW,
      onLog: (line) => logs.push(line),
      replace: true,
    });

    expect(totals.sessionsSkipped).toBe(1);
    expect(db.events.has("stale:1")).toBe(true);
    expect(db.callLog.some((entry) => entry.startsWith("deleteMany:"))).toBe(false);
    expect(logs).toContain("load: refused 9801: session is live; the live ingest service owns it");
  });

  test("without --replace, the existing skip-duplicates behaviour is unchanged", async () => {
    const db = fakeDb();
    await seedStaleRows(db);
    const countBefore = sessionRows(db).length;

    const totals = await loadRecordings([dir], db, { now: () => FAR_FUTURE_NOW, onLog: () => {} });

    expect(totals.sessionsSkipped).toBe(0);
    expect(db.events.has("stale:1")).toBe(true);
    expect(db.events.has("stale:2")).toBe(true);
    expect(db.events.has("stale:3")).toBe(true);
    expect(db.callLog.some((entry) => entry.startsWith("deleteMany:"))).toBe(false);
    // The 3 stale rows stay, plus the 22 drivers + 1 position from the
    // recording (skip-duplicates never removes anything).
    expect(sessionRows(db)).toHaveLength(countBefore + 23);
  });
});
