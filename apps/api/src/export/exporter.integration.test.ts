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

async function wipe(): Promise<void> {
  await db.export.deleteMany({ where: { sessionKey: { in: [SESSION_KEY, DRIVERS_ONLY_SESSION_KEY] } } });
  await db.event.deleteMany({ where: { sessionKey: { in: [SESSION_KEY, DRIVERS_ONLY_SESSION_KEY] } } });
  await db.session.deleteMany({ where: { sessionKey: { in: [SESSION_KEY, DRIVERS_ONLY_SESSION_KEY] } } });
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

test("finished session with only drivers events: skipped, no exports row against real Postgres", async () => {
  dir = await mkdtemp(join(tmpdir(), "exporter-integration-"));
  const log = vi.fn();
  const exporter = createExporter({ db, dir, log });

  await exporter.runOnce();

  const row = await db.export.findUnique({ where: { sessionKey: DRIVERS_ONLY_SESSION_KEY } });
  expect(row).toBeNull();
  expect(log).toHaveBeenCalledWith(`export skipped ${DRIVERS_ONLY_SESSION_KEY.toString()}: no timing events`);
});
