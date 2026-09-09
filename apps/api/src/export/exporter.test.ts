// Unit tests: a recording, in-memory fake stands in for PrismaClient (the
// pattern in apps/api/src/polls/poll-module.test.ts). File writes are real
// (fast, deterministic Node fs against an OS temp dir) -- only the database
// is faked.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@formula-time/db";

import { createExporter } from "./exporter.js";

const gunzipAsync = promisify(gunzip);

interface FakeSessionRow {
  sessionKey: bigint;
  name: string;
  country: string;
  circuitKey: number;
  dateStart: Date;
  dateEnd: Date;
  totalLaps: number | null;
  status: "upcoming" | "live" | "finished";
}

interface FakeEventRow {
  seq: bigint;
  eventId: string;
  sessionKey: bigint;
  endpoint: string;
  sourceTime: Date | null;
  payload: unknown;
}

interface FakeExportRow {
  sessionKey: bigint;
  exportedAt: Date;
  path: string;
}

function session(sessionKey: bigint, status: FakeSessionRow["status"]): FakeSessionRow {
  return {
    sessionKey,
    name: "Test GP",
    country: "Testland",
    circuitKey: 1,
    dateStart: new Date("2026-09-08T12:00:00.000Z"),
    dateEnd: new Date("2026-09-08T14:00:00.000Z"),
    totalLaps: 50,
    status,
  };
}

function event(sessionKey: bigint, seq: bigint, endpoint = "position"): FakeEventRow {
  return {
    seq,
    eventId: `event-${sessionKey.toString()}-${seq.toString()}`,
    sessionKey,
    endpoint,
    sourceTime: new Date("2026-09-08T12:30:00.000Z"),
    payload: { driver_number: 1 },
  };
}

function makeFakeDb() {
  const calls: string[] = [];
  const sessions: FakeSessionRow[] = [];
  const events: FakeEventRow[] = [];
  const exports: FakeExportRow[] = [];

  return {
    calls,
    sessions,
    events,
    exports,
    session: {
      findMany: vi.fn(async ({ where }: { where: { status: string; export: null } }) => {
        calls.push("session.findMany");
        return sessions.filter(
          (s) => s.status === where.status && !exports.some((e) => e.sessionKey === s.sessionKey),
        );
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { sessionKey: bigint } }) => {
        calls.push("session.findUniqueOrThrow");
        const found = sessions.find((s) => s.sessionKey === where.sessionKey);
        if (found === undefined) throw new Error(`no session ${where.sessionKey.toString()}`);
        return found;
      }),
    },
    event: {
      findMany: vi.fn(
        async ({ where, take }: { where: { sessionKey: bigint; seq: { gt: bigint } }; take: number }) => {
          calls.push("event.findMany");
          return events
            .filter((e) => e.sessionKey === where.sessionKey && e.seq > where.seq.gt)
            .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
            .slice(0, take);
        },
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { sessionKey: bigint; endpoint: { not: string } } }) => {
          calls.push("event.findFirst");
          const found = events.find(
            (e) => e.sessionKey === where.sessionKey && e.endpoint !== where.endpoint.not,
          );
          return found === undefined ? null : { seq: found.seq };
        },
      ),
    },
    export: {
      create: vi.fn(async ({ data }: { data: FakeExportRow }) => {
        calls.push("export.create");
        exports.push({ ...data });
        return data;
      }),
    },
  };
}

type FakeDb = ReturnType<typeof makeFakeDb>;

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "exporter-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("createExporter", () => {
  test("finished, no exports row: the file is written, then the row is created, same timestamp in both", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(1n, "finished"));
    db.events.push(event(1n, 1n), event(1n, 2n));

    const dir = join(tmpRoot, "out");
    const exporter = createExporter({ db: db as unknown as PrismaClient, dir, log: vi.fn() });
    await exporter.runOnce();

    expect(db.exports).toHaveLength(1);
    const row = db.exports[0];
    expect(row).toBeDefined();

    const gz = await readFile(join(dir, "1.json.gz"));
    const json = JSON.parse((await gunzipAsync(gz)).toString("utf-8")) as {
      schema: number;
      exported_at: string;
      events: unknown[];
    };
    expect(json.schema).toBe(1);
    expect(json.exported_at).toBe(row?.exportedAt.toISOString());
    expect(json.events).toHaveLength(2);
  });

  test("finished, already has an exports row: untouched", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(2n, "finished"));
    db.exports.push({ sessionKey: 2n, exportedAt: new Date(), path: "/existing/2.json.gz" });

    const exporter = createExporter({
      db: db as unknown as PrismaClient,
      dir: join(tmpRoot, "out"),
      log: vi.fn(),
    });
    await exporter.runOnce();

    expect(db.exports).toHaveLength(1);
    expect(db.calls).not.toContain("export.create");
    expect(db.calls).not.toContain("event.findMany");
  });

  test("finished, only drivers events: skipped, no exports row, logged once", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(6n, "finished"));
    db.events.push(event(6n, 1n, "drivers"), event(6n, 2n, "drivers"));

    const log = vi.fn();
    const exporter = createExporter({ db: db as unknown as PrismaClient, dir: join(tmpRoot, "out"), log });

    await exporter.runOnce();
    expect(db.exports).toHaveLength(0);
    expect(db.calls).not.toContain("export.create");
    expect(log).toHaveBeenCalledWith("export skipped 6: no timing events");
    expect(log).toHaveBeenCalledTimes(1);

    // Re-checked on a later tick, but logged only once per process.
    await exporter.runOnce();
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("finished, only drivers events at first: exported once a timing event lands", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(7n, "finished"));
    db.events.push(event(7n, 1n, "drivers"));

    const log = vi.fn();
    const exporter = createExporter({ db: db as unknown as PrismaClient, dir: join(tmpRoot, "out"), log });

    await exporter.runOnce();
    expect(db.exports).toHaveLength(0);

    // A late load adds timing data; the next tick exports it.
    db.events.push(event(7n, 2n, "position"));
    await exporter.runOnce();
    expect(db.exports).toHaveLength(1);
    expect(db.exports[0]?.sessionKey).toBe(7n);
  });

  test("finished, has a position event: exported (not skipped)", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(8n, "finished"));
    db.events.push(event(8n, 1n, "drivers"), event(8n, 2n, "position"));

    const log = vi.fn();
    const exporter = createExporter({ db: db as unknown as PrismaClient, dir: join(tmpRoot, "out"), log });
    await exporter.runOnce();

    expect(db.exports).toHaveLength(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("export skipped"));
  });

  test("live session: untouched", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(3n, "live"));

    const exporter = createExporter({
      db: db as unknown as PrismaClient,
      dir: join(tmpRoot, "out"),
      log: vi.fn(),
    });
    await exporter.runOnce();

    expect(db.exports).toHaveLength(0);
    expect(db.calls).not.toContain("event.findMany");
  });

  test("a write failure leaves no row; the next runOnce (once fixed) retries and succeeds", async () => {
    const db: FakeDb = makeFakeDb();
    db.sessions.push(session(4n, "finished"));
    db.events.push(event(4n, 1n));

    // `mkdir(dir, { recursive: true })` fails with ENOTDIR when a path
    // segment is an ordinary file instead of a directory.
    const blocker = join(tmpRoot, "blocker-file");
    await writeFile(blocker, "not a directory");
    const badDir = join(blocker, "sub");

    const log = vi.fn();
    const failingExporter = createExporter({ db: db as unknown as PrismaClient, dir: badDir, log });
    await failingExporter.runOnce();

    expect(db.exports).toHaveLength(0);
    expect(log).toHaveBeenCalledWith("export failed", expect.objectContaining({ sessionKey: "4" }));

    const goodDir = join(tmpRoot, "good");
    const retryExporter = createExporter({ db: db as unknown as PrismaClient, dir: goodDir, log });
    await retryExporter.runOnce();

    expect(db.exports).toHaveLength(1);
  });

  test("start()/stop() manage a timer without throwing, and stop() is idempotent", () => {
    const db = makeFakeDb();
    const exporter = createExporter({ db: db as unknown as PrismaClient, dir: join(tmpRoot, "out"), log: vi.fn() });
    exporter.start();
    exporter.start(); // idempotent -- must not create a second timer
    exporter.stop();
    expect(() => exporter.stop()).not.toThrow();
  });
});
