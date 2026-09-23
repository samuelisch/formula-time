import { describe, expect, test, vi } from "vitest";

import { EntryListFetches } from "./entry-list-fetches.js";
import { enqueueDriverRows, enqueueRows } from "./enqueue.js";
import type { RecordRows } from "./enqueue.js";
import { LiveNormalizer } from "./normalize.js";
import type { QueueItem, RawRecord } from "./types.js";
import type { LaneLog } from "../log.js";
import { EventQueue } from "../writer/queue.js";

const START = Date.parse("2026-09-06T13:00:00Z");

// No meeting_key: the selection and pre-race tests pass SESSION as the sole
// row in the snapshot handed to runDue, which would otherwise read as a
// meeting whose only known session is its own race and make the Friday
// fetch due. The Friday tests build their own meeting fixtures below.
const SESSION: RawRecord = {
  session_key: 11361,
  session_name: "Race",
  country_name: "Italy",
  date_start: "2026-09-06T13:00:00+00:00",
  date_end: "2026-09-06T15:00:00+00:00",
};

/**
 * The lane's own wiring, in memory: a real normalizer and queue behind the
 * two injected enqueue callbacks, so a moved test still asserts on the rows
 * that reach the queue.
 */
function makeFetches(
  fetcher: (url: string) => Promise<unknown>,
  opts: {
    known?: number[];
    onRecorded?: RecordRows;
    log?: LaneLog;
    countStat?: (stat: string, n?: number) => void;
  } = {},
): { fetches: EntryListFetches; queue: EventQueue<QueueItem> } {
  const queue = new EventQueue<QueueItem>();
  const normalizer = new LiveNormalizer();
  const known = new Set(opts.known ?? [11361]);
  const onRecorded = opts.onRecorded;
  const fetches = new EntryListFetches({
    fetcher,
    enqueueDrivers: (rows, expectedSessionKey) =>
      enqueueDriverRows(normalizer, queue, rows, expectedSessionKey, (key) => known.has(key), onRecorded),
    enqueueRows: async (endpoint, sessionKey, rows) => {
      const result = await enqueueRows(normalizer, queue, endpoint, sessionKey, rows, onRecorded);
      return { newRows: result.newRows, malformed: result.malformed };
    },
    isKnownSession: (key) => known.has(key),
    countStat: opts.countStat ?? ((): void => {}),
    log: opts.log ?? ((): void => {}),
  });
  return { fetches, queue };
}

function fakeFetcher(responses: Record<string, unknown>): {
  fetcher: (url: string) => Promise<unknown>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url: string) => {
      calls.push(url);
      const parsed = new URL(url);
      const endpoint = parsed.pathname.split("/").at(-1) ?? "";
      return responses[endpoint] ?? [];
    },
  };
}

describe("EntryListFetches: selection fetch", () => {
  test("a session selected with zero rows returned enqueues the 22 static `drivers` records tagged with that session", async () => {
    const { fetcher } = fakeFetcher({ drivers: [] });
    const { fetches, queue } = makeFetches(fetcher);

    expect(await fetches.onSessionSelected(11361, START)).toBe(true);

    const items = queue.drain(1000);
    expect(items).toHaveLength(22);
    expect(items.every((i) => i.endpoint === "drivers" && i.sessionKey === 11361n)).toBe(true);
  });

  test("the static fallback is emitted once, with its reason, then retried every 5 minutes until rows arrive", async () => {
    let driversResponse: unknown = [];
    const fetcher = async (): Promise<unknown> => driversResponse;
    const logs: string[] = [];
    const { fetches, queue } = makeFetches(fetcher, { log: (message: string) => logs.push(message) });

    await fetches.onSessionSelected(11361, START);
    expect(queue.drain(1000)).toHaveLength(22);
    expect(logs).toContain("entry list: static fallback (no rows) session_key=11361");

    // Well inside the 5-minute retry window: nothing is due.
    expect(await fetches.runDue(SESSION, [SESSION], START + 60_000)).toBe(false);

    // 5 minutes later, still zero rows: retried, but the fallback is not re-emitted.
    expect(await fetches.runDue(SESSION, [SESSION], START + 5 * 60_000)).toBe(true);
    expect(queue.drain(1000)).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith("entry list: static fallback"))).toHaveLength(1);

    // The fetch now returns rows: the next due retry emits them.
    driversResponse = [{ session_key: 11361, meeting_key: 1293, driver_number: 44, full_name: "Lewis HAMILTON" }];
    expect(await fetches.runDue(SESSION, [SESSION], START + 10 * 60_000)).toBe(true);
    const fetched = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ sessionKey: 11361n });

    // Satisfied: no further retries, even much later.
    expect(await fetches.runDue(SESSION, [SESSION], START + 60 * 60_000)).toBe(false);
  });

  test("a row naming another known session at selection is still written, tagged to the session it names, and counted foreign", async () => {
    const driversResponse = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 99999, meeting_key: 1293, driver_number: 2, full_name: "Foreign Row" },
    ];
    const fetcher = async (): Promise<unknown> => driversResponse;
    const logs: string[] = [];
    const { fetches, queue } = makeFetches(fetcher, {
      known: [11361, 99999], // both sessions upserted, so both are known
      log: (message: string) => logs.push(message),
    });

    await fetches.onSessionSelected(11361, START);

    const items = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.sessionKey))).toEqual(new Set([11361n, 99999n]));
    expect(logs.some((l) => l.includes("foreign=1"))).toBe(true);
  });

  test("a row naming a session that is not in the sessions table is dropped, never queued (events.session_key is a FK)", async () => {
    const driversResponse = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 99999, meeting_key: 1293, driver_number: 2, full_name: "Unknown Session Row" },
    ];
    const fetcher = async (): Promise<unknown> => driversResponse;
    const logs: string[] = [];
    const { fetches, queue } = makeFetches(fetcher, { known: [11361], log: (message: string) => logs.push(message) });

    await fetches.onSessionSelected(11361, START);

    const items = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionKey: 11361n });
    expect(logs.some((l) => l.includes("unknown_session=1"))).toBe(true);
  });

  test("fetched entry-list rows reach onRecorded (the jsonl recorder) once per session_key, same as the fallback", async () => {
    const driversResponse = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 11361, meeting_key: 1293, driver_number: 4, full_name: "Lando NORRIS 2" },
    ];
    const fetcher = async (): Promise<unknown> => driversResponse;
    const onRecorded = vi.fn(async () => {});
    const { fetches } = makeFetches(fetcher, { onRecorded });

    await fetches.onSessionSelected(11361, START);

    const driverCalls = onRecorded.mock.calls.filter((c) => c[1] === "drivers");
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0]?.[0]).toBe(11361);
    expect(driverCalls[0]?.[2]).toHaveLength(2);
  });
});

describe("EntryListFetches: pre-race refresh", () => {
  test("fires once, 5 minutes before date_start; a failed attempt is retried the very next tick", async () => {
    let refreshShouldFail = true;
    let refreshCallCount = 0;
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/drivers?session_key=11361")) {
        refreshCallCount += 1;
        if (refreshCallCount === 1) {
          // The selection fetch is satisfied on the very first call.
          return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
        }
        if (refreshShouldFail) throw new Error("network error");
        return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    const logs: Array<{ message: string; level: string | undefined }> = [];
    const { fetches, queue } = makeFetches(fetcher, {
      log: (message, opts) => logs.push({ message, level: opts?.level }),
    });

    // Well inside the live window, well before T-5min.
    await fetches.onSessionSelected(11361, START - 20 * 60_000);
    queue.drain(1000);
    expect(refreshCallCount).toBe(1);

    // Not yet T-5min: nothing due.
    expect(await fetches.runDue(SESSION, [SESSION], START - 20 * 60_000)).toBe(false);
    expect(refreshCallCount).toBe(1);

    // T-5min: the refresh is due; the fetch throws, so it's not marked done.
    expect(await fetches.runDue(SESSION, [SESSION], START - 5 * 60_000)).toBe(true);
    expect(refreshCallCount).toBe(2);
    expect(
      logs.some(
        (l) => l.level === "error" && l.message.startsWith("entry list: pre-race refresh failed for session_key=11361"),
      ),
    ).toBe(true);

    // The very next tick, still inside the T-5min..T window: retried, and this time it succeeds.
    refreshShouldFail = false;
    expect(await fetches.runDue(SESSION, [SESSION], START - 5 * 60_000)).toBe(true);
    expect(refreshCallCount).toBe(3);

    // A further tick in the same window: one-shot, not retried again.
    expect(await fetches.runDue(SESSION, [SESSION], START - 4 * 60_000)).toBe(false);
    expect(refreshCallCount).toBe(3);
  });
});

describe("EntryListFetches: Friday meeting-wide fetch", () => {
  const FP1: RawRecord = {
    session_key: 11360,
    meeting_key: 1293,
    session_type: "Practice",
    date_start: "2026-09-04T11:30:00Z",
    date_end: "2026-09-04T12:30:00Z",
  };
  const RACE: RawRecord = {
    session_key: 11361,
    meeting_key: 1293,
    session_type: "Race",
    session_name: "Race",
    date_start: "2026-09-06T13:00:00Z",
    date_end: "2026-09-06T15:00:00Z",
  };

  test("fires once per meeting once its first session has started and its race session is known; retries every 30 minutes on failure", async () => {
    let now = Date.parse("2026-09-04T11:31:00Z"); // 1 minute after FP1's date_start
    let shouldFail = true;
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/drivers?meeting_key=1293")) {
        if (shouldFail) throw new Error("network error");
        return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    const logs: string[] = [];
    const { fetches, queue } = makeFetches(fetcher, { log: (message: string) => logs.push(message) });

    expect(await fetches.checkFridayFetch([FP1, RACE], now)).toBe(true);
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(1);
    expect(logs.some((l) => l.includes("friday fetch meeting_key=1293 deferred"))).toBe(true);
    queue.drain(1000);

    // Immediately again: not due yet (30-minute retry cadence).
    expect(await fetches.checkFridayFetch([FP1, RACE], now)).toBe(false);
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(1);

    // 30 minutes later: retried, and this time it succeeds.
    now += 30 * 60_000;
    shouldFail = false;
    expect(await fetches.checkFridayFetch([FP1, RACE], now)).toBe(true);
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(2);
    const items = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionKey: 11361n }); // tagged to the RACE session named in the row, not the meeting

    // Satisfied: no further fetches for this meeting, even much later.
    now += 60 * 60_000;
    expect(await fetches.checkFridayFetch([FP1, RACE], now)).toBe(false);
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(2);
  });

  test("fetched rows reach onRecorded (the jsonl recorder), tagged to the session they name", async () => {
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/drivers?meeting_key=1293")) {
        return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    const onRecorded = vi.fn(async () => {});
    const { fetches } = makeFetches(fetcher, { onRecorded });

    await fetches.checkFridayFetch([FP1, RACE], Date.parse("2026-09-04T11:31:00Z"));

    const raceCalls = onRecorded.mock.calls.filter((c) => c[1] === "drivers" && c[0] === 11361);
    expect(raceCalls).toHaveLength(1);
    expect(raceCalls[0]?.[2]).toHaveLength(1);
  });

  test("a race session whose sessions upsert has not landed does not count as known: no fetch", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      return [];
    };
    const { fetches } = makeFetches(fetcher, { known: [] });

    expect(await fetches.checkFridayFetch([FP1, RACE], Date.parse("2026-09-04T11:31:00Z"))).toBe(false);
    expect(calls.some((u) => u.includes("meeting_key="))).toBe(false);
  });

  test("no race session known yet -> never fires", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      return [];
    };
    const { fetches } = makeFetches(fetcher);

    expect(await fetches.checkFridayFetch([FP1], Date.parse("2026-09-04T11:31:00Z"))).toBe(false);
    expect(calls.some((u) => u.includes("meeting_key="))).toBe(false);
  });

  test("a calendar with 15 past meetings and one upcoming meeting (first session passed) makes exactly one fetch, for the upcoming meeting", async () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    const pastMeetings: RawRecord[] = [];
    const known: number[] = [30001];
    for (let i = 0; i < 15; i++) {
      const meetingKey = 1279 + i;
      known.push(21000 + i);
      pastMeetings.push(
        {
          session_key: 20000 + i,
          meeting_key: meetingKey,
          session_type: "Practice",
          date_start: "2026-08-01T10:00:00Z",
          date_end: "2026-08-01T11:00:00Z",
        },
        {
          session_key: 21000 + i,
          meeting_key: meetingKey,
          session_type: "Race",
          session_name: "Race",
          date_start: "2026-08-03T13:00:00Z",
          date_end: "2026-08-03T15:00:00Z",
        },
      );
    }
    const upcoming: RawRecord[] = [
      {
        session_key: 30000,
        meeting_key: 1300,
        session_type: "Practice",
        date_start: "2026-09-08T10:00:00Z",
        date_end: "2026-09-08T11:00:00Z",
      },
      {
        session_key: 30001,
        meeting_key: 1300,
        session_type: "Race",
        session_name: "Race",
        date_start: "2026-09-10T13:00:00Z",
        date_end: "2026-09-10T15:00:00Z",
      },
    ];
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/drivers?meeting_key="))
        return [{ session_key: 30001, meeting_key: 1300, driver_number: 1, full_name: "Lando NORRIS" }];
      return [];
    };
    const { fetches } = makeFetches(fetcher, { known });

    await fetches.checkFridayFetch([...pastMeetings, ...upcoming], now);

    const meetingFetches = calls.filter((u) => u.includes("/drivers?meeting_key="));
    expect(meetingFetches).toEqual([expect.stringContaining("meeting_key=1300")]);
  });

  test("a past meeting is never fetched even when its race session is known", async () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    const pastMeeting: RawRecord[] = [
      {
        session_key: 20000,
        meeting_key: 1279,
        session_type: "Practice",
        date_start: "2026-08-01T10:00:00Z",
        date_end: "2026-08-01T11:00:00Z",
      },
      {
        session_key: 21000,
        meeting_key: 1279,
        session_type: "Race",
        session_name: "Race",
        date_start: "2026-08-03T13:00:00Z",
        date_end: "2026-08-03T15:00:00Z",
      },
    ];
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      return [];
    };
    const { fetches } = makeFetches(fetcher, { known: [21000] });

    // Keep checking well past the 30-minute retry cadence: still never fetched.
    let laterNow = now;
    for (let i = 0; i < 4; i++) {
      expect(await fetches.checkFridayFetch(pastMeeting, laterNow)).toBe(false);
      laterNow += 40 * 60_000;
    }

    expect(calls.some((u) => u.includes("meeting_key="))).toBe(false);
  });
});

describe("EntryListFetches: the budget rule", () => {
  test("runDue makes at most one request per tick: the selection retry wins over a due Friday fetch", async () => {
    const FRIDAY_FP1: RawRecord = {
      session_key: 11360,
      meeting_key: 1293,
      session_type: "Practice",
      date_start: "2026-09-04T11:30:00Z",
      date_end: "2026-09-04T12:30:00Z",
    };
    const RACE_IN_MEETING: RawRecord = { ...SESSION, meeting_key: 1293 };
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      return []; // both the selection fetch and Friday come back empty
    };
    const { fetches } = makeFetches(fetcher);

    await fetches.onSessionSelected(11361, START); // selection fetch: falls back, retries in 5 min
    calls.length = 0;

    // The selection retry is due again; Friday is due too, but only one fetch happens.
    expect(await fetches.runDue(RACE_IN_MEETING, [FRIDAY_FP1, RACE_IN_MEETING], START + 5 * 60_000)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/drivers?session_key=11361");

    // The next tick spends its one request on Friday.
    expect(await fetches.runDue(RACE_IN_MEETING, [FRIDAY_FP1, RACE_IN_MEETING], START + 5 * 60_000)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/drivers?meeting_key=1293");
  });
});
