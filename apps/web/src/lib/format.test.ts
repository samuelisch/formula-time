import { describe, expect, it } from "vitest";

import {
  clock,
  duration,
  excludeSession,
  gapText,
  lapTime,
  number,
  pitStopText,
  raceSubtitle,
  raceTitle,
  raceTitleDisambiguated,
  text,
} from "./format.ts";
import type { RaceIndexEntry } from "../races/api.ts";

function makeRace(overrides: Partial<RaceIndexEntry> = {}): RaceIndexEntry {
  return {
    session_key: 1,
    name: "Race",
    country: "Italy",
    date_start: "2026-09-06T13:00:00.000Z",
    date_end: "2026-09-06T15:00:00.000Z",
    total_laps: 53,
    exported_at: "2026-09-06T15:10:00.000Z",
    meeting_name: null,
    circuit_short_name: null,
    location: null,
    ...overrides,
  };
}

describe("text", () => {
  it("falls back on null, undefined, and empty string", () => {
    expect(text(null)).toBe("—");
    expect(text(undefined)).toBe("—");
    expect(text("")).toBe("—");
  });

  it("stringifies a present value", () => {
    expect(text("VER")).toBe("VER");
    expect(text(5)).toBe("5");
    expect(text(0)).toBe("0");
  });

  it("accepts a custom fallback", () => {
    expect(text(null, "n/a")).toBe("n/a");
  });
});

describe("number", () => {
  it("falls back to em dash on null, undefined, and non-numeric values", () => {
    expect(number(null)).toBe("—");
    expect(number(undefined)).toBe("—");
    expect(number("3.2")).toBe("—");
  });

  it("formats to the requested digits, defaulting to 1", () => {
    expect(number(1.2345)).toBe("1.2");
    expect(number(1.2367, 3)).toBe("1.237");
    expect(number(1, 0)).toBe("1");
  });
});

describe("lapTime", () => {
  it("falls back to em dash on null, undefined, and non-numeric values", () => {
    expect(lapTime(null)).toBe("—");
    expect(lapTime(undefined)).toBe("—");
    expect(lapTime("31.234")).toBe("—");
  });

  it("formats a sub-minute value as seconds to 3 decimals, like number(value, 3)", () => {
    expect(lapTime(31.2)).toBe("31.200");
    expect(lapTime(9.567)).toBe("9.567");
  });

  it("formats a value at or above 60s as m:ss.SSS, zero-padding the seconds", () => {
    expect(lapTime(91.234)).toBe("1:31.234");
    expect(lapTime(61.005)).toBe("1:01.005");
    expect(lapTime(60)).toBe("1:00.000");
    expect(lapTime(125.5)).toBe("2:05.500");
  });
});

describe("gapText", () => {
  it("renders the em dash for a null gap", () => {
    expect(gapText(null)).toBe("—");
  });

  it("renders a lapped string gap as-is", () => {
    expect(gapText("+1 LAP")).toBe("+1 LAP");
    expect(gapText("+2 LAPS")).toBe("+2 LAPS");
  });

  it("formats a numeric gap to 3 decimals with an s suffix", () => {
    expect(gapText(4.338)).toBe("4.338s");
  });
});

describe("duration", () => {
  it("renders the em dash for anything not a number", () => {
    expect(duration(null)).toBe("—");
    expect(duration(undefined)).toBe("—");
    expect(duration("24.9")).toBe("—");
  });

  it("formats a sub-minute value as SS.S with no unit", () => {
    expect(duration(24.9)).toBe("24.9s");
  });

  it("formats a value at or above 60s as M:SS.S with no unit suffix", () => {
    expect(duration(1840.7)).toBe("30:40.7");
    expect(duration(60)).toBe("1:00.0");
  });
});

describe("pitStopText", () => {
  it("renders the em dash for no pit stop", () => {
    expect(pitStopText(null)).toBe("—");
  });

  it("formats lap and duration from a pit-stop record", () => {
    expect(pitStopText({ lap_number: 7, pit_duration: 2.4 })).toBe("L7 · 2.4s");
  });

  it("formats a pit duration over a minute as m:ss.s", () => {
    expect(pitStopText({ lap_number: 3, pit_duration: 1840.7 })).toBe("L3 · 30:40.7");
  });
});

describe("clock", () => {
  it("falls back on null, undefined, and an unparseable string", () => {
    expect(clock(null)).toBe("—");
    expect(clock(undefined)).toBe("—");
    expect(clock("not-a-date")).toBe("—");
  });

  it("renders HH:MM:SS UTC from an ISO source time", () => {
    expect(clock("2026-09-08T13:05:07.000Z")).toBe("13:05:07 UTC");
  });
});

describe("raceTitle", () => {
  it("uses meeting_name when present", () => {
    expect(raceTitle({ meeting_name: "Spanish Grand Prix", country: "Spain", name: "Race" })).toBe("Spanish Grand Prix");
  });

  it("falls back to country · name when meeting_name is absent", () => {
    expect(raceTitle({ country: "Italy", name: "Race" })).toBe("Italy · Race");
  });

  it("falls back to country · name when meeting_name is null", () => {
    expect(raceTitle({ meeting_name: null, country: "Italy", name: "Race" })).toBe("Italy · Race");
  });

  it("renders the em dash for a missing country or name in the fallback", () => {
    expect(raceTitle({ name: "Race" })).toBe("— · Race");
    expect(raceTitle({ country: "Italy" })).toBe("Italy · —");
  });
});

describe("raceSubtitle", () => {
  it("joins circuit_short_name, location, and the formatted date, dropping missing parts", () => {
    expect(
      raceSubtitle({
        circuit_short_name: "Barcelona-Catalunya",
        location: "Montmeló",
        date_start: "2026-06-14T13:00:00.000Z",
      }),
    ).toBe("Barcelona-Catalunya · Montmeló · 2026-06-14");
  });

  it("drops a missing circuit_short_name", () => {
    expect(raceSubtitle({ location: "Montmeló", date_start: "2026-06-14T13:00:00.000Z" })).toBe("Montmeló · 2026-06-14");
  });

  it("drops a missing location", () => {
    expect(raceSubtitle({ circuit_short_name: "Barcelona-Catalunya", date_start: "2026-06-14T13:00:00.000Z" })).toBe(
      "Barcelona-Catalunya · 2026-06-14",
    );
  });

  it("renders just the date when circuit_short_name and location are both absent", () => {
    expect(raceSubtitle({ date_start: "2026-06-14T13:00:00.000Z" })).toBe("2026-06-14");
  });

  it("drops the date when date_start is missing", () => {
    expect(raceSubtitle({ circuit_short_name: "Barcelona-Catalunya" })).toBe("Barcelona-Catalunya");
  });

  it("drops the date when date_start is unparseable, rather than leaking date()'s em dash", () => {
    expect(raceSubtitle({ circuit_short_name: "Barcelona-Catalunya", date_start: "not-a-date" })).toBe("Barcelona-Catalunya");
  });
});

describe("raceTitleDisambiguated", () => {
  it("returns the plain title when no other race in the list shares it", () => {
    const races = [makeRace({ session_key: 1, meeting_name: "Spanish Grand Prix", date_start: "2026-06-14T13:00:00.000Z" })];
    expect(raceTitleDisambiguated({ meeting_name: "Italian Grand Prix", country: "Italy", name: "Race" }, races)).toBe(
      "Italian Grand Prix",
    );
  });

  it("appends the session's own year when another race in the list shares the title", () => {
    const races = [makeRace({ session_key: 1, meeting_name: "Spanish Grand Prix", date_start: "2025-06-01T13:00:00.000Z" })];
    expect(
      raceTitleDisambiguated({ meeting_name: "Spanish Grand Prix", date_start: "2026-06-14T13:00:00.000Z" }, races),
    ).toBe("Spanish Grand Prix (2026)");
  });

  it("falls back to the plain title when the session has no date_start to disambiguate with", () => {
    const races = [makeRace({ session_key: 1, meeting_name: "Spanish Grand Prix" })];
    expect(raceTitleDisambiguated({ meeting_name: "Spanish Grand Prix" }, races)).toBe("Spanish Grand Prix");
  });

  it("falls back to the plain title when a colliding session's date_start is unparseable, rather than rendering (NaN)", () => {
    const races = [makeRace({ session_key: 1, meeting_name: "Spanish Grand Prix", date_start: "2025-06-01T13:00:00.000Z" })];
    expect(raceTitleDisambiguated({ meeting_name: "Spanish Grand Prix", date_start: "not-a-date" }, races)).toBe(
      "Spanish Grand Prix",
    );
  });
});

describe("excludeSession", () => {
  it("drops the race whose session_key matches, leaving the rest", () => {
    const races = [makeRace({ session_key: 1 }), makeRace({ session_key: 2 }), makeRace({ session_key: 3 })];
    expect(excludeSession(races, 2).map((race) => race.session_key)).toEqual([1, 3]);
  });

  it("matches a string session_key against the numeric field", () => {
    const races = [makeRace({ session_key: 1 }), makeRace({ session_key: 2 })];
    expect(excludeSession(races, "2").map((race) => race.session_key)).toEqual([1]);
  });

  it("leaves the list unchanged when no race matches", () => {
    const races = [makeRace({ session_key: 1 }), makeRace({ session_key: 2 })];
    expect(excludeSession(races, 999)).toEqual(races);
  });
});
