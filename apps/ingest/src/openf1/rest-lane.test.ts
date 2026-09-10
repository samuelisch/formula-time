import { describe, expect, test, vi } from "vitest";

import type { QueueItem, RawRecord } from "./types.js";
import {
  POLL_ROTATION,
  RestLane,
  buildPollUrl,
  emitTaggedDriverRows,
  pickLiveSession,
  sessionExpired,
} from "./rest-lane.js";
import { LiveNormalizer } from "./normalize.js";
import { EventQueue } from "../writer/queue.js";

const START = Date.parse("2026-09-06T13:00:00Z");
const END = Date.parse("2026-09-06T15:00:00Z");
const WINDOW = 30 * 60 * 1000;

// No meeting_key: most tests below use SESSION as the sole row in a fake
// `sessions?year=` response, which would otherwise read as a meeting whose
// only known session is its own race — not a real-world shape (OpenF1's
// full-year response always carries a race's practice/qualifying siblings
// too) and not one the Friday-fetch tests below need SESSION for; they
// build their own meeting fixtures with an explicit meeting_key instead.
const SESSION: RawRecord = {
  session_key: 11361,
  session_name: "Race",
  circuit_key: 39,
  country_name: "Italy",
  date_start: "2026-09-06T13:00:00+00:00",
  date_end: "2026-09-06T15:00:00+00:00",
};

describe("pickLiveSession", () => {
  test("just inside the pre-race window edge -> selected", () => {
    expect(pickLiveSession([SESSION], START - WINDOW)).toBe(SESSION);
  });

  test("one ms before the pre-race window -> not selected", () => {
    expect(pickLiveSession([SESSION], START - WINDOW - 1)).toBeNull();
  });

  test("just inside the post-race window edge -> still selected", () => {
    expect(pickLiveSession([SESSION], END + WINDOW)).toBe(SESSION);
  });

  test("one ms past the post-race window -> not selected", () => {
    expect(pickLiveSession([SESSION], END + WINDOW + 1)).toBeNull();
  });

  test("a session with unparseable dates is skipped, not thrown", () => {
    const bad: RawRecord = { session_key: 1, date_start: "nope", date_end: "nope" };
    expect(pickLiveSession([bad, SESSION], START)).toBe(SESSION);
  });
});

describe("sessionExpired", () => {
  test("null session -> never expired", () => {
    expect(sessionExpired(null, Date.now())).toBe(false);
  });

  test("expires only once the clock leaves the post-race grace window", () => {
    expect(sessionExpired(SESSION, END + WINDOW)).toBe(false);
    expect(sessionExpired(SESSION, END + WINDOW + 1)).toBe(true);
  });
});

describe("buildPollUrl", () => {
  test("session_key only, no cursor (the live API rejects date filters)", () => {
    expect(buildPollUrl("position", 11361, null)).toBe(
      "https://api.openf1.org/v1/position?session_key=11361",
    );
  });

  test("a cursor is added as a date filter only when both a timestamp field and a cursor are given", () => {
    expect(buildPollUrl("position", 11361, "2026-09-06T13:00:00Z")).toContain("date%3E%3D=");
    expect(buildPollUrl("stints", 11361, "2026-09-06T13:00:00Z")).toBe(
      "https://api.openf1.org/v1/stints?session_key=11361",
    );
  });
});

describe("POLL_ROTATION", () => {
  test("weighted rotation order is stable and covers every polled endpoint", () => {
    expect(POLL_ROTATION[0]).toBe("position");
    expect(new Set(POLL_ROTATION)).toEqual(
      new Set(["position", "intervals", "laps", "race_control", "weather", "pit", "stints"]),
    );
    // "hot" endpoints appear most often
    const counts = new Map<string, number>();
    for (const endpoint of POLL_ROTATION) counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
    expect(counts.get("position")).toBeGreaterThan(counts.get("stints")!);
  });
});

function fakeFetcher(responses: Record<string, unknown>): { fetcher: (url: string) => Promise<unknown>; calls: string[] } {
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

describe("RestLane discovery", () => {
  test("upserts every discovered session, even before any is live", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION], drivers: [] });
    const onSession = vi.fn();
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START - 2 * WINDOW, onSession, onLog: () => {} });

    await lane.discoverOnce();

    expect(onSession).toHaveBeenCalledWith(SESSION, START - 2 * WINDOW);
    expect(lane.status().active).toBe(false); // outside the live window still
  });

  test("onSessionSelected fires once, only for the session that becomes live, not once per discovery tick", async () => {
    const upcoming: RawRecord = {
      session_key: 11362,
      session_name: "Race",
      date_start: "2026-09-13T13:00:00Z",
      date_end: "2026-09-13T15:00:00Z",
    };
    const finished: RawRecord = {
      session_key: 11349,
      session_name: "Race",
      date_start: "2026-08-30T13:00:00Z",
      date_end: "2026-08-30T15:00:00Z",
    };
    const { fetcher } = fakeFetcher({ sessions: [finished, SESSION, upcoming], drivers: [{ driver_number: 1 }] });
    const onSession = vi.fn();
    const onSessionSelected = vi.fn();
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onSession, onSessionSelected, onLog: () => {} });

    await lane.discoverOnce();

    // onSession still sees every row...
    expect(onSession).toHaveBeenCalledTimes(3);
    // ...but onSessionSelected fires only for the one that became live.
    expect(onSessionSelected).toHaveBeenCalledTimes(1);
    expect(onSessionSelected).toHaveBeenCalledWith(SESSION, START);

    await lane.discoverOnce(); // same session still selected: not called again

    expect(onSessionSelected).toHaveBeenCalledTimes(1);
  });

  test("one onSession row throwing (a malformed session) does not stop the rest, or starve ensureLiveSession", async () => {
    const bad: RawRecord = { session_key: "not-a-number", session_name: "Race", date_start: "nope", date_end: "nope" };
    const { fetcher } = fakeFetcher({ sessions: [bad, SESSION], drivers: [{ driver_number: 1 }] });
    const onSession = vi.fn(async (row: RawRecord) => {
      if (row === bad) throw new Error("upsertSession: session_key is not a valid integer");
    });
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onSession, onLog: () => {} });

    const outcome = await lane.discoverOnce();

    // Both rows were still handed to onSession, in order — the throw on the
    // first didn't stop the loop.
    expect(onSession).toHaveBeenCalledTimes(2);
    expect(onSession).toHaveBeenNthCalledWith(1, bad, START);
    expect(onSession).toHaveBeenNthCalledWith(2, SESSION, START);
    // And ensureLiveSession() still ran on the good session despite the bad
    // one throwing first.
    expect(outcome.live).toBe(true);
    expect(lane.status()).toEqual({ active: true, sessionKey: 11361 });
  });

  test("a session whose sessions upsert fails is not selected; it retries and is selected once the upsert succeeds", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION], drivers: [] });
    let shouldFail = true;
    const onSession = vi.fn(async () => {
      if (shouldFail) throw new Error("db down");
    });
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onSession, onLog: () => {} });

    const first = await lane.discoverOnce();
    expect(first.live).toBe(false);
    expect(lane.status()).toEqual({ active: false, sessionKey: null });

    shouldFail = false;
    const second = await lane.discoverOnce();
    expect(second.live).toBe(true);
    expect(lane.status()).toEqual({ active: true, sessionKey: 11361 });
  });

  test("selects the live session", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION] });
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: () => {} });

    await lane.discoverOnce();

    expect(lane.status()).toEqual({ active: true, sessionKey: 11361 });
  });
});

describe("RestLane: races only (issue #168)", () => {
  const PRACTICE_1: RawRecord = {
    session_key: 40001,
    meeting_key: 1400,
    session_type: "Practice",
    session_name: "Practice 1",
    country_name: "Italy",
    circuit_key: 39,
    date_start: "2026-09-06T13:00:00Z",
    date_end: "2026-09-06T14:00:00Z",
  };
  const QUALIFYING: RawRecord = {
    session_key: 40002,
    meeting_key: 1400,
    session_type: "Qualifying",
    session_name: "Qualifying",
    country_name: "Italy",
    circuit_key: 39,
    date_start: "2026-09-06T15:00:00Z",
    date_end: "2026-09-06T16:00:00Z",
  };
  const SPRINT: RawRecord = {
    session_key: 40003,
    meeting_key: 1400,
    session_type: "Race", // OpenF1 gives a sprint session_type "Race"...
    session_name: "Sprint", // ...but session_name "Sprint" — the filter is on session_name.
    country_name: "Italy",
    circuit_key: 39,
    date_start: "2026-09-06T17:00:00Z",
    date_end: "2026-09-06T18:00:00Z",
  };
  const RACE_ROW: RawRecord = {
    session_key: 40004,
    meeting_key: 1400,
    session_type: "Race",
    session_name: "Race",
    country_name: "Italy",
    circuit_key: 39,
    date_start: "2026-09-06T19:00:00Z",
    date_end: "2026-09-06T21:00:00Z",
  };

  test("a sessions?year= response with Practice 1, Qualifying, Sprint, Race rows upserts only the Race row; knownSessionKeys holds one key", async () => {
    const { fetcher } = fakeFetcher({ sessions: [PRACTICE_1, QUALIFYING, SPRINT, RACE_ROW], drivers: [] });
    const onSession = vi.fn();
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, {
      fetcher,
      now: () => Date.parse("2026-09-05T00:00:00Z"), // outside every session's live window
      onSession,
      onLog: () => {},
    });

    await lane.discoverOnce();

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(RACE_ROW, expect.any(Number));
    const knownSessionKeys = (lane as unknown as { knownSessionKeys: Set<number> }).knownSessionKeys;
    expect(knownSessionKeys).toEqual(new Set([40004]));
  });

  test("a Practice session inside its live window is not selected while a Race one is", async () => {
    const { fetcher } = fakeFetcher({ sessions: [PRACTICE_1, RACE_ROW], drivers: [] });
    const queue = new EventQueue<QueueItem>();
    const practiceNow = Date.parse("2026-09-06T13:30:00Z"); // inside PRACTICE_1's window, outside RACE_ROW's
    const lane = new RestLane(queue, { fetcher, now: () => practiceNow, onLog: () => {} });

    await lane.discoverOnce();

    expect(lane.status()).toEqual({ active: false, sessionKey: null });

    const raceNow = Date.parse("2026-09-06T19:30:00Z"); // inside RACE_ROW's window
    const lane2 = new RestLane(queue, { fetcher, now: () => raceNow, onLog: () => {} });
    await lane2.discoverOnce();

    expect(lane2.status()).toEqual({ active: true, sessionKey: 40004 });
  });

  test("the Friday check still fires with the practice rows present in the snapshot", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/sessions?")) return [PRACTICE_1, QUALIFYING, SPRINT, RACE_ROW];
      if (url.includes("/drivers?meeting_key=1400")) {
        return [{ session_key: 40004, meeting_key: 1400, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    // After PRACTICE_1's date_start, well before RACE_ROW's own live window —
    // no session is selected live, so the idle discovery tick's own Friday
    // check runs unbudgeted, grouping the meeting from every row in the
    // snapshot (practice, qualifying and sprint included) to find its first
    // session's start and its (already-known) race session.
    const now = Date.parse("2026-09-06T13:30:00Z");
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });

    await lane.discoverOnce();

    expect(calls.some((u) => u.includes("meeting_key=1400"))).toBe(true);
    const items = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionKey: 40004n });
  });
});

describe("RestLane: static entry list emitted on session selection", () => {
  test("selecting a session enqueues 22 `drivers` records tagged with that session", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION] });
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: () => {} });

    await lane.discoverOnce();

    const items = queue.drain(1000);
    expect(items).toHaveLength(22);
    expect(items.every((i) => i.endpoint === "drivers" && i.sessionKey === 11361n)).toBe(true);
  });

  test("re-selecting the same session (simulating a restart) enqueues identical ids — the writer's dedup makes the re-emission harmless", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION] });

    const firstQueue = new EventQueue<QueueItem>();
    const firstLane = new RestLane(firstQueue, { fetcher, now: () => START, onLog: () => {} });
    await firstLane.discoverOnce();
    const firstIds = firstQueue
      .drain(1000)
      .map((i) => i.eventId)
      .sort();

    // A fresh RestLane (and queue) simulates a process restart: nothing
    // carries over except what the fetcher itself returns.
    const secondQueue = new EventQueue<QueueItem>();
    const secondLane = new RestLane(secondQueue, { fetcher, now: () => START, onLog: () => {} });
    await secondLane.discoverOnce();
    const secondIds = secondQueue
      .drain(1000)
      .map((i) => i.eventId)
      .sort();

    expect(firstIds).toHaveLength(22);
    expect(secondIds).toEqual(firstIds);
  });
});

describe("RestLane.pollOnce", () => {
  test("no active session -> null, no fetch", async () => {
    const { fetcher, calls } = fakeFetcher({});
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: () => {} });

    expect(await lane.pollOnce()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("polls the rotation endpoint with session_key only and enqueues normalized rows", async () => {
    const row = { driver_number: 1, date: "2026-09-06T13:00:00Z" };
    const { fetcher, calls } = fakeFetcher({ sessions: [SESSION], position: [row] });
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: () => {} });
    await lane.discoverOnce(); // selects the session
    queue.drain(1000); // clear the static entry-list rows emitted on selection

    const result = await lane.pollOnce();

    expect(result).toEqual({ endpoint: "position", rows: 1, newRows: 1, malformed: 0 });
    expect(calls.at(-1)).toBe("https://api.openf1.org/v1/position?session_key=11361");
    const [item] = queue.drain(10);
    expect(item).toMatchObject({ endpoint: "position", sessionKey: 11361n });
  });

  test("rotation order is followed across successive polls", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION], drivers: [] });
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: () => {} });
    await lane.discoverOnce();

    const endpoints: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await lane.pollOnce();
      if (result) endpoints.push(result.endpoint);
    }
    expect(endpoints).toEqual(POLL_ROTATION.slice(0, 5));
  });

  test("releases the session once its live window has closed", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION], drivers: [] });
    const queue = new EventQueue<QueueItem>();
    let now = START;
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });
    await lane.discoverOnce();
    expect(lane.status().active).toBe(true);

    now = END + WINDOW + 1;
    const result = await lane.pollOnce();

    expect(result).toBeNull();
    expect(lane.status().active).toBe(false);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("RestLane.stop() and an in-flight tick (SIGTERM race)", () => {
  test("stop() does not resolve until the in-flight poll's fetch resolves, and its rows are in the queue by then", async () => {
    const queue = new EventQueue<QueueItem>();
    let resolvePosition: ((rows: RawRecord[]) => void) | null = null;
    const fetcher = (url: string): Promise<unknown> => {
      if (url.includes("/sessions")) return Promise.resolve([SESSION]);
      if (url.includes("/drivers")) return Promise.resolve([]);
      // The rotation poll (first endpoint in POLL_ROTATION is "position"):
      // left pending until the test resolves it, simulating a slow network
      // call still in flight when stop() is called.
      return new Promise<RawRecord[]>((resolve) => {
        resolvePosition = resolve;
      });
    };
    const lane = new RestLane(queue, {
      fetcher,
      now: () => START,
      tickMs: 5,
      discoveryIntervalMs: 5,
      onLog: () => {},
    });

    lane.start();
    // Discovery (immediate) selects the session; the next tick (~5ms later)
    // starts the rotation poll and blocks on the pending "position" fetch.
    await waitUntil(() => resolvePosition !== null);
    queue.drain(1000); // clear the static entry-list rows emitted on selection

    let stopped = false;
    const stopPromise = lane.stop().then(() => {
      stopped = true;
    });

    // The fetch is still pending: stop() must not have resolved yet, and no
    // rows from this tick should be queued.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    expect(queue.size).toBe(0);

    // Let the fetch resolve — the tick can now finish enqueueing its rows.
    resolvePosition!([{ driver_number: 1, date: "2026-09-06T13:00:00Z" }]);
    await stopPromise;

    expect(stopped).toBe(true);
    expect(queue.size).toBeGreaterThan(0);
    const [item] = queue.drain(10);
    expect(item).toMatchObject({ endpoint: "position" });
  });
});

// The fetched entry list, replacing the static ENTRY_LIST_2026
// fallback. Verified: every OpenF1 `drivers` row carries
// its own `session_key` and `meeting_key`, e.g.
// `{"meeting_key":1293,"session_key":11361,"driver_number":1,...}`
// (recordings/11361/raw/drivers.jsonl) — so a row is tagged by the
// `session_key` in ITS OWN payload, never by the session/meeting the fetch
// was made for.
describe("emitTaggedDriverRows", () => {
  test("tags each row by its own session_key; a row naming a different session is still written and counted foreign", () => {
    const normalizer = new LiveNormalizer();
    const queue = new EventQueue<QueueItem>();
    const rows: RawRecord[] = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 11362, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
    ];

    const result = emitTaggedDriverRows(normalizer, queue, rows, 11361);

    expect(result.newRows).toBe(2);
    expect(result.foreign).toBe(1); // the 11362 row named a different session than expected
    const items = queue.drain(10);
    expect(new Set(items.map((i) => i.sessionKey))).toEqual(new Set([11361n, 11362n]));
    expect(items.every((i) => i.endpoint === "drivers")).toBe(true);
  });

  test("a row with no numeric session_key of its own can't be tagged or written; counted malformed", () => {
    const normalizer = new LiveNormalizer();
    const queue = new EventQueue<QueueItem>();
    const rows: RawRecord[] = [{ driver_number: 1, full_name: "No Session" }];

    const result = emitTaggedDriverRows(normalizer, queue, rows, 11361);

    expect(result.malformed).toBe(1);
    expect(result.newRows).toBe(0);
    expect(queue.size).toBe(0);
  });

  test("a row naming a session isKnownSession rejects is dropped and counted unknownSession; groups carry the written payloads per session", () => {
    const queue = new EventQueue<QueueItem>();
    const result = emitTaggedDriverRows(
      new LiveNormalizer(),
      queue,
      [
        { session_key: 1, driver_number: 1 },
        { session_key: 2, driver_number: 2 },
      ],
      1,
      (key) => key === 1,
    );
    expect(result.unknownSession).toBe(1);
    expect(result.foreign).toBe(0);
    expect(result.newRows).toBe(1);
    expect(result.groups.map((g) => g.sessionKey)).toEqual([1]);
    expect(queue.drain(10).map((i) => i.sessionKey)).toEqual([1n]);
  });

  test("expectedSessionKey null (the Friday meeting-wide fetch) counts nothing as foreign", () => {
    const normalizer = new LiveNormalizer();
    const queue = new EventQueue<QueueItem>();
    const rows: RawRecord[] = [
      { session_key: 11360, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
    ];

    const result = emitTaggedDriverRows(normalizer, queue, rows, null);

    expect(result.foreign).toBe(0);
    expect(result.newRows).toBe(2);
  });
});

describe("RestLane: fetched entry list at session selection (issue #39)", () => {
  test("zero rows at selection -> static fallback emitted once; the poll loop retries every 5 minutes; fetched rows are emitted once they arrive, with no duplicate fallback", async () => {
    let now = START;
    let driversResponse: unknown = [];
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/sessions?")) return [SESSION];
      if (url.includes("/drivers?session_key=")) return driversResponse;
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });

    await lane.discoverOnce(); // selects SESSION; the fetch returns zero rows -> static fallback
    const afterSelection = queue.drain(1000);
    expect(afterSelection.filter((i) => i.endpoint === "drivers")).toHaveLength(22);

    // Well inside the 5-minute retry window: normal rotation resumes, no retry yet.
    const soon = await lane.pollOnce();
    expect(soon?.endpoint).toBe(POLL_ROTATION[0]);
    queue.drain(1000);

    // 5 minutes later, still zero rows: the poll loop retries the fetch, but the fallback is not re-emitted.
    now = START + 5 * 60_000;
    const stillZero = await lane.pollOnce();
    expect(stillZero?.endpoint).toBe("drivers");
    expect(queue.drain(1000).filter((i) => i.endpoint === "drivers")).toHaveLength(0);

    // The fetch now returns rows: the next due retry emits them (dedup makes the overlap with the fallback harmless).
    driversResponse = [{ session_key: 11361, meeting_key: 1293, driver_number: 44, full_name: "Lewis HAMILTON" }];
    now = START + 10 * 60_000;
    const fetched = await lane.pollOnce();
    expect(fetched?.endpoint).toBe("drivers");
    const fetchedRows = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(fetchedRows).toHaveLength(1);
    expect(fetchedRows[0]).toMatchObject({ sessionKey: 11361n });

    // Satisfied: no further retries, even much later.
    now = START + 60 * 60_000;
    const after = await lane.pollOnce();
    expect(after?.endpoint).not.toBe("drivers");
  });

  test("a row naming another known session at selection is still written, tagged to the session it names, and counted foreign", async () => {
    const OTHER: RawRecord = {
      ...SESSION,
      session_key: 99999,
      date_start: "2026-09-13T13:00:00+00:00",
      date_end: "2026-09-13T15:00:00+00:00",
    };
    const driversResponse = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 99999, meeting_key: 1293, driver_number: 2, full_name: "Foreign Row" },
    ];
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/sessions?")) return [SESSION, OTHER]; // both upserted, so both are known
      if (url.includes("/drivers?session_key=")) return driversResponse;
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: () => {} });

    await lane.discoverOnce();

    const items = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.sessionKey))).toEqual(new Set([11361n, 99999n]));
  });

  test("a row naming a session that is not in the sessions table is dropped, never queued (events.session_key is a FK)", async () => {
    const driversResponse = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 99999, meeting_key: 1293, driver_number: 2, full_name: "Unknown Session Row" },
    ];
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/sessions?")) return [SESSION]; // 99999 is never upserted
      if (url.includes("/drivers?session_key=")) return driversResponse;
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const logs: string[] = [];
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: (l) => logs.push(l) });

    await lane.discoverOnce();

    const items = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionKey: 11361n });
    expect(logs.some((l) => l.includes("unknown_session=1"))).toBe(true);
  });

  test("fetched entry-list rows reach onNewRows (the jsonl recorder) once per session_key, same as the fallback", async () => {
    const driversResponse = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 11361, meeting_key: 1293, driver_number: 4, full_name: "Lando NORRIS 2" },
    ];
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/sessions?")) return [SESSION];
      if (url.includes("/drivers?session_key=")) return driversResponse;
      return [];
    };
    const onNewRows = vi.fn(async () => {});
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onNewRows, onLog: () => {} });

    await lane.discoverOnce();

    const driverCalls = onNewRows.mock.calls.filter((c) => c[1] === "drivers");
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0]?.[0]).toBe(11361);
    expect(driverCalls[0]?.[2]).toHaveLength(2);
  });
});

describe("RestLane: Friday entry-list fetch (issue #39)", () => {
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
      if (url.includes("/sessions?")) return [FP1, RACE];
      if (url.includes("/drivers?meeting_key=1293")) {
        if (shouldFail) throw new Error("network error");
        return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });

    // FP1 (Practice) is inside its live window but is never selected (races
    // only) — no session goes live, so the idle discovery tick's own Friday
    // check runs immediately, unbudgeted (there is no rotation while idle).
    // RACE's own upsert succeeds trivially this tick (no onSession override
    // here), so it is already known, and the fetch fires straight away.
    await lane.discoverOnce();
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(1);
    queue.drain(1000);

    // Immediately again: not due yet (30-minute retry cadence).
    await lane.discoverOnce();
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(1);

    // 30 minutes later: retried, and this time it succeeds.
    now += 30 * 60_000;
    shouldFail = false;
    await lane.discoverOnce();
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(2);
    const items = queue.drain(1000).filter((i) => i.endpoint === "drivers");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionKey: 11361n }); // tagged to the RACE session named in the row, not the meeting

    // Satisfied: no further fetches for this meeting, even much later.
    now += 60 * 60_000;
    await lane.discoverOnce();
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(2);
  });

  test("fetched rows reach onNewRows (the jsonl recorder), tagged to the session they name", async () => {
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/sessions?")) return [FP1, RACE];
      if (url.includes("/drivers?meeting_key=1293")) {
        return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    const onNewRows = vi.fn(async () => {});
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, {
      fetcher,
      now: () => Date.parse("2026-09-04T11:31:00Z"),
      onNewRows,
      onLog: () => {},
    });

    // FP1 stays unselected (Practice); RACE is already known, so the idle
    // tick's own Friday check fires within this one discoverOnce() call.
    await lane.discoverOnce();

    const raceCalls = onNewRows.mock.calls.filter((c) => c[1] === "drivers" && c[0] === 11361);
    expect(raceCalls).toHaveLength(1);
    expect(raceCalls[0]?.[2]).toHaveLength(1);
  });

  test("a race session whose sessions upsert failed this tick does not count as known: no fetch until it lands", async () => {
    let raceFails = true;
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/sessions?")) return [FP1, RACE];
      if (url.includes("/drivers?meeting_key=1293")) {
        return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    const onSession = vi.fn(async (row: RawRecord) => {
      if (raceFails && row["session_name"] === "Race") throw new Error("db down");
    });
    let now = Date.parse("2026-09-04T11:31:00Z");
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onSession, onLog: () => {} });

    const raceRows = () => queue.drain(1000).filter((i) => i.endpoint === "drivers" && i.sessionKey === 11361n);

    // FP1 is Practice, never selected. RACE's own upsert fails: it is not
    // "known" yet, so checkFridayFetch's own knownSessionKeys guard skips
    // the meeting entirely — no meeting-wide fetch is even attempted.
    await lane.discoverOnce();
    expect(calls.some((u) => u.includes("meeting_key="))).toBe(false);
    expect(raceRows()).toHaveLength(0);

    now += 60_000;
    raceFails = false;
    await lane.discoverOnce(); // RACE's upsert succeeds this time: it becomes known
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(1);
    expect(raceRows()).toHaveLength(1);
  });

  test("no race session known yet -> never fires", async () => {
    const PRACTICE_ONLY: RawRecord = { ...FP1 };
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/sessions?")) return [PRACTICE_ONLY];
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, {
      fetcher,
      now: () => Date.parse("2026-09-04T11:31:00Z"),
      onLog: () => {},
    });

    await lane.discoverOnce();

    expect(calls.some((u) => u.includes("meeting_key="))).toBe(false);
  });

  test("a calendar with 15 past meetings and one upcoming meeting (first session passed) makes exactly one fetch, for the upcoming meeting", async () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    const pastMeetings: RawRecord[] = [];
    for (let i = 0; i < 15; i++) {
      const meetingKey = 1279 + i;
      pastMeetings.push(
        { session_key: 20000 + i, meeting_key: meetingKey, session_type: "Practice", date_start: "2026-08-01T10:00:00Z", date_end: "2026-08-01T11:00:00Z" },
        { session_key: 21000 + i, meeting_key: meetingKey, session_type: "Race", session_name: "Race", date_start: "2026-08-03T13:00:00Z", date_end: "2026-08-03T15:00:00Z" },
      );
    }
    const upcoming: RawRecord[] = [
      { session_key: 30000, meeting_key: 1300, session_type: "Practice", date_start: "2026-09-08T10:00:00Z", date_end: "2026-09-08T11:00:00Z" },
      { session_key: 30001, meeting_key: 1300, session_type: "Race", session_name: "Race", date_start: "2026-09-10T13:00:00Z", date_end: "2026-09-10T15:00:00Z" },
    ];
    const allSessions = [...pastMeetings, ...upcoming];
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/sessions?")) return allSessions;
      if (url.includes("/drivers?meeting_key=")) return [{ session_key: 30001, meeting_key: 1300, driver_number: 1, full_name: "Lando NORRIS" }];
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });

    await lane.discoverOnce();

    const meetingFetches = calls.filter((u) => u.includes("/drivers?meeting_key="));
    expect(meetingFetches).toEqual([expect.stringContaining("meeting_key=1300")]);
  });

  test("a past meeting is never fetched even when its race session is known", async () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    const pastMeeting: RawRecord[] = [
      { session_key: 20000, meeting_key: 1279, session_type: "Practice", date_start: "2026-08-01T10:00:00Z", date_end: "2026-08-01T11:00:00Z" },
      { session_key: 21000, meeting_key: 1279, session_type: "Race", session_name: "Race", date_start: "2026-08-03T13:00:00Z", date_end: "2026-08-03T15:00:00Z" },
    ];
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/sessions?")) return pastMeeting;
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });

    await lane.discoverOnce();
    // Keep discovering well past the 30-minute retry cadence: still never fetched.
    let laterNow = now;
    for (let i = 0; i < 3; i++) {
      laterNow += 40 * 60_000;
      const lane2 = new RestLane(queue, { fetcher, now: () => laterNow, onLog: () => {} });
      await lane2.discoverOnce();
    }

    expect(calls.some((u) => u.includes("meeting_key="))).toBe(false);
  });
});

describe("RestLane: pre-race refresh (issue #39)", () => {
  test("fires once, 5 minutes before date_start; a failed attempt is retried the very next tick", async () => {
    let now = START - 20 * 60_000; // well inside the live window, well before T-5min
    let refreshShouldFail = true;
    let refreshCallCount = 0;
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/sessions?")) return [SESSION];
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
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });

    await lane.discoverOnce(); // selects SESSION; the selection fetch is satisfied immediately
    queue.drain(1000);
    expect(refreshCallCount).toBe(1);

    // Not yet T-5min: normal rotation, no pre-race refresh.
    const early = await lane.pollOnce();
    expect(early?.endpoint).not.toBe("drivers");
    expect(refreshCallCount).toBe(1);

    // T-5min: the pre-race refresh is due; the fetch throws, so it's not marked done.
    now = START - 5 * 60_000;
    const failedAttempt = await lane.pollOnce();
    expect(failedAttempt?.endpoint).toBe("drivers");
    expect(refreshCallCount).toBe(2);

    // The very next tick, still inside the T-5min..T window: retried, and this time it succeeds.
    refreshShouldFail = false;
    const succeededAttempt = await lane.pollOnce();
    expect(succeededAttempt?.endpoint).toBe("drivers");
    expect(refreshCallCount).toBe(3);

    // A further tick in the same window: one-shot, not retried again.
    const settled = await lane.pollOnce();
    expect(settled?.endpoint).not.toBe("drivers");
    expect(refreshCallCount).toBe(3);
  });
});

describe("RestLane: drivers fetch budget (issue #39)", () => {
  test("a tick with a due drivers fetch makes no rotation request, and the rotation resumes at the same index next tick (nothing skipped)", async () => {
    let now = START;
    const driversResponse: unknown = []; // forces the static fallback + a 5-minute retry cadence
    let calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/sessions?")) return [SESSION];
      if (url.includes("/drivers?session_key=")) return driversResponse;
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => now, onLog: () => {} });

    await lane.discoverOnce();
    calls = [];

    const first = await lane.pollOnce();
    expect(first?.endpoint).toBe(POLL_ROTATION[0]);
    calls = [];

    now = START + 5 * 60_000; // the selection retry is now due
    const driversTick = await lane.pollOnce();
    expect(driversTick?.endpoint).toBe("drivers");
    expect(calls.every((u) => u.includes("/drivers?session_key="))).toBe(true);
    expect(calls.some((u) => u.includes(`/${POLL_ROTATION[1]}?`))).toBe(false);
    calls = [];

    const refresh = await lane.pollOnce(); // the live loop's sessions refresh (60 s cadence) is also due: its own tick
    expect(refresh?.endpoint).toBe("sessions");
    expect(calls.every((u) => u.includes("/sessions?"))).toBe(true);
    calls = [];

    const resumed = await lane.pollOnce(); // must resume at rotation index 1, not 2
    expect(resumed?.endpoint).toBe(POLL_ROTATION[1]);
  });

  test("a session discovered inside both its live window and its meeting's Friday window makes one drivers fetch in that tick; Friday waits for the next", async () => {
    const FP1: RawRecord = {
      session_key: 11360,
      meeting_key: 1293,
      session_type: "Practice",
      date_start: "2026-09-04T11:30:00Z",
      date_end: "2026-09-04T12:30:00Z",
    };
    const RACE: RawRecord = { ...SESSION, meeting_key: 1293, session_type: "Race" };
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url.includes("/sessions?")) return [FP1, RACE];
      if (url.includes("/drivers?")) {
        return [{ session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" }];
      }
      return [];
    };
    const queue = new EventQueue<QueueItem>();
    const lane = new RestLane(queue, { fetcher, now: () => START, onLog: () => {} }); // restart mid-race

    await lane.discoverOnce(); // RACE selected: selection fetch only
    expect(calls.filter((u) => u.includes("/drivers?"))).toEqual([expect.stringContaining("session_key=11361")]);

    const next = await lane.pollOnce(); // Friday's meeting-wide fetch takes the next tick
    expect(next?.endpoint).toBe("drivers");
    expect(calls.filter((u) => u.includes("meeting_key=1293"))).toHaveLength(1);
  });
});
