import { describe, expect, it } from "vitest";

import { createPlaybackClock } from "./playbackClock.ts";

const BOUNDS = { startSourceMs: 0, endSourceMs: 100_000 };

describe("createPlaybackClock", () => {
  it("does not advance while paused (the default state)", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    expect(clock.tick(10_000)).toBe(0);
    expect(clock.isPlaying()).toBe(false);
  });

  it("advances 1:1 with elapsed wall time while playing", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.play(0);
    expect(clock.tick(1_000)).toBe(1_000);
    expect(clock.tick(2_500)).toBe(2_500);
  });

  // The real wiring (useReplayPlayback's requestAnimationFrame loop) never
  // calls tick() while paused, so this deliberately does not either -- a
  // clock that relied on a paused tick to keep its wall-clock baseline
  // fresh would jump by the whole idle gap on the next tick after play().
  it("pause holds the source time; play() after an idle gap does not jump on the first tick", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.play(0);
    clock.tick(1_000);
    expect(clock.sourceMs()).toBe(1_000);

    clock.pause();
    expect(clock.isPlaying()).toBe(false);
    // A long idle gap passes here with no call into the clock at all.

    clock.play(50_000); // resumes after the idle gap; re-baselines to 50_000
    expect(clock.tick(51_000)).toBe(2_000); // only the 1000ms since play() counts, not the 49s gap
  });

  it("play after an idle gap since construction advances zero at the first tick", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    // The clock sat constructed-but-idle for 60s (e.g. the page loaded and
    // the viewer took a while to press Play) before play() is ever called.
    clock.play(60_000); // re-baselines to 60_000, ignoring the 60s since construction
    expect(clock.tick(60_000)).toBe(0); // zero elapsed since play(), not 60s
  });

  it("seek while paused, then play, does not jump on the first tick", () => {
    const clock = createPlaybackClock({ ...BOUNDS, initialWallMs: 0 });
    clock.play(0);
    clock.tick(1_000);
    clock.pause();

    // A seek while paused (e.g. dragging the slider) re-baselines the wall
    // clock itself, so neither the idle gap before it nor the seek call
    // itself may leak into a later resume's first tick.
    clock.seek(5_000, 90_000);
    expect(clock.sourceMs()).toBe(5_000);

    clock.play(90_200); // resumes shortly after the seek
    expect(clock.tick(91_200)).toBe(6_000); // only the 1000ms since play() counts, not the 90s gap
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
    clock.play(0);
    clock.tick(200_000); // far past the end
    expect(clock.sourceMs()).toBe(100_000);
    expect(clock.isPlaying()).toBe(false);

    clock.play(200_000);
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
