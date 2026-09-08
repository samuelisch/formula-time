import { describe, expect, test, vi } from "vitest";

import type { QueueItem, RawRecord } from "./types.js";
import { POLL_ROTATION, RestLane, buildPollUrl, pickLiveSession, sessionExpired } from "./rest-lane.js";
import { EventQueue } from "../writer/queue.js";

const START = Date.parse("2026-09-06T13:00:00Z");
const END = Date.parse("2026-09-06T15:00:00Z");
const WINDOW = 30 * 60 * 1000;

const SESSION: RawRecord = {
  session_key: 11361,
  meeting_key: 1293,
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
      date_start: "2026-09-13T13:00:00Z",
      date_end: "2026-09-13T15:00:00Z",
    };
    const finished: RawRecord = {
      session_key: 11349,
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
    const bad: RawRecord = { session_key: "not-a-number", date_start: "nope", date_end: "nope" };
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
