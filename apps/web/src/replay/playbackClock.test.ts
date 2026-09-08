import { describe, expect, it } from "vitest";

import { createPlaybackClock } from "./playbackClock.ts";

const BOUNDS = { startSourceMs: 0, endSourceMs: 100_000 };

describe("createPlaybackClock", () => {
  it("does not advance while paused (the default state)", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    expect(clock.tick(10_000)).toBe(0);
    expect(clock.isPlaying()).toBe(false);
  });

  it("advances by speed × elapsed wall time while playing", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.play();
    expect(clock.tick(1_000)).toBe(1_000); // 1x by default
    clock.setSpeed(5);
    expect(clock.tick(2_000)).toBe(1_000 + 5 * 1_000); // 1000ms elapsed at 5x
    clock.setSpeed(20);
    expect(clock.tick(2_500)).toBe(6_000 + 20 * 500); // 500ms elapsed at 20x
  });

  it("pause holds the source time and does not jump on resume", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.play();
    clock.tick(1_000);
    expect(clock.sourceMs()).toBe(1_000);

    clock.pause();
    expect(clock.tick(50_000)).toBe(1_000); // wall time passed, but paused
    expect(clock.isPlaying()).toBe(false);

    clock.play();
    expect(clock.tick(51_000)).toBe(2_000); // only the 1000ms since the last tick counts
  });

  it("seek jumps directly and clamps to [startSourceMs, endSourceMs]", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.seek(50_000);
    expect(clock.sourceMs()).toBe(50_000);
    clock.seek(-10);
    expect(clock.sourceMs()).toBe(0);
    clock.seek(500_000);
    expect(clock.sourceMs()).toBe(100_000);
  });

  it("stops playing once it reaches endSourceMs, and play() is a no-op at the end", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.play();
    clock.tick(200_000); // far past the end
    expect(clock.sourceMs()).toBe(100_000);
    expect(clock.isPlaying()).toBe(false);

    clock.play();
    expect(clock.isPlaying()).toBe(false); // already at the end
  });

  it("seeking back from the end allows play() to resume", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.seek(100_000);
    clock.play();
    expect(clock.isPlaying()).toBe(false);

    clock.seek(90_000);
    clock.play();
    expect(clock.isPlaying()).toBe(true);
  });
});
