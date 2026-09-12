// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`. Connection pattern from
// `packages/db/src/db.integration.test.ts`.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { createDb, type PrismaClient } from "@formula-time/db";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { createExporter } from "./exporter.js";

const gunzipAsync = promisify(gunzip);

const db: PrismaClient = createDb();

const SESSION_KEY = 9_000_003n;
const DRIVERS_ONLY_SESSION_KEY = 9_000_004n;
const RELOAD_SESSION_KEY = 9_000_005n;

const ALL_SESSION_KEYS = [SESSION_KEY, DRIVERS_ONLY_SESSION_KEY, RELOAD_SESSION_KEY];

async function wipe(): Promise<void> {
  await db.export.deleteMany({ where: { sessionKey: { in: ALL_SESSION_KEYS } } });
  await db.event.deleteMany({ where: { sessionKey: { in: ALL_SESSION_KEYS } } });
  await db.session.deleteMany({ where: { sessionKey: { in: ALL_SESSION_KEYS } } });
}

let dir: string;

beforeAll(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: SESSION_KEY,
      name: "Exporter Integration Test Grand Prix",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 53,
      status: "finished",
      meetingName: "Exporter Integration Test Grand Prix",
      circuitShortName: "Testland Circuit",
      location: "Testville",
    },
  });
  await db.event.createMany({
    data: [
      {
        eventId: "exporter-it-1",
        sessionKey: SESSION_KEY,
        endpoint: "position",
        sourceTime: new Date("2026-09-08T12:10:00.000Z"),
        payload: { driver_number: 1, position: 1 },
      },
      {
        eventId: "exporter-it-2",
        sessionKey: SESSION_KEY,
        endpoint: "position",
        sourceTime: null,
        payload: { driver_number: 2, position: 2 },
      },
      {
        eventId: "exporter-it-3",
        sessionKey: SESSION_KEY,
        endpoint: "drivers",
        sourceTime: new Date("2026-09-08T12:20:00.000Z"),
        payload: { driver_number: 3, full_name: "Driver Three" },
      },
    ],
  });

  // A finished practice/qualifying-shaped session whose only ingest
  // activity was the `drivers` endpoint -- no timing data to replay.
  await db.session.create({
    data: {
      sessionKey: DRIVERS_ONLY_SESSION_KEY,
      name: "Exporter Integration Test Practice",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T09:00:00.000Z"),
      dateEnd: new Date("2026-09-08T10:00:00.000Z"),
      totalLaps: null,
      status: "finished",
    },
  });
  await db.event.create({
    data: {
      eventId: "exporter-it-drivers-only",
      sessionKey: DRIVERS_ONLY_SESSION_KEY,
      endpoint: "drivers",
      sourceTime: new Date("2026-09-08T09:05:00.000Z"),
      payload: { driver_number: 4, full_name: "Driver Four" },
    },
  });
});

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("exports a real session: gzip file matches ADR-0009 §1 exactly; a second runOnce writes nothing more", async () => {
  dir = await mkdtemp(join(tmpdir(), "exporter-integration-"));
  const exporter = createExporter({ db, dir, log: () => {} });

  await exporter.runOnce();

  const row = await db.export.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });
  expect(row.path).toBe(join(dir, `${SESSION_KEY.toString()}.json.gz`));

  const gz = await readFile(row.path);
  const json = JSON.parse((await gunzipAsync(gz)).toString("utf-8")) as {
    schema: number;
    exported_at: string;
    session: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
  };

  expect(json.schema).toBe(1);
  expect(json.exported_at).toBe(row.exportedAt.toISOString());
  expect(json.session).toEqual({
    session_key: Number(SESSION_KEY),
    name: "Exporter Integration Test Grand Prix",
    country: "Testland",
    circuit_key: 1,
    date_start: "2026-09-08T12:00:00.000Z",
    date_end: "2026-09-08T14:00:00.000Z",
    total_laps: 53,
    status: "finished",
    meeting_name: "Exporter Integration Test Grand Prix",
    circuit_short_name: "Testland Circuit",
    location: "Testville",
  });

  expect(json.events).toHaveLength(3);
  expect(json.events.map((e) => e["event_id"])).toEqual(["exporter-it-1", "exporter-it-2", "exporter-it-3"]);
  for (const e of json.events) {
    expect(Object.keys(e).sort()).toEqual(["endpoint", "event_id", "payload", "source_time"]);
  }
  expect(json.events[1]?.["source_time"]).toBeNull();

  // Idempotent: a second pass finds the session already has an `exports`
  // row and does nothing (HLD §7 "Export").
  const countBefore = await db.export.count({ where: { sessionKey: SESSION_KEY } });
  await exporter.runOnce();
  const countAfter = await db.export.count({ where: { sessionKey: SESSION_KEY } });
  expect(countAfter).toBe(countBefore);
});

test("reload: three later-received rows on an already-exported session move exported_at and land in the file", async () => {
  dir = await mkdtemp(join(tmpdir(), "exporter-integration-"));
  await db.session.create({
    data: {
      sessionKey: RELOAD_SESSION_KEY,
      name: "Exporter Integration Test Reload Grand Prix",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 53,
      status: "finished",
    },
  });
  await db.event.createMany({
    data: [
      {
        eventId: "exporter-it-reload-1",
        sessionKey: RELOAD_SESSION_KEY,
        endpoint: "position",
        sourceTime: new Date("2026-09-08T12:10:00.000Z"),
        payload: { driver_number: 1, position: 1 },
      },
      {
        eventId: "exporter-it-reload-2",
        sessionKey: RELOAD_SESSION_KEY,
        endpoint: "position",
        sourceTime: new Date("2026-09-08T12:11:00.000Z"),
        payload: { driver_number: 2, position: 2 },
      },
    ],
  });

  const exporter = createExporter({ db, dir, log: () => {} });
  await exporter.runOnce();

  const firstRow = await db.export.findUniqueOrThrow({ where: { sessionKey: RELOAD_SESSION_KEY } });

  // A reload writes new rows with a `received_at` after the first export's
  // `exported_at` -- the same shape a re-run of ingest's replay produces.
  const reloadedAt = new Date(firstRow.exportedAt.getTime() + 1000);
  await db.event.createMany({
    data: [
      {
        eventId: "exporter-it-reload-3",
        sessionKey: RELOAD_SESSION_KEY,
        endpoint: "position",
        sourceTime: new Date("2026-09-08T12:12:00.000Z"),
        receivedAt: reloadedAt,
        payload: { driver_number: 3, position: 3 },
      },
      {
        eventId: "exporter-it-reload-4",
        sessionKey: RELOAD_SESSION_KEY,
        endpoint: "position",
        sourceTime: new Date("2026-09-08T12:13:00.000Z"),
        receivedAt: reloadedAt,
        payload: { driver_number: 4, position: 4 },
      },
      {
        eventId: "exporter-it-reload-5",
        sessionKey: RELOAD_SESSION_KEY,
        endpoint: "position",
        sourceTime: new Date("2026-09-08T12:14:00.000Z"),
        receivedAt: reloadedAt,
        payload: { driver_number: 5, position: 5 },
      },
    ],
  });

  await exporter.runOnce();

  const secondRow = await db.export.findUniqueOrThrow({ where: { sessionKey: RELOAD_SESSION_KEY } });
  expect(secondRow.exportedAt.getTime()).toBeGreaterThan(firstRow.exportedAt.getTime());
  expect(secondRow.path).toBe(firstRow.path);

  const gz = await readFile(secondRow.path);
  const json = JSON.parse((await gunzipAsync(gz)).toString("utf-8")) as {
    exported_at: string;
    events: Array<Record<string, unknown>>;
  };
  expect(json.exported_at).toBe(secondRow.exportedAt.toISOString());
  expect(json.events.map((e) => e["event_id"])).toEqual([
    "exporter-it-reload-1",
    "exporter-it-reload-2",
    "exporter-it-reload-3",
    "exporter-it-reload-4",
    "exporter-it-reload-5",
  ]);
});

test("finished session with only drivers events: skipped, no exports row against real Postgres", async () => {
  dir = await mkdtemp(join(tmpdir(), "exporter-integration-"));
  const log = vi.fn();
  const exporter = createExporter({ db, dir, log });

  await exporter.runOnce();

  const row = await db.export.findUnique({ where: { sessionKey: DRIVERS_ONLY_SESSION_KEY } });
  expect(row).toBeNull();
  expect(log).toHaveBeenCalledWith(`export skipped ${DRIVERS_ONLY_SESSION_KEY.toString()}: no timing events`);
});
