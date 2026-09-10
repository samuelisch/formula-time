// Integration test (ADR-0002): needs the real Postgres from the root
// docker-compose.yml. Run `pnpm db:up`, `pnpm db:migrate:deploy`, then
// `pnpm test:integration`.
//
// Exercises PollModule's lifecycle (open from templates, lock, resolve,
// void, and reload on start()) against the real conditional-update
// statements — every one of them a Postgres-decided row count, per
// apps/api/AGENTS.md: "acknowledge to the browser only after the `votes`
// insert commits" (the vote path itself lands in a follow-up slice; this
// slice pins the lock/resolve/void writes that share its pattern).
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createDb } from "@formula-time/db";
import type { DriverState, RaceState } from "@formula-time/domain";

import { PollModule } from "./poll-module.js";

const db = createDb();

const SESSION_KEY = 9_100_001n;

function fakeLog() {
  return { info: () => {} };
}

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

beforeEach(async () => {
  await wipe();
  await db.session.create({
    data: {
      sessionKey: SESSION_KEY,
      name: "Integration Test Grand Prix",
      country: "Testland",
      circuitKey: 1,
      dateStart: new Date("2026-09-08T12:00:00.000Z"),
      dateEnd: new Date("2026-09-08T14:00:00.000Z"),
      totalLaps: 10, // locks_at_lap = 5
      status: "live",
    },
  });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

describe("PollModule against real Postgres", () => {
  test("opens two poll rows from templates when drivers appear and totalLaps is known", async () => {
    const module = new PollModule({ db, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 10, country: "Testland" });

    module.onState(
      raceState({
        drivers: {
          "1": driver({ driver_number: 1, name_acronym: "VER" }),
          "44": driver({ driver_number: 44, name_acronym: "HAM" }),
        },
      }),
    );
    await module.waitForIdle();

    const rows = await db.poll.findMany({ where: { sessionKey: SESSION_KEY }, orderBy: { pollId: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.pollId).sort()).toEqual([`${SESSION_KEY}:podium`, `${SESSION_KEY}:winner`]);
    for (const row of rows) {
      expect(row.status).toBe("open");
      expect(row.locksAtLap).toBe(5);
      expect(row.options).toEqual([
        { id: "1", label: "VER" },
        { id: "44", label: "HAM" },
      ]);
    }
  });

  test("locks a poll in Postgres when leaderLap reaches locks_at_lap", async () => {
    const module = new PollModule({ db, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 10, country: "Testland" });

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 1 }) },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();

    let rows = await db.poll.findMany({ where: { sessionKey: SESSION_KEY } });
    expect(rows.every((r) => r.status === "open")).toBe(true);

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 5 }) },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();

    rows = await db.poll.findMany({ where: { sessionKey: SESSION_KEY } });
    expect(rows.every((r) => r.status === "locked")).toBe(true);
    expect(module.publicPolls().every((p) => p.status === "locked")).toBe(true);
  });

  test("resolves winner and podium from driver_order on chequered", async () => {
    const module = new PollModule({ db, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 10, country: "Testland" });

    module.onState(
      raceState({
        drivers: {
          "1": driver({ driver_number: 1, position: 1 }),
          "2": driver({ driver_number: 2, position: 2 }),
          "3": driver({ driver_number: 3, position: 3 }),
          "4": driver({ driver_number: 4, position: 4 }),
        },
        driver_order: [1, 2, 3, 4],
      }),
    );
    await module.waitForIdle();

    module.onState(
      raceState({
        drivers: {
          "1": driver({ driver_number: 1, position: 1 }),
          "2": driver({ driver_number: 2, position: 2 }),
          "3": driver({ driver_number: 3, position: 3 }),
          "4": driver({ driver_number: 4, position: 4 }),
        },
        driver_order: [1, 2, 3, 4],
        race_control: {
          session_status: null,
          current_flag: "CHEQUERED",
          safety_car: null,
          active_flags: {},
          driver_flags: {},
          recent_messages: [],
        },
      }),
    );
    await module.waitForIdle();

    const winnerRow = await db.poll.findUniqueOrThrow({ where: { pollId: `${SESSION_KEY}:winner` } });
    const podiumRow = await db.poll.findUniqueOrThrow({ where: { pollId: `${SESSION_KEY}:podium` } });
    expect(winnerRow.status).toBe("resolved");
    expect(winnerRow.winningOptionIds).toEqual(["1"]);
    expect(winnerRow.resolvedAt).not.toBeNull();
    expect(podiumRow.status).toBe("resolved");
    expect(podiumRow.winningOptionIds).toEqual(["1", "2", "3"]);
  });

  test("void marks open and locked polls only, in Postgres", async () => {
    const module = new PollModule({ db, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 10, country: "Testland" });

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 5 }) },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();

    let rows = await db.poll.findMany({ where: { sessionKey: SESSION_KEY } });
    expect(rows.every((r) => r.status === "locked")).toBe(true);

    await module.onSessionFinished();

    rows = await db.poll.findMany({ where: { sessionKey: SESSION_KEY } });
    expect(rows.every((r) => r.status === "void")).toBe(true);
  });

  test("start() on a session with existing votes reloads tallies equal to a groupBy over the table", async () => {
    await db.poll.create({
      data: {
        pollId: `${SESSION_KEY}:winner`,
        sessionKey: SESSION_KEY,
        question: "Who wins the Testland GP?",
        options: [
          { id: "1", label: "VER" },
          { id: "44", label: "HAM" },
        ],
        locksAtLap: 5,
        status: "open",
      },
    });

    const viewerIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.vote.createMany({
      data: [
        { pollId: `${SESSION_KEY}:winner`, viewerId: viewerIds[0]!, optionId: "1" },
        { pollId: `${SESSION_KEY}:winner`, viewerId: viewerIds[1]!, optionId: "1" },
        { pollId: `${SESSION_KEY}:winner`, viewerId: viewerIds[2]!, optionId: "44" },
      ],
    });

    const module = new PollModule({ db, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 10, country: "Testland" });

    const grouped = await db.vote.groupBy({
      by: ["optionId"],
      where: { pollId: `${SESSION_KEY}:winner` },
      _count: { optionId: true },
    });
    const expectedTally: Record<string, number> = {};
    for (const group of grouped) {
      expectedTally[group.optionId] = group._count.optionId;
    }

    const winner = module.publicPolls().find((p) => p.poll_id === `${SESSION_KEY}:winner`);
    expect(winner?.tally).toEqual(expectedTally);
    expect(winner?.total_votes).toBe(3);
  });
});
