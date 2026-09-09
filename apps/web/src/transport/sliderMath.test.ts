import { describe, expect, it } from "vitest";

import { currentLap, snapTarget, type TickMark } from "./sliderMath.ts";

const TICKS: TickMark[] = [
  { lap: 1, value: 0 },
  { lap: 2, value: 30_000 },
  { lap: 3, value: 60_000 },
  { lap: 4, value: 90_000 },
  { lap: 5, value: 100_000 },
];

describe("snapTarget", () => {
  const min = 0;
  const max = 100_000; // 1.5% of the range is 1_500ms

  it("snaps to the nearest tick within the threshold", () => {
    expect(snapTarget(29_000, TICKS, min, max)).toEqual({ lap: 2, value: 30_000 }); // 1000ms away, within 1500
    expect(snapTarget(31_400, TICKS, min, max)).toEqual({ lap: 2, value: 30_000 }); // 1400ms away
  });

  it("does not snap when the nearest tick is outside the threshold", () => {
    expect(snapTarget(27_000, TICKS, min, max)).toBeNull(); // 3000ms from lap 2's tick
    expect(snapTarget(45_000, TICKS, min, max)).toBeNull(); // between lap 2 and 3, far from both
  });

  it("snaps exactly at the threshold boundary", () => {
    expect(snapTarget(31_500, TICKS, min, max)).toEqual({ lap: 2, value: 30_000 }); // exactly 1500ms
    expect(snapTarget(31_501, TICKS, min, max)).toBeNull();
  });

  it("returns null when there are no ticks or a degenerate range", () => {
    expect(snapTarget(5_000, [], min, max)).toBeNull();
    expect(snapTarget(5_000, TICKS, 10, 10)).toBeNull();
  });
});

describe("currentLap", () => {
  it("is the latest tick at or before the value", () => {
    expect(currentLap(0, TICKS)).toBe(1);
    expect(currentLap(45_000, TICKS)).toBe(2);
    expect(currentLap(100_000, TICKS)).toBe(5);
  });

  it("is null before the first tick", () => {
    expect(currentLap(-1, TICKS)).toBeNull();
    expect(currentLap(10_000, [{ lap: 3, value: 20_000 }])).toBeNull();
  });
});
