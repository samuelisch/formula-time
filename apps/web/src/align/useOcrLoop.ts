// Drives the OCR worker `useCapture.ts` hands it via `begin()`: the
// SAMPLE_MS sampling timer, the pixel-diff gate, `findLapLine`/
// `parseLapText` per sample, auto-locating the HUD counter, and whole-frame
// lights-out pixel detection. Emits raw readings (a lap number, a
// lights-out fire) through `onLapReading`/`onLightsOut`, and every OCR
// attempt (success or failure) through `onSample` for the diagnostics line
// -- it never applies a reading to a delay itself; `applyOffset.ts` and the
// caller (`useAligner.ts`) own that policy.
import { useCallback, useLayoutEffect, useRef } from "react";

import {
  clearStoredCrop,
  drawInto,
  readPixels,
  readStoredCrop,
  writeStoredCrop,
  type OcrWorker,
} from "./capture.ts";
import { createLightsOutDetector, cropFromBBox, findLapLine, parseLapText, redFractionGrid, regionChanged } from "./core.ts";
import { createLightsGate, NO_READ_NUDGE_STATUS, SAMPLE_MS, shouldNudgeNoRead, type Crop } from "./policy.ts";

const AUTO_DETECT_MS = 3_000;

/** One `recognize()` attempt in the lap-counter OCR loop -- the raw text
 * (whether or not it parsed as LAP N/M) on success, or the rejection's
 * message when the promise rejects. Drives the diagnostics line; this
 * hook does no formatting of its own. */
export type OcrSample = { text: string; parsed: boolean } | { error: string };

export interface UseOcrLoopOptions {
  /** The live video frame to sample -- `useCapture`'s `frame()`. */
  frame: () => HTMLVideoElement;
  getCrop: () => Crop | null;
  setCrop: (next: Crop | null) => void;
  setStatus: (status: string) => void;
  /** A lap counter read of `lap`, at the `performance.now()` the frame was
   * grabbed. The caller decides whether it's anchored, locked, or rejected. */
  onLapReading: (lap: number, frameAt: number) => void;
  /** The lights-out pixel detector fired at `frameAt`; `isRestart`
   * distinguishes a restart from the original race start. */
  onLightsOut: (frameAt: number, isRestart: boolean) => void;
  /** Every crop-recognize attempt, success or failure -- never the
   * auto-detect scan's own recognize() calls, which are a separate,
   * pre-lock concern. */
  onSample: (sample: OcrSample) => void;
  leaderLap: number;
  sessionStatus: string | null | undefined;
}

export interface OcrLoopControls {
  /** Starts sampling against `worker`. Resets every per-run tracker (lights
   * gate/detector, the pixel-diff baseline, the no-read nudge) and either
   * validates a remembered crop or starts scanning for the HUD counter. */
  begin: (worker: OcrWorker) => void;
  stop: () => void;
  /** Cancels an in-progress auto-detect scan -- called when the user drags
   * a crop box by hand, which makes the scan moot. */
  cancelAutoDetect: () => void;
}

export function useOcrLoop(options: UseOcrLoopOptions): OcrLoopControls {
  // Live values the sampling loop (a plain interval callback, outside
  // React's render cycle) needs to read without re-subscribing on every
  // change -- kept current via a ref, synced from a layout effect after
  // each render so the write never happens during render itself. Must be
  // `useLayoutEffect`, not `useEffect`: layout effects flush synchronously
  // right after commit, before the browser can run any queued macrotask --
  // so `sample()`'s `setInterval` (SAMPLE_MS) can never observe a commit
  // whose ref sync hasn't run yet.
  const liveRef = useRef(options);
  useLayoutEffect(() => {
    liveRef.current = options;
  });

  // 480x270 with a 48x27 grid: a real gantry light (~2% of frame width)
  // fills most of a 10x10 tile.
  const frameCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  if (frameCanvasElRef.current === null) {
    const el = document.createElement("canvas");
    el.width = 480;
    el.height = 270;
    frameCanvasElRef.current = el;
  }
  const frameCanvas = frameCanvasElRef.current;

  const cropCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  cropCanvasElRef.current ??= document.createElement("canvas");
  const cropCanvas = cropCanvasElRef.current;

  const pendingCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  pendingCanvasElRef.current ??= document.createElement("canvas");
  const pendingCanvas = pendingCanvasElRef.current;

  const recognizeCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  recognizeCanvasElRef.current ??= document.createElement("canvas");
  const recognizeCanvas = recognizeCanvasElRef.current;

  const detectCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  detectCanvasElRef.current ??= document.createElement("canvas");
  const detectCanvas = detectCanvasElRef.current;

  const workerRef = useRef<OcrWorker | null>(null);
  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoDetectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const lightsGateRef = useRef(createLightsGate());
  const lightsDetectorRef = useRef(createLightsOutDetector());

  const lastPixelsRef = useRef<Uint8ClampedArray | null>(null);
  const pendingFrameRef = useRef<{ frameAt: number } | null>(null);
  const recognizingRef = useRef(false);
  const autoDetectAttemptRef = useRef(0);
  const sampleCountRef = useRef(0);
  const everReadRef = useRef(false);
  const noReadNudgeShownRef = useRef(false);
  const stoppedRef = useRef(true);

  const stopAutoDetect = useCallback(() => {
    if (autoDetectTimerRef.current !== null) clearInterval(autoDetectTimerRef.current);
    autoDetectTimerRef.current = null;
  }, []);

  // OCR the whole frame and let tesseract's line geometry say WHERE
  // "LAP N/M" sits; that bbox (padded) becomes the crop. Alternates full
  // frame (near-native res) and top-half-2x passes -- the HUD text is small
  // and lives up top.
  const autoDetectOnce = useCallback(async () => {
    const worker = workerRef.current;
    const video = liveRef.current.frame();
    if (!worker || recognizingRef.current || !video.videoWidth) return;
    recognizingRef.current = true;
    try {
      autoDetectAttemptRef.current += 1;
      const zoomTop = autoDetectAttemptRef.current % 2 === 0;
      const scale = Math.min(1.0, 1600 / video.videoWidth) * (zoomTop ? 2 : 1);
      const srcH = zoomTop ? Math.round(video.videoHeight / 2) : video.videoHeight;
      drawInto(detectCanvas, video, 0, 0, video.videoWidth, srcH, video.videoWidth * scale, srcH * scale);
      const result = await worker.recognize(detectCanvas, {}, { text: true, blocks: true });
      const hit = findLapLine(result.data.blocks);
      const found = hit
        ? cropFromBBox(
            {
              x0: hit.bbox.x0 / scale,
              y0: hit.bbox.y0 / scale,
              x1: hit.bbox.x1 / scale,
              y1: hit.bbox.y1 / scale,
            },
            video.videoWidth,
            video.videoHeight,
          )
        : null;
      if (found) {
        liveRef.current.setCrop(found);
        writeStoredCrop(found);
        stopAutoDetect();
        liveRef.current.setStatus(`Found the lap counter (${hit!.text.trim()}) — watching`);
      }
    } catch {
      /* transient; the next attempt retries */
    }
    recognizingRef.current = false;
  }, [detectCanvas, stopAutoDetect]);

  const startAutoDetect = useCallback(() => {
    stopAutoDetect();
    liveRef.current.setStatus("Scanning the whole window for the lap counter (LAP N/M)… lights-out detection is already active. Drag on the preview to override.");
    autoDetectTimerRef.current = setInterval(() => void autoDetectOnce(), AUTO_DETECT_MS);
    void autoDetectOnce();
  }, [autoDetectOnce, stopAutoDetect]);

  // A remembered box must still show the lap counter; otherwise discard it
  // and fall back to scanning the whole window.
  const validateRememberedCrop = useCallback(async () => {
    const worker = workerRef.current;
    const video = liveRef.current.frame();
    const box = liveRef.current.getCrop();
    if (!worker || !box || !video.videoWidth) {
      startAutoDetect();
      return;
    }
    recognizingRef.current = true;
    let valid = false;
    try {
      const sx = box.x * video.videoWidth;
      const sy = box.y * video.videoHeight;
      const sw = Math.max(8, box.w * video.videoWidth);
      const sh = Math.max(8, box.h * video.videoHeight);
      drawInto(detectCanvas, video, sx, sy, sw, sh, sw * 2, sh * 2);
      const result = await worker.recognize(detectCanvas);
      valid = parseLapText(result.data.text) !== null;
    } catch {
      /* treat as invalid */
    }
    recognizingRef.current = false;
    if (valid) {
      liveRef.current.setStatus("Remembered box still shows the lap counter ✓ — watching");
    } else {
      liveRef.current.setCrop(null);
      clearStoredCrop();
      startAutoDetect();
    }
  }, [detectCanvas, startAutoDetect]);

  // Recognizes the latest pending snapshot, if any, when the worker is
  // free -- looping (not recursing) so a newer frame landing while busy is
  // picked up by the same call. recognizeCanvas is a stable copy taken
  // before each async recognize call so later sample() ticks can keep
  // overwriting pendingCanvas without disturbing the frame the in-flight
  // worker is reading.
  const processPending = useCallback(async () => {
    if (recognizingRef.current) return;
    while (pendingFrameRef.current && workerRef.current) {
      const worker = workerRef.current;
      const { frameAt } = pendingFrameRef.current;
      pendingFrameRef.current = null;
      recognizeCanvas.width = pendingCanvas.width;
      recognizeCanvas.height = pendingCanvas.height;
      drawInto(recognizeCanvas, pendingCanvas, 0, 0, pendingCanvas.width, pendingCanvas.height, pendingCanvas.width, pendingCanvas.height);
      recognizingRef.current = true;
      try {
        let reading = null;
        try {
          const result = await worker.recognize(recognizeCanvas);
          reading = parseLapText(result.data.text);
          liveRef.current.onSample({ text: result.data.text, parsed: reading !== null });
        } catch (error) {
          // Surfaced to the diagnostics line instead of swallowed -- the
          // next sample still retries, but a persistent rejection (e.g. the
          // worker crashed) is now visible rather than silent.
          liveRef.current.onSample({ error: error instanceof Error ? error.message : "OCR failed" });
        }
        if (reading && !stoppedRef.current) {
          everReadRef.current = true;
          liveRef.current.onLapReading(reading.lap, frameAt);
        }
      } finally {
        recognizingRef.current = false;
      }
    }
  }, [pendingCanvas, recognizeCanvas]);

  // Sampling starts as soon as capture is ready -- the whole-frame lights
  // watch needs no box (at race start there IS no lap counter on screen
  // yet). The crop only gates the lap-OCR branch below.
  const sample = useCallback(() => {
    // Counted and checked every tick, independent of whether a crop box
    // exists yet -- a missing/misplaced box is exactly the case this nudge
    // is for.
    sampleCountRef.current += 1;
    if (shouldNudgeNoRead(sampleCountRef.current, everReadRef.current, noReadNudgeShownRef.current)) {
      noReadNudgeShownRef.current = true;
      liveRef.current.setStatus(NO_READ_NUDGE_STATUS);
    }

    const video = liveRef.current.frame();
    if (!video.videoWidth) return;

    // Pushed every sample tick, independent of the OCR guard below -- an
    // in-flight recognize() must never starve this of frames.
    if (lightsGateRef.current.shouldWatch(liveRef.current.leaderLap, liveRef.current.sessionStatus)) {
      const lightsFrameAt = performance.now();
      drawInto(frameCanvas, video, 0, 0, video.videoWidth, video.videoHeight, frameCanvas.width, frameCanvas.height);
      const framePixels = readPixels(frameCanvas);
      if (framePixels.length > 0) {
        const fired = lightsDetectorRef.current.push(redFractionGrid(framePixels, frameCanvas.width, frameCanvas.height, 48, 27), Date.now());
        if (fired) {
          lightsGateRef.current.markFired();
          liveRef.current.onLightsOut(lightsFrameAt, lightsGateRef.current.isRestart());
        }
      }
    }

    const box = liveRef.current.getCrop();
    if (!box) return;

    const sx = box.x * video.videoWidth;
    const sy = box.y * video.videoHeight;
    const sw = Math.max(8, box.w * video.videoWidth);
    const sh = Math.max(8, box.h * video.videoHeight);
    const frameAt = performance.now(); // grabbed right before the pixels are read
    drawInto(cropCanvas, video, sx, sy, sw, sh, sw * 2, sh * 2); // 2x upscale helps OCR on small HUD text

    const pixels = readPixels(cropCanvas);
    if (pixels.length === 0 || !regionChanged(lastPixelsRef.current, pixels)) return;
    lastPixelsRef.current = pixels;
    pendingCanvas.width = cropCanvas.width;
    pendingCanvas.height = cropCanvas.height;
    drawInto(pendingCanvas, cropCanvas, 0, 0, cropCanvas.width, cropCanvas.height, cropCanvas.width, cropCanvas.height);
    pendingFrameRef.current = { frameAt }; // latest-wins
    void processPending();
  }, [cropCanvas, frameCanvas, pendingCanvas, processPending]);

  const begin = useCallback(
    (worker: OcrWorker) => {
      workerRef.current = worker;
      stoppedRef.current = false;
      lightsGateRef.current = createLightsGate();
      lightsDetectorRef.current = createLightsOutDetector();
      lastPixelsRef.current = null;
      pendingFrameRef.current = null;
      sampleCountRef.current = 0;
      everReadRef.current = false;
      noReadNudgeShownRef.current = false;
      sampleTimerRef.current = setInterval(sample, SAMPLE_MS);

      const remembered = readStoredCrop();
      if (remembered) {
        liveRef.current.setCrop(remembered);
        liveRef.current.setStatus("Checking the remembered box…");
        void validateRememberedCrop();
      } else {
        startAutoDetect();
      }
    },
    [sample, startAutoDetect, validateRememberedCrop],
  );

  const stop = useCallback(() => {
    stoppedRef.current = true;
    stopAutoDetect();
    if (sampleTimerRef.current !== null) clearInterval(sampleTimerRef.current);
    sampleTimerRef.current = null;
    workerRef.current = null;
  }, [stopAutoDetect]);

  return { begin, stop, cancelAutoDetect: stopAutoDetect };
}
