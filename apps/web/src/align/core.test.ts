import { describe, expect, it } from "vitest";
import {
  parseLapText, createLapTracker, decideCorrection, regionChanged,
  chooseAnchorTarget, compensateTarget,
  redFractionGrid, createLightsOutDetector, countLit, changedFraction,
  createOffsetTracker, predictFlipWall,
  findLapLine, cropFromBBox, summarizeVerdict,
} from "./core.ts";

describe("parseLapText: OCR text is noisy; the parser is the guard", () => {
  it("clean HUD text", () => {
    expect(parseLapText("LAP 34/72")).toEqual({ lap: 34, total: 72 });
  });
  it("spaced separator", () => {
    expect(parseLapText("LAP 34 / 72")).toEqual({ lap: 34, total: 72 });
  });
  it("misread prefix still yields the numbers", () => {
    expect(parseLapText("1AP  5/72\n")).toEqual({ lap: 5, total: 72 });
  });
  it("no numbers -> null", () => {
    expect(parseLapText("SAFETY CAR")).toBeNull();
  });
  it("lap beyond total rejected", () => {
    expect(parseLapText("LAP 80/72")).toBeNull();
  });
  it("lap zero rejected", () => {
    expect(parseLapText("LAP 0/72")).toBeNull();
  });
  it("total below 2 rejected", () => {
    expect(parseLapText("LAP 3/1")).toBeNull();
  });
  it("absurd total rejected", () => {
    expect(parseLapText("LAP 3/500")).toBeNull();
  });
  it("non-string -> null", () => {
    expect(parseLapText(undefined)).toBeNull();
  });
});

describe("createLapTracker: only +1 is a flip; misreads never move the tracker", () => {
  it("tracks first, same, flip, and rejects backwards/jump reads", () => {
    const tracker = createLapTracker();
    expect(tracker.accept(34)).toBe("first"); // first read locks the lap without anchoring time
    expect(tracker.accept(34)).toBe("same");
    expect(tracker.accept(35)).toBe("flip");
    expect(tracker.accept(33)).toBe("rejected"); // backwards (replay graphic) rejected
    expect(tracker.accept(38)).toBe("rejected"); // jump (misread) rejected
    expect(tracker.current()).toBe(35); // rejected reads do not move the tracker
    expect(tracker.accept(36)).toBe("flip"); // normal progression resumes
  });
});

describe("createLapTracker: re-lock after 3 consecutive identical rejected reads", () => {
  it("(a) three identical rejected reads re-lock as 'first' and current() moves", () => {
    const tracker = createLapTracker();
    expect(tracker.accept(34)).toBe("first");
    expect(tracker.accept(50)).toBe("rejected"); // 1st occurrence of 50
    expect(tracker.accept(50)).toBe("rejected"); // 2nd occurrence of 50
    expect(tracker.accept(50)).toBe("first"); // 3rd identical rejected value re-locks
    expect(tracker.current()).toBe(50); // re-lock moves the tracker to the new value

    // (c) after re-lock, the next +1 is a flip
    expect(tracker.accept(51)).toBe("flip"); // normal progression resumes after re-lock
    expect(tracker.current()).toBe(51);
  });

  it("(b) mixed rejected values do NOT re-lock", () => {
    const tracker = createLapTracker();
    expect(tracker.accept(34)).toBe("first");
    expect(tracker.accept(50)).toBe("rejected");
    expect(tracker.accept(51)).toBe("rejected"); // different value resets the streak
    expect(tracker.accept(50)).toBe("rejected"); // streak restarted, only 1 so far
    expect(tracker.accept(52)).toBe("rejected"); // different again, no re-lock
    expect(tracker.current()).toBe(34); // tracker never moved off the original lock
  });
});

describe("chooseAnchorTarget: lap-1 lights-out preference vs plain lookup", () => {
  const anchors = {
    lights_out: "2026-08-24T12:00:00.000Z",
    laps: [
      { lap: 1, source_time: "2026-08-24T12:00:05.000Z" },
      { lap: 2, source_time: "2026-08-24T12:01:30.000Z" },
    ],
  };

  it("first-ever lock at lap 1 prefers lights_out", () => {
    expect(chooseAnchorTarget(anchors, 1, false)).toBe("2026-08-24T12:00:00.000Z");
  });
  it("falls back to laps[1] when lights_out is absent", () => {
    expect(chooseAnchorTarget({ laps: anchors.laps }, 1, false)).toBe("2026-08-24T12:00:05.000Z");
  });
  it("plain lap lookup for non-1 laps", () => {
    expect(chooseAnchorTarget(anchors, 2, false)).toBe("2026-08-24T12:01:30.000Z");
  });
  it("missing anchor -> null", () => {
    expect(chooseAnchorTarget(anchors, 3, false)).toBeNull();
  });
  it("a RE-lock at lap 1 does NOT choose lights_out — it's a misread storm, not race start", () => {
    expect(chooseAnchorTarget(anchors, 1, true)).toBe("2026-08-24T12:00:05.000Z");
  });
  it("no anchors -> null", () => {
    expect(chooseAnchorTarget(null, 1, false)).toBeNull();
  });
});

describe("compensateTarget: adjust an anchor for elapsed handling time", () => {
  it("compensation adds elapsed ms", () => {
    expect(compensateTarget("2026-08-24T12:00:00.000Z", 1500)).toBe("2026-08-24T12:00:01.500Z");
  });
  it("zero elapsed leaves the target unchanged", () => {
    expect(compensateTarget("2026-08-24T12:00:00.000Z", 0)).toBe("2026-08-24T12:00:00.000Z");
  });
  it("null target -> null", () => {
    expect(compensateTarget(null, 1500)).toBeNull();
  });
  it("undefined target -> null", () => {
    expect(compensateTarget(undefined, 1500)).toBeNull();
  });
  it("garbage target -> null", () => {
    expect(compensateTarget("not a date", 1500)).toBeNull();
  });
  it("garbage elapsed -> null", () => {
    expect(compensateTarget("2026-08-24T12:00:00.000Z", Number.NaN)).toBeNull();
  });
});

describe("decideCorrection: 300ms deadband (spec A2), seek beyond it", () => {
  it("zero delta -> none", () => {
    expect(decideCorrection(0)).toBe("none");
  });
  it("boundary is inside the deadband", () => {
    expect(decideCorrection(300)).toBe("none");
  });
  it("negative boundary -> none", () => {
    expect(decideCorrection(-300)).toBe("none");
  });
  it("just beyond the deadband -> seek", () => {
    expect(decideCorrection(301)).toBe("seek");
  });
  it("sign does not matter", () => {
    expect(decideCorrection(-2000)).toBe("seek");
  });
  it("unknown display time -> no correction", () => {
    expect(decideCorrection(Number.NaN)).toBe("none");
  });
});

describe("regionChanged: diff gate for the OCR loop (changed-pixel fraction)", () => {
  const flat = new Array(64).fill(100);

  it("no previous frame -> changed", () => {
    expect(regionChanged(null, flat)).toBe(true);
  });
  it("identical frames -> unchanged", () => {
    const same = [...flat];
    expect(regionChanged(flat, same)).toBe(false);
  });
  it("big pixel shift -> changed", () => {
    const shifted = [...flat];
    for (let i = 0; i < shifted.length; i += 4) shifted[i] = 200; // every R channel moves 100
    expect(regionChanged(flat, shifted)).toBe(true);
  });
  it("size mismatch (crop moved) -> changed", () => {
    expect(regionChanged(flat, new Array(32).fill(100))).toBe(true);
  });
  it("small-area large change (digit flip) -> changed", () => {
    // The harness-caught case: one digit flipping inside a generous crop —
    // a small FRACTION of pixels changing by a lot must open the gate.
    const oneDigit = [...flat];
    oneDigit[0] = 255; // 1 of 16 sampled pixels (6.25%) moves hard
    expect(regionChanged(flat, oneDigit)).toBe(true);
  });
  it("uniform sub-threshold noise -> unchanged", () => {
    // Uniform low-level noise (compression flicker) must NOT open the gate.
    const noisy = flat.map((value) => value + 5); // every pixel moves, but under PIXEL_DELTA
    expect(regionChanged(flat, noisy)).toBe(false);
  });
});

describe("redFractionGrid: saturated-red per cell", () => {
  it("left cell fully red, yellow right cell excluded", () => {
    // 4x2 image, 2x1 grid: left half saturated red, right half orange (excluded).
    const px: number[] = [];
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        if (x < 2) px.push(200, 20, 20, 255); // saturated LED red
        else px.push(230, 200, 40, 255); // yellow: r-g too small -> not red
      }
    }
    const grid = redFractionGrid(px, 4, 2, 2, 1);
    expect(grid).toEqual([1, 0]);
  });
  it("warm blooming red counts as red", () => {
    // Warm blooming red (real start-light color from the owner's clip) counts.
    const warm: number[] = [];
    for (let i = 0; i < 4; i += 1) warm.push(226, 154, 124, 255);
    expect(redFractionGrid(warm, 2, 2, 1, 1)).toEqual([1]);
  });
});

describe("createLightsOutDetector: scalar ramp-then-collapse (validated on real footage)", () => {
  // Helper: a grid of `total` tiles with exactly `count` tiles fully red.
  function gridWithCount(count: number, total = 100): number[] {
    const grid = new Array(total).fill(0);
    for (let i = 0; i < count; i += 1) grid[i] = 1;
    return grid;
  }

  it("fires exactly once, at the real lights-out frame", () => {
    // Real-clip fixture: red-tile counts at 3fps from the owner's Zandvoort start
    // recording (2026-09-06). Baseline signage ~7-9, lights ramp to 19, collapse
    // at index 45 (t=15.0s) — the detector must fire there and ONLY there.
    const realCounts = [4,4,5,5,4,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,8,8,8,8,8,9,8,8,7,9,9,12,12,15,14,18,18,19,16,14,15,7,4,8,8,4,5,8,10];
    const detector = createLightsOutDetector();
    const fired: number[] = [];
    for (let i = 0; i < realCounts.length; i += 1) {
      // vary WHICH tiles are lit gently (stable prefix) so no frame reads as a cut
      if (detector.push(gridWithCount(realCounts[i]!), i * 333)) fired.push(i);
    }
    expect(fired).toEqual([45]);
  });

  it("second real start clip: fires once at lights-out", () => {
    // Second real clip (race-start-2, 10fps, union color test): slow ramp 1->11
    // as lights come on, collapse to 0 at index 213 — must fire there and nowhere
    // else despite long dead stretches.
    const counts2 = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,2,2,2,2,1,1,2,1,1,1,1,1,1,1,1,1,2,1,1,1,1,1,1,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,2,2,2,3,4,3,2,2,2,4,5,4,2,2,3,4,4,4,6,6,7,7,7,7,7,8,8,8,7,7,9,10,11,10,8,8,8,9,9,11,10,11,11,10,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,0,1,1,0,0,1];
    const detector = createLightsOutDetector();
    const fired: number[] = [];
    for (let i = 0; i < counts2.length; i += 1) {
      if (detector.push(gridWithCount(counts2[i]!), i * 100)) fired.push(i);
    }
    expect(fired).toEqual([213]);
  });

  it("racing footage never fires the lights detector", () => {
    // Negative real clip (lap-change, 10fps): racing footage with wild red churn
    // (cars, cuts, counts bouncing 5..68) — must NEVER fire.
    const counts3 = [5,29,5,5,5,5,5,5,5,5,5,5,5,7,6,5,5,5,5,6,6,7,5,5,5,5,5,5,4,5,5,5,5,5,10,9,11,9,9,10,18,25,15,11,13,6,6,7,9,8,12,12,15,13,16,9,8,11,17,17,28,30,30,41,32,29,26,28,27,29,35,42,49,44,39,41,41,40,44,48,43,50,59,68,58,48,36,36,31,44,65];
    const detector = createLightsOutDetector();
    const fired: number[] = [];
    for (let i = 0; i < counts3.length; i += 1) {
      if (detector.push(gridWithCount(counts3[i]!), i * 100)) fired.push(i);
    }
    expect(fired).toEqual([]);
  });

  it("summary replay fires where the grid path fires", () => {
    // pushSummary (the fixture-replay path) is the SAME decision as push(grid):
    // a trace of {count, changed} reproduces the grid path exactly. This is what
    // lets poc/fixtures/lights hold compact per-sample summaries of real footage.
    const realCounts = [4,4,5,5,4,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,8,8,8,8,8,9,8,8,7,9,9,12,12,15,14,18,18,19,16,14,15,7,4,8,8,4,5,8,10];
    const detector = createLightsOutDetector();
    const fired: number[] = [];
    let previous: number[] | null = null;
    for (let i = 0; i < realCounts.length; i += 1) {
      const grid = gridWithCount(realCounts[i]!);
      const summary = { count: countLit(grid), changed: changedFraction(grid, previous) };
      previous = grid;
      if (detector.pushSummary(summary, i * 333)) fired.push(i);
    }
    expect(fired).toEqual([45]);
    expect(countLit([0.1, 0.25, 0.9])).toBe(2); // countLit uses >= threshold
    expect(changedFraction([0, 0.5, 1, 1], [0, 0.4, 1, 0.97])).toBe(0.25); // counts tiles moving > 0.05
    expect(changedFraction([1, 1], null)).toBe(0); // no previous grid -> nothing changed
  });

  it("wholesale change is a cut, not lights-out", () => {
    // A camera cut (most tiles changing at once) never fires, even with a drop.
    const detector = createLightsOutDetector();
    for (let i = 0; i < 12; i += 1) detector.push(gridWithCount(12), i * 333); // ramped and held
    // cut: a completely different tile pattern with a lower count
    const cutGrid = new Array(100).fill(0.5); // every tile changes by >0.05
    expect(detector.push(cutGrid, 12 * 333)).toBeNull();
  });

  it("collapse without a ramp is not lights-out", () => {
    // No ramp -> no fire: static signage disappearing (shot change already vetoed,
    // but even a gentle fade without a preceding ramp must not fire).
    const detector = createLightsOutDetector();
    for (let i = 0; i < 15; i += 1) detector.push(gridWithCount(8), i * 333); // flat baseline
    expect(detector.push(gridWithCount(2), 15 * 333)).toBeNull();
  });
});

describe("createOffsetTracker: the offset is the state; events are evidence", () => {
  it("seeds, nudges via EMA, and re-seeds exactly on lights", () => {
    const tracker = createOffsetTracker();
    expect(tracker.offsetMs()).toBeNull(); // no estimate before any observation
    expect(tracker.observe("2026-08-23T13:00:00.000Z", Date.parse("2026-08-23T13:00:20.000Z"), "lights")).toBe("seeded");
    expect(tracker.offsetMs()).toBe(20000); // lights observation seeds the offset exactly
    // Noisy flips pull the estimate slowly (EMA gain 0.3)
    expect(tracker.observe("2026-08-23T13:01:30.000Z", Date.parse("2026-08-23T13:01:51.000Z"), "flip")).toBe("accepted");
    expect(tracker.offsetMs()).toBe(20300); // one +1s-noisy flip moves the estimate only 300ms
    // A lights observation snaps the estimate
    expect(tracker.observe("2026-08-23T13:03:00.000Z", Date.parse("2026-08-23T13:03:19.000Z"), "lights")).toBe("seeded");
    expect(tracker.offsetMs()).toBe(19000); // lights re-seeds exactly
    expect(tracker.observationCount()).toBe(3);
  });
});

describe("discard guard and re-lock", () => {
  it("discards wild samples then re-locks after 3 consecutive", () => {
    const tracker = createOffsetTracker();
    tracker.observe("2026-08-23T13:00:00.000Z", Date.parse("2026-08-23T13:00:20.000Z"), "lights");
    const wildWall = Date.parse("2026-08-23T13:01:40.000Z"); // +100s vs anchor: 80s off the estimate
    expect(tracker.observe("2026-08-23T13:00:00.000Z", wildWall, "flip")).toBe("discarded"); // 1st wild sample discarded
    expect(tracker.offsetMs()).toBe(20000); // discard leaves the estimate untouched
    expect(tracker.observe("2026-08-23T13:00:00.000Z", wildWall, "flip")).toBe("discarded"); // 2nd discarded
    expect(tracker.observe("2026-08-23T13:00:00.000Z", wildWall, "flip")).toBe("relock"); // 3rd consecutive re-locks
    expect(tracker.offsetMs()).toBe(100000); // re-lock adopts the persistent value
  });

  it("an in-range sample resets the discard streak", () => {
    const wildWall = Date.parse("2026-08-23T13:01:40.000Z");
    const tracker2 = createOffsetTracker();
    tracker2.observe("2026-08-23T13:00:00.000Z", Date.parse("2026-08-23T13:00:20.000Z"), "lights");
    tracker2.observe("2026-08-23T13:00:00.000Z", wildWall, "flip");
    expect(tracker2.observe("2026-08-23T13:01:00.000Z", Date.parse("2026-08-23T13:01:20.500Z"), "flip")).toBe("accepted");
    expect(tracker2.observe("2026-08-23T13:00:00.000Z", wildWall, "flip")).toBe("discarded"); // streak restarted at 1
  });

  it("garbage in -> discarded, estimate untouched", () => {
    const tracker2 = createOffsetTracker();
    tracker2.observe("2026-08-23T13:00:00.000Z", Date.parse("2026-08-23T13:00:20.000Z"), "lights");
    expect(tracker2.observe("not a date", 123, "flip")).toBe("discarded");
    expect(tracker2.observe("2026-08-23T13:00:00.000Z", Number.NaN, "flip")).toBe("discarded");
  });
});

describe("predictFlipWall", () => {
  it("predicts the wall time an anchor's event appears on this viewer's screen", () => {
    expect(predictFlipWall("2026-08-23T13:04:53.000Z", 20000)).toBe(Date.parse("2026-08-23T13:05:13.000Z"));
  });
  it("null anchor -> null", () => {
    expect(predictFlipWall(null, 20000)).toBeNull();
  });
  it("garbage offset -> null", () => {
    expect(predictFlipWall("2026-08-23T13:04:53.000Z", Number.NaN)).toBeNull();
  });
});

describe("findLapLine: locate the HUD counter among full-frame OCR blocks", () => {
  // Version 7's recognize({ blocks: true }) shape (measured against the
  // installed library, PR body has the raw keys): Page.blocks[].paragraphs[].lines[].
  function blocksOf(lines: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[]) {
    return [{ paragraphs: [{ lines }] }];
  }

  const lines = [
    { text: "PIRELLI", bbox: { x0: 10, y0: 10, x1: 80, y1: 30 } },
    { text: "LAP 34/72", bbox: { x0: 100, y0: 40, x1: 220, y1: 70 } },
    { text: "VER 1:12.3", bbox: { x0: 100, y0: 80, x1: 220, y1: 100 } },
  ];

  it("finds the LAP N/M line", () => {
    const hit = findLapLine(blocksOf(lines));
    expect(hit).toBeTruthy();
    expect(hit!.bbox.x0).toBe(100);
  });
  it("no counters -> null", () => {
    expect(findLapLine(blocksOf([{ text: "no counters here", bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }]))).toBeNull();
  });
  it("empty blocks -> null", () => {
    expect(findLapLine([])).toBeNull();
  });
  it("null blocks (page has no lines at all) -> null", () => {
    expect(findLapLine(null)).toBeNull();
  });
  it("a block with no paragraphs -> null, doesn't throw", () => {
    expect(findLapLine([{ paragraphs: [] }])).toBeNull();
  });
  it("nonsense lap/total rejected by the parser", () => {
    expect(findLapLine(blocksOf([{ text: "LAP 90/72", bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }]))).toBeNull();
  });
});

describe("summarizeVerdict: the status sentence policy.ts produces, collapsed to a diagnostics-history label", () => {
  it("a genuine lock", () => {
    expect(summarizeVerdict("Locked on lap 3 — aligning at the next lap change")).toBe("locked");
  });
  it("a rejected misread names the expected lap", () => {
    expect(summarizeVerdict("Seeing lap 9 on screen, expected 4 — will re-lock if it persists")).toBe("rejected: expected 4");
  });
  it("no anchor yet names the lap", () => {
    expect(summarizeVerdict("Lap 5 — no anchor yet, will retry at the next lap")).toBe("no anchor for lap 5");
  });
  it("a lights-out apply with no anchor yet", () => {
    expect(summarizeVerdict("Lights out — no anchor yet, will retry at the next lap")).toBe("no anchor for lights out");
  });
  it("an applied flip, seeded", () => {
    expect(summarizeVerdict("Lap 6: seeded — delay 1.2s")).toBe("flip accepted");
  });
  it("an applied flip, accepted", () => {
    expect(summarizeVerdict("Lap 7: accepted — delay 1.2s")).toBe("flip accepted");
  });
  it("an applied flip, re-locked", () => {
    expect(summarizeVerdict("Lap 8: re-locked — delay 1.2s")).toBe("flip accepted");
  });
  it("an applied flip, discarded", () => {
    expect(summarizeVerdict("Lap 9: discarded (too far off) — delay 1.2s")).toBe("flip discarded");
  });
  it("a lights-out apply, accepted", () => {
    expect(summarizeVerdict("Lights out: seeded — delay 0.1s")).toBe("lights out accepted");
  });
});

describe("cropFromBBox: normalized, padded, clamped box around the found line", () => {
  it("left edge padded outward, width and height padded, clamped inside the frame", () => {
    const crop = cropFromBBox({ x0: 100, y0: 100, x1: 300, y1: 140 }, 1000, 500);
    expect(crop !== null && crop.x < 0.1 && crop.x >= 0).toBe(true); // left edge padded outward
    expect(crop!.w > 0.2).toBe(true); // width includes padding beyond the 200px text
    expect(crop!.y < 0.2 && crop!.h > 0.08).toBe(true); // height padded
    expect(crop!.x + crop!.w <= 1 && crop!.y + crop!.h <= 1).toBe(true); // clamped inside the frame
  });
  it("corner box clamps at 0", () => {
    const corner = cropFromBBox({ x0: 0, y0: 0, x1: 50, y1: 20 }, 1000, 500);
    expect(corner !== null && corner.x === 0 && corner.y === 0).toBe(true);
  });
  it("no bbox -> null", () => {
    expect(cropFromBBox(null, 1000, 500)).toBeNull();
  });
  it("degenerate frame -> null", () => {
    expect(cropFromBBox({ x0: 0, y0: 0, x1: 50, y1: 20 }, 0, 500)).toBeNull();
  });
});
