// Sequences one lap/lights reading through the verdict policy and the
// offset tracker, then routes the resulting delay through the `TimeTarget`
// seam. Everything that computes a verdict or an offset lives in
// policy.ts/core.ts; this module only calls them in the right order.
import { createLapTracker, createOffsetTracker, type LapTracker, type OffsetTracker } from "./core.ts";
import { applyReading, createLapVerdictPolicy, lightsLabel, type LapVerdictPolicy, type ObserveKind } from "./policy.ts";
import type { Anchors } from "../live/anchors.ts";
import type { TimeTarget } from "../transport/TimeTarget.ts";

/**
 * Routes one anchored observation's computed offset through the
 * `TimeTarget` seam instead of a raw `setDelayMs`. `ms` is exactly what
 * `applyReading` passes to `setDelayMs`, always `Math.max(0, offsetMs)`,
 * and `offsetMs` is `OffsetTracker.offsetMs()` (`core.ts`): `observedWall −
 * anchorSourceMs`. That is a constant mapping between the viewer's wall
 * clock and the data's source-time axis -- true whether the anchor is
 * seconds old (live) or days old (a replay recording) -- so the position to
 * show is always `sourceMs = nowWallMs − offsetMs`, on both platforms. One
 * branch, no anchor needed here.
 *
 * `now` must be the SAME wall clock `observedWall` itself was computed
 * from (the caller closes over one `nowWallMs = Date.now()` for both), not
 * a fresh `Date.now()` call here -- otherwise the two calls' sub-ms drift
 * leaks into the position.
 *
 * Live: `seekTo(atMs)` resolves to `setDelayMs(now() − atMs)` (floored at
 * 0), so seeking to `now() − ms` sets the delay to exactly `ms`.
 *
 * Replay: seeks the playback clock to `nowWallMs − offsetMs`, which lands
 * at the anchor's own source time (plus whatever small residual `now`
 * differs from `observedWall`) -- not `anchorMs + ms`, which is wrong
 * end to end for a historic anchor (`ms` is then days, not a lead) and
 * clamps to the end of the recording. Playback always resumes, never
 * pauses.
 */
export function applyOffsetToTarget(target: TimeTarget, ms: number, now: () => number = Date.now): void {
  target.seekTo(now() - ms);
  target.playback()?.play();
}

/** The reading-pipeline state a run of sampling accumulates: recreated
 * fresh at the start of every sampling session (see `useOcrLoop`'s
 * `begin()`), never reused across a stop/start cycle. */
export interface ReadingTrackers {
  tracker: LapTracker;
  lapPolicy: LapVerdictPolicy;
  offsetTracker: OffsetTracker;
}

export function createReadingTrackers(): ReadingTrackers {
  return {
    tracker: createLapTracker(),
    lapPolicy: createLapVerdictPolicy(),
    offsetTracker: createOffsetTracker(),
  };
}

/** What a reading needs from the outside world at the moment it's applied
 * -- fetched fresh (never a stale closure) by the caller, since sampling
 * runs on a timer outside React's render cycle. */
export interface ReadingContext {
  anchors: Anchors;
  target: TimeTarget;
  pipelineBiasMs: number;
}

function applyObservedReading(
  kind: ObserveKind,
  lap: number,
  isRestart: boolean,
  label: string,
  frameAt: number,
  offsetTracker: OffsetTracker,
  ctx: ReadingContext,
): string {
  const nowWallMs = Date.now();
  return applyReading({
    anchors: ctx.anchors,
    kind,
    lap,
    isRestart,
    label,
    frameAt,
    nowWallMs,
    nowPerfMs: performance.now(),
    pipelineBiasMs: ctx.pipelineBiasMs,
    tracker: offsetTracker,
    setDelayMs: (ms) => applyOffsetToTarget(ctx.target, ms, () => nowWallMs),
  });
}

/** A lap counter read of `lap` at `frameAt` (performance.now() when the
 * frame was grabbed). Runs it through the monotonic lap tracker and the
 * lock/apply policy; only a "first" (genuine lap-1 lock) or "flip" verdict
 * reaches the offset tracker. Returns the new status line, or null when the
 * verdict is "same" (nothing changed, no status update needed). */
export function handleLapRead(lap: number, frameAt: number, trackers: ReadingTrackers, ctx: ReadingContext): string | null {
  const verdict = trackers.tracker.accept(lap);
  const action = trackers.lapPolicy.decide(verdict, lap, trackers.tracker.current());
  if (action.type === "ignore") return null;
  if (action.type === "rejected" || action.type === "locked") return action.status;
  return applyObservedReading("flip", lap, false, action.label, frameAt, trackers.offsetTracker, ctx);
}

/** A lights-out pixel-detector fire at `frameAt`. Always an anchored
 * observation -- unlike a lap read, there is no lock/reject phase.
 * `isRestart` comes from the sampling loop's own lights-arming gate, which
 * distinguishes a restart from the original race start. */
export function handleLightsOutRead(frameAt: number, isRestart: boolean, trackers: ReadingTrackers, ctx: ReadingContext): string {
  return applyObservedReading("lights", 0, isRestart, lightsLabel(isRestart), frameAt, trackers.offsetTracker, ctx);
}
