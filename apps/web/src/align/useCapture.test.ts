// Covers the capture lifecycle in isolation from OCR sampling: the
// generation-guarded start/stop chain's race conditions are already
// covered end to end through the composed hook in useAligner.test.ts (a
// user only ever drives Start/Stop through that surface) -- this file
// covers what useCapture.ts alone is responsible for: phase/visible
// transitions, handing off the worker via `onRunning`, the failure path,
// and the crop-drag override.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OcrWorker, TesseractModule } from "./capture.ts";
import { useCapture } from "./useCapture.ts";

function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaStreamTrack;
}

function fakeStream(): MediaStream {
  const track = fakeTrack();
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
}

function fakeWorker(): OcrWorker {
  return {
    setParameters: vi.fn().mockResolvedValue(undefined),
    recognize: vi.fn().mockResolvedValue({ data: { text: "", lines: [] } }),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeTesseract = {} as TesseractModule;

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("useCapture", () => {
  beforeEach(() => {
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  it("goes idle -> starting -> running, hands the worker to onRunning, and shows the panel throughout", async () => {
    const worker = fakeWorker();
    const setStatus = vi.fn();
    const onRunning = vi.fn();
    const { result } = renderHook(() =>
      useCapture({
        captureDisplayMedia: () => Promise.resolve(fakeStream()),
        loadTesseract: () => Promise.resolve(fakeTesseract),
        createOcrWorker: () => Promise.resolve(worker),
        setStatus,
        onRunning,
        onStop: vi.fn(),
        onManualCrop: vi.fn(),
      }),
    );

    expect(result.current.phase).toBe("idle");
    expect(result.current.visible).toBe(false);

    act(() => result.current.start());
    expect(result.current.phase).toBe("starting");
    expect(result.current.visible).toBe(true);
    expect(setStatus).toHaveBeenCalledWith("Loading OCR…");

    await act(async () => {
      await flush();
    });

    expect(result.current.phase).toBe("running");
    expect(onRunning).toHaveBeenCalledExactlyOnceWith(worker);
  });

  it("stop() hides the panel, releases the stream, terminates the worker, and calls onStop", async () => {
    const worker = fakeWorker();
    const stream = fakeStream();
    const onStop = vi.fn();
    const { result } = renderHook(() =>
      useCapture({
        captureDisplayMedia: () => Promise.resolve(stream),
        loadTesseract: () => Promise.resolve(fakeTesseract),
        createOcrWorker: () => Promise.resolve(worker),
        setStatus: vi.fn(),
        onRunning: vi.fn(),
        onStop,
        onManualCrop: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.start();
      await flush();
    });
    expect(result.current.phase).toBe("running");

    act(() => result.current.stop());

    expect(result.current.phase).toBe("idle");
    expect(result.current.visible).toBe(false);
    expect(stream.getTracks()[0]!.stop).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("a start failure formats the error, keeps the panel visible, resets phase to idle, and never calls onStop", async () => {
    const setStatus = vi.fn();
    const onStop = vi.fn();
    const { result } = renderHook(() =>
      useCapture({
        captureDisplayMedia: () => Promise.reject(new Error("Permission denied")),
        loadTesseract: () => Promise.resolve(fakeTesseract),
        createOcrWorker: () => Promise.resolve(fakeWorker()),
        setStatus,
        onRunning: vi.fn(),
        onStop,
        onManualCrop: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.start();
      await flush();
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.visible).toBe(true); // stays up so the failure is seen
    expect(setStatus).toHaveBeenLastCalledWith(
      "Couldn't start: Permission denied — check network (OCR loads from a CDN) and allow screen sharing, then try again",
    );
    expect(onStop).not.toHaveBeenCalled();
  });

  it("dragging on the preview sets the crop and calls onManualCrop, cancelling any auto-detect scan", async () => {
    const onManualCrop = vi.fn();
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useCapture({
        captureDisplayMedia: () => Promise.resolve(fakeStream()),
        loadTesseract: () => Promise.resolve(fakeTesseract),
        createOcrWorker: () => Promise.resolve(fakeWorker()),
        setStatus,
        onRunning: vi.fn(),
        onStop: vi.fn(),
        onManualCrop,
      }),
    );

    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100, toJSON: () => ({}),
    });
    act(() => result.current.previewCanvasRef(canvas));

    act(() => {
      result.current.onPreviewPointerDown({ clientX: 10, clientY: 10, currentTarget: canvas } as never);
      result.current.onPreviewPointerUp({ clientX: 60, clientY: 60, currentTarget: canvas } as never);
    });

    expect(result.current.crop).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(onManualCrop).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenLastCalledWith("Box set — watching the lap counter there");
  });

  it("a stray click (sub-1% drag) keeps the previous crop", async () => {
    const { result } = renderHook(() =>
      useCapture({
        captureDisplayMedia: () => Promise.resolve(fakeStream()),
        loadTesseract: () => Promise.resolve(fakeTesseract),
        createOcrWorker: () => Promise.resolve(fakeWorker()),
        setStatus: vi.fn(),
        onRunning: vi.fn(),
        onStop: vi.fn(),
        onManualCrop: vi.fn(),
      }),
    );

    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100, toJSON: () => ({}),
    });
    act(() => result.current.previewCanvasRef(canvas));

    act(() => {
      result.current.onPreviewPointerDown({ clientX: 10, clientY: 10, currentTarget: canvas } as never);
      result.current.onPreviewPointerUp({ clientX: 10.2, clientY: 10.2, currentTarget: canvas } as never);
    });

    expect(result.current.crop).toBeNull();
  });
});
