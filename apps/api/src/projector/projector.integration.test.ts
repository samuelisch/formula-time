// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`. Connection pattern from
// `packages/db/src/db.integration.test.ts`.
import { createDb, type PrismaClient } from "@formula-time/db";
import { afterAll, beforeAll, expect, test } from "vitest";

import { prismaEventSource } from "./event-source.js";
import { RaceStateProjector } from "./projector.js";

const db: PrismaClient = createDb();

const SESSION_KEY = 9_000_002n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wipe(): Promise<void> {
  await db.event.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeAll(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: SESSION_KEY,
      name: "Projector Integration Test Grand Prix",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 60,
      status: "live",
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("folds real rows from Postgres, sits idle with no subscriber call, and rebuilds on a late commit", async () => {
  const session = await db.session.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });

  // A throwaway row reserves a seq value ("G") immediately below the three
  // real rows, then is deleted -- freeing that exact value for reuse later
  // as the explicit seq of a "late" row (Prisma accepts seq on create). This
  // is how a real late commit looks: a seq is assigned at insert but the row
  // that held it never lands, or lands after rows ahead of it already did.
  const gap = await db.event.create({
    data: {
      eventId: "gap-reservation",
      sessionKey: SESSION_KEY,
      endpoint: "drivers",
      payload: { driver_number: -1 },
    },
    select: { seq: true },
  });
  await db.event.delete({ where: { eventId: "gap-reservation" } });

  const created = [];
  for (const driverNumber of [1, 2, 3]) {
    created.push(
      await db.event.create({
        data: {
          eventId: `driver-${driverNumber}`,
          sessionKey: SESSION_KEY,
          endpoint: "drivers",
          payload: { driver_number: driverNumber },
        },
        select: { seq: true },
      }),
    );
  }
  const highestSeq = created[created.length - 1]?.seq;
  expect(highestSeq).toBeDefined();

  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const source = prismaEventSource(db);
  const projector = new RaceStateProjector({
    source,
    session,
    tickMs: 50,
    detectorEveryTicks: 1,
    detectorWindow: 1_000_000n,
    log: (msg, fields) => logs.push({ msg, fields }),
  });

  let calls = 0;
  projector.subscribe(() => {
    calls += 1;
  });

  try {
    projector.start();
    await vi_waitFor(() => projector.status().caughtUp === true);

    expect(projector.snapshot().drivers["1"]).toBeDefined();
    expect(projector.snapshot().drivers["2"]).toBeDefined();
    expect(projector.snapshot().drivers["3"]).toBeDefined();
    expect(projector.status().cursor).toBe(highestSeq);
    expect(calls).toBe(1);

    // A second tick with no new rows: no subscriber call.
    await sleep(150);
    expect(calls).toBe(1);

    // The late row: explicit seq below the cursor, reusing the freed gap.
    await db.event.create({
      data: {
        eventId: "driver-late",
        sessionKey: SESSION_KEY,
        endpoint: "drivers",
        payload: { driver_number: 999 },
        seq: gap.seq,
      },
    });

    await vi_waitFor(() => logs.some((l) => l.msg === "late commit detected"));
    await vi_waitFor(() => projector.snapshot().drivers["999"] !== undefined);

    expect(projector.snapshot().drivers["999"]).toBeDefined();
    expect(projector.status().cursor).toBe(highestSeq);
  } finally {
    projector.stop();
    await db.event.deleteMany({ where: { sessionKey: SESSION_KEY, eventId: "driver-late" } });
  }
});

/** Polls a real timer until `predicate()` is true, or throws after 2s. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("vi_waitFor: timed out");
    }
    await sleep(10);
  }
}
