import { describe, expect, test } from "vitest";

import { fakePrisma } from "../test/fake-prisma.js";
import { fakeSession } from "../test/fixtures.js";
import { pickSession } from "./session-picker.js";

const NOW = new Date("2026-09-09T12:00:00Z");
const now = () => NOW.getTime();

describe("pickSession", () => {
  test("prefers the live session with the latest dateStart", async () => {
    const db = fakePrisma([
      fakeSession({ sessionKey: 1n, status: "finished", dateStart: new Date("2026-09-05T00:00:00Z"), dateEnd: new Date("2026-09-05T02:00:00Z") }),
      fakeSession({ sessionKey: 2n, status: "live", dateStart: new Date("2026-09-06T00:00:00Z"), dateEnd: new Date("2026-09-06T02:00:00Z") }),
      fakeSession({ sessionKey: 3n, status: "upcoming", dateStart: new Date("2026-09-11T09:30:00Z"), dateEnd: new Date("2026-09-11T10:30:00Z") }),
    ]);
    const session = await pickSession(db, now);
    expect(session?.sessionKey).toBe(2n);
  });

  test("picks the nearest upcoming session on a calendar of finished and upcoming rows", async () => {
    const db = fakePrisma([
      fakeSession({ sessionKey: 1n, status: "finished", dateStart: new Date("2026-08-30T00:00:00Z"), dateEnd: new Date("2026-08-30T02:00:00Z") }),
      fakeSession({ sessionKey: 2n, status: "finished", dateStart: new Date("2026-09-06T00:00:00Z"), dateEnd: new Date("2026-09-06T02:00:00Z") }),
      // Next upcoming: Spain Practice 1.
      fakeSession({ sessionKey: 3n, status: "upcoming", dateStart: new Date("2026-09-11T09:30:00Z"), dateEnd: new Date("2026-09-11T10:30:00Z") }),
      fakeSession({ sessionKey: 4n, status: "upcoming", dateStart: new Date("2026-09-13T13:00:00Z"), dateEnd: new Date("2026-09-13T15:00:00Z") }),
      // Far-future Abu Dhabi race that used to win the naive "greatest dateStart" fallback.
      fakeSession({ sessionKey: 5n, status: "upcoming", dateStart: new Date("2026-12-06T13:00:00Z"), dateEnd: new Date("2026-12-06T15:00:00Z") }),
    ]);
    const session = await pickSession(db, now);
    expect(session?.sessionKey).toBe(3n);
  });

  test("skips an upcoming row whose window has already closed (stale status)", async () => {
    const db = fakePrisma([
      // Status still says "upcoming" but dateEnd + 30min is already in the past.
      fakeSession({ sessionKey: 1n, status: "upcoming", dateStart: new Date("2026-09-09T09:00:00Z"), dateEnd: new Date("2026-09-09T10:00:00Z") }),
      fakeSession({ sessionKey: 2n, status: "upcoming", dateStart: new Date("2026-09-11T09:30:00Z"), dateEnd: new Date("2026-09-11T10:30:00Z") }),
    ]);
    const session = await pickSession(db, now);
    expect(session?.sessionKey).toBe(2n);
  });

  test("falls back to the most recent finished session when nothing is live or upcoming", async () => {
    const db = fakePrisma([
      fakeSession({ sessionKey: 1n, status: "finished", dateStart: new Date("2026-09-05T00:00:00Z"), dateEnd: new Date("2026-09-05T02:00:00Z") }),
      fakeSession({ sessionKey: 2n, status: "finished", dateStart: new Date("2026-09-07T00:00:00Z"), dateEnd: new Date("2026-09-07T02:00:00Z") }),
    ]);
    const session = await pickSession(db, now);
    expect(session?.sessionKey).toBe(2n);
  });

  test("returns null when the table is empty", async () => {
    const session = await pickSession(fakePrisma([]), now);
    expect(session).toBeNull();
  });
});
