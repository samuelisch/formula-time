// Pure, DOM-free policy layer for auto-align (issue #50): arming, lap-verdict
// dispatch, and the apply rule. No capture, no OCR, no store -- capture.ts
// and useAligner.ts wire this to the browser and to `useAnchors()` /
// `setDelayMs`. Ported from the POC's poc/ui/align.js glue, with the seek
// path dropped: the apply rule ends at `setDelayMs`, never a server seek.
import { chooseAnchorTarget, type OffsetTracker } from "./core.ts";
import type { Anchors } from "../live/anchors.ts";

export type LapVerdict = "first" | "same" | "flip" | "rejected";
export type ObserveKind = "lights" | "flip";

// --- Lights-out arming (POC: lightsArmed()) --------------------------------
// Armed below lap 2 (race not clearly underway) and for a lap after
// "SESSION ABORTED" (the data leads the broadcast, so by the time the viewer
// SEES restart lights the data status has already moved past ABORTED).

export interface LightsGate {
  /** Call every sample tick before running the pixel detector. Returns
   * whether the detector should run this tick (armed, and not already fired
   * since the last time it disarmed). */
  shouldWatch(leaderLap: number, sessionStatus: string | null | undefined): boolean;
  /** Call when the detector actually fires, to suppress re-firing until the
   * gate next disarms and re-arms. */
  markFired(): void;
  /** True once an abort has been seen -- distinguishes a restart from the
   * original race start for anchor selection. */
  isRestart(): boolean;
}

export function createLightsGate(): LightsGate {
  let abortBaselineLap: number | null = null;
  let firedThisArming = false;
  return {
    shouldWatch(leaderLap, sessionStatus) {
      if (sessionStatus === "SESSION ABORTED") abortBaselineLap = leaderLap;
      const armed = leaderLap < 2 || (abortBaselineLap !== null && leaderLap <= abortBaselineLap + 1);
      if (!armed) {
        firedThisArming = false; // disarmed: re-arm cleanly for a restart
        return false;
      }
      return !firedThisArming;
    },
    markFired() {
      firedThisArming = true;
    },
    isRestart() {
      return abortBaselineLap !== null && abortBaselineLap >= 1;
    },
  };
}

export function lightsLabel(isRestart: boolean): string {
  return isRestart ? "Restart lights out" : "Lights out";
}

// --- Lap verdict -> action (POC: handleReading()'s tracker.accept branch) --

export type LapAction =
  | { type: "ignore" }
  | { type: "rejected"; status: string }
  | { type: "locked"; status: string }
  | { type: "apply"; label: string };

export interface LapVerdictPolicy {
  decide(verdict: LapVerdict, lap: number, trackerCurrent: number | null): LapAction;
}

/** Owns `hasLockedOnce` (POC: distinguishes a genuine first lock -- which,
 * at lap 1, IS lights-out -- from a re-lock, which never gets that
 * treatment: it's evidence of a misread storm, not race start). */
export function createLapVerdictPolicy(): LapVerdictPolicy {
  let hasLockedOnce = false;
  return {
    decide(verdict, lap, trackerCurrent) {
      if (verdict === "same") return { type: "ignore" };
      if (verdict === "rejected") {
        const expected = (trackerCurrent ?? 0) + 1;
        return {
          type: "rejected",
          status: `Seeing lap ${lap} on screen, expected ${expected} — will re-lock if it persists`,
        };
      }
      if (verdict === "first") {
        const isRelock = hasLockedOnce;
        hasLockedOnce = true;
        // First read is not time-anchored -- wait for a flip, UNLESS this is
        // the genuine first-ever lock at lap 1: that read is not a flip, but
        // it IS an anchored event (lights-out), so it applies immediately.
        if (isRelock || lap !== 1) {
          return { type: "locked", status: `Locked on lap ${lap} — aligning at the next lap change` };
        }
        return { type: "apply", label: `Lap ${lap}` };
      }
      // flip
      return { type: "apply", label: `Lap ${lap}` };
    },
  };
}

// --- The apply rule (issue #50 body, verbatim) ------------------------------
//
// On a lights-out fire at frame time f (performance.now) or a lap flip read
// at f: target = chooseAnchorTarget(anchors, lap, isRelock) (lights-out uses
// restarts.at(-1) after an abort, else lights_out); observedWall = Date.now()
// - (performance.now() - f) + PIPELINE_BIAS_MS; tracker.observe(target,
// observedWall, kind); if the tracker's offsetMs() is a number,
// setDelayMs(Math.max(0, offsetMs)). If the anchor for the lap/event seen is
// unknown, the status says "no anchor yet, will retry at the next lap" and
// returns -- no server fetch, no retry loop: anchors come from `useAnchors()`
// synchronously.

export function chooseTarget(anchors: Anchors, kind: ObserveKind, lap: number, isRestart: boolean): string | null {
  if (kind === "lights") {
    return isRestart ? (anchors.restarts.at(-1) ?? null) : anchors.lights_out;
  }
  // chooseAnchorTarget's isRelock is always false here: a re-lock (isRelock
  // true) never reaches the apply rule -- createLapVerdictPolicy returns
  // "locked" for it above, before an anchor is ever looked up.
  return chooseAnchorTarget(anchors, lap, false);
}

export function computeObservedWall(nowWallMs: number, nowPerfMs: number, frameAt: number, pipelineBiasMs: number): number {
  return nowWallMs - (nowPerfMs - frameAt) + pipelineBiasMs;
}

export interface ApplyReadingInput {
  anchors: Anchors;
  kind: ObserveKind;
  lap: number;
  isRestart: boolean;
  label: string;
  frameAt: number;
  nowWallMs: number;
  nowPerfMs: number;
  pipelineBiasMs: number;
  tracker: OffsetTracker;
  setDelayMs: (ms: number) => void;
}

/** Applies one anchored observation (a lap flip, the genuine first lock at
 * lap 1, or a lights-out fire) and returns the status line text. Synchronous
 * end to end -- no seek, no trim loop: the render is a pure function of the
 * delay `setDelayMs` sets. */
export function applyReading(input: ApplyReadingInput): string {
  const target = chooseTarget(input.anchors, input.kind, input.lap, input.isRestart);
  if (target === null) {
    return `${input.label} — no anchor yet, will retry at the next lap`;
  }
  const observedWall = computeObservedWall(input.nowWallMs, input.nowPerfMs, input.frameAt, input.pipelineBiasMs);
  const verdict = input.tracker.observe(target, observedWall, input.kind);
  const offsetMs = input.tracker.offsetMs();
  if (typeof offsetMs === "number") {
    input.setDelayMs(Math.max(0, offsetMs));
  }
  return statusForVerdict(input.label, verdict, offsetMs);
}

function statusForVerdict(label: string, verdict: "seeded" | "accepted" | "discarded" | "relock", offsetMs: number | null): string {
  const seconds = offsetMs === null ? "?" : (offsetMs / 1000).toFixed(1);
  switch (verdict) {
    case "seeded":
      return `${label}: seeded — delay ${seconds}s`;
    case "accepted":
      return `${label}: accepted — delay ${seconds}s`;
    case "discarded":
      return `${label}: discarded (too far off) — delay ${seconds}s`;
    case "relock":
      return `${label}: re-locked — delay ${seconds}s`;
  }
}

// --- No-read nudge (POC: NO_READ_NUDGE_SAMPLES) -----------------------------
// ~10s of samples with zero successful parses ever: the crop is probably
// missing the counter. Nudge once, don't spam.

export const SAMPLE_MS = 100; // spec: flip lateness <=100ms; the diff gate keeps OCR rare
export const NO_READ_NUDGE_SAMPLES = Math.ceil(10_000 / SAMPLE_MS);
export const NO_READ_NUDGE_STATUS = "No lap counter read yet — check the box covers LAP N/M";

export function shouldNudgeNoRead(sampleCount: number, everRead: boolean, alreadyShown: boolean): boolean {
  return !everRead && !alreadyShown && sampleCount >= NO_READ_NUDGE_SAMPLES;
}

// --- Pipeline bias (POC: PIPELINE_BIAS_MS, the `?bias=` override) ----------
// Measured residual of the correction pipeline that per-event compensation
// alone can't see. `?bias=` lets it be tuned live without a code change;
// guarded so a missing or non-numeric param falls back to the measured
// default rather than silently zeroing the bias.

export const DEFAULT_PIPELINE_BIAS_MS = 1100;

export function resolvePipelineBiasMs(search: string, defaultMs = DEFAULT_PIPELINE_BIAS_MS): number {
  const param = new URLSearchParams(search).get("bias");
  const override = Number(param);
  return param !== null && Number.isFinite(override) && override >= 0 ? override : defaultMs;
}

// --- Crop validation (POC: isValidCrop) -------------------------------------
// Accept a stored crop only if it's a well-formed unit box -- otherwise a
// corrupted/edited localStorage value could produce a zero-size crop and
// throw inside getImageData every sample tick.

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function isValidCrop(box: unknown): box is Crop {
  if (!box || typeof box !== "object") return false;
  const candidate = box as Partial<Record<keyof Crop, unknown>>;
  const inUnitRange = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!inUnitRange(candidate.x) || !inUnitRange(candidate.y) || !inUnitRange(candidate.w) || !inUnitRange(candidate.h)) {
    return false;
  }
  return candidate.w > 0 && candidate.h > 0;
}

// --- Start failure formatting (POC: start()'s catch block) -----------------

export function formatStartFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : "Screen capture failed";
  return `Couldn't start: ${reason} — check network (OCR loads from a CDN) and allow screen sharing, then try again`;
}
