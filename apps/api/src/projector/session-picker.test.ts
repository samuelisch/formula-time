import { describe, expect, test } from "vitest";

import { pickSession } from "./session-picker.js";

interface FakeSession {
  sessionKey: bigint;
  status: string;
  dateStart: Date;
  dateEnd: Date;
}

function fakeDb(sessions: FakeSession[]) {
  return {
    session: {
      findFirst: async (args: {
        where?: { status: string; dateEnd?: { gte: Date } };
        orderBy: { dateStart: "desc" | "asc" };
      }) => {
        let pool = sessions;
        if (args.where?.status !== undefined) {
          pool = pool.filter((s) => s.status === args.where?.status);
        }
        if (args.where?.dateEnd !== undefined) {
          const cutoff = args.where.dateEnd.gte;
          pool = pool.filter((s) => s.dateEnd.getTime() >= cutoff.getTime());
        }
        const sorted = [...pool].sort((a, b) =>
          args.orderBy.dateStart === "desc"
            ? b.dateStart.getTime() - a.dateStart.getTime()
            : a.dateStart.getTime() - b.dateStart.getTime(),
        );
        return sorted[0] ?? null;
      },
    },
  };
}

const NOW = new Date("2026-09-09T12:00:00Z");
const now = () => NOW.getTime();

describe("pickSession", () => {
  test("prefers the live session with the latest dateStart", async () => {
    const sessions: FakeSession[] = [
      { sessionKey: 1n, status: "finished", dateStart: new Date("2026-09-05T00:00:00Z"), dateEnd: new Date("2026-09-05T02:00:00Z") },
      { sessionKey: 2n, status: "live", dateStart: new Date("2026-09-06T00:00:00Z"), dateEnd: new Date("2026-09-06T02:00:00Z") },
      { sessionKey: 3n, status: "upcoming", dateStart: new Date("2026-09-11T09:30:00Z"), dateEnd: new Date("2026-09-11T10:30:00Z") },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb(sessions) as any, now);
    expect(session?.sessionKey).toBe(2n);
  });

  test("picks the nearest upcoming session on a calendar of finished and upcoming rows", async () => {
    const sessions: FakeSession[] = [
      { sessionKey: 1n, status: "finished", dateStart: new Date("2026-08-30T00:00:00Z"), dateEnd: new Date("2026-08-30T02:00:00Z") },
      { sessionKey: 2n, status: "finished", dateStart: new Date("2026-09-06T00:00:00Z"), dateEnd: new Date("2026-09-06T02:00:00Z") },
      // Next upcoming: Spain Practice 1.
      { sessionKey: 3n, status: "upcoming", dateStart: new Date("2026-09-11T09:30:00Z"), dateEnd: new Date("2026-09-11T10:30:00Z") },
      { sessionKey: 4n, status: "upcoming", dateStart: new Date("2026-09-13T13:00:00Z"), dateEnd: new Date("2026-09-13T15:00:00Z") },
      // Far-future Abu Dhabi race that used to win the naive "greatest dateStart" fallback.
      { sessionKey: 5n, status: "upcoming", dateStart: new Date("2026-12-06T13:00:00Z"), dateEnd: new Date("2026-12-06T15:00:00Z") },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb(sessions) as any, now);
    expect(session?.sessionKey).toBe(3n);
  });

  test("skips an upcoming row whose window has already closed (stale status)", async () => {
    const sessions: FakeSession[] = [
      // Status still says "upcoming" but dateEnd + 30min is already in the past.
      { sessionKey: 1n, status: "upcoming", dateStart: new Date("2026-09-09T09:00:00Z"), dateEnd: new Date("2026-09-09T10:00:00Z") },
      { sessionKey: 2n, status: "upcoming", dateStart: new Date("2026-09-11T09:30:00Z"), dateEnd: new Date("2026-09-11T10:30:00Z") },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb(sessions) as any, now);
    expect(session?.sessionKey).toBe(2n);
  });

  test("falls back to the most recent finished session when nothing is live or upcoming", async () => {
    const sessions: FakeSession[] = [
      { sessionKey: 1n, status: "finished", dateStart: new Date("2026-09-05T00:00:00Z"), dateEnd: new Date("2026-09-05T02:00:00Z") },
      { sessionKey: 2n, status: "finished", dateStart: new Date("2026-09-07T00:00:00Z"), dateEnd: new Date("2026-09-07T02:00:00Z") },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb(sessions) as any, now);
    expect(session?.sessionKey).toBe(2n);
  });

  test("returns null when the table is empty", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb([]) as any, now);
    expect(session).toBeNull();
  });
});
