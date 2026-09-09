import { describe, expect, it } from "vitest";

import { clock, lapTime, number, pitStopText, text } from "./format.ts";

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

describe("pitStopText", () => {
  it("renders the em dash for no pit stop", () => {
    expect(pitStopText(null)).toBe("—");
  });

  it("formats lap and duration from a pit-stop record", () => {
    expect(pitStopText({ lap_number: 7, pit_duration: 2.4 })).toBe("L7 · 2.4s");
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
