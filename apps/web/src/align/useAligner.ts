// Owns capture, timers, and the OCR worker for auto-align (issue #50);
// React (AlignPanel.tsx) owns nothing but rendering this state. Port of the
// POC's poc/ui/align.js glue -- see that file's comments for the shape this
// mirrors. Everything DOM-free lives in policy.ts; every DOM/media/OCR touch
// point is a function from capture.ts, overridable here for tests.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useAnchors, useDelay, useDisplayed, useLeaderLap } from "../live/selectors.ts";
import {
  captureDisplayMedia as defaultCaptureDisplayMedia,
  createOcrWorker as defaultCreateOcrWorker,
  clearStoredCrop,
  drawInto,
  loadTesseract as defaultLoadTesseract,
  readPixels,
  readStoredCrop,
  strokeRect,
  writeStoredCrop,
  type OcrWorker,
  type TesseractModule,
} from "./capture.ts";
import {
  createLapTracker,
  createLightsOutDetector,
  createOffsetTracker,
  cropFromBBox,
  findLapLine,
  parseLapText,
  redFractionGrid,
  regionChanged,
} from "./core.ts";
import {
  applyReading,
  createLapVerdictPolicy,
  createLightsGate,
  formatStartFailure,
  lightsLabel,
  resolvePipelineBiasMs,
  SAMPLE_MS,
  shouldNudgeNoRead,
  type Crop,
} from "./policy.ts";

const PREVIEW_MS = 200;
const AUTO_DETECT_MS = 3_000;
const PREVIEW_WIDTH = 480;

export type AlignerPhase = "idle" | "starting" | "running";

export interface UseAlignerOptions {
  captureDisplayMedia?: () => Promise<MediaStream>;
  loadTesseract?: () => Promise<TesseractModule>;
  createOcrWorker?: (tesseract: TesseractModule) => Promise<OcrWorker>;
}

export interface AlignerState {
  phase: AlignerPhase;
  status: string;
  crop: Crop | null;
  /** Whether the panel should render at all -- separate from `phase` so a
   * capture failure (phase resets to "idle") still shows its status. */
  visible: boolean;
  previewCanvasRef: (el: HTMLCanvasElement | null) => void;
  onPreviewPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onPreviewPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  start: () => void;
  stop: () => void;
}

const IDLE_STATUS = "Line the data up with the broadcast on your screen";

export function useAligner(options: UseAlignerOptions = {}): AlignerState {
  const captureDisplayMediaImpl = options.captureDisplayMedia ?? defaultCaptureDisplayMedia;
  const loadTesseractImpl = options.loadTesseract ?? defaultLoadTesseract;
  const createOcrWorkerImpl = options.createOcrWorker ?? defaultCreateOcrWorker;

  const anchors = useAnchors();
  const leaderLap = useLeaderLap();
  const displayed = useDisplayed();
  const sessionStatus = displayed?.state.race_control.session_status ?? null;
  const { setDelayMs } = useDelay();

  const [phase, setPhase] = useState<AlignerPhase>("idle");
  const [status, setStatus] = useState(IDLE_STATUS);
  const [crop, setCropState] = useState<Crop | null>(null);
  // Separate from `phase`: a capture failure resets phase to "idle" (so the
  // user can retry) but keeps the panel up so the failure status stays
  // visible (POC: "stop() hides the workspace; re-show it so the failure is
  // visible").
  const [visible, setVisible] = useState(false);

  // Live values the sampling loop (a plain interval callback, outside
  // React's render cycle) needs to read without re-subscribing on every
  // change -- kept current via a ref synced each render, POC-style.
  const liveRef = useRef({ anchors, leaderLap, sessionStatus, setDelayMs });
  liveRef.current = { anchors, leaderLap, sessionStatus, setDelayMs };

  // Offscreen DOM handles this hook owns imperatively (drawn into and
  // resized from timer/OCR callbacks, not from render) -- lazily created
  // refs, never React state: mutating them must never schedule a re-render.
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  if (videoElRef.current === null) {
    videoElRef.current = document.createElement("video");
    videoElRef.current.muted = true;
  }
  const video = videoElRef.current;

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

  // 480x270 with a 48x27 grid: a real gantry light (~2% of frame width)
  // fills most of a 10x10 tile.
  const frameCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  if (frameCanvasElRef.current === null) {
    frameCanvasElRef.current = document.createElement("canvas");
    frameCanvasElRef.current.width = 480;
    frameCanvasElRef.current.height = 270;
  }
  const frameCanvas = frameCanvasElRef.current;

  const previewCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<OcrWorker | null>(null);
  const cropRef = useRef<Crop | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoDetectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const trackerRef = useRef(createLapTracker());
  const lapPolicyRef = useRef(createLapVerdictPolicy());
  const lightsGateRef = useRef(createLightsGate());
  const lightsDetectorRef = useRef(createLightsOutDetector());
  const offsetTrackerRef = useRef(createOffsetTracker());

  const lastPixelsRef = useRef<Uint8ClampedArray | null>(null);
  const pendingFrameRef = useRef<{ frameAt: number } | null>(null);
  const recognizingRef = useRef(false);
  const autoDetectAttemptRef = useRef(0);
  const sampleCountRef = useRef(0);
  const everReadRef = useRef(false);
  const noReadNudgeShownRef = useRef(false);
  const stoppedRef = useRef(true);

  const pipelineBiasMsRef = useRef(resolvePipelineBiasMs(window.location.search));

  const setCrop = useCallback((next: Crop | null) => {
    cropRef.current = next;
    setCropState(next);
  }, []);

  const drawPreview = useCallback(() => {
    const canvas = previewCanvasElRef.current;
    if (!canvas || !video.videoWidth) return;
    const height = Math.round((PREVIEW_WIDTH * video.videoHeight) / video.videoWidth);
    drawInto(canvas, video, 0, 0, video.videoWidth, video.videoHeight, PREVIEW_WIDTH, height);
    const box = cropRef.current;
    if (box) {
      strokeRect(canvas, box.x * canvas.width, box.y * canvas.height, box.w * canvas.width, box.h * canvas.height, "#e10600");
    }
  }, [video]);

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
    if (!worker || recognizingRef.current || !video.videoWidth) return;
    recognizingRef.current = true;
    try {
      autoDetectAttemptRef.current += 1;
      const zoomTop = autoDetectAttemptRef.current % 2 === 0;
      const scale = Math.min(1.0, 1600 / video.videoWidth) * (zoomTop ? 2 : 1);
      const srcH = zoomTop ? Math.round(video.videoHeight / 2) : video.videoHeight;
      drawInto(detectCanvas, video, 0, 0, video.videoWidth, srcH, video.videoWidth * scale, srcH * scale);
      const result = await worker.recognize(detectCanvas);
      const hit = findLapLine(result.data.lines);
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
        setCrop(found);
        writeStoredCrop(found);
        stopAutoDetect();
        setStatus(`Found the lap counter (${hit!.text.trim()}) — watching`);
      }
    } catch {
      /* transient; the next attempt retries */
    }
    recognizingRef.current = false;
  }, [detectCanvas, setCrop, stopAutoDetect, video]);

  const startAutoDetect = useCallback(() => {
    stopAutoDetect();
    setStatus("Scanning the whole window for the lap counter (LAP N/M)… lights-out detection is already active. Drag on the preview to override.");
    autoDetectTimerRef.current = setInterval(() => void autoDetectOnce(), AUTO_DETECT_MS);
    void autoDetectOnce();
  }, [autoDetectOnce, stopAutoDetect]);

  // A remembered box must still show the lap counter; otherwise discard it
  // and fall back to scanning the whole window.
  const validateRememberedCrop = useCallback(async () => {
    const worker = workerRef.current;
    const box = cropRef.current;
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
      setStatus("Remembered box still shows the lap counter ✓ — watching");
    } else {
      setCrop(null);
      clearStoredCrop();
      startAutoDetect();
    }
  }, [detectCanvas, setCrop, startAutoDetect, video]);

  // The reading applies whether it's a lap flip or the genuine first-ever
  // lock at lap 1 (issue #50: both are "flip" kind for the offset tracker --
  // lights-out is the separate pixel path below).
  const applyLapReading = useCallback(
    (lap: number, frameAt: number) => {
      const status = applyReading({
        anchors: liveRef.current.anchors,
        kind: "flip",
        lap,
        isRestart: false,
        label: `Lap ${lap}`,
        frameAt,
        nowWallMs: Date.now(),
        nowPerfMs: performance.now(),
        pipelineBiasMs: pipelineBiasMsRef.current,
        tracker: offsetTrackerRef.current,
        setDelayMs: liveRef.current.setDelayMs,
      });
      setStatus(status);
    },
    [],
  );

  const handleReading = useCallback(
    (lap: number, frameAt: number) => {
      if (stoppedRef.current) return;
      everReadRef.current = true;
      const verdict = trackerRef.current.accept(lap);
      const action = lapPolicyRef.current.decide(verdict, lap, trackerRef.current.current());
      if (action.type === "ignore") return;
      if (action.type === "rejected" || action.type === "locked") {
        setStatus(action.status);
        return;
      }
      applyLapReading(lap, frameAt);
    },
    [applyLapReading],
  );

  // Recognizes the latest pending snapshot, if any, when the worker is
  // free. recognizeCanvas is a stable copy taken before the async recognize
  // call so later sample() ticks can keep overwriting pendingCanvas without
  // disturbing the frame the in-flight worker is reading.
  const processPending = useCallback(async () => {
    const worker = workerRef.current;
    if (!worker || recognizingRef.current || !pendingFrameRef.current) return;
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
      } catch {
        /* transient OCR failure -- the next sample retries */
      }
      if (reading) handleReading(reading.lap, frameAt);
    } finally {
      recognizingRef.current = false;
      if (pendingFrameRef.current) void processPending(); // a newer frame landed while busy
    }
  }, [handleReading, pendingCanvas, recognizeCanvas]);

  const handleLightsOut = useCallback((frameAt: number) => {
    const isRestart = lightsGateRef.current.isRestart();
    const label = lightsLabel(isRestart);
    const status = applyReading({
      anchors: liveRef.current.anchors,
      kind: "lights",
      lap: 0,
      isRestart,
      label,
      frameAt,
      nowWallMs: Date.now(),
      nowPerfMs: performance.now(),
      pipelineBiasMs: pipelineBiasMsRef.current,
      tracker: offsetTrackerRef.current,
      setDelayMs: liveRef.current.setDelayMs,
    });
    setStatus(status);
  }, []);

  // Sampling starts as soon as capture is ready -- the whole-frame lights
  // watch needs no box (at race start there IS no lap counter on screen
  // yet). The crop only gates the lap-OCR branch below.
  const sample = useCallback(() => {
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
          handleLightsOut(lightsFrameAt);
        }
      }
    }

    const box = cropRef.current;
    if (!box) return;
    sampleCountRef.current += 1;
    if (shouldNudgeNoRead(sampleCountRef.current, everReadRef.current, noReadNudgeShownRef.current)) {
      noReadNudgeShownRef.current = true;
      setStatus("No lap counter read yet — check the box covers LAP N/M");
    }

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
  }, [cropCanvas, frameCanvas, handleLightsOut, pendingCanvas, processPending, video]);

  const beginSampling = useCallback(() => {
    if (sampleTimerRef.current !== null) return; // already sampling -- box changes just take effect
    trackerRef.current = createLapTracker();
    lapPolicyRef.current = createLapVerdictPolicy();
    lightsGateRef.current = createLightsGate();
    lightsDetectorRef.current = createLightsOutDetector();
    offsetTrackerRef.current = createOffsetTracker();
    lastPixelsRef.current = null;
    pendingFrameRef.current = null;
    sampleCountRef.current = 0;
    everReadRef.current = false;
    noReadNudgeShownRef.current = false;
    sampleTimerRef.current = setInterval(() => sample(), SAMPLE_MS);
  }, [sample]);

  // Releases the stream and timers without touching `visible`/`status` --
  // shared by the Stop button (which also hides the panel) and a capture
  // failure (which keeps the panel up to show the failure).
  const releaseResources = useCallback(() => {
    stoppedRef.current = true;
    stopAutoDetect();
    if (sampleTimerRef.current !== null) clearInterval(sampleTimerRef.current);
    if (previewTimerRef.current !== null) clearInterval(previewTimerRef.current);
    sampleTimerRef.current = null;
    previewTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    video.srcObject = null;
    setPhase("idle");
  }, [stopAutoDetect, video]);

  const stop = useCallback(() => {
    releaseResources();
    setVisible(false);
    setStatus(IDLE_STATUS);
  }, [releaseResources]);

  const start = useCallback(() => {
    if (phase !== "idle") return; // in-flight guard against a double click during setup
    stoppedRef.current = false;
    // Show the panel and busy state IMMEDIATELY, before the async setup, so
    // the click always has visible feedback and a failure is never written
    // into a hidden panel.
    setVisible(true);
    setPhase("starting");
    setStatus("Loading OCR…");
    void (async () => {
      try {
        const tesseract = await loadTesseractImpl();
        setStatus("Pick the window playing the broadcast");
        const stream = await captureDisplayMediaImpl();
        streamRef.current = stream;
        stream.getVideoTracks()[0]?.addEventListener("ended", stop); // browser's own "stop sharing"
        video.srcObject = stream;
        await video.play();
        if (!workerRef.current) {
          workerRef.current = await createOcrWorkerImpl(tesseract);
        }
        setPhase("running");
        previewTimerRef.current = setInterval(drawPreview, PREVIEW_MS);
        beginSampling(); // the lights watch is live from this moment, box or not
        const remembered = readStoredCrop();
        if (remembered) {
          setCrop(remembered);
          setStatus("Checking the remembered box…");
          void validateRememberedCrop();
        } else {
          startAutoDetect();
        }
      } catch (error) {
        releaseResources();
        // panel stays visible so the failure is seen (unlike the Stop
        // button, this does not reset status to the idle message).
        setStatus(formatStartFailure(error));
      }
    })();
  }, [
    beginSampling,
    captureDisplayMediaImpl,
    drawPreview,
    loadTesseractImpl,
    createOcrWorkerImpl,
    phase,
    releaseResources,
    setCrop,
    startAutoDetect,
    stop,
    validateRememberedCrop,
    video,
  ]);

  const previewCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
    previewCanvasElRef.current = el;
  }, []);

  const boxFromDrag = useCallback(
    (dragStart: { x: number; y: number }, dragEnd: { x: number; y: number }): Crop => ({
      x: Math.min(dragStart.x, dragEnd.x),
      y: Math.min(dragStart.y, dragEnd.y),
      w: Math.abs(dragEnd.x - dragStart.x),
      h: Math.abs(dragEnd.y - dragStart.y),
    }),
    [],
  );

  const normalizedPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width || 1;
    const height = rect.height || 1;
    return { x: (event.clientX - rect.left) / width, y: (event.clientY - rect.top) / height };
  }, []);

  const onPreviewPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      dragStartRef.current = normalizedPoint(event);
    },
    [normalizedPoint],
  );

  const onPreviewPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const dragStart = dragStartRef.current;
      dragStartRef.current = null;
      if (!dragStart) return;
      const box = boxFromDrag(dragStart, normalizedPoint(event));
      if (box.w < 0.01 || box.h < 0.01) return; // stray click, keep the old box
      setCrop(box);
      writeStoredCrop(box);
      stopAutoDetect();
      setStatus("Box set — watching the lap counter there");
    },
    [boxFromDrag, normalizedPoint, setCrop, stopAutoDetect],
  );

  useEffect(() => stop, [stop]); // unmount: release the stream and timers

  return { phase, status, crop, visible, previewCanvasRef, onPreviewPointerDown, onPreviewPointerUp, start, stop };
}
