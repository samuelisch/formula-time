import { describe, expect, it, vi } from "vitest";

import type { Anchors } from "../live/anchors.ts";
import type { OffsetTracker } from "./core.ts";
import {
  applyReading,
  chooseTarget,
  computeObservedWall,
  createLapVerdictPolicy,
  createLightsGate,
  formatStartFailure,
  isValidCrop,
  lightsLabel,
  resolvePipelineBiasMs,
  shouldNudgeNoRead,
} from "./policy.ts";

const emptyAnchors: Anchors = { lights_out: null, laps: [], restarts: [] };

// --- Arming policy ----------------------------------------------------------

describe("createLightsGate", () => {
  it("is armed below lap 2", () => {
    const gate = createLightsGate();
    expect(gate.shouldWatch(0, null)).toBe(true);
    expect(gate.shouldWatch(1, null)).toBe(true);
  });

  it("disarms once the leader reaches lap 2 with no abort seen", () => {
    const gate = createLightsGate();
    gate.shouldWatch(1, null);
    expect(gate.shouldWatch(2, null)).toBe(false);
  });

  it("re-arms for a lap after SESSION ABORTED, then disarms again", () => {
    const gate = createLightsGate();
    gate.shouldWatch(2, null); // race underway, disarmed
    expect(gate.shouldWatch(2, "SESSION ABORTED")).toBe(true); // armed at abort lap
    expect(gate.shouldWatch(3, null)).toBe(true); // still armed one lap later
    expect(gate.shouldWatch(4, null)).toBe(false); // disarmed again
  });

  it("suppresses re-firing until the gate disarms and re-arms", () => {
    const gate = createLightsGate();
    expect(gate.shouldWatch(0, null)).toBe(true);
    gate.markFired();
    expect(gate.shouldWatch(1, null)).toBe(false); // still armed, but already fired
    expect(gate.shouldWatch(2, null)).toBe(false); // disarmed: re-arm cleared the fired flag
    expect(gate.shouldWatch(2, "SESSION ABORTED")).toBe(true); // armed again, fresh
  });

  it("isRestart is false until an abort has been seen, true after", () => {
    const gate = createLightsGate();
    gate.shouldWatch(0, null);
    expect(gate.isRestart()).toBe(false);
    gate.shouldWatch(5, "SESSION ABORTED");
    expect(gate.isRestart()).toBe(true);
  });

  it("arms and reports isRestart on an abort seen at leaderLap 0 -- an aborted start before lap 1 completes", () => {
    const gate = createLightsGate();
    expect(gate.shouldWatch(0, "SESSION ABORTED")).toBe(true); // armed at the abort lap
    expect(gate.isRestart()).toBe(true);

    // The following lights-out fire is labelled a restart, and selects the
    // latest restart anchor rather than the stale lights_out anchor.
    expect(lightsLabel(gate.isRestart())).toBe("Restart lights out");
    const anchors: Anchors = {
      lights_out: "2026-01-01T00:00:00.000Z",
      laps: [],
      restarts: ["2026-01-01T00:10:00.000Z", "2026-01-01T00:20:00.000Z"],
    };
    expect(chooseTarget(anchors, "lights", 0, gate.isRestart())).toBe(anchors.restarts.at(-1));
  });
});

// --- Lap verdict -> action ---------------------------------------------------

describe("createLapVerdictPolicy", () => {
  it("ignores 'same'", () => {
    const policy = createLapVerdictPolicy();
    expect(policy.decide("same", 3, 3)).toEqual({ type: "ignore" });
  });

  it("reports 'rejected' with the expected next lap", () => {
    const policy = createLapVerdictPolicy();
    expect(policy.decide("rejected", 9, 3)).toEqual({
      type: "rejected",
      status: "Seeing lap 9 on screen, expected 4 — will re-lock if it persists",
    });
  });

  it("applies immediately on the genuine first-ever lock at lap 1", () => {
    const policy = createLapVerdictPolicy();
    expect(policy.decide("first", 1, null)).toEqual({ type: "apply", label: "Lap 1" });
  });

  it("only locks (no apply) on a first read past lap 1", () => {
    const policy = createLapVerdictPolicy();
    expect(policy.decide("first", 5, null)).toEqual({
      type: "locked",
      status: "Locked on lap 5 — aligning at the next lap change",
    });
  });

  it("a re-lock at lap 1 never gets the lights-out treatment", () => {
    const policy = createLapVerdictPolicy();
    policy.decide("first", 1, null); // genuine first lock
    expect(policy.decide("first", 1, null)).toEqual({
      type: "locked",
      status: "Locked on lap 1 — aligning at the next lap change",
    });
  });

  it("applies on a flip", () => {
    const policy = createLapVerdictPolicy();
    policy.decide("first", 3, null);
    expect(policy.decide("flip", 4, 3)).toEqual({ type: "apply", label: "Lap 4" });
  });
});

// --- chooseTarget -------------------------------------------------------------

describe("chooseTarget", () => {
  const anchors: Anchors = {
    lights_out: "2026-01-01T00:00:00.000Z",
    laps: [{ lap: 1, source_time: "2026-01-01T00:00:00.000Z" }],
    restarts: ["2026-01-01T00:10:00.000Z", "2026-01-01T00:20:00.000Z"],
  };

  it("flip kind delegates to chooseAnchorTarget", () => {
    expect(chooseTarget(anchors, "flip", 1, false)).toBe(anchors.lights_out);
  });

  it("lights kind uses lights_out when no abort has been seen", () => {
    expect(chooseTarget(anchors, "lights", 1, false)).toBe(anchors.lights_out);
  });

  it("lights kind uses the latest restart after an abort", () => {
    expect(chooseTarget(anchors, "lights", 1, true)).toBe("2026-01-01T00:20:00.000Z");
  });

  it("lights kind with no restarts recorded returns null", () => {
    expect(chooseTarget(emptyAnchors, "lights", 1, true)).toBeNull();
  });
});

// --- computeObservedWall -------------------------------------------------------

describe("computeObservedWall", () => {
  it("folds the frame's elapsed handling time and the pipeline bias into Date.now()", () => {
    // frame grabbed at perf=1000; 250ms of handling has since elapsed; wall
    // clock is now 50_000; bias adds 1100ms.
    expect(computeObservedWall(50_000, 1_250, 1_000, 1_100)).toBe(50_000 - 250 + 1_100);
  });
});

// --- applyReading (the apply rule) --------------------------------------------

function fakeTracker(overrides: Partial<OffsetTracker> = {}): OffsetTracker {
  return {
    observe: vi.fn().mockReturnValue("seeded"),
    offsetMs: vi.fn().mockReturnValue(0),
    observationCount: vi.fn().mockReturnValue(1),
    ...overrides,
  };
}

describe("applyReading", () => {
  it("reports no anchor and never touches the tracker or setDelayMs when the target is unknown", () => {
    const tracker = fakeTracker();
    const setDelayMs = vi.fn();
    const status = applyReading({
      anchors: emptyAnchors,
      kind: "flip",
      lap: 4,
      isRestart: false,
      label: "Lap 4",
      frameAt: 0,
      nowWallMs: 0,
      nowPerfMs: 0,
      pipelineBiasMs: 1100,
      tracker,
      setDelayMs,
    });
    expect(status).toBe("Lap 4 — no anchor yet, will retry at the next lap");
    expect(tracker.observe).not.toHaveBeenCalled();
    expect(setDelayMs).not.toHaveBeenCalled();
  });

  it("observes the target and sets the delay, clamped to zero, on a numeric offset", () => {
    const tracker = fakeTracker({ observe: vi.fn().mockReturnValue("accepted"), offsetMs: vi.fn().mockReturnValue(-500) });
    const setDelayMs = vi.fn();
    const anchors: Anchors = { lights_out: "2026-01-01T00:00:00.000Z", laps: [], restarts: [] };
    const status = applyReading({
      anchors,
      kind: "lights",
      lap: 1,
      isRestart: false,
      label: "Lights out",
      frameAt: 1_000,
      nowWallMs: 50_000,
      nowPerfMs: 1_250,
      pipelineBiasMs: 1_100,
      tracker,
      setDelayMs,
    });
    expect(tracker.observe).toHaveBeenCalledWith(anchors.lights_out, 50_000 - 250 + 1_100, "lights");
    expect(setDelayMs).toHaveBeenCalledWith(0); // Math.max(0, -500)
    expect(status).toBe("Lights out: accepted — delay -0.5s");
  });

  it("reports each verdict with the offset in seconds", () => {
    const anchors: Anchors = { lights_out: "2026-01-01T00:00:00.000Z", laps: [], restarts: [] };
    const cases: Array<["seeded" | "accepted" | "discarded" | "relock", string]> = [
      ["seeded", "Lights out: seeded — delay 2.0s"],
      ["accepted", "Lights out: accepted — delay 2.0s"],
      ["discarded", "Lights out: discarded (too far off) — delay 2.0s"],
      ["relock", "Lights out: re-locked — delay 2.0s"],
    ];
    for (const [verdict, expected] of cases) {
      const tracker = fakeTracker({ observe: vi.fn().mockReturnValue(verdict), offsetMs: vi.fn().mockReturnValue(2_000) });
      const status = applyReading({
        anchors,
        kind: "lights",
        lap: 1,
        isRestart: false,
        label: "Lights out",
        frameAt: 0,
        nowWallMs: 0,
        nowPerfMs: 0,
        pipelineBiasMs: 0,
        tracker,
        setDelayMs: vi.fn(),
      });
      expect(status).toBe(expected);
    }
  });

  it("does not call setDelayMs while the tracker has no offset yet (discarded, first sample)", () => {
    const tracker = fakeTracker({ observe: vi.fn().mockReturnValue("discarded"), offsetMs: vi.fn().mockReturnValue(null) });
    const setDelayMs = vi.fn();
    const anchors: Anchors = { lights_out: "2026-01-01T00:00:00.000Z", laps: [], restarts: [] };
    applyReading({
      anchors,
      kind: "lights",
      lap: 1,
      isRestart: false,
      label: "Lights out",
      frameAt: 0,
      nowWallMs: 0,
      nowPerfMs: 0,
      pipelineBiasMs: 0,
      tracker,
      setDelayMs,
    });
    expect(setDelayMs).not.toHaveBeenCalled();
  });
});

// --- No-read nudge -------------------------------------------------------------

describe("shouldNudgeNoRead", () => {
  it("fires once, ~10s in, only if nothing has ever been read", () => {
    expect(shouldNudgeNoRead(99, false, false)).toBe(false);
    expect(shouldNudgeNoRead(100, false, false)).toBe(true);
    expect(shouldNudgeNoRead(100, true, false)).toBe(false); // already read something
    expect(shouldNudgeNoRead(100, false, true)).toBe(false); // already shown
  });
});

// --- Pipeline bias override -----------------------------------------------------

describe("resolvePipelineBiasMs", () => {
  it("defaults to 1100ms with no override", () => {
    expect(resolvePipelineBiasMs("")).toBe(1100);
  });

  it("uses a valid non-negative ?bias= override", () => {
    expect(resolvePipelineBiasMs("?bias=250")).toBe(250);
    expect(resolvePipelineBiasMs("?bias=0")).toBe(0);
  });

  it("falls back to the default on a missing, negative, or non-numeric override", () => {
    expect(resolvePipelineBiasMs("?bias=-5")).toBe(1100);
    expect(resolvePipelineBiasMs("?bias=nope")).toBe(1100);
    expect(resolvePipelineBiasMs("?other=1")).toBe(1100);
  });
});

// --- Crop validation -------------------------------------------------------------

describe("isValidCrop", () => {
  it("accepts a well-formed unit box", () => {
    expect(isValidCrop({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toBe(true);
  });

  it("rejects null, non-objects, out-of-range, or zero-size boxes", () => {
    expect(isValidCrop(null)).toBe(false);
    expect(isValidCrop("nope")).toBe(false);
    expect(isValidCrop({ x: -0.1, y: 0, w: 0.5, h: 0.5 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: 0, h: 0.5 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: 1.5, h: 0.5 })).toBe(false);
  });
});

// --- Start failure formatting -----------------------------------------------------

describe("formatStartFailure", () => {
  it("includes the error message and the network/screen-share hint", () => {
    expect(formatStartFailure(new Error("Permission denied"))).toBe(
      "Couldn't start: Permission denied — check network (OCR loads from a CDN) and allow screen sharing, then try again",
    );
  });

  it("falls back to a generic reason for a non-Error throw", () => {
    expect(formatStartFailure("boom")).toBe(
      "Couldn't start: Screen capture failed — check network (OCR loads from a CDN) and allow screen sharing, then try again",
    );
  });
});

// --- lightsLabel -------------------------------------------------------------------

describe("lightsLabel", () => {
  it("distinguishes the original start from a restart", () => {
    expect(lightsLabel(false)).toBe("Lights out");
    expect(lightsLabel(true)).toBe("Restart lights out");
  });
});
