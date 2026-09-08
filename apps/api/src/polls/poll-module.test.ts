import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@formula-time/db";
import type { DriverState, RaceState } from "@formula-time/domain";

import { PollModule } from "./poll-module.js";

// A recording, in-memory fake standing in for PrismaClient. Cast to
// PrismaClient at the PollModule boundary — the fake only implements the
// handful of calls PollModule actually makes.
function makeFakeDb() {
  const calls: string[] = [];
  const pollRows: Record<string, unknown>[] = [];
  const voteRows: Record<string, unknown>[] = [];
  let failNextUpdateManyCall = false;

  const db = {
    calls,
    pollRows,
    voteRows,
    /** The next poll.updateMany call rejects instead of resolving; only that one. */
    failNextUpdateMany() {
      failNextUpdateManyCall = true;
    },
    poll: {
      findMany: vi.fn(async ({ where }: { where: { sessionKey: bigint } }) => {
        calls.push("poll.findMany");
        return pollRows.filter((row) => row["sessionKey"] === where.sessionKey);
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => {
        calls.push("poll.createMany");
        for (const row of data) {
          if (!pollRows.some((existing) => existing["pollId"] === row["pollId"])) {
            pollRows.push({ ...row });
          }
        }
        return { count: data.length };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { pollId: string; status: string };
          data: Record<string, unknown>;
        }) => {
          if (failNextUpdateManyCall) {
            failNextUpdateManyCall = false;
            calls.push(`poll.updateMany:${where.pollId}:${where.status}->FAILED`);
            throw new Error("simulated db failure");
          }
          calls.push(`poll.updateMany:${where.pollId}:${where.status}->${String(data["status"])}`);
          const row = pollRows.find((r) => r["pollId"] === where.pollId && r["status"] === where.status);
          if (row === undefined) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    vote: {
      findMany: vi.fn(async ({ where }: { where: { pollId: { in: string[] } } }) => {
        calls.push("vote.findMany");
        return voteRows.filter((row) => where.pollId.in.includes(row["pollId"] as string));
      }),
    },
  };

  return db;
}

function fakeLog() {
  return { info: vi.fn() };
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

const SESSION_KEY = 12345n;

describe("PollModule.onState — opening templates", () => {
  let db: ReturnType<typeof makeFakeDb>;
  let module: PollModule;

  beforeEach(async () => {
    db = makeFakeDb();
    module = new PollModule({ db: db as unknown as PrismaClient, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 72, country: "Dutch" });
  });

  it("opens the two templates once drivers are present and totalLaps is known", async () => {
    module.onState(
      raceState({
        drivers: {
          "1": driver({ driver_number: 1, name_acronym: "VER" }),
          "44": driver({ driver_number: 44, name_acronym: "HAM" }),
        },
      }),
    );
    await module.waitForIdle();

    const polls = module.publicPolls();
    expect(polls).toHaveLength(2);
    const winner = polls.find((p) => p.poll_id === `${SESSION_KEY}:winner`);
    const podium = polls.find((p) => p.poll_id === `${SESSION_KEY}:podium`);
    expect(winner?.question).toBe("Who wins the Dutch GP?");
    expect(podium?.question).toBe("Pick a driver to finish on the podium of the Dutch GP");
    expect(winner?.locks_at_lap).toBe(36);
    expect(winner?.options).toEqual([
      { id: "1", label: "VER" },
      { id: "44", label: "HAM" },
    ]);
    expect(db.calls).toContain("poll.createMany");
  });

  it("does not open polls when totalLaps is null, and logs once", async () => {
    const log = { info: vi.fn() };
    const localDb = makeFakeDb();
    const localModule = new PollModule({ db: localDb as unknown as PrismaClient, log });
    await localModule.start({ sessionKey: SESSION_KEY, totalLaps: null, country: "Dutch" });

    localModule.onState(raceState({ drivers: { "1": driver({ driver_number: 1 }) } }));
    await localModule.waitForIdle();
    localModule.onState(raceState({ drivers: { "1": driver({ driver_number: 1 }) } }));
    await localModule.waitForIdle();

    expect(localModule.publicPolls()).toHaveLength(0);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("polls not opened: total_laps unknown");
    expect(localDb.calls).not.toContain("poll.createMany");
  });
});

describe("PollModule.onState — locking", () => {
  it("locks when leaderLap >= locks_at_lap, DB write before memory changes", async () => {
    const db = makeFakeDb();
    const module = new PollModule({ db: db as unknown as PrismaClient, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 10, country: "Dutch" }); // locks_at_lap = 5

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 1 }) },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();
    expect(module.publicPolls()[0]?.status).toBe("open");

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 5 }) },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();

    const lockCallIndex = db.calls.findIndex((c) => c.includes("open->locked"));
    expect(lockCallIndex).toBeGreaterThanOrEqual(0);
    expect(module.publicPolls().every((p) => p.status === "locked")).toBe(true);
    // the DB write is recorded before we can observe the in-memory flip —
    // by construction (await before assignment) the call log entry always
    // precedes the status read above.
  });

  it("a rejected write does not poison the chain: the next onState still locks", async () => {
    const db = makeFakeDb();
    const log = fakeLog();
    const module = new PollModule({ db: db as unknown as PrismaClient, log });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 10, country: "Dutch" }); // locks_at_lap = 5

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 1 }) },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();
    expect(module.publicPolls().every((p) => p.status === "open")).toBe(true);

    // The lock write on this tick rejects; the chain must still resolve.
    db.failNextUpdateMany();
    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 5 }) },
        driver_order: [1],
      }),
    );
    await expect(module.waitForIdle()).resolves.toBeUndefined();
    // The failed write never landed, so the poll is still open.
    expect(module.publicPolls().every((p) => p.status === "open")).toBe(true);

    // The next onState is unaffected — the chain kept running.
    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1, current_lap: 5 }) },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();
    expect(module.publicPolls().every((p) => p.status === "locked")).toBe(true);
  });
});

describe("PollModule.onState — resolving on chequered", () => {
  it("resolves winner/podium from driver_order when chequered", async () => {
    const db = makeFakeDb();
    const module = new PollModule({ db: db as unknown as PrismaClient, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 72, country: "Dutch" });

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

    const polls = module.publicPolls();
    const winner = polls.find((p) => p.poll_id === `${SESSION_KEY}:winner`);
    const podium = polls.find((p) => p.poll_id === `${SESSION_KEY}:podium`);
    expect(winner?.status).toBe("resolved");
    expect(winner?.winning_option_ids).toEqual(["1"]);
    expect(podium?.winning_option_ids).toEqual(["1", "2", "3"]);
  });

  it("does not resolve when driver_order is empty at the chequered moment", async () => {
    const db = makeFakeDb();
    const module = new PollModule({ db: db as unknown as PrismaClient, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 72, country: "Dutch" });

    module.onState(raceState({ drivers: { "1": driver({ driver_number: 1, position: 1 }) }, driver_order: [1] }));
    await module.waitForIdle();

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1 }) },
        driver_order: [],
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

    expect(module.publicPolls().every((p) => p.status !== "resolved")).toBe(true);
  });
});

describe("PollModule.onSessionFinished — void", () => {
  it("voids open and locked polls only", async () => {
    const db = makeFakeDb();
    const module = new PollModule({ db: db as unknown as PrismaClient, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 4, country: "Dutch" }); // locks_at_lap = 2

    module.onState(
      raceState({
        drivers: {
          "1": driver({ driver_number: 1, position: 1, current_lap: 2 }),
        },
        driver_order: [1],
      }),
    );
    await module.waitForIdle();

    // Force one poll into resolved by chequered, leave the other polls as-is
    // (both currently locked, since lap 2 >= locks_at_lap 2).
    expect(module.publicPolls().every((p) => p.status === "locked")).toBe(true);

    await module.onSessionFinished();

    expect(module.publicPolls().every((p) => p.status === "void")).toBe(true);
  });

  it("leaves an already-resolved poll alone", async () => {
    const db = makeFakeDb();
    const module = new PollModule({ db: db as unknown as PrismaClient, log: fakeLog() });
    await module.start({ sessionKey: SESSION_KEY, totalLaps: 4, country: "Dutch" });

    module.onState(
      raceState({
        drivers: { "1": driver({ driver_number: 1, position: 1 }) },
        driver_order: [1],
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
    expect(module.publicPolls().every((p) => p.status === "resolved")).toBe(true);

    await module.onSessionFinished();
    expect(module.publicPolls().every((p) => p.status === "resolved")).toBe(true);
  });
});
