// Covers useOcrLoop.ts's own responsibilities: kicking off crop
// auto-detection or validating a remembered one, and the no-read nudge.
// jsdom has no real 2D canvas context, so `drawInto`/`readPixels` are the
// documented no-ops (see capture.ts) -- sample()'s pixel-diff OCR branch
// and the lights pixel detector can't be exercised here; that logic is
// covered directly in core.test.ts and against real footage in
// lightsFixtures.test.ts. What IS testable without real pixels -- worker
// text recognition, crop bookkeeping, and the sampling/nudge timers -- is
// covered below.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStoredCrop, writeStoredCrop, type OcrWorker } from "./capture.ts";
import type { Crop } from "./policy.ts";
import { useOcrLoop, type UseOcrLoopOptions } from "./useOcrLoop.ts";

function fakeVideo(width = 640, height = 360): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height } as unknown as HTMLVideoElement;
}

function fakeWorker(recognize: OcrWorker["recognize"]): OcrWorker {
  return { setParameters: vi.fn(), recognize, terminate: vi.fn() };
}

function makeOptions(overrides: Partial<UseOcrLoopOptions> = {}): UseOcrLoopOptions & { crop: { current: Crop | null } } {
  const crop = { current: null as Crop | null };
  const base: UseOcrLoopOptions = {
    frame: () => fakeVideo(),
    getCrop: () => crop.current,
    setCrop: (next) => {
      crop.current = next;
    },
    setStatus: vi.fn(),
    onLapReading: vi.fn(),
    onLightsOut: vi.fn(),
    leaderLap: 0,
    sessionStatus: null,
    ...overrides,
  };
  return Object.assign(base, { crop });
}

describe("useOcrLoop", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* not available in this environment */
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("begin() with no remembered crop scans the frame, and a hit sets the crop and reports it found", async () => {
    const recognize = vi.fn().mockResolvedValue({
      data: { text: "", lines: [{ text: "LAP 3/50", bbox: { x0: 100, y0: 20, x1: 200, y1: 40 } }] },
    });
    const options = makeOptions();
    const { result } = renderHook(() => useOcrLoop(options));

    await act(async () => {
      result.current.begin(fakeWorker(recognize));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recognize).toHaveBeenCalled();
    expect(options.crop.current).not.toBeNull();
    expect(options.setStatus).toHaveBeenCalledWith(expect.stringContaining("Found the lap counter (LAP 3/50)"));
  });

  it("begin() with a valid remembered crop confirms it without starting a scan", async () => {
    const remembered: Crop = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    writeStoredCrop(remembered);
    const recognize = vi.fn().mockResolvedValue({ data: { text: "LAP 12/58", lines: [] } });
    const options = makeOptions();
    const { result } = renderHook(() => useOcrLoop(options));

    await act(async () => {
      result.current.begin(fakeWorker(recognize));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(options.crop.current).toEqual(remembered);
    expect(options.setStatus).toHaveBeenCalledWith("Checking the remembered box…");
    expect(options.setStatus).toHaveBeenCalledWith(expect.stringContaining("Remembered box still shows the lap counter"));
  });

  it("begin() with an invalid remembered crop discards it and falls back to scanning", async () => {
    const remembered: Crop = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    writeStoredCrop(remembered);
    const recognize = vi.fn().mockResolvedValue({ data: { text: "SAFETY CAR", lines: [] } }); // no LAP N/M -> invalid
    const options = makeOptions();
    const { result } = renderHook(() => useOcrLoop(options));

    await act(async () => {
      result.current.begin(fakeWorker(recognize));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(options.crop.current).toBeNull();
    expect(options.setStatus).toHaveBeenCalledWith(expect.stringContaining("Scanning the whole window"));

    clearStoredCrop(); // cleanup: this test's own write, not shared with other tests via beforeEach's clear
  });

  it("stop() clears the sampling and auto-detect timers -- no further recognize() calls after it", async () => {
    vi.useFakeTimers();
    const recognize = vi.fn().mockResolvedValue({ data: { text: "", lines: [] } });
    const options = makeOptions();
    const { result } = renderHook(() => useOcrLoop(options));

    act(() => result.current.begin(fakeWorker(recognize)));
    await vi.advanceTimersByTimeAsync(3_100); // past the first auto-detect tick
    const callsBeforeStop = recognize.mock.calls.length;
    expect(callsBeforeStop).toBeGreaterThan(0);

    act(() => result.current.stop());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(recognize.mock.calls.length).toBe(callsBeforeStop);
  });

  it("nudges 'no lap counter read yet' after ~10s of samples with a crop set but nothing ever parsed", async () => {
    vi.useFakeTimers();
    const recognize = vi.fn().mockResolvedValue({ data: { text: "", lines: [] } }); // never parses
    const options = makeOptions({ getCrop: () => ({ x: 0, y: 0, w: 1, h: 1 }) });
    const { result } = renderHook(() => useOcrLoop(options));

    act(() => result.current.begin(fakeWorker(recognize)));
    await vi.advanceTimersByTimeAsync(10_100);

    expect(options.setStatus).toHaveBeenCalledWith("No lap counter read yet — check the box covers LAP N/M");
  });
});
