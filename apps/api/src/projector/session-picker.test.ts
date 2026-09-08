import { describe, expect, test } from "vitest";

import { pickSession } from "./session-picker.js";

interface FakeSession {
  sessionKey: bigint;
  status: string;
  dateStart: Date;
}

function fakeDb(sessions: FakeSession[]) {
  return {
    session: {
      findFirst: async (args: {
        where?: { status: string };
        orderBy: { dateStart: "desc" };
      }) => {
        const pool = args.where ? sessions.filter((s) => s.status === args.where?.status) : sessions;
        const sorted = [...pool].sort((a, b) => b.dateStart.getTime() - a.dateStart.getTime());
        return sorted[0] ?? null;
      },
    },
  };
}

describe("pickSession", () => {
  test("prefers the live session with the latest dateStart", async () => {
    const sessions: FakeSession[] = [
      { sessionKey: 1n, status: "finished", dateStart: new Date("2026-09-05T00:00:00Z") },
      { sessionKey: 2n, status: "live", dateStart: new Date("2026-09-06T00:00:00Z") },
      { sessionKey: 3n, status: "upcoming", dateStart: new Date("2026-09-07T00:00:00Z") },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb(sessions) as any);
    expect(session?.sessionKey).toBe(2n);
  });

  test("falls back to the greatest dateStart when nothing is live", async () => {
    const sessions: FakeSession[] = [
      { sessionKey: 1n, status: "finished", dateStart: new Date("2026-09-05T00:00:00Z") },
      { sessionKey: 2n, status: "upcoming", dateStart: new Date("2026-09-07T00:00:00Z") },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb(sessions) as any);
    expect(session?.sessionKey).toBe(2n);
  });

  test("returns null when the table is empty", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await pickSession(fakeDb([]) as any);
    expect(session).toBeNull();
  });
});
