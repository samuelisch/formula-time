// Integration test (ADR-0002): needs the real Postgres from the root
// docker-compose.yml. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`.
//
// The vote-burst harness required before votes are public: thousands of
// POSTs in a few seconds, checked for exactness. 1,000 distinct viewers
// each fire two concurrent POST /vote requests (2,000 requests fired
// together, so every viewer races itself for the row that survives). Every
// request goes through the real HTTP path (Fastify's `app.inject`) and the
// real conditional upsert (vote-path.ts) — nothing here is faked.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "@formula-time/db";
import type { DriverState, RaceState } from "@formula-time/domain";

import { PollModule } from "./poll-module.js";
import { registerPolls } from "./routes.js";

const db = createDb();
const SESSION_KEY = 9_300_001n;
const POLL_ID = `${SESSION_KEY}:winner`;
const VIEWER_COUNT = 1000;

function driver(overrides: Partial<DriverState> & { driver_number: number }): DriverState {
  return {
    full_name: null,
    name_acronym: null,
    team_name: null,
    team_colour: null,
    position: null,
    interval: null,
    gap_to_leader: null,
    current_lap: null,
    lap_duration: null,
    sector_durations: { sector_1: null, sector_2: null, sector_3: null },
    is_pit_out_lap: null,
    tyre: { stint_number: null, compound: null, lap_start: null, lap_end: null, age_at_start: null, age: null },
    pit_stops: [],
    latest_pit_stop: null,
    source_timestamps: {},
    ...overrides,
  };
}

function raceState(overrides: Partial<RaceState> = {}): RaceState {
  return {
    sequence: 0,
    latest_source_time: null,
    session: null,
    drivers: {},
    driver_order: [],
    race_control: {
      session_status: null,
      current_flag: null,
      safety_car: null,
      active_flags: {},
      driver_flags: {},
      recent_messages: [],
    },
    weather: null,
    anomalies: { duplicate_events: 0, stale_updates: 0, missing_driver: 0, unsupported_events: 0 },
    ...overrides,
  };
}

async function wipe(): Promise<void> {
  await db.vote.deleteMany({ where: { pollId: { startsWith: `${SESSION_KEY}:` } } });
  await db.poll.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

let app: FastifyInstance;
let module: PollModule;

beforeAll(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: SESSION_KEY,
      name: "Vote Burst Integration Test",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 50,
      status: "live",
    },
  });

  module = new PollModule({ db, log: { info: () => {} } });
  await module.start({ sessionKey: SESSION_KEY, totalLaps: 50, country: "Testland" });
  module.onState(
    raceState({
      drivers: {
        "1": driver({ driver_number: 1, name_acronym: "AAA" }),
        "44": driver({ driver_number: 44, name_acronym: "BBB" }),
      },
    }),
  );
  await module.waitForIdle();

  app = Fastify();
  registerPolls(app, module);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await wipe();
  await db.$disconnect();
});

describe("vote burst", () => {
  test(
    "1,000 distinct viewers voting twice concurrently (2,000 requests) land exactly 1,000 rows",
    async () => {
      const viewerIds = Array.from({ length: VIEWER_COUNT }, () => randomUUID());
      const sentOptions = new Map<string, [string, string]>();

      const requests: Promise<unknown>[] = [];
      for (const viewerId of viewerIds) {
        const pair: [string, string] = Math.random() < 0.5 ? ["1", "44"] : ["44", "1"];
        sentOptions.set(viewerId, pair);
        for (const optionId of pair) {
          requests.push(
            app.inject({
              method: "POST",
              url: "/vote",
              headers: { cookie: `viewer_id=${viewerId}` },
              payload: { poll_id: POLL_ID, option_id: optionId },
            }),
          );
        }
      }

      const startedAt = Date.now();
      await Promise.all(requests);
      const wallMs = Date.now() - startedAt;
      // Recorded in the PR body per the acceptance criteria.
      // eslint-disable-next-line no-console
      console.log(`vote-burst wall time: ${wallMs}ms for ${requests.length} requests`);

      const rows = await db.vote.findMany({ where: { pollId: POLL_ID } });
      expect(rows).toHaveLength(VIEWER_COUNT);
      for (const row of rows) {
        const sent = sentOptions.get(row.viewerId);
        expect(sent).toBeDefined();
        expect(sent).toContain(row.optionId);
      }

      const grouped = await db.vote.groupBy({
        by: ["optionId"],
        where: { pollId: POLL_ID },
        _count: { optionId: true },
      });
      const expectedTally: Record<string, number> = {};
      for (const group of grouped) {
        expectedTally[group.optionId] = group._count.optionId;
      }

      const winner = module.publicPolls().find((p) => p.poll_id === POLL_ID);
      expect(winner?.total_votes).toBe(VIEWER_COUNT);
      expect(winner?.tally).toEqual(expectedTally);
    },
    60_000,
  );
});
