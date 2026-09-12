// Shared data builders for apps/api unit tests -- a full, valid `Session`
// row with sensible defaults, so a test only spells out the fields it
// varies.
import type { Session } from "@formula-time/db";

export function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionKey: 42n,
    name: "Test GP",
    country: "Testland",
    circuitKey: 1,
    dateStart: new Date("2026-09-06T13:00:00.000Z"),
    dateEnd: new Date("2026-09-06T15:00:00.000Z"),
    totalLaps: 50,
    status: "live",
    meetingName: null,
    circuitShortName: null,
    location: null,
    ...overrides,
  };
}
