// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`. Reuses the DATABASE_URL vitest.integration.config.ts
// sets (5433, same as packages/db/src/db.integration.test.ts).
//
// Pins the two facts that only Postgres enforces: the same batch written
// twice via `event.createMany({ skipDuplicates: true })` leaves the row
// count unchanged (ADR-0001 §2 invariant 3: REST/MQTT twins dedup to one
// row), and `seq` is strictly increasing in arrival order across batches
// (HLD §7 single writer: one connection, so seq order == commit order).

import { afterAll, beforeEach, expect, test } from "vitest";

import { createDb } from "@formula-time/db";

import type { QueueItem } from "../openf1/types.js";
import { EventQueue } from "./queue.js";
import { EventWriter } from "./writer.js";

const db = createDb(undefined, { max: 1 });

const SESSION_KEY = 9_000_002n;

async function wipe(): Promise<void> {
  await db.event.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeEach(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: SESSION_KEY,
      name: "Writer Integration Test",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 72,
      status: "live",
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

function item(eventId: string, endpoint = "position"): QueueItem {
  return {
    eventId,
    sessionKey: SESSION_KEY,
    endpoint,
    sourceTime: new Date("2026-09-08T12:30:00.000Z"),
    payload: { eventId, driver_number: 1 },
  };
}

test("the same batch written twice leaves the row count unchanged", async () => {
  const queue = new EventQueue<QueueItem>();
  queue.push(item("writer-it-a"));
  queue.push(item("writer-it-b"));
  const writer = new EventWriter(db, queue);

  const first = await writer.drainOnce();
  expect(first).toEqual({ inserted: 2, skipped: 0 });

  // REST/MQTT twin: the same events arrive again.
  queue.push(item("writer-it-a"));
  queue.push(item("writer-it-b"));
  const second = await writer.drainOnce();
  expect(second).toEqual({ inserted: 0, skipped: 2 });

  const rows = await db.event.findMany({ where: { sessionKey: SESSION_KEY } });
  expect(rows).toHaveLength(2);
});

test("seq is strictly increasing in arrival order across two batches", async () => {
  const queue = new EventQueue<QueueItem>();
  const writer = new EventWriter(db, queue, { batchSize: 3 });

  queue.push(item("writer-it-seq-1"));
  queue.push(item("writer-it-seq-2"));
  queue.push(item("writer-it-seq-3"));
  await writer.drainOnce();

  queue.push(item("writer-it-seq-4"));
  queue.push(item("writer-it-seq-5"));
  await writer.drainOnce();

  const rows = await db.event.findMany({
    where: { sessionKey: SESSION_KEY },
    orderBy: { seq: "asc" },
  });
  expect(rows.map((r) => r.eventId)).toEqual([
    "writer-it-seq-1",
    "writer-it-seq-2",
    "writer-it-seq-3",
    "writer-it-seq-4",
    "writer-it-seq-5",
  ]);
  const seqs = rows.map((r) => r.seq);
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]! > seqs[i - 1]!).toBe(true);
  }
});
