// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`. Connection pattern from
// `projector.integration.test.ts`.
//
// Tests delta push behavior: "three events -> one `state`, then a delta whose
// patch touches only the changed driver." Wires a real RaceStateProjector
// (real Postgres fold) to a real Fanout, exactly as session-lifecycle.ts
// does, and drives a delta-format socket through both a first-ever push
// (no baseline yet: a `state` push, per the ADR's join contract) and a
// second push after one more event lands for one driver (a `delta` whose
// patch touches only that driver).
import { createDb, type PrismaClient } from "@formula-time/db";
import { afterAll, beforeAll, expect, test } from "vitest";

import { prismaEventSource } from "../projector/event-source.js";
import { RaceStateProjector } from "../projector/projector.js";
import { Fanout } from "./fanout.js";

const db: PrismaClient = createDb();
// A distinctive, unlikely-to-collide key: this Postgres is shared across
// concurrent worktrees/agents (no isolated per-test database), and a
// nearby value (9_000_089) was seen collide with another agent's concurrent
// test work in this same shared instance during development.
const SESSION_KEY = 9_178_920_089n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await sleep(10);
  }
}

class FakeRes {
  public chunks: Buffer[] = [];
  public writableLength = 0;

  public write(chunk: Buffer): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  public destroy(): this {
    return this;
  }
}

function frames(res: FakeRes): Array<{ event: string; data: Record<string, unknown> }> {
  return res.chunks
    .map((chunk) => chunk.toString("utf8"))
    .filter((frame) => frame.startsWith("event: state") || frame.startsWith("event: delta"))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      return {
        event: (eventLine as string).slice("event: ".length),
        data: JSON.parse((dataLine as string).slice("data: ".length)) as Record<string, unknown>,
      };
    });
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
      name: "Delta Integration Test Grand Prix",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-09T12:00:00.000Z"),
      dateEnd: new Date("2026-09-09T14:00:00.000Z"),
      totalLaps: 60,
      status: "live",
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("three events fold into one state push; one more event for one driver produces a delta touching only that driver", async () => {
  const session = await db.session.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });

  for (const driverNumber of [1, 2, 3]) {
    await db.event.create({
      data: {
        eventId: `driver-${driverNumber}`,
        sessionKey: SESSION_KEY,
        endpoint: "drivers",
        payload: { driver_number: driverNumber, full_name: `Driver ${driverNumber}` },
      },
    });
  }

  const fanout = new Fanout();
  const source = prismaEventSource(db);
  const projector = new RaceStateProjector({ source, session, tickMs: 50, log: () => {} });

  projector.subscribe((state, cursor) => {
    void fanout.push({
      type: "state",
      seq: cursor.toString(),
      sent_at: Date.now(),
      session_key: session.sessionKey.toString(),
      total_laps: session.totalLaps,
      state,
      polls: [],
    });
  });

  const res = new FakeRes();
  await fanout.join(res, "plain", "delta");

  try {
    projector.start();
    await waitFor(() => projector.status().caughtUp === true);
    await waitFor(() => frames(res).length >= 1);

    const firstFrames = frames(res);
    expect(firstFrames).toHaveLength(1);
    expect(firstFrames[0]?.event).toBe("state");
    const firstState = firstFrames[0]?.data as { state: { drivers: Record<string, unknown> } };
    expect(Object.keys(firstState.state.drivers)).toEqual(["1", "2", "3"]);

    // One more event, one driver only.
    await db.event.create({
      data: {
        eventId: "position-1",
        sessionKey: SESSION_KEY,
        endpoint: "position",
        payload: { driver_number: 1, position: 1 },
      },
    });

    await waitFor(() => frames(res).length >= 2);
    const secondFrame = frames(res)[1] as { event: string; data: Record<string, unknown> };
    expect(secondFrame.event).toBe("delta");
    expect(secondFrame.data["type"]).toBe("delta");
    expect(secondFrame.data["base_seq"]).toBe(firstFrames[0]?.data["seq"]);

    const patch = secondFrame.data["patch"] as Array<{ path: string }>;
    expect(patch.length).toBeGreaterThan(0);
    for (const op of patch) {
      if (op.path.startsWith("/drivers/")) {
        expect(op.path.startsWith("/drivers/1/")).toBe(true);
      }
    }
  } finally {
    projector.stop();
  }
});
