import { describe, expect, it } from "vitest";

import { sessionToWire, type SessionLike } from "./wire.js";

function base(): SessionLike {
  return {
    sessionKey: 11361,
    name: "Race",
    country: "Italy",
    circuitKey: 39,
    dateStart: new Date("2026-09-06T13:00:00.000Z"),
    dateEnd: new Date("2026-09-06T15:00:00.000Z"),
    totalLaps: 53,
    status: "finished",
    meetingName: "Italian Grand Prix",
    circuitShortName: "Monza",
    location: "Monza",
  };
}

describe("sessionToWire", () => {
  it("stringifies a bigint, a numeric, and a string session key to the same string", () => {
    const bigintWire = sessionToWire({ ...base(), sessionKey: 11361n });
    const numberWire = sessionToWire({ ...base(), sessionKey: 11361 });
    const stringWire = sessionToWire({ ...base(), sessionKey: "11361" });

    expect(bigintWire.session_key).toBe("11361");
    expect(numberWire.session_key).toBe("11361");
    expect(stringWire.session_key).toBe("11361");
  });

  it("gives the same date_start/date_end whether given as Date or as an ISO string", () => {
    const iso = "2026-09-06T13:00:00.000Z";
    const fromDate = sessionToWire({ ...base(), dateStart: new Date(iso) });
    const fromString = sessionToWire({ ...base(), dateStart: iso });

    expect(fromDate.date_start).toBe(iso);
    expect(fromString.date_start).toBe(iso);
  });

  it("passes null fields through unchanged", () => {
    const wire = sessionToWire({
      ...base(),
      totalLaps: null,
      meetingName: null,
      circuitShortName: null,
      location: null,
    });

    expect(wire.total_laps).toBeNull();
    expect(wire.meeting_name).toBeNull();
    expect(wire.circuit_short_name).toBeNull();
    expect(wire.location).toBeNull();
  });

  it("carries every other field straight through, renamed to its wire key", () => {
    const wire = sessionToWire(base());

    expect(wire).toEqual({
      session_key: "11361",
      name: "Race",
      country: "Italy",
      circuit_key: 39,
      date_start: "2026-09-06T13:00:00.000Z",
      date_end: "2026-09-06T15:00:00.000Z",
      total_laps: 53,
      status: "finished",
      meeting_name: "Italian Grand Prix",
      circuit_short_name: "Monza",
      location: "Monza",
    });
  });
});
