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
  meetingName: string | null;
  circuitShortName: string | null;
  location: string | null;
}

interface FakeEventRow {
  seq: bigint;
  eventId: string;
  sessionKey: bigint;
  endpoint: string;
  sourceTime: Date | null;
  receivedAt: Date;
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
    meetingName: "Test Grand Prix",
    circuitShortName: "Testland Circuit",
    location: "Testville",
  };
}

function event(
  sessionKey: bigint,
  seq: bigint,
  endpoint = "position",
  receivedAt = new Date("2026-09-08T12:30:00.000Z"),
): FakeEventRow {
  return {
    seq,
    eventId: `event-${sessionKey.toString()}-${seq.toString()}`,
    sessionKey,
    endpoint,
    sourceTime: new Date("2026-09-08T12:30:00.000Z"),
    receivedAt,
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
    // Stands in for the one raw query `runOnce` issues: `finished` sessions
    // left-joined to `exports` and to `MAX(received_at)` grouped by
    // `session_key`, keeping a row when there is no `exports` row yet or
    // when the max `received_at` is newer than `exported_at`.
    $queryRaw: vi.fn(async () => {
      calls.push("$queryRaw");
      const rows: Array<{ session_key: string; exported_at: Date | null; path: string | null }> = [];
      for (const s of sessions) {
        if (s.status !== "finished") continue;
        const existing = exports.find((e) => e.sessionKey === s.sessionKey);
        const maxReceivedAt = events
          .filter((e) => e.sessionKey === s.sessionKey)
          .reduce<Date | null>((max, e) => (max === null || e.receivedAt > max ? e.receivedAt : max), null);
        const isNew = existing === undefined;
        const isStale = existing !== undefined && maxReceivedAt !== null && maxReceivedAt > existing.exportedAt;
        if (isNew || isStale) {
          rows.push({
            session_key: s.sessionKey.toString(),
            exported_at: existing?.exportedAt ?? null,
            path: existing?.path ?? null,
          });
        }
      }
      return rows;
    }),
    session: {
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
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { sessionKey: bigint };
          data: { exportedAt: Date; path: string };
        }) => {
          calls.push("export.update");
          const idx = exports.findIndex((e) => e.sessionKey === where.sessionKey);
          if (idx === -1) throw new Error(`no export row for ${where.sessionKey.toString()}`);
          const row = exports[idx];
          if (row === undefined) throw new Error(`no export row for ${where.sessionKey.toString()}`);
          const updated = { ...row, exportedAt: data.exportedAt, path: data.path };
          exports[idx] = updated;
          return updated;
        },
      ),
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

  test("session object carries meeting_name, circuit_short_name and location; null when the row has none", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(12n, "finished"));
    db.events.push(event(12n, 1n));

    const withNaming = createExporter({
      db: db as unknown as PrismaClient,
      dir: join(tmpRoot, "with-naming"),
      log: vi.fn(),
    });
    await withNaming.runOnce();
    const withNamingJson = JSON.parse(
      (await gunzipAsync(await readFile(join(tmpRoot, "with-naming", "12.json.gz")))).toString("utf-8"),
    ) as { session: { meeting_name: string | null; circuit_short_name: string | null; location: string | null } };
    expect(withNamingJson.session.meeting_name).toBe("Test Grand Prix");
    expect(withNamingJson.session.circuit_short_name).toBe("Testland Circuit");
    expect(withNamingJson.session.location).toBe("Testville");

    const bare = makeFakeDb();
    bare.sessions.push({
      ...session(13n, "finished"),
      meetingName: null,
      circuitShortName: null,
      location: null,
    });
    bare.events.push(event(13n, 1n));

    const withoutNaming = createExporter({
      db: bare as unknown as PrismaClient,
      dir: join(tmpRoot, "without-naming"),
      log: vi.fn(),
    });
    await withoutNaming.runOnce();
    const withoutNamingJson = JSON.parse(
      (await gunzipAsync(await readFile(join(tmpRoot, "without-naming", "13.json.gz")))).toString("utf-8"),
    ) as { session: { meeting_name: string | null; circuit_short_name: string | null; location: string | null } };
    expect(withoutNamingJson.session.meeting_name).toBeNull();
    expect(withoutNamingJson.session.circuit_short_name).toBeNull();
    expect(withoutNamingJson.session.location).toBeNull();
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

  test("stale: an exports row with a newer received_at is re-exported with a later exported_at, row updated", async () => {
    const db = makeFakeDb();
    db.sessions.push(session(9n, "finished"));
    const oldExportedAt = new Date("2026-09-09T00:00:00.000Z");
    db.exports.push({ sessionKey: 9n, exportedAt: oldExportedAt, path: "/old/9.json.gz" });
    db.events.push(event(9n, 1n, "position", new Date("2026-09-09T01:00:00.000Z")));

    const dir = join(tmpRoot, "out");
    const log = vi.fn();
    const exporter = createExporter({ db: db as unknown as PrismaClient, dir, log });
    await exporter.runOnce();

    expect(db.calls).toContain("export.update");
    expect(db.calls).not.toContain("export.create");
    expect(db.exports).toHaveLength(1);
    const row = db.exports[0];
    expect(row?.exportedAt.getTime()).toBeGreaterThan(oldExportedAt.getTime());
    expect(log).toHaveBeenCalledWith("export re-exported 9", expect.objectContaining({ exportedAt: row?.exportedAt.toISOString() }));

    const gz = await readFile(join(dir, "9.json.gz"));
    const json = JSON.parse((await gunzipAsync(gz)).toString("utf-8")) as { exported_at: string };
    expect(json.exported_at).toBe(row?.exportedAt.toISOString());
  });

  test("not stale: an exports row with an older (or equal) received_at is left alone", async () => {
    const db = makeFakeDb();
    const exportedAt = new Date("2026-09-09T01:00:00.000Z");
    db.sessions.push(session(10n, "finished"));
    db.exports.push({ sessionKey: 10n, exportedAt, path: "/old/10.json.gz" });
    db.events.push(event(10n, 1n, "position", new Date("2026-09-09T00:00:00.000Z")));

    const exporter = createExporter({ db: db as unknown as PrismaClient, dir: join(tmpRoot, "out"), log: vi.fn() });
    await exporter.runOnce();

    expect(db.calls).not.toContain("export.update");
    expect(db.calls).not.toContain("export.create");
    expect(db.exports[0]?.exportedAt).toEqual(exportedAt);
  });

  test("a write failure during re-export leaves the old row and file untouched", async () => {
    const db = makeFakeDb();
    const oldExportedAt = new Date("2026-09-09T00:00:00.000Z");
    db.sessions.push(session(11n, "finished"));
    db.exports.push({ sessionKey: 11n, exportedAt: oldExportedAt, path: "/old/11.json.gz" });
    db.events.push(event(11n, 1n, "position", new Date("2026-09-09T01:00:00.000Z")));

    // Same ENOTDIR trick as the "new" write-failure test: a path segment
    // that is an ordinary file, not a directory.
    const blocker = join(tmpRoot, "stale-blocker-file");
    await writeFile(blocker, "not a directory");
    const badDir = join(blocker, "sub");

    const log = vi.fn();
    const exporter = createExporter({ db: db as unknown as PrismaClient, dir: badDir, log });
    await exporter.runOnce();

    expect(db.calls).not.toContain("export.update");
    expect(db.exports[0]?.exportedAt).toEqual(oldExportedAt);
    expect(db.exports[0]?.path).toBe("/old/11.json.gz");
    expect(log).toHaveBeenCalledWith("export failed", expect.objectContaining({ sessionKey: "11" }));
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
