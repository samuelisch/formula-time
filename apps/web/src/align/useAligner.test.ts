// Covers the two review findings on `useAligner.ts` that can't be reached
// through `AlignPanel.test.tsx` (which only ever exercises "starting" and a
// rejected `getDisplayMedia`): the OCR worker leak on stop/unmount, and the
// stop-during-setup race. Drives `start()`/`stop()` directly via
// `renderHook`, with every capture/OCR touch point faked through
// `UseAlignerOptions` so the async setup chain can be paused and resumed by
// hand.
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyAnchors, type Anchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import { TimeTargetProvider, type TimeTarget, type TimeTargetProviderProps } from "../transport/TimeTarget.ts";
import { useLiveTimeTarget } from "../transport/useLiveTimeTarget.ts";
import type { OcrWorker, TesseractModule } from "./capture.ts";
import { createOffsetTracker } from "./core.ts";
import { chooseTarget, computeObservedWall } from "./policy.ts";
import { applyOffsetToTarget, useAligner } from "./useAligner.ts";

function resetStore(overrides: Partial<ReturnType<typeof useLiveStore.getState>> = {}): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    anchors: emptyAnchors(),
    ...overrides,
  });
}

// `useAligner` reads through `useTimeTarget()` (issue #67); every
// `renderHook` below mounts it inside this live-backed provider, matching
// how `BoardPage` wires it in the app -- none of these tests exercise an
// anchored reading, so the real store (reset by `resetStore()` above) is
// enough. `applyOffsetToTarget`'s own describe block below drives fake
// targets directly instead, to cover the routing this issue adds.
function LiveWrapper({ children }: { children: ReactNode }) {
  const target = useLiveTimeTarget();
  const props: TimeTargetProviderProps = { value: target, children };
  return createElement(TimeTargetProvider, props);
}

function fakeTrack(): MediaStreamTrack {
  return {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function fakeStream(): { stream: MediaStream; track: MediaStreamTrack } {
  const track = fakeTrack();
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function fakeWorker(): OcrWorker {
  return {
    setParameters: vi.fn().mockResolvedValue(undefined),
    recognize: vi.fn().mockResolvedValue({ data: { text: "", lines: [] } }),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeTesseract = {} as TesseractModule;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flushes pending microtasks -- generous enough to carry `start()`'s async
 * setup chain through every `await` up to (but not past) whichever promise
 * the test has deliberately left unresolved. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("useAligner", () => {
  beforeEach(() => {
    resetStore();
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    try {
      localStorage.clear();
    } catch {
      /* not available in this environment */
    }
  });

  // --- OCR worker leak (Must change) -----------------------------------------

  it("terminates the OCR worker once when Stop is pressed", async () => {
    const worker = fakeWorker();
    const { stream } = fakeStream();
    const { result } = renderHook(
      () =>
        useAligner({
          loadTesseract: () => Promise.resolve(fakeTesseract),
          captureDisplayMedia: () => Promise.resolve(stream),
          createOcrWorker: () => Promise.resolve(worker),
        }),
      { wrapper: LiveWrapper },
    );

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("running");

    act(() => {
      result.current.stop();
    });

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates the OCR worker on unmount", async () => {
    const worker = fakeWorker();
    const { stream } = fakeStream();
    const { result, unmount } = renderHook(
      () =>
        useAligner({
          loadTesseract: () => Promise.resolve(fakeTesseract),
          captureDisplayMedia: () => Promise.resolve(stream),
          createOcrWorker: () => Promise.resolve(worker),
        }),
      { wrapper: LiveWrapper },
    );

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("running");

    unmount();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  // --- Stop-during-setup race (Bug) -------------------------------------------

  it("releases whatever a chain acquired, and starts no timers, when Stop lands before the pending permission promise resolves", async () => {
    const { stream, track } = fakeStream();
    const captureDisplayMedia = deferred<MediaStream>();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const { result } = renderHook(
      () =>
        useAligner({
          loadTesseract: () => Promise.resolve(fakeTesseract),
          captureDisplayMedia: () => captureDisplayMedia.promise,
          createOcrWorker: () => Promise.resolve(fakeWorker()),
        }),
      { wrapper: LiveWrapper },
    );

    await act(async () => {
      result.current.start();
      await flush(2);
    });
    expect(result.current.phase).toBe("starting"); // blocked on the still-pending getDisplayMedia() promise

    act(() => {
      result.current.stop();
    });
    expect(result.current.phase).toBe("idle");

    const intervalCallsBeforeResolve = setIntervalSpy.mock.calls.length;
    await act(async () => {
      captureDisplayMedia.resolve(stream);
      await flush(3);
    });

    expect(track.stop).toHaveBeenCalledTimes(1); // the chain's own stream, released
    expect(result.current.phase).toBe("idle");
    expect(setIntervalSpy.mock.calls.length).toBe(intervalCallsBeforeResolve); // no sample/preview timers started
  });

  it("keeps only the second chain's resources when Start is clicked again while the first chain is still pending", async () => {
    const { stream: stream1, track: track1 } = fakeStream();
    const { stream: stream2, track: track2 } = fakeStream();
    const worker2 = fakeWorker();
    const capture1 = deferred<MediaStream>();
    let captureCalls = 0;
    const captureDisplayMedia = vi.fn(() => {
      captureCalls += 1;
      return captureCalls === 1 ? capture1.promise : Promise.resolve(stream2);
    });

    const { result } = renderHook(
      () =>
        useAligner({
          loadTesseract: () => Promise.resolve(fakeTesseract),
          captureDisplayMedia,
          createOcrWorker: () => Promise.resolve(worker2),
        }),
      { wrapper: LiveWrapper },
    );

    await act(async () => {
      result.current.start();
      await flush(2);
    });
    expect(result.current.phase).toBe("starting"); // first chain blocked on capture1

    act(() => {
      result.current.stop();
    });

    await act(async () => {
      result.current.start(); // second chain: captureDisplayMedia resolves immediately this time
      await flush(4);
    });
    expect(result.current.phase).toBe("running");

    await act(async () => {
      capture1.resolve(stream1); // the first chain's stale permission prompt finally resolves
      await flush(3);
    });

    expect(track1.stop).toHaveBeenCalledTimes(1); // stale chain's stream released
    expect(track2.stop).not.toHaveBeenCalled(); // the live chain's stream is untouched
    expect(result.current.phase).toBe("running"); // the live chain's state survives
  });

  // Round 2 finding: the first pass's stale-chain cleanup at the video.play()
  // and createOcrWorker() checkpoints released streamRef.current/
  // video.srcObject/workerRef.current -- the SHARED refs -- instead of the
  // stale chain's own locally-acquired stream/worker. Once a second chain had
  // already run to completion and taken those refs over, resolving the first
  // chain's paused promise would stop the live chain's stream and blank its
  // video source. These two tests pause at each of those later checkpoints
  // (the earlier two tests above only ever pause at captureDisplayMedia, the
  // earliest checkpoint, which is why this passed CI the first time).

  it("keeps the second chain's stream and video source when Stop lands while a stale chain is paused at video.play()", async () => {
    const { stream: stream1, track: track1 } = fakeStream();
    const { stream: stream2, track: track2 } = fakeStream();
    const worker2 = fakeWorker();

    let captureCalls = 0;
    const captureDisplayMedia = vi.fn(() => {
      captureCalls += 1;
      return Promise.resolve(captureCalls === 1 ? stream1 : stream2);
    });

    const play1 = deferred<void>();
    let playCalls = 0;
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => {
      playCalls += 1;
      return playCalls === 1 ? play1.promise : Promise.resolve(undefined);
    });

    // jsdom doesn't implement HTMLMediaElement.srcObject as an accessor (no
    // prototype property to spy on), so intercept the hook's own
    // document.createElement("video") call and define one on that specific
    // instance -- a direct, per-write record of what the hook assigns to
    // video.srcObject, not an inference from track/worker calls alone.
    const srcObjectWrites: unknown[] = [];
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = realCreateElement(tagName);
      if (tagName === "video") {
        let value: unknown = null;
        Object.defineProperty(element, "srcObject", {
          configurable: true,
          get: () => value,
          set: (next: unknown) => {
            value = next;
            srcObjectWrites.push(next);
          },
        });
      }
      return element;
    });

    const { result } = renderHook(
      () =>
        useAligner({
          loadTesseract: () => Promise.resolve(fakeTesseract),
          captureDisplayMedia,
          createOcrWorker: () => Promise.resolve(worker2),
        }),
      { wrapper: LiveWrapper },
    );

    await act(async () => {
      result.current.start(); // first chain: gets stream1, then blocks on play1
      await flush(3);
    });
    expect(result.current.phase).toBe("starting");
    expect(track1.stop).not.toHaveBeenCalled(); // not stopped yet -- Stop hasn't run

    act(() => {
      result.current.stop(); // synchronously stops streamRef.current (stream1) via releaseResources
    });
    expect(track1.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.start(); // second chain: stream2, play() resolves immediately, worker2
      await flush(4);
    });
    expect(result.current.phase).toBe("running");
    expect(srcObjectWrites.at(-1)).toBe(stream2); // the live chain's stream is showing
    const writeCountOnceRunning = srcObjectWrites.length;

    await act(async () => {
      play1.resolve(undefined); // the first chain's stale play() finally settles
      await flush(3);
    });

    // The stale chain released its OWN stream (already stopped above by
    // Stop's releaseResources -- calling stop() again on it is a harmless
    // no-op) and never touched the live chain's stream, worker, phase, or
    // video source.
    expect(track1.stop).toHaveBeenCalled();
    expect(track2.stop).not.toHaveBeenCalled();
    expect(worker2.terminate).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("running");
    expect(srcObjectWrites.length).toBe(writeCountOnceRunning); // no further writes -- never nulled or reassigned
    expect(srcObjectWrites.at(-1)).toBe(stream2); // still showing the live chain's stream
  });

  it("keeps the second chain's worker when Stop lands while a stale chain is paused creating the OCR worker", async () => {
    const { stream: stream1, track: track1 } = fakeStream();
    const { stream: stream2, track: track2 } = fakeStream();
    const worker1 = fakeWorker();
    const worker2 = fakeWorker();

    let captureCalls = 0;
    const captureDisplayMedia = vi.fn(() => {
      captureCalls += 1;
      return Promise.resolve(captureCalls === 1 ? stream1 : stream2);
    });
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined); // resolves immediately for every chain

    const worker1Deferred = deferred<OcrWorker>();
    let workerCalls = 0;
    const createOcrWorker = vi.fn(() => {
      workerCalls += 1;
      return workerCalls === 1 ? worker1Deferred.promise : Promise.resolve(worker2);
    });

    const { result } = renderHook(
      () =>
        useAligner({
          loadTesseract: () => Promise.resolve(fakeTesseract),
          captureDisplayMedia,
          createOcrWorker,
        }),
      { wrapper: LiveWrapper },
    );

    await act(async () => {
      result.current.start(); // first chain: gets stream1, play() resolves, blocks creating worker1
      await flush(4);
    });
    expect(result.current.phase).toBe("starting");

    act(() => {
      result.current.stop(); // stops stream1's track via releaseResources; workerRef.current is still null
    });
    expect(track1.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.start(); // second chain: stream2, play(), worker2 -- all resolve immediately
      await flush(5);
    });
    expect(result.current.phase).toBe("running");

    await act(async () => {
      worker1Deferred.resolve(worker1); // the first chain's stale createOcrWorker() finally settles
      await flush(3);
    });

    // The stale chain terminates its OWN abandoned worker (worker1) and
    // re-releases its own stream (already stopped above -- a second stop()
    // call on the same track is a harmless no-op) -- never the live chain's
    // worker2/stream2, and never workerRef.current/streamRef.current.
    expect(worker1.terminate).toHaveBeenCalledTimes(1);
    expect(worker2.terminate).not.toHaveBeenCalled();
    expect(track1.stop).toHaveBeenCalled();
    expect(track2.stop).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("running");
  });
});

// --- Routing an anchored reading's offset through the TimeTarget seam
// (issue #67) -----------------------------------------------------------
//
// `applyOffsetToTarget` is what `applyLapReading`/`handleLightsOut` pass as
// `applyReading`'s `setDelayMs` callback -- these drive it directly with
// hand-rolled fake targets rather than the whole OCR pipeline, exactly
// mirroring how `TransportBar.test.tsx` fakes `TimeTarget` rather than the
// real store/playback clock.

const NO_ANCHORS: Anchors = { lights_out: null, laps: [], restarts: [] };

function fakeLiveTarget(overrides: Partial<TimeTarget> = {}): TimeTarget {
  return {
    displayedAt: () => null,
    seekTo: vi.fn(),
    nudge: vi.fn(),
    anchors: () => NO_ANCHORS,
    range: () => ({ startMs: 0, endMs: 100_000 }),
    playback: () => null,
    notice: () => null,
    syncOffsetMs: () => 0,
    ...overrides,
  };
}

function fakeReplayTarget(overrides: Partial<TimeTarget> = {}): TimeTarget & {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  const play = vi.fn();
  const pause = vi.fn();
  return {
    displayedAt: () => 0,
    seekTo: vi.fn(),
    nudge: vi.fn(),
    anchors: () => NO_ANCHORS,
    range: () => ({ startMs: 0, endMs: 90_000 }),
    playback: () => ({ playing: false, play, pause }),
    notice: () => null,
    syncOffsetMs: () => 0,
    play,
    pause,
    ...overrides,
  };
}

describe("applyOffsetToTarget", () => {
  it("live: seeks to now() - ms, which a live target's own seekTo resolves back to setDelayMs(ms) -- unchanged from the pre-#67 direct call", () => {
    const target = fakeLiveTarget({ range: () => ({ startMs: 0, endMs: 200_000 }) });
    applyOffsetToTarget(target, 4_000, () => 200_000);
    expect(target.seekTo).toHaveBeenCalledWith(196_000);
  });

  it("live, through the real useLiveTimeTarget: ends with delayMs exactly ms (the setDelayMs path, unchanged)", () => {
    resetStore({ buffer: { entries: [{ at: 0, raw: "{}" }, { at: 300_000, raw: "{}" }] } });
    const { result } = renderHook(() => useLiveTimeTarget(() => 300_000));

    applyOffsetToTarget(result.current, 7_500, () => 300_000);

    expect(useLiveStore.getState().delayMs).toBe(7_500);
  });

  it("replay: seeks to now() - ms and keeps playing", () => {
    const target = fakeReplayTarget();
    applyOffsetToTarget(target, 1_500, () => 90_000);
    expect(target.seekTo).toHaveBeenCalledWith(88_500);
    expect(target.play).toHaveBeenCalledTimes(1);
  });

  // Fix round 1 on PR #110: the coordinator's ruling. `offsetMs` is
  // `OffsetTracker.offsetMs()`, `observedWall − anchorSourceMs` -- for a
  // replay of a days-old recording watched today, that gap is genuinely
  // huge (days), not a small "lead". The bug in the original PR treated it
  // as a lead and did `seekTo(anchorMs + ms)`, landing ~2 anchor-gaps past
  // "now" and clamping to the end of the recording -- exactly the failure
  // issue #67 named: "on a replay, 'Lights out' jumps the clock to lap 1"
  // never actually happened. The fix (`seekTo(now() − ms)`, `now` the SAME
  // wall clock `observedWall` was computed from) makes the huge offset and
  // the huge "now" cancel, landing back at the anchor's own source time
  // plus only the small residual between `observedWall` and that shared
  // `now` -- proven below end to end with the real `computeObservedWall`
  // and `OffsetTracker`, a historic anchor, and a fake `Date.now()` set to
  // "today", days later.
  it("replay: a historic anchor plus a far-later Date.now() lands the seek at the anchor's source time, not the end of the recording", () => {
    const target = fakeReplayTarget();
    const anchorIso = "2026-09-06T13:05:00.000Z"; // lap 1's source time, days before "today"
    const anchorMs = Date.parse(anchorIso);

    // "Today", watching the replay -- days after the anchor, and the same
    // wall clock the reading itself was computed against (nowWallMs).
    const nowWallMs = anchorMs + 3 * 24 * 60 * 60 * 1000 + 500;
    const frameAt = 1_000; // performance.now() when the frame was grabbed
    const nowPerfMs = frameAt + 40; // 40ms of OCR/processing elapsed since
    const pipelineBiasMs = 25; // measured residual bias

    const observedWall = computeObservedWall(nowWallMs, nowPerfMs, frameAt, pipelineBiasMs);
    const tracker = createOffsetTracker();
    tracker.observe(anchorIso, observedWall, "lights"); // kind "lights" always (re)seeds
    const offsetMs = tracker.offsetMs();
    expect(offsetMs).toBe(observedWall - anchorMs);

    applyOffsetToTarget(target, offsetMs!, () => nowWallMs); // same wall clock the reading used

    const lead = nowWallMs - observedWall; // the small processing residual, not the days-scale gap
    expect(target.seekTo).toHaveBeenCalledWith(anchorMs + lead);
    expect(target.play).toHaveBeenCalledTimes(1);
  });

  it("replay: a lights-out reseed lands the seek on lap 1's own source time", () => {
    const target = fakeReplayTarget();
    const lap1SourceTime = "2026-09-06T13:00:00.000Z";
    const anchors: Anchors = { lights_out: lap1SourceTime, laps: [{ lap: 1, source_time: lap1SourceTime }], restarts: [] };
    const anchorIso = chooseTarget(anchors, "lights", 0, false);
    expect(anchorIso).toBe(lap1SourceTime);
    const anchorMs = Date.parse(anchorIso!);

    const nowWallMs = anchorMs + 500; // observed at the same instant as the frame, no pipeline lag
    const tracker = createOffsetTracker();
    tracker.observe(anchorIso, nowWallMs, "lights");
    const offsetMs = tracker.offsetMs()!;

    applyOffsetToTarget(target, offsetMs, () => nowWallMs);

    expect(target.seekTo).toHaveBeenCalledWith(anchorMs);
    expect(target.play).toHaveBeenCalledTimes(1);
  });

  it("live: the delay set is exactly the tracker's measured offset", () => {
    resetStore({ buffer: { entries: [{ at: 0, raw: "{}" }, { at: 1_000_000, raw: "{}" }] } });
    const { result } = renderHook(() => useLiveTimeTarget(() => 500_000));

    const anchorIso = "2026-09-06T13:00:00.000Z";
    const observedWall = Date.parse(anchorIso) + 3_200; // the offset the tracker measures
    const tracker = createOffsetTracker();
    tracker.observe(anchorIso, observedWall, "flip");
    const offsetMs = tracker.offsetMs()!;
    expect(offsetMs).toBe(3_200);

    applyOffsetToTarget(result.current, offsetMs, () => 500_000);

    expect(useLiveStore.getState().delayMs).toBe(offsetMs);
  });
});
