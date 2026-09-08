// Covers the two review findings on `useAligner.ts` that can't be reached
// through `AlignPanel.test.tsx` (which only ever exercises "starting" and a
// rejected `getDisplayMedia`): the OCR worker leak on stop/unmount, and the
// stop-during-setup race. Drives `start()`/`stop()` directly via
// `renderHook`, with every capture/OCR touch point faked through
// `UseAlignerOptions` so the async setup chain can be paused and resumed by
// hand.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyAnchors } from "../live/anchors.ts";
import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import type { OcrWorker, TesseractModule } from "./capture.ts";
import { useAligner } from "./useAligner.ts";

function resetStore(): void {
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
  });
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
    const { result } = renderHook(() =>
      useAligner({
        loadTesseract: () => Promise.resolve(fakeTesseract),
        captureDisplayMedia: () => Promise.resolve(stream),
        createOcrWorker: () => Promise.resolve(worker),
      }),
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
    const { result, unmount } = renderHook(() =>
      useAligner({
        loadTesseract: () => Promise.resolve(fakeTesseract),
        captureDisplayMedia: () => Promise.resolve(stream),
        createOcrWorker: () => Promise.resolve(worker),
      }),
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
    const { result } = renderHook(() =>
      useAligner({
        loadTesseract: () => Promise.resolve(fakeTesseract),
        captureDisplayMedia: () => captureDisplayMedia.promise,
        createOcrWorker: () => Promise.resolve(fakeWorker()),
      }),
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

    const { result } = renderHook(() =>
      useAligner({
        loadTesseract: () => Promise.resolve(fakeTesseract),
        captureDisplayMedia,
        createOcrWorker: () => Promise.resolve(worker2),
      }),
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

    const { result } = renderHook(() =>
      useAligner({
        loadTesseract: () => Promise.resolve(fakeTesseract),
        captureDisplayMedia,
        createOcrWorker: () => Promise.resolve(worker2),
      }),
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

    const { result } = renderHook(() =>
      useAligner({
        loadTesseract: () => Promise.resolve(fakeTesseract),
        captureDisplayMedia,
        createOcrWorker,
      }),
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
