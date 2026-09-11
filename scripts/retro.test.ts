import { describe, expect, it } from "vitest";
import { inPeriod } from "./retro.mjs";

describe("inPeriod", () => {
  it("includes a PR merged at the start of the period", () => {
    expect(inPeriod("2026-09-09T00:00:01Z", "2026-09-09")).toBe(true);
  });

  it("excludes a PR merged before the period starts", () => {
    expect(inPeriod("2026-09-08T23:59:59Z", "2026-09-09")).toBe(false);
  });

  it("includes a PR merged up to the end of the end date, in UTC", () => {
    expect(inPeriod("2026-09-10T23:59:59Z", "2026-09-09", "2026-09-10")).toBe(true);
  });

  it("excludes a PR merged the day after the end date", () => {
    expect(inPeriod("2026-09-11T00:00:00Z", "2026-09-09", "2026-09-10")).toBe(false);
  });
});
