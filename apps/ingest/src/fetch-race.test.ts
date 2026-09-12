// Unit tests: rate spacing, 429 retry, the ordering rule
// (lap/stint exceptions, drivers first), and the ADR-0010 live guard.
// Fakes only; no network, no filesystem, no Postgres — see
// fetch-race.integration.test.ts for the real-Postgres end-to-end case.

import { describe, expect, test } from "vitest";

import { RaceStateReducer, createInitialState } from "@formula-time/domain";
import type { RaceEvent } from "@formula-time/domain";

import type { NormalizedRow } from "./openf1/normalize.js";
import type { Fetcher, RawRecord } from "./openf1/types.js";
import {
  fetchRaces,
  lapsEffectiveSourceTimeIso,
  orderForEmission,
  splitLapRow,
  withRetry,
  withSpacing,
} from "./fetch-race.js";
import type { RaceRecorder } from "./fetch-race.js";
import type { LoaderDb } from "./load-recording.js";

// A shared fake clock: `sleep` advances `clock` directly instead of really
// waiting, so "8 requests take >= 14.7s of fake time" is provable without
// the test taking 14.7 real seconds.
function fakeClock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void>; clock: () => number } {
  let clock = start;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}

describe("withSpacing", () => {
  test("8 requests take at least 14.7s of fake time (2.1s spacing, 7 gaps)", async () => {
    const { now, sleep, clock } = fakeClock();
    const raw: Fetcher = async () => [];
    const spaced = withSpacing(raw, 2100, { now, sleep });

    for (let i = 0; i < 8; i += 1) {
      await spaced(`https://api.openf1.org/v1/x?i=${i}`);
    }

    expect(clock()).toBeGreaterThanOrEqual(2100 * 7);
  });

  test("a call arriving after the spacing has already elapsed does not wait", async () => {
    const { now, sleep, clock } = fakeClock();
    const raw: Fetcher = async () => [];
    const spaced = withSpacing(raw, 2100, { now, sleep });

    await spaced("https://api.openf1.org/v1/x");
    const before = clock();
    await spaced("https://api.openf1.org/v1/x"); // immediately after — should wait 2100
    expect(clock()).toBe(before + 2100);
  });
});

describe("withRetry", () => {
  test("a 429 is retried after the delay, then succeeds", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error("OpenF1 429 for https://api.openf1.org/v1/laps?session_key=1");
      return [{ a: 1 }];
    };
    const sleeps: number[] = [];
    const retried = withRetry(fetcher, { sleep: async (ms) => void sleeps.push(ms) });

    const result = await retried("https://api.openf1.org/v1/laps?session_key=1");

    expect(result).toEqual([{ a: 1 }]);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([20_000]);
  });

  test("a 500 is retried the same as a 429", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error("OpenF1 500 for https://api.openf1.org/v1/laps?session_key=1");
      return [];
    };
    const retried = withRetry(fetcher, { sleep: async () => {} });

    await expect(retried("https://api.openf1.org/v1/laps?session_key=1")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("gives up after 3 retries (4 attempts total) and rethrows", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      throw new Error("OpenF1 429 for https://api.openf1.org/v1/laps?session_key=1");
    };
    const retried = withRetry(fetcher, { sleep: async () => {} });

    await expect(retried("https://api.openf1.org/v1/laps?session_key=1")).rejects.toThrow(/429/);
    expect(calls).toBe(4);
  });

  test("a non-retryable error (e.g. a thrown non-Error, or a 400) is not retried", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      throw new Error("OpenF1 400 for https://api.openf1.org/v1/laps?session_key=1");
    };
    const retried = withRetry(fetcher, { sleep: async () => {} });

    await expect(retried("https://api.openf1.org/v1/laps?session_key=1")).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });
});

function normalized(endpoint: string, payload: RawRecord, sourceTime: string | null): NormalizedRow {
  return { eventId: `${endpoint}:${JSON.stringify(payload)}`, endpoint, sourceTime, payload };
}

// A historical laps row arrives already complete, one row per lap; the
// live lane instead records it twice — once at lap start with
// durations/segments still null, once complete. `splitLapRow` reproduces
// that so the lap counter, the lap markers and the poll clock flip at lap
// start, not at lap end.
describe("splitLapRow", () => {
  const DATE_START = "2026-01-01T13:51:29.800Z";
  const LAP_DURATION = 86.305;

  function lapRow(): NormalizedRow {
    return normalized(
      "laps",
      {
        driver_number: 63,
        lap_number: 10,
        date_start: DATE_START,
        lap_duration: LAP_DURATION,
        duration_sector_1: 28.306,
        duration_sector_2: 29.439,
        duration_sector_3: 28.56,
        i1_speed: 297,
        i2_speed: 301,
        st_speed: 305,
        is_pit_out_lap: false,
        segments_sector_1: [2048, 2048],
        segments_sector_2: [2048, 2048],
        segments_sector_3: [2048, 2048],
      },
      DATE_START,
    );
  }

  test("a lap row with date_start and lap_duration yields two rows with distinct event ids", () => {
    const [startRow, completeRow] = splitLapRow(lapRow());

    expect(startRow).toBeDefined();
    expect(completeRow).toBeDefined();
    expect(startRow!.eventId).not.toBe(completeRow!.eventId);
  });

  test("the start row carries date_start with the lap's durations/segments nulled", () => {
    const [startRow] = splitLapRow(lapRow());

    expect(startRow!.payload["date_start"]).toBe(DATE_START);
    expect(startRow!.payload["driver_number"]).toBe(63);
    expect(startRow!.payload["lap_number"]).toBe(10);
    for (const field of [
      "lap_duration",
      "duration_sector_1",
      "duration_sector_2",
      "duration_sector_3",
      "i1_speed",
      "i2_speed",
      "st_speed",
      "segments_sector_1",
      "segments_sector_2",
      "segments_sector_3",
    ]) {
      expect(startRow!.payload[field]).toBeNull();
    }
    expect(lapsEffectiveSourceTimeIso(startRow!)).toBe(DATE_START);
  });

  test("the complete row is the original row, applied at date_start + lap_duration", () => {
    const original = lapRow();
    const [, completeRow] = splitLapRow(original);

    expect(completeRow).toBe(original);
    expect(lapsEffectiveSourceTimeIso(completeRow!)).toBe(
      new Date(Date.parse(DATE_START) + LAP_DURATION * 1000).toISOString(),
    );
  });

  test("a row missing date_start is not split", () => {
    const row = normalized("laps", { driver_number: 63, lap_number: 10, lap_duration: 86.305 }, null);
    expect(splitLapRow(row)).toEqual([row]);
  });

  test("a row missing lap_duration is not split", () => {
    const row = normalized("laps", { driver_number: 63, lap_number: 10, date_start: DATE_START }, DATE_START);
    expect(splitLapRow(row)).toEqual([row]);
  });

  test("a non-laps row is never split", () => {
    const row = normalized("position", { driver_number: 63, date: DATE_START }, DATE_START);
    expect(splitLapRow(row)).toEqual([row]);
  });

  function toRaceEvent(row: NormalizedRow): RaceEvent {
    return {
      event_id: row.eventId,
      endpoint: row.endpoint,
      source_time: lapsEffectiveSourceTimeIso(row),
      payload: row.payload,
    };
  }

  test("folding both rows through RaceStateReducer sets current_lap at the start row's time, lap_duration only at the complete row's time", () => {
    const state = createInitialState({ sessions: [], drivers: [{ driver_number: 63 }] });
    const reducer = new RaceStateReducer(state);
    const [startRow, completeRow] = splitLapRow(lapRow());

    reducer.apply(toRaceEvent(startRow!));
    expect(state.drivers["63"]!.current_lap).toBe(10);
    expect(state.drivers["63"]!.lap_duration).toBeNull();
    expect(state.latest_source_time).toBe(DATE_START);

    reducer.apply(toRaceEvent(completeRow!));
    expect(state.drivers["63"]!.current_lap).toBe(10);
    expect(state.drivers["63"]!.lap_duration).toBe(LAP_DURATION);
    expect(state.latest_source_time).toBe(
      new Date(Date.parse(DATE_START) + LAP_DURATION * 1000).toISOString(),
    );
  });
});

describe("orderForEmission", () => {
  const SESSION_START_MS = Date.parse("2026-01-01T13:00:00Z");

  test("drivers rows come first, unsorted, ahead of every timestamped row", () => {
    const driver1 = normalized("drivers", { driver_number: 1 }, null);
    const driver2 = normalized("drivers", { driver_number: 3 }, null);
    const position = normalized("position", { date: "2026-01-01T13:00:01Z" }, "2026-01-01T13:00:01Z");

    const byEndpoint = new Map([
      ["drivers", [driver1, driver2]],
      ["position", [position]],
    ]);

    const ordered = orderForEmission(byEndpoint, SESSION_START_MS);
    expect(ordered.slice(0, 2)).toEqual([driver1, driver2]);
    expect(ordered[2]).toBe(position);
  });

  test("a lap with lap_duration 90 lands after a position row 60s past its date_start and before one 120s past", () => {
    const dateStart = "2026-01-01T13:00:00Z";
    const lap = normalized(
      "laps",
      { driver_number: 1, lap_number: 1, date_start: dateStart, lap_duration: 90 },
      dateStart, // the normalizer's own sourceTime for laps is unadjusted date_start
    );
    const earlyPosition = normalized(
      "position",
      { date: "2026-01-01T13:01:00Z" }, // +60s
      "2026-01-01T13:01:00Z",
    );
    const latePosition = normalized(
      "position",
      { date: "2026-01-01T13:02:00Z" }, // +120s
      "2026-01-01T13:02:00Z",
    );

    const byEndpoint = new Map([
      ["drivers", []],
      ["position", [earlyPosition, latePosition]],
      ["laps", [lap]],
    ]);

    const ordered = orderForEmission(byEndpoint, SESSION_START_MS);
    // lap's order key is date_start + 90s = 13:01:30, so: earlyPosition (13:01:00), lap (13:01:30), latePosition (13:02:00).
    expect(ordered).toEqual([earlyPosition, lap, latePosition]);
  });

  test("a lap with no lap_duration lands at its raw date_start", () => {
    const dateStart = "2026-01-01T13:05:00Z";
    const lap = normalized("laps", { driver_number: 1, lap_number: 1, date_start: dateStart }, dateStart);
    const position = normalized("position", { date: "2026-01-01T13:04:59Z" }, "2026-01-01T13:04:59Z");

    const byEndpoint = new Map([
      ["drivers", []],
      ["position", [position]],
      ["laps", [lap]],
    ]);

    expect(orderForEmission(byEndpoint, SESSION_START_MS)).toEqual([position, lap]);
  });

  test("a stint lands at its lap's date_start (the normalizer's own join, reused as-is)", () => {
    const lapDateStart = "2026-01-01T13:10:00Z";
    // The normalizer computed this stint's sourceTime by joining
    // driver_number + lap_start to the laps row's date_start — reproduced
    // here as the input, since orderForEmission trusts row.sourceTime for
    // every endpoint except laps.
    const stint = normalized("stints", { driver_number: 1, lap_start: 5 }, lapDateStart);
    const sameTimeLap = normalized(
      "laps",
      { driver_number: 1, lap_number: 5, date_start: lapDateStart, lap_duration: 95 },
      lapDateStart,
    );

    const byEndpoint = new Map([
      ["drivers", []],
      ["laps", [sameTimeLap]],
      ["stints", [stint]],
    ]);

    const ordered = orderForEmission(byEndpoint, SESSION_START_MS);
    // stint's key = lapDateStart (13:10:00); the lap's own key = date_start
    // + 95s (13:11:35) — the stint lands strictly before its own lap.
    expect(ordered).toEqual([stint, sameTimeLap]);
  });

  test("a stint with no matching lap falls back to session start", () => {
    const stint = normalized("stints", { driver_number: 9, lap_start: 1 }, null);
    const byEndpoint = new Map([
      ["drivers", []],
      ["stints", [stint]],
    ]);

    // Nothing else to compare against; just confirm it doesn't throw and is present.
    expect(orderForEmission(byEndpoint, SESSION_START_MS)).toEqual([stint]);
  });

  test("ties break in the fetch order (RECORDING_ENDPOINT_ORDER)", () => {
    const t = "2026-01-01T13:00:00Z";
    const position = normalized("position", { date: t }, t);
    const intervals = normalized("intervals", { date: t }, t);
    const weather = normalized("weather", { date: t }, t);

    const byEndpoint = new Map([
      ["drivers", []],
      ["weather", [weather]],
      ["position", [position]],
      ["intervals", [intervals]],
    ]);

    // RECORDING_ENDPOINT_ORDER: drivers, position, intervals, laps, stints, pit, race_control, weather.
    expect(orderForEmission(byEndpoint, SESSION_START_MS)).toEqual([position, intervals, weather]);
  });
});

interface FakeEventRow {
  eventId: string;
  sessionKey: unknown;
  endpoint: string;
  sourceTime: Date | null;
  seq: number;
}

function fakeLoaderDb(): LoaderDb & {
  sessions: Map<string, { status?: string }>;
  insertOrder: string[];
  events: Map<string, FakeEventRow>;
} {
  const sessions = new Map<string, { status?: string }>();
  const events = new Map<string, FakeEventRow>();
  const insertOrder: string[] = [];
  let nextSeq = 1;

  async function createMany(args: {
    data: Array<{ eventId: string; sessionKey: unknown; endpoint: string; sourceTime: Date | null }>;
  }): Promise<{ count: number }> {
    let count = 0;
    for (const row of args.data) {
      if (events.has(row.eventId)) continue;
      events.set(row.eventId, { ...row, seq: nextSeq });
      nextSeq += 1;
      insertOrder.push(row.eventId);
      count += 1;
    }
    return { count };
  }

  function deleteMany(args: { where: { sessionKey: bigint } }): { count: number } {
    const key = args.where.sessionKey.toString();
    let count = 0;
    for (const [eventId, row] of [...events.entries()]) {
      if (String(row.sessionKey) !== key) continue;
      events.delete(eventId);
      const index = insertOrder.indexOf(eventId);
      if (index !== -1) insertOrder.splice(index, 1);
      count += 1;
    }
    return { count };
  }

  return {
    sessions,
    insertOrder,
    events,
    session: {
      async upsert(args) {
        const key = args.where.sessionKey.toString();
        // Matches Prisma's real `update` semantics: an `update` key present
        // with value `undefined` leaves that column untouched instead of a
        // wholesale replace — see sessions.ts's `updateFieldsPreservingNaming`.
        let row: { status?: string };
        if (sessions.has(key)) {
          row = { ...sessions.get(key) };
          for (const [field, value] of Object.entries(args.update)) {
            if (value !== undefined) (row as Record<string, unknown>)[field] = value;
          }
        } else {
          row = { ...args.create };
        }
        sessions.set(key, row);
        return row;
      },
      async findUnique(args) {
        const key = args.where.sessionKey.toString();
        const row = sessions.get(key);
        return row ? { status: row.status as never } : null;
      },
    },
    event: {
      createMany,
      async deleteMany(args) {
        return deleteMany(args);
      },
      async findMany(args) {
        const key = args.where.sessionKey.toString();
        return [...events.values()]
          .filter((row) => String(row.sessionKey) === key)
          .sort((a, b) => a.seq - b.seq)
          .map((row) => ({ endpoint: row.endpoint, sourceTime: row.sourceTime }));
      },
    },
    // Same rollback-on-throw stand-in as load-recording.test.ts's fakeDb —
    // see its comment for why a snapshot/restore is enough here.
    async $transaction(fn) {
      const eventsSnapshot = new Map(events);
      const insertOrderSnapshot = [...insertOrder];
      const nextSeqSnapshot = nextSeq;
      try {
        return await fn({
          event: {
            createMany,
            async deleteMany(args) {
              return deleteMany(args);
            },
          },
        });
      } catch (error) {
        events.clear();
        for (const [key, row] of eventsSnapshot) events.set(key, row);
        insertOrder.length = 0;
        insertOrder.push(...insertOrderSnapshot);
        nextSeq = nextSeqSnapshot;
        throw error;
      }
    },
  };
}

interface FakeRecorderCalls {
  writeSessionCalls: number;
  appendRowsCalls: Array<{ sessionKey: number; endpoint: string; rowCount: number }>;
}

function fakeRecorder(): { recorder: RaceRecorder; calls: FakeRecorderCalls } {
  const calls: FakeRecorderCalls = { writeSessionCalls: 0, appendRowsCalls: [] };
  const recorder: RaceRecorder = {
    async writeSession() {
      calls.writeSessionCalls += 1;
    },
    async appendRows(sessionKey, endpoint, rows) {
      calls.appendRowsCalls.push({ sessionKey, endpoint, rowCount: rows.length });
    },
  };
  return { recorder, calls };
}

function endpointResponses(byEndpoint: Record<string, RawRecord[]>): Fetcher {
  return async (url: string): Promise<unknown> => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.split("/").at(-1) ?? "";
    return byEndpoint[endpoint] ?? [];
  };
}

describe("fetchRaces: ADR-0010 — refuses a live session, writes nothing for it", () => {
  test("a session whose own window contains `now` is refused, and no endpoint beyond `sessions` is fetched", async () => {
    const requestedUrls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      requestedUrls.push(url);
      if (url.includes("/sessions?")) {
        return [
          {
            session_key: 9201,
            session_name: "Race",
            country_name: "Italy",
            circuit_key: 39,
            date_start: "2026-01-01T13:00:00+00:00",
            date_end: "2026-01-01T15:00:00+00:00",
          },
        ];
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const db = fakeLoaderDb();
    const logs: string[] = [];
    const result = await fetchRaces([9201], db, fetcher, {
      now: () => Date.parse("2026-01-01T14:00:00Z"), // squarely inside the window
      onLog: (line) => logs.push(line),
    });

    expect(result.inserted).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(db.sessions.has("9201")).toBe(false);
    // The ADR-0010 refusal message comes from the shared
    // `writeSessionThroughLoader` (load-recording.ts), "load:"-prefixed
    // regardless of caller.
    expect(logs).toContain("load: refused 9201: session is live; the live ingest service owns it");
    // Only the one `sessions?session_key=` lookup — the guard runs before
    // any of the 8 endpoint fetches, so a refused session costs nothing else.
    expect(requestedUrls).toHaveLength(1);
  });

  test("round-3 review fix: an upcoming session (window not yet open) is refused too, not only a live one", async () => {
    const requestedUrls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      requestedUrls.push(url);
      if (url.includes("/sessions?")) {
        return [
          {
            session_key: 9501,
            session_name: "Race",
            country_name: "Italy",
            circuit_key: 39,
            date_start: "2026-01-01T13:00:00+00:00",
            date_end: "2026-01-01T15:00:00+00:00",
          },
        ];
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const db = fakeLoaderDb();
    const logs: string[] = [];
    const result = await fetchRaces([9501], db, fetcher, {
      now: () => Date.parse("2025-01-01T00:00:00Z"), // well before the window even opens: naturally "upcoming"
      onLog: (line) => logs.push(line),
    });

    expect(result.inserted).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(db.sessions.has("9501")).toBe(false);
    expect(logs).toContain("load: refused 9501: window not closed; the live ingest service owns it");
    expect(requestedUrls).toHaveLength(1);
  });

  test("round-2 review fix: a refused session with a meeting_key makes zero meetings requests", async () => {
    // meeting_key present (unlike the fixtures above) is what exercises the
    // ordering bug: the meetings fetch must run only after the guard, so a
    // refused session costs no meetings request either.
    const requestedUrls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      requestedUrls.push(url);
      if (url.includes("/sessions?")) {
        return [
          {
            session_key: 9701,
            meeting_key: 1293,
            session_name: "Race",
            country_name: "Italy",
            circuit_key: 39,
            date_start: "2026-01-01T13:00:00+00:00",
            date_end: "2026-01-01T15:00:00+00:00",
          },
        ];
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const db = fakeLoaderDb();
    const result = await fetchRaces([9701], db, fetcher, {
      now: () => Date.parse("2026-01-01T14:00:00Z"), // squarely inside the window: refused as live
      onLog: () => {},
    });

    expect(result.sessionsSkipped).toBe(1);
    expect(requestedUrls.filter((u) => u.includes("/meetings?"))).toHaveLength(0);
    expect(requestedUrls).toHaveLength(1); // only the sessions?session_key= lookup
  });
});

describe("fetchRaces: issue #168 — refuses a non-race session, writes nothing for it", () => {
  test("a Qualifying session_key is refused, and no endpoint beyond sessions is fetched", async () => {
    const requestedUrls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      requestedUrls.push(url);
      if (url.includes("/sessions?")) {
        return [
          {
            session_key: 9601,
            session_name: "Qualifying",
            country_name: "Italy",
            circuit_key: 39,
            date_start: "2026-01-01T13:00:00+00:00",
            date_end: "2026-01-01T15:00:00+00:00",
          },
        ];
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const db = fakeLoaderDb();
    const logs: string[] = [];
    const result = await fetchRaces([9601], db, fetcher, {
      now: () => Date.parse("2026-06-01T00:00:00Z"), // well past the window: not refused for being live
      onLog: (line) => logs.push(line),
    });

    expect(result.inserted).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(db.sessions.has("9601")).toBe(false);
    expect(logs).toContain('load: refused 9601: session_name is "Qualifying", only "Race" is loaded');
    // Only the one `sessions?session_key=` lookup — the shared
    // writeSessionThroughLoader refuses before any of the 8 endpoint fetches.
    expect(requestedUrls).toHaveLength(1);
  });
});

describe("fetchRaces: no session found for the session_key", () => {
  test("an empty sessions response is refused and reported as not found", async () => {
    const fetcher: Fetcher = async () => [];
    const db = fakeLoaderDb();
    const logs: string[] = [];
    const result = await fetchRaces([424242], db, fetcher, { onLog: (line) => logs.push(line) });

    expect(result.sessionsNotFound).toBe(1);
    expect(result.sessionsAttempted).toBe(1);
    expect(logs).toContain("fetch-race: refused 424242: no session found for this session_key");
  });
});

describe("fetchRaces: happy path — fake fetcher, drivers-then-events, finished, idempotent", () => {
  test("fetches every endpoint, writes drivers first, marks the session finished, and a second run inserts 0", async () => {
    const fetcher = endpointResponses({
      sessions: [
        {
          session_key: 9999,
          session_name: "Race",
          country_name: "Italy",
          circuit_key: 39,
          date_start: "2026-01-01T13:00:00+00:00",
          date_end: "2026-01-01T15:00:00+00:00",
        },
      ],
      drivers: [{ session_key: 9999, driver_number: 1, full_name: "Test Driver" }],
      position: [{ session_key: 9999, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }],
    });

    const db = fakeLoaderDb();
    const now = () => Date.parse("2026-06-01T00:00:00Z"); // well after the session's window
    const first = await fetchRaces([9999], db, fetcher, { now, onLog: () => {} });

    expect(first.inserted).toBe(2); // 1 driver + 1 position row
    expect(first.sessionsSkipped).toBe(0);
    expect(first.sessionsNotFound).toBe(0);
    expect(db.insertOrder[0]).toMatch(/^drivers:/);
    expect(db.sessions.get("9999")?.status).toBe("finished");

    const second = await fetchRaces([9999], db, fetcher, { now, onLog: () => {} });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
  });
});

describe("fetchRaces: meeting_name — one meetings?meeting_key= fetch per session", () => {
  test("the session row gets meeting_name from a meetings?meeting_key= fetch", async () => {
    const calls: string[] = [];
    const base = endpointResponses({
      sessions: [
        {
          session_key: 11307,
          meeting_key: 1250,
          session_name: "Race",
          country_name: "Spain",
          circuit_key: 100,
          date_start: "2026-06-01T13:00:00+00:00",
          date_end: "2026-06-01T15:00:00+00:00",
        },
      ],
      meetings: [{ meeting_key: 1250, meeting_name: "Spanish Grand Prix" }],
    });
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return base(url);
    };

    const db = fakeLoaderDb();
    const now = () => Date.parse("2026-06-02T00:00:00Z");
    await fetchRaces([11307], db, fetcher, { now, onLog: () => {} });

    expect(calls.filter((u) => u.includes("/meetings?meeting_key=1250"))).toHaveLength(1);
    expect((db.sessions.get("11307") as Record<string, unknown>)["meetingName"]).toBe("Spanish Grand Prix");
  });
});

// A laps row's persisted `source_time` must be the same adjusted instant
// (`date_start + lap_duration`) as its emission order key, not the raw
// `date_start` — otherwise the browser fold's scrub can reveal the lap's
// final time before the lap actually finished (see
// `lapsEffectiveSourceTimeIso`'s comment in fetch-race.ts for the full
// reasoning). One historical laps row lands as two events (start +
// complete, see the `splitLapRow` describe block above) — the complete row
// is the one this adjustment applies to.
describe("fetchRaces: round 1 fix — a laps row's stored source_time matches its order key", () => {
  test("a laps row with lap_duration is stored at date_start + lap_duration, not raw date_start", async () => {
    const dateStart = "2026-01-01T13:00:00.000Z";
    const fetcher = endpointResponses({
      sessions: [
        {
          session_key: 8001,
          session_name: "Race",
          country_name: "Italy",
          circuit_key: 39,
          date_start: "2026-01-01T13:00:00+00:00",
          date_end: "2026-01-01T15:00:00+00:00",
        },
      ],
      laps: [{ session_key: 8001, driver_number: 1, lap_number: 1, date_start: dateStart, lap_duration: 90 }],
    });

    const db = fakeLoaderDb();
    const now = () => Date.parse("2026-06-01T00:00:00Z");
    await fetchRaces([8001], db, fetcher, { now, onLog: () => {} });

    const lapEvents = [...db.events.values()].filter((event) => event.endpoint === "laps");
    expect(lapEvents).toHaveLength(2); // start row + complete row
    const times = lapEvents.map((event) => event.sourceTime?.toISOString()).sort();
    expect(times).toEqual([
      "2026-01-01T13:00:00.000Z", // start row: raw date_start
      "2026-01-01T13:01:30.000Z", // complete row: dateStart + 90s
    ]);
  });
});

// The per-endpoint log line reports how many rows actually reach the
// queue, not how many the normalizer saw — those differ for laps once a
// row is split, and a log a human greps for row counts must count the
// thing it names.
describe("fetchRaces: the endpoint summary log counts emitted (post-split) rows, not just normalized rows", () => {
  test("a laps row that splits into two logs emitted=2 alongside the pre-split new=1", async () => {
    const fetcher = endpointResponses({
      sessions: [
        {
          session_key: 8003,
          session_name: "Race",
          country_name: "Italy",
          circuit_key: 39,
          date_start: "2026-01-01T13:00:00+00:00",
          date_end: "2026-01-01T15:00:00+00:00",
        },
      ],
      laps: [
        {
          session_key: 8003,
          driver_number: 1,
          lap_number: 1,
          date_start: "2026-01-01T13:00:00.000Z",
          lap_duration: 90,
        },
      ],
    });

    const db = fakeLoaderDb();
    const now = () => Date.parse("2026-06-01T00:00:00Z");
    const logs: string[] = [];
    await fetchRaces([8003], db, fetcher, { now, onLog: (line) => logs.push(line) });

    const lapsLine = logs.find((line) => line.includes("endpoint=laps"));
    expect(lapsLine).toContain("new=1"); // one row normalized/recorded
    expect(lapsLine).toContain("emitted=2"); // two rows reached the queue after the split

    // A non-laps endpoint never splits: new and emitted stay equal.
    const positionLine = logs.find((line) => line.includes("endpoint=position"));
    expect(positionLine).toContain("new=0");
    expect(positionLine).toContain("emitted=0");
  });
});

// The recording (`RaceRecorder`) is a durable artefact of what OpenF1
// actually returned; it must not carry the emission-time lap split, or a
// reload of it would no longer replay OpenF1's real rows one-for-one.
describe("fetchRaces: the recording keeps OpenF1's raw rows, one per historical lap, while the queue gets two", () => {
  test("the recorder receives the single pre-split laps row; the event queue receives the start row and the complete row", async () => {
    const dateStart = "2026-01-01T13:00:00.000Z";
    const fetcher = endpointResponses({
      sessions: [
        {
          session_key: 8004,
          session_name: "Race",
          country_name: "Italy",
          circuit_key: 39,
          date_start: "2026-01-01T13:00:00+00:00",
          date_end: "2026-01-01T15:00:00+00:00",
        },
      ],
      laps: [{ session_key: 8004, driver_number: 1, lap_number: 1, date_start: dateStart, lap_duration: 90 }],
    });

    const db = fakeLoaderDb();
    const { recorder, calls } = fakeRecorder();
    const now = () => Date.parse("2026-06-01T00:00:00Z");

    await fetchRaces([8004], db, fetcher, { now, onLog: () => {}, recorder });

    const lapsAppend = calls.appendRowsCalls.find((call) => call.endpoint === "laps");
    expect(lapsAppend?.rowCount).toBe(1); // the recording keeps OpenF1's one raw row for this lap

    const lapEvents = [...db.events.values()].filter((event) => event.endpoint === "laps");
    expect(lapEvents).toHaveLength(2); // the queue/database got the start row and the complete row
  });
});

// `writeSessionThroughLoader` hands `emitAll` a brand new `LiveNormalizer`
// per call, so every fetched row looks "new" to it again on a rerun —
// without a guard, the jsonl recording (unlike the idempotent DB write)
// would duplicate its content on every rerun.
describe("fetchRaces: round 1 fix — the jsonl recording is not duplicated on a rerun", () => {
  test("writeSession/appendRows are called on the first run only, not on a rerun of the same (already-finished) session", async () => {
    const fetcher = endpointResponses({
      sessions: [
        {
          session_key: 8002,
          session_name: "Race",
          country_name: "Italy",
          circuit_key: 39,
          date_start: "2026-01-01T13:00:00+00:00",
          date_end: "2026-01-01T15:00:00+00:00",
        },
      ],
      drivers: [{ session_key: 8002, driver_number: 1, full_name: "Test Driver" }],
      position: [{ session_key: 8002, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }],
    });

    const db = fakeLoaderDb();
    const { recorder, calls } = fakeRecorder();
    const now = () => Date.parse("2026-06-01T00:00:00Z");

    await fetchRaces([8002], db, fetcher, { now, onLog: () => {}, recorder });
    expect(calls.writeSessionCalls).toBe(1);
    expect(calls.appendRowsCalls.map((call) => call.endpoint)).toEqual(["drivers", "position"]);

    await fetchRaces([8002], db, fetcher, { now, onLog: () => {}, recorder });
    // Unchanged by the second (idempotent, already-finished) run.
    expect(calls.writeSessionCalls).toBe(1);
    expect(calls.appendRowsCalls).toHaveLength(2);
  });
});

// --replace reaches `fetchRaces` through the same `writeSessionThroughLoader`
// path the recording loader uses — no second implementation. The
// delete/rollback/verify-line behaviour itself is covered by
// load-recording.test.ts; this only pins that the flag and the stale rows
// actually get to that shared path from here.
describe("fetchRaces: --replace threads through the shared write path", () => {
  test("a session with a stale row gets that row deleted before the fetched row lands", async () => {
    const fetcher = endpointResponses({
      sessions: [
        {
          session_key: 9900,
          session_name: "Race",
          country_name: "Italy",
          circuit_key: 39,
          date_start: "2026-01-01T13:00:00+00:00",
          date_end: "2026-01-01T15:00:00+00:00",
        },
      ],
      position: [{ session_key: 9900, driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }],
    });

    const db = fakeLoaderDb();
    db.sessions.set("9900", { status: "finished" });
    await db.event.createMany({
      data: [{ eventId: "stale:1", sessionKey: 9900n, endpoint: "position", sourceTime: null, payload: {} }],
      skipDuplicates: true,
    });

    const now = () => Date.parse("2026-06-01T00:00:00Z");
    const logs: string[] = [];
    const result = await fetchRaces([9900], db, fetcher, { now, onLog: (line) => logs.push(line), replace: true });

    expect(result.sessionsSkipped).toBe(0);
    expect(db.events.has("stale:1")).toBe(false);
    expect([...db.events.values()].some((row) => row.endpoint === "position")).toBe(true);
    expect(logs.some((line) => line.startsWith("load: verify 9900 "))).toBe(true);
  });
});
