import { describe, expect, test, vi } from "vitest";

import { SessionDiscovery } from "./discovery.js";
import type { CountStat } from "./discovery.js";
import type { RawRecord } from "./types.js";

const START = Date.parse("2026-09-06T13:00:00Z");
const WINDOW = 30 * 60 * 1000;

const SESSION: RawRecord = {
  session_key: 11361,
  session_name: "Race",
  circuit_key: 39,
  country_name: "Italy",
  date_start: "2026-09-06T13:00:00+00:00",
  date_end: "2026-09-06T15:00:00+00:00",
};

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

function makeDiscovery(
  fetcher: (url: string) => Promise<unknown>,
  opts: {
    onSession?: (session: RawRecord, nowMs: number, meetingNames: ReadonlyMap<number, string>) => void | Promise<void>;
    onRecorded?: (sessionKey: number, endpoint: string, rows: RawRecord[]) => Promise<void>;
    countStat?: CountStat;
    log?: (message: string) => void;
    intervalMs?: number;
  } = {},
): SessionDiscovery {
  return new SessionDiscovery({
    fetcher,
    year: 2026,
    intervalMs: opts.intervalMs ?? 60_000,
    onSession: opts.onSession,
    onRecorded: opts.onRecorded ?? (async (): Promise<void> => {}),
    countStat: opts.countStat ?? ((): void => {}),
    log: opts.log ?? ((): void => {}),
  });
}

describe("SessionDiscovery.refreshSessions", () => {
  test("upserts every discovered race session, even before any is live", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION] });
    const onSession = vi.fn();
    const discovery = makeDiscovery(fetcher, { onSession });

    const result = await discovery.refreshSessions(START - 2 * WINDOW);

    expect(onSession).toHaveBeenCalledWith(SESSION, START - 2 * WINDOW, expect.any(Map));
    expect(result?.upserted.has(SESSION)).toBe(true);
    expect(discovery.sessions()).toEqual([SESSION]);
    expect(discovery.isKnownSession(11361)).toBe(true);
  });

  test("a sessions?year= response with Practice 1, Qualifying, Sprint, Race rows upserts only the Race row; only that key is known", async () => {
    const PRACTICE_1: RawRecord = {
      session_key: 40001,
      meeting_key: 1400,
      session_type: "Practice",
      session_name: "Practice 1",
      date_start: "2026-09-06T13:00:00Z",
      date_end: "2026-09-06T14:00:00Z",
    };
    const QUALIFYING: RawRecord = {
      session_key: 40002,
      meeting_key: 1400,
      session_type: "Qualifying",
      session_name: "Qualifying",
      date_start: "2026-09-06T15:00:00Z",
      date_end: "2026-09-06T16:00:00Z",
    };
    const SPRINT: RawRecord = {
      session_key: 40003,
      meeting_key: 1400,
      session_type: "Race", // OpenF1 gives a sprint session_type "Race"...
      session_name: "Sprint", // ...but session_name "Sprint" — the filter is on session_name.
      date_start: "2026-09-06T17:00:00Z",
      date_end: "2026-09-06T18:00:00Z",
    };
    const RACE_ROW: RawRecord = {
      session_key: 40004,
      meeting_key: 1400,
      session_type: "Race",
      session_name: "Race",
      date_start: "2026-09-06T19:00:00Z",
      date_end: "2026-09-06T21:00:00Z",
    };
    const { fetcher } = fakeFetcher({ sessions: [PRACTICE_1, QUALIFYING, SPRINT, RACE_ROW] });
    const onSession = vi.fn();
    const discovery = makeDiscovery(fetcher, { onSession });

    const result = await discovery.refreshSessions(Date.parse("2026-09-05T00:00:00Z"));

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(RACE_ROW, expect.any(Number), expect.any(Map));
    expect(discovery.isKnownSession(40004)).toBe(true);
    for (const key of [40001, 40002, 40003]) expect(discovery.isKnownSession(key)).toBe(false);
    // The snapshot still holds every fetched row, race or not: the Friday
    // entry-list check groups a meeting's sessions from it.
    expect(result?.rows).toHaveLength(4);
  });

  test("a failed sessions fetch returns null, logs at error level, and keeps the previous snapshot", async () => {
    let shouldFail = false;
    const fetcher = async (url: string): Promise<unknown> => {
      if (url.includes("/sessions?")) {
        if (shouldFail) throw new Error("network error");
        return [SESSION];
      }
      return [];
    };
    const logs: Array<{ message: string; level: string | undefined }> = [];
    const countStat = vi.fn();
    const discovery = makeDiscovery(fetcher, {
      countStat,
      log: (message: string, opts?: { level?: string }): void => {
        logs.push({ message, level: opts?.level });
      },
    });

    await discovery.refreshSessions(START);
    shouldFail = true;

    expect(await discovery.refreshSessions(START + 60_000)).toBeNull();
    expect(discovery.sessions()).toEqual([SESSION]);
    expect(logs.some((l) => l.level === "error" && l.message.startsWith("rest: session discovery failed"))).toBe(true);
    expect(countStat).toHaveBeenCalledWith("errors");
  });

  test("a row whose upsert throws is skipped and logged; the rest of the snapshot still upserts", async () => {
    const bad: RawRecord = { session_key: "not-a-number", session_name: "Race", date_start: "nope", date_end: "nope" };
    const { fetcher } = fakeFetcher({ sessions: [bad, SESSION] });
    const onSession = vi.fn(async (row: RawRecord) => {
      if (row === bad) throw new Error("upsertSession: session_key is not a valid integer");
    });
    const logs: string[] = [];
    const discovery = makeDiscovery(fetcher, { onSession, log: (message: string) => logs.push(message) });

    const result = await discovery.refreshSessions(START);

    expect(onSession).toHaveBeenCalledTimes(2);
    expect(result?.upserted.has(bad)).toBe(false);
    expect(result?.upserted.has(SESSION)).toBe(true);
    expect(logs.some((l) => l.startsWith("rest: session row skipped"))).toBe(true);
  });

  test("counts its two fetches as polls, so they land in the lane's one takeStats()", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION] });
    const countStat = vi.fn();
    const discovery = makeDiscovery(fetcher, { countStat });

    await discovery.refreshSessions(START);

    expect(countStat.mock.calls.filter((c) => c[0] === "polls")).toHaveLength(2);
  });
});

describe("SessionDiscovery meeting names", () => {
  test("fetches meetings?year= once per tick and passes the resulting map to onSession", async () => {
    const meetings = [{ meeting_key: 1293, meeting_name: "Italian Grand Prix" }];
    const { fetcher, calls } = fakeFetcher({ sessions: [SESSION], meetings });
    const onSession = vi.fn();
    const discovery = makeDiscovery(fetcher, { onSession });

    await discovery.refreshSessions(START - 2 * WINDOW);

    expect(calls.filter((u) => u.includes("/meetings?"))).toHaveLength(1);
    expect(onSession).toHaveBeenCalledWith(SESSION, START - 2 * WINDOW, new Map([[1293, "Italian Grand Prix"]]));
    expect(discovery.meetingNames()).toEqual(new Map([[1293, "Italian Grand Prix"]]));
  });

  test("a meetings fetch failure keeps the previous tick's map instead of clearing it", async () => {
    let shouldFail = false;
    const meetings = [{ meeting_key: 1293, meeting_name: "Italian Grand Prix" }];
    const fetcher = async (url: string): Promise<unknown> => {
      const parsed = new URL(url);
      const endpoint = parsed.pathname.split("/").at(-1) ?? "";
      if (endpoint === "meetings") {
        if (shouldFail) throw new Error("network error");
        return meetings;
      }
      if (endpoint === "sessions") return [SESSION];
      return [];
    };
    const onSession = vi.fn();
    const discovery = makeDiscovery(fetcher, { onSession });

    await discovery.refreshSessions(START - 2 * WINDOW);
    expect(onSession).toHaveBeenNthCalledWith(1, SESSION, START - 2 * WINDOW, new Map([[1293, "Italian Grand Prix"]]));

    shouldFail = true;
    await discovery.refreshSessions(START - 2 * WINDOW);
    expect(onSession).toHaveBeenNthCalledWith(2, SESSION, START - 2 * WINDOW, new Map([[1293, "Italian Grand Prix"]]));
  });
});

describe("SessionDiscovery.recordFollowedMeetingRow", () => {
  const followedSession: RawRecord = { ...SESSION, meeting_key: 1293 };

  test("fires once for endpoint 'meetings' with the followed session's own row, matched by meeting_key", async () => {
    const meetings = [
      { meeting_key: 1400, meeting_name: "Wrong Meeting" }, // a different meeting_key: must not be picked
      { meeting_key: 1293, meeting_name: "Italian Grand Prix" },
    ];
    const { fetcher } = fakeFetcher({ sessions: [followedSession], meetings });
    const onRecorded = vi.fn(async () => {});
    const discovery = makeDiscovery(fetcher, { onRecorded });

    await discovery.refreshSessions(START);
    await discovery.recordFollowedMeetingRow(followedSession, 11361);

    const meetingCalls = onRecorded.mock.calls.filter((c) => c[1] === "meetings");
    expect(meetingCalls).toHaveLength(1);
    expect(meetingCalls[0]).toEqual([11361, "meetings", [{ meeting_key: 1293, meeting_name: "Italian Grand Prix" }]]);

    // A later tick must not fire it again for the same session_key.
    await discovery.refreshSessions(START + 60_000);
    await discovery.recordFollowedMeetingRow(followedSession, 11361);
    expect(onRecorded.mock.calls.filter((c) => c[1] === "meetings")).toHaveLength(1);
  });

  test("records nothing when no meetings row matches the followed session's meeting_key", async () => {
    const meetings = [{ meeting_key: 1400, meeting_name: "Wrong Meeting" }];
    const { fetcher } = fakeFetcher({ sessions: [followedSession], meetings });
    const onRecorded = vi.fn(async () => {});
    const discovery = makeDiscovery(fetcher, { onRecorded });

    await discovery.refreshSessions(START);
    await discovery.recordFollowedMeetingRow(followedSession, 11361);

    expect(onRecorded.mock.calls.filter((c) => c[1] === "meetings")).toHaveLength(0);
  });

  test("records nothing while no session is followed", async () => {
    const meetings = [{ meeting_key: 1293, meeting_name: "Italian Grand Prix" }];
    const { fetcher } = fakeFetcher({ sessions: [followedSession], meetings });
    const onRecorded = vi.fn(async () => {});
    const discovery = makeDiscovery(fetcher, { onRecorded });

    await discovery.refreshSessions(START);
    await discovery.recordFollowedMeetingRow(null, null);

    expect(onRecorded).not.toHaveBeenCalled();
  });
});

describe("SessionDiscovery.sessionsRefreshDue", () => {
  test("due until the first refresh, then only once the interval has passed", async () => {
    const { fetcher } = fakeFetcher({ sessions: [SESSION] });
    const discovery = makeDiscovery(fetcher, { intervalMs: 60_000 });

    expect(discovery.sessionsRefreshDue(START)).toBe(true);

    await discovery.refreshSessions(START);

    expect(discovery.sessionsRefreshDue(START + 59_999)).toBe(false);
    expect(discovery.sessionsRefreshDue(START + 60_000)).toBe(true);
  });
});
