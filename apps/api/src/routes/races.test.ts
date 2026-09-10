// Unit tests: an in-memory fake stands in for PrismaClient (the pattern
// in apps/api/src/export/exporter.test.ts), a fake exporter writes a
// small real gzip file and counts calls, and Fastify's own `inject`
// drives the two routes (the pattern in apps/api/src/cors.test.ts).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip, gzipSync } from "node:zlib";
import { promisify } from "node:util";

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@formula-time/db";

import type { Exporter } from "../export/exporter.js";
import { racesRoutes } from "./races.js";

const gunzipAsync = promisify(gunzip);

interface FakeSessionRow {
  name: string;
  country: string;
  dateStart: Date;
  dateEnd: Date;
  totalLaps: number | null;
}

interface FakeExportRow {
  sessionKey: bigint;
  exportedAt: Date;
  path: string;
  session: FakeSessionRow;
}

function exportRow(sessionKey: bigint, overrides: Partial<FakeSessionRow & { exportedAt: Date }> = {}): FakeExportRow {
  return {
    sessionKey,
    exportedAt: overrides.exportedAt ?? new Date("2026-09-08T18:00:00.000Z"),
    path: `/exports/${sessionKey.toString()}.json.gz`,
    session: {
      name: overrides.name ?? "Test GP",
      country: overrides.country ?? "Testland",
      dateStart: overrides.dateStart ?? new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: overrides.dateEnd ?? new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: overrides.totalLaps ?? 50,
    },
  };
}

function makeFakeDb(rows: FakeExportRow[] = []) {
  return {
    rows,
    export: {
      findMany: vi.fn(async () => rows.map((r) => ({ ...r, session: { ...r.session } }))),
      findUnique: vi.fn(async ({ where }: { where: { sessionKey: bigint } }) => {
        const found = rows.find((r) => r.sessionKey === where.sessionKey);
        return found === undefined ? null : { ...found, session: { ...found.session } };
      }),
    },
  };
}

function makeFakeExporter(dir: string, gz: Buffer) {
  const calls: Array<{ sessionKey: bigint; exportedAt: Date }> = [];
  return {
    calls,
    runOnce: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    exportSession: vi.fn(async (sessionKey: bigint, exportedAt: Date) => {
      calls.push({ sessionKey, exportedAt });
      await writeFile(join(dir, `${sessionKey.toString()}.json.gz`), gz);
    }),
  } satisfies Exporter & { calls: Array<{ sessionKey: bigint; exportedAt: Date }> };
}

function buildApp(db: unknown, exporter: Exporter, dir: string) {
  const app = Fastify();
  app.register(racesRoutes, {
    prefix: "/api",
    db: db as unknown as PrismaClient,
    exporter,
    dir,
  });
  return app;
}

interface FakeEventRow {
  seq: bigint;
  eventId: string;
  endpoint: string;
  sourceTime: Date | null;
  payload: unknown;
}

interface FakeEventsDbOptions {
  session?: { status: "upcoming" | "live" | "finished" } | null;
  events?: FakeEventRow[];
}

// Mirrors prismaEventSource's query (apps/api/src/projector/event-source.ts):
// filter to seq > afterSeq, sort ascending, take the page.
function makeFakeEventsDb(opts: FakeEventsDbOptions) {
  const events = opts.events ?? [];
  const session = opts.session === undefined ? null : opts.session;
  return {
    session: {
      findUnique: vi.fn(async () => session),
    },
    event: {
      findMany: vi.fn(async ({ where, take }: { where: { sessionKey: bigint; seq: { gt: bigint } }; take: number }) => {
        return events
          .filter((row) => row.seq > where.seq.gt)
          .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
          .slice(0, take);
      }),
    },
  };
}

let dir: string;
let gz: Buffer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "races-test-"));
  gz = gzipSync(Buffer.from(JSON.stringify({ schema: 1, hello: "world" })));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/races", () => {
  test("index shape and order: sorted by date_start descending", async () => {
    const older = exportRow(1n, { dateStart: new Date("2026-01-01T00:00:00.000Z") });
    const newer = exportRow(2n, { dateStart: new Date("2026-06-01T00:00:00.000Z") });
    const db = makeFakeDb([older, newer]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const res = await app.inject({ url: "/api/races" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        session_key: 2,
        name: "Test GP",
        country: "Testland",
        date_start: "2026-06-01T00:00:00.000Z",
        date_end: "2026-09-08T14:00:00.000Z",
        total_laps: 50,
        exported_at: "2026-09-08T18:00:00.000Z",
      },
      {
        session_key: 1,
        name: "Test GP",
        country: "Testland",
        date_start: "2026-01-01T00:00:00.000Z",
        date_end: "2026-09-08T14:00:00.000Z",
        total_laps: 50,
        exported_at: "2026-09-08T18:00:00.000Z",
      },
    ]);
  });

  test("empty index", async () => {
    const db = makeFakeDb([]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const res = await app.inject({ url: "/api/races" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("GET /api/races/:session_key", () => {
  test("400 for a non-integer key", async () => {
    const db = makeFakeDb([]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const res = await app.inject({ url: "/api/races/abc" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("404 with no row", async () => {
    const db = makeFakeDb([]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const res = await app.inject({ url: "/api/races/11361" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("200 with the exact headers and a gunzippable body equal to the file", async () => {
    const row = exportRow(11361n);
    await writeFile(join(dir, "11361.json.gz"), gz);
    const db = makeFakeDb([row]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const res = await app.inject({ url: "/api/races/11361" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["etag"]).toBe(`"11361-${row.exportedAt.getTime()}"`);
    expect(res.headers["vary"]).toBe("accept-encoding");
    expect(res.rawPayload).toEqual(gz);
    const body = await gunzipAsync(res.rawPayload);
    expect(JSON.parse(body.toString("utf-8"))).toEqual({ schema: 1, hello: "world" });
    expect(exporter.calls).toHaveLength(0);
  });

  test("304 on matching if-none-match, no body", async () => {
    const row = exportRow(11361n);
    await writeFile(join(dir, "11361.json.gz"), gz);
    const db = makeFakeDb([row]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);
    const etag = `"11361-${row.exportedAt.getTime()}"`;

    const res = await app.inject({ url: "/api/races/11361", headers: { "if-none-match": etag } });

    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
    expect(res.headers["etag"]).toBe(etag);
  });

  test("missing file: the exporter regenerates it once, then serves 200; a second request does not call it again", async () => {
    const row = exportRow(11361n);
    // No file written to `dir` -- it is missing on disk (ADR-0009 §3).
    const db = makeFakeDb([row]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const first = await app.inject({ url: "/api/races/11361" });
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload).toEqual(gz);
    expect(exporter.calls).toHaveLength(1);
    expect(exporter.calls[0]).toEqual({ sessionKey: 11361n, exportedAt: row.exportedAt });

    const second = await app.inject({ url: "/api/races/11361" });
    expect(second.statusCode).toBe(200);
    expect(exporter.calls).toHaveLength(1);
  });

  test("etag changes when exported_at changes (a re-export)", async () => {
    const firstExportedAt = new Date("2026-09-08T18:00:00.000Z");
    const row = exportRow(11361n, { exportedAt: firstExportedAt });
    await writeFile(join(dir, "11361.json.gz"), gz);
    const db = makeFakeDb([row]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const first = await app.inject({ url: "/api/races/11361" });
    const firstEtag = first.headers["etag"];
    expect(firstEtag).toBe(`"11361-${firstExportedAt.getTime()}"`);

    // Same shape as a re-export: the row's exported_at moves and the file
    // is rewritten -- the route reads the row fresh on every request.
    const secondExportedAt = new Date("2026-09-09T00:00:00.000Z");
    db.rows[0]!.exportedAt = secondExportedAt;
    const gz2 = gzipSync(Buffer.from(JSON.stringify({ schema: 1, hello: "reloaded" })));
    await writeFile(join(dir, "11361.json.gz"), gz2);

    const second = await app.inject({ url: "/api/races/11361" });
    const secondEtag = second.headers["etag"];
    expect(secondEtag).toBe(`"11361-${secondExportedAt.getTime()}"`);
    expect(secondEtag).not.toBe(firstEtag);
  });

  test("?v= is ignored: same response as without it", async () => {
    const row = exportRow(11361n);
    await writeFile(join(dir, "11361.json.gz"), gz);
    const db = makeFakeDb([row]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    const withV = await app.inject({ url: "/api/races/11361?v=123456789" });
    const withoutV = await app.inject({ url: "/api/races/11361" });

    expect(withV.statusCode).toBe(200);
    expect(withV.headers["etag"]).toBe(withoutV.headers["etag"]);
    expect(withV.rawPayload).toEqual(withoutV.rawPayload);
    expect(exporter.calls).toHaveLength(0);
  });

  test("readFile sanity: on-disk file after regeneration matches the fake exporter's bytes", async () => {
    const row = exportRow(11361n);
    const db = makeFakeDb([row]);
    const exporter = makeFakeExporter(dir, gz);
    const app = buildApp(db, exporter, dir);

    await app.inject({ url: "/api/races/11361" });

    const onDisk = await readFile(join(dir, "11361.json.gz"));
    expect(onDisk).toEqual(gz);
  });
});

describe("GET /api/races/:session_key/events", () => {
  function makeEvents(count: number, startSeq = 1n): FakeEventRow[] {
    const rows: FakeEventRow[] = [];
    for (let i = 0; i < count; i++) {
      const seq = startSeq + BigInt(i);
      rows.push({
        seq,
        eventId: `evt-${seq.toString()}`,
        endpoint: "car_data",
        sourceTime: new Date(Date.UTC(2026, 8, 8, 12, 0, i)),
        payload: { n: i },
      });
    }
    return rows;
  }

  test("400 for a non-integer session_key", async () => {
    const db = makeFakeEventsDb({ session: { status: "live" } });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/abc/events" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("400 for a non-integer since_seq", async () => {
    const db = makeFakeEventsDb({ session: { status: "live" } });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?since_seq=abc" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("400 for a negative since_seq", async () => {
    const db = makeFakeEventsDb({ session: { status: "live" } });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?since_seq=-1" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("400 for a limit of 0", async () => {
    const db = makeFakeEventsDb({ session: { status: "live" } });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?limit=0" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("400 for a limit above the maximum of 5000", async () => {
    const db = makeFakeEventsDb({ session: { status: "live" } });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?limit=5001" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("400 for a non-integer limit", async () => {
    const db = makeFakeEventsDb({ session: { status: "live" } });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?limit=abc" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("404 when the session does not exist", async () => {
    const db = makeFakeEventsDb({ session: null });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  test("a short page (fewer rows than limit): shape, RaceEvent fields only, next_seq, no-store", async () => {
    const events = makeEvents(3);
    const db = makeFakeEventsDb({ session: { status: "live" }, events });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?limit=5000" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_key).toBe("11361");
    expect(body.status).toBe("live");
    expect(body.next_seq).toBe(3);
    expect(body.events).toEqual([
      { event_id: "evt-1", endpoint: "car_data", source_time: events[0]!.sourceTime!.toISOString(), payload: { n: 0 } },
      { event_id: "evt-2", endpoint: "car_data", source_time: events[1]!.sourceTime!.toISOString(), payload: { n: 1 } },
      { event_id: "evt-3", endpoint: "car_data", source_time: events[2]!.sourceTime!.toISOString(), payload: { n: 2 } },
    ]);
    // Byte-for-byte the RaceEvent shape -- no `seq` field leaks through.
    for (const event of body.events) {
      expect(Object.keys(event).sort()).toEqual(["endpoint", "event_id", "payload", "source_time"]);
    }
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a full page (events.length === limit): next_seq is the last row's seq, immutable cache header", async () => {
    const events = makeEvents(5);
    const db = makeFakeEventsDb({ session: { status: "finished" }, events });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?limit=3" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(3);
    expect(body.next_seq).toBe(3);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("paging with since_seq: only rows with seq > since_seq come back, in ascending order", async () => {
    const events = makeEvents(5);
    const db = makeFakeEventsDb({ session: { status: "live" }, events });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?since_seq=2&limit=5000" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.map((e: { event_id: string }) => e.event_id)).toEqual(["evt-3", "evt-4", "evt-5"]);
    expect(body.next_seq).toBe(5);
  });

  test("no rows past since_seq: empty events, next_seq null, no-store", async () => {
    const events = makeEvents(3);
    const db = makeFakeEventsDb({ session: { status: "live" }, events });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events?since_seq=3" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toEqual([]);
    expect(body.next_seq).toBeNull();
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("default since_seq is 0 and default limit is 5000", async () => {
    const events = makeEvents(2);
    const db = makeFakeEventsDb({ session: { status: "upcoming" }, events });
    const app = buildApp(db, makeFakeExporter("/tmp", gz), "/tmp");

    const res = await app.inject({ url: "/api/races/11361/events" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(2);
    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionKey: 11361n, seq: { gt: 0n } }, take: 5000 }),
    );
  });
});
