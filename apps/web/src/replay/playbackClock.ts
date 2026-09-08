// The replay playback clock (issue #57): a pure, React-free state machine on
// the `source_time` axis so it is trivially unit-testable (no timers, no
// `requestAnimationFrame`). `ReplayPage`'s hook calls `tick(nowWallMs)` on
// every animation frame; the caller supplies wall time so tests can drive it
// deterministically.
export type PlaybackSpeed = 1 | 5 | 20;

export interface PlaybackClock {
  isPlaying(): boolean;
  speed(): PlaybackSpeed;
  sourceMs(): number;
  /** Resumes playback from the current position. A no-op once already at the end. */
  play(): void;
  /** Freezes the current position; a later `tick` no longer advances it. */
  pause(): void;
  setSpeed(speed: PlaybackSpeed): void;
  /** Jumps directly to `targetSourceMs`, clamped to `[startSourceMs, endSourceMs]`. */
  seek(targetSourceMs: number): void;
  /**
   * Advances the clock by `speed * (nowWallMs - <wall time of the last tick>)`
   * while playing, clamped to the bounds; a no-op on the position while
   * paused. Always records `nowWallMs` so a later resume does not jump by the
   * time spent paused. Call on every frame, playing or not. Returns the
   * (possibly unchanged) source time.
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
  let speed: PlaybackSpeed = 1;
  let sourceMs = startSourceMs;
  let lastWallMs = opts.initialWallMs;

  return {
    isPlaying: () => playing,
    speed: () => speed,
    sourceMs: () => sourceMs,

    play(): void {
      playing = sourceMs < endSourceMs;
    },

    pause(): void {
      playing = false;
    },

    setSpeed(next: PlaybackSpeed): void {
      speed = next;
    },

    seek(targetSourceMs: number): void {
      sourceMs = clamp(targetSourceMs, startSourceMs, endSourceMs);
    },

    tick(nowWallMs: number): number {
      if (playing) {
        const elapsedMs = nowWallMs - lastWallMs;
        sourceMs = clamp(sourceMs + elapsedMs * speed, startSourceMs, endSourceMs);
        if (sourceMs >= endSourceMs) playing = false;
      }
      lastWallMs = nowWallMs;
      return sourceMs;
    },
  };
}
