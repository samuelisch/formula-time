import { describe, expect, it } from "vitest";

import { FORMATION_WINDOW_MS, replayStartMs } from "./replayStart.ts";

const MIN = 60_000;

function at(hh: number, mm: number, ss = 0): number {
  return Date.parse(`2026-09-06T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`);
}

describe("replayStartMs", () => {
  it("(a) on time: starts at date_start", () => {
    const result = replayStartMs({
      firstSourceMs: at(12, 6),
      lastSourceMs: at(15, 0),
      dateStartMs: at(13, 0),
      lightsOutMs: at(13, 4),
    });
    expect(result).toBe(at(13, 0));
  });

  it("(b) delayed 30 min: starts FORMATION_WINDOW_MS before the measured lights-out", () => {
    const result = replayStartMs({
      firstSourceMs: at(12, 6),
      lastSourceMs: at(15, 30),
      dateStartMs: at(13, 0),
      lightsOutMs: at(13, 34),
    });
    expect(result).toBe(at(13, 34) - FORMATION_WINDOW_MS);
    expect(result).toBe(at(13, 29));
  });

  it("(c) no lights-out anchor: starts at date_start", () => {
    const result = replayStartMs({
      firstSourceMs: at(12, 6),
      lastSourceMs: at(14, 0),
      dateStartMs: at(13, 0),
      lightsOutMs: null,
    });
    expect(result).toBe(at(13, 0));
  });

  it("(d) fetched race whose data begins after date_start: clamps up to the first event", () => {
    const result = replayStartMs({
      firstSourceMs: at(13, 3, 30),
      lastSourceMs: at(15, 0),
      dateStartMs: at(13, 0),
      lightsOutMs: at(13, 3, 30),
    });
    expect(result).toBe(at(13, 3, 30));
  });

  it("(e) date_start after lights out (a bad row): clamps down to lights out", () => {
    const result = replayStartMs({
      firstSourceMs: at(12, 6),
      lastSourceMs: at(15, 0),
      dateStartMs: at(14, 0),
      lightsOutMs: at(13, 4),
    });
    expect(result).toBe(at(13, 4));
  });

  it("(f) no first event: nothing to play", () => {
    const result = replayStartMs({
      firstSourceMs: null,
      lastSourceMs: null,
      dateStartMs: at(13, 0),
      lightsOutMs: at(13, 4),
    });
    expect(result).toBeNull();
  });

  it("carries a one-line comment citing the three measured gaps", () => {
    // The constant itself covers the largest measured gap (4.1 min) with margin.
    expect(FORMATION_WINDOW_MS).toBe(5 * MIN);
  });
});
