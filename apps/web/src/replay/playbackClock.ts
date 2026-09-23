// The replay playback clock: a pure, React-free state machine on the
// `source_time` axis so it is trivially unit-testable (no timers, no
// `requestAnimationFrame`). 1x only: data plays at the rate it was
// recorded. `play()`/`seek()` re-baseline the wall clock to `nowMs`
// themselves, so the first `tick` after any idle gap never jumps
// `sourceMs` forward by the whole gap in one frame.
export interface PlaybackClock {
  isPlaying(): boolean;
  sourceMs(): number;
  /**
   * Resumes playback from the current position and re-baselines the wall
   * clock to `nowMs` (default `performance.now()`), so the next `tick`
   * counts only time elapsed since this call, never time spent paused or
   * idle before it. A no-op (but still re-baselines) once already at the end.
   */
  play(nowMs?: number): void;
  /** Freezes the current position; a later `tick` no longer advances it. */
  pause(): void;
  /**
   * Jumps directly to `targetSourceMs`, clamped to `[startSourceMs, endSourceMs]`,
   * and re-baselines the wall clock to `nowMs` (default `performance.now()`)
   * for the same reason `play` does -- a seek while paused must not itself
   * cause a jump on the next `play`.
   */
  seek(targetSourceMs: number, nowMs?: number): void;
  /**
   * Advances the clock 1:1 by `nowWallMs - <wall time of the last
   * play/seek/tick>` while playing, clamped to the bounds; a no-op on the
   * position while paused (but still records `nowWallMs`). Call only while
   * playing -- `play`/`seek` keep the baseline fresh across a pause.
   */
  tick(nowWallMs: number): number;
}

export interface PlaybackClockOptions {
  startSourceMs: number;
  endSourceMs: number;
  /** Wall time (e.g. `performance.now()`) at construction, so the first `tick` has a baseline. */
  initialWallMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function createPlaybackClock(opts: PlaybackClockOptions): PlaybackClock {
  const { startSourceMs, endSourceMs } = opts;
  let playing = false;
  let sourceMs = startSourceMs;
  let lastWallMs = opts.initialWallMs;

  return {
    isPlaying: () => playing,
    sourceMs: () => sourceMs,

    play(nowMs: number = performance.now()): void {
      playing = sourceMs < endSourceMs;
      lastWallMs = nowMs;
    },

    pause(): void {
      playing = false;
    },

    seek(targetSourceMs: number, nowMs: number = performance.now()): void {
      sourceMs = clamp(targetSourceMs, startSourceMs, endSourceMs);
      lastWallMs = nowMs;
    },

    tick(nowWallMs: number): number {
      if (playing) {
        const elapsedMs = nowWallMs - lastWallMs;
        sourceMs = clamp(sourceMs + elapsedMs, startSourceMs, endSourceMs);
        if (sourceMs >= endSourceMs) playing = false;
      }
      lastWallMs = nowWallMs;
      return sourceMs;
    },
  };
}
