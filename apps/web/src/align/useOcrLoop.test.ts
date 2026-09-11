// Covers useOcrLoop.ts's own responsibilities: kicking off crop
// auto-detection or validating a remembered one, the no-read nudge, and
// the onSample diagnostics feed. jsdom has no real 2D canvas context, so
// `drawInto`/`readPixels` are documented no-ops (see capture.ts) --
// `readPixels` is stubbed below to a fixed non-empty buffer purely to
// clear the crop branch's "any pixels at all" gate, not to fake real
// pixel content; the lights pixel detector and real pixel-diff behavior
// stay covered by core.test.ts and, against real footage,
// lightsFixtures.test.ts. What IS testable here -- worker text
// recognition, crop bookkeeping, the sampling/nudge timers, and the
// per-attempt onSample callback -- is covered below.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OcrWorker } from "./capture.ts";
import { SAMPLE_MS, type Crop } from "./policy.ts";
import { useOcrLoop, type UseOcrLoopOptions } from "./useOcrLoop.ts";

vi.mock("./capture.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture.ts")>();
  return { ...actual, readPixels: () => new Uint8ClampedArray(4) };
});

const { clearStoredCrop, writeStoredCrop } = await import("./capture.ts");

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
    onSample: vi.fn(),
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
    // Version 7's recognize(img, {}, { blocks: true }) shape (measured
    // against the installed library, PR body has the raw keys): lines sit
    // under blocks[].paragraphs[].lines[], not at the page's top level.
    const recognize = vi.fn().mockResolvedValue({
      data: { text: "", blocks: [{ paragraphs: [{ lines: [{ text: "LAP 3/50", bbox: { x0: 100, y0: 20, x1: 200, y1: 40 } }] }] }] },
    });
    const options = makeOptions();
    const { result } = renderHook(() => useOcrLoop(options));

    await act(async () => {
      result.current.begin(fakeWorker(recognize));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recognize).toHaveBeenCalledWith(expect.anything(), {}, { text: true, blocks: true });
    expect(options.crop.current).not.toBeNull();
    expect(options.setStatus).toHaveBeenCalledWith(expect.stringContaining("Found the lap counter (LAP 3/50)"));
  });

  it("begin() with a valid remembered crop confirms it without starting a scan", async () => {
    const remembered: Crop = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    writeStoredCrop(remembered);
    const recognize = vi.fn().mockResolvedValue({ data: { text: "LAP 12/58", blocks: null } });
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
    const recognize = vi.fn().mockResolvedValue({ data: { text: "SAFETY CAR", blocks: null } }); // no LAP N/M -> invalid
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
    const recognize = vi.fn().mockResolvedValue({ data: { text: "", blocks: null } });
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
    const recognize = vi.fn().mockResolvedValue({ data: { text: "", blocks: null } }); // never parses
    const options = makeOptions({ getCrop: () => ({ x: 0, y: 0, w: 1, h: 1 }) });
    const { result } = renderHook(() => useOcrLoop(options));

    act(() => result.current.begin(fakeWorker(recognize)));
    await vi.advanceTimersByTimeAsync(10_100);

    expect(options.setStatus).toHaveBeenCalledWith("No lap counter read yet — check the box covers LAP N/M");
  });

  it("reports every crop recognize() attempt through onSample, parsed true/false by whether it read a lap", async () => {
    vi.useFakeTimers();
    // jsdom's canvas has no 2D context, so readPixels() always returns an
    // empty array -- regionChanged() takes the "always changed" branch on
    // the very first sample only, which is enough to drive one
    // processPending() call through the crop-recognize branch below.
    const recognize = vi.fn().mockResolvedValue({ data: { text: "LAP 4/60", blocks: null } });
    const options = makeOptions({ getCrop: () => ({ x: 0, y: 0, w: 1, h: 1 }) });
    const { result } = renderHook(() => useOcrLoop(options));

    act(() => result.current.begin(fakeWorker(recognize)));
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.onSample).toHaveBeenCalledWith({ text: "LAP 4/60", parsed: true });
  });

  it("a rejected recognize() reaches onSample as an error, not a silent drop", async () => {
    vi.useFakeTimers();
    const recognize = vi.fn().mockRejectedValue(new Error("worker crashed"));
    const options = makeOptions({ getCrop: () => ({ x: 0, y: 0, w: 1, h: 1 }) });
    const { result } = renderHook(() => useOcrLoop(options));

    act(() => result.current.begin(fakeWorker(recognize)));
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    await act(async () => {
      await Promise.resolve();
    });

    expect(options.onSample).toHaveBeenCalledWith({ error: "worker crashed" });
  });
});
