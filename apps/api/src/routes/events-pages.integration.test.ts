// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration` (or point `DATABASE_URL`/`DATABASE_DIRECT_URL`
// at a throwaway container).
//
// Exercises GET /api/races/:session_key/events against real rows
// (issue #96): seed 12 events, page with limit 5, and assert the three
// pages come back 5/5/2 with `next_seq` chaining -- and that a page
// boundary neither drops nor duplicates a row.
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, type PrismaClient } from "@formula-time/db";

import type { Exporter } from "../export/exporter.js";
import { racesRoutes } from "./races.js";

const db: PrismaClient = createDb();

const SESSION_KEY = 9_600_096n;

const noopExporter: Exporter = {
  runOnce: async () => {},
  exportSession: async () => {},
  start: () => {},
  stop: () => {},
};

function buildApp() {
  const app = Fastify();
  app.register(racesRoutes, { prefix: "/api", db, exporter: noopExporter, dir: "/tmp/events-pages-96-unused" });
  return app;
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
      name: "Events Pages Integration Test Grand Prix",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 10,
      status: "live",
    },
  });

  for (let i = 0; i < 12; i++) {
    await db.event.create({
      data: {
        eventId: `evt-${SESSION_KEY.toString()}-${i}`,
        sessionKey: SESSION_KEY,
        endpoint: "car_data",
        sourceTime: new Date(Date.UTC(2026, 8, 8, 12, 0, i)),
        payload: { n: i },
      },
    });
  }
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

describe("GET /api/races/:session_key/events against real Postgres", () => {
  test("404 for an unknown session", async () => {
    const app = buildApp();
    const res = await app.inject({ url: "/api/races/1/events" });
    expect(res.statusCode).toBe(404);
  });

  test("pages 5/5/2 with next_seq chaining; no row dropped or duplicated across the boundary", async () => {
    const app = buildApp();

    const first = await app.inject({ url: `/api/races/${SESSION_KEY.toString()}/events?limit=5` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.session_key).toBe(SESSION_KEY.toString());
    expect(firstBody.status).toBe("live");
    expect(firstBody.events).toHaveLength(5);
    expect(firstBody.next_seq).not.toBeNull();
    // A full page is immutable by construction.
    expect(first.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const second = await app.inject({
      url: `/api/races/${SESSION_KEY.toString()}/events?limit=5&since_seq=${firstBody.next_seq}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.events).toHaveLength(5);
    expect(secondBody.next_seq).not.toBeNull();
    expect(second.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const third = await app.inject({
      url: `/api/races/${SESSION_KEY.toString()}/events?limit=5&since_seq=${secondBody.next_seq}`,
    });
    expect(third.statusCode).toBe(200);
    const thirdBody = third.json();
    expect(thirdBody.events).toHaveLength(2);
    expect(thirdBody.next_seq).not.toBeNull();
    // A short page (the head) never caches.
    expect(third.headers["cache-control"]).toBe("no-store");

    // The three pages, concatenated, are exactly the 12 seeded rows in
    // order, once each -- a page boundary drops nothing and duplicates
    // nothing.
    const allEventIds = [...firstBody.events, ...secondBody.events, ...thirdBody.events].map(
      (e: { event_id: string }) => e.event_id,
    );
    const expectedEventIds = Array.from({ length: 12 }, (_, i) => `evt-${SESSION_KEY.toString()}-${i}`);
    expect(allEventIds).toEqual(expectedEventIds);
    expect(new Set(allEventIds).size).toBe(12);

    // One more page past the end: empty, next_seq null, no-store.
    const fourth = await app.inject({
      url: `/api/races/${SESSION_KEY.toString()}/events?limit=5&since_seq=${thirdBody.next_seq}`,
    });
    expect(fourth.statusCode).toBe(200);
    const fourthBody = fourth.json();
    expect(fourthBody.events).toEqual([]);
    expect(fourthBody.next_seq).toBeNull();
    expect(fourth.headers["cache-control"]).toBe("no-store");
  });
});
