import { describe, expect, it } from "vitest";

import { clock, number, text } from "./format.ts";

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
