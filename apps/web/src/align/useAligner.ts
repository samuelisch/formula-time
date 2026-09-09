// Owns capture, timers, and the OCR worker for auto-align; React
// (AlignPanel.tsx) owns nothing but rendering this state. Everything
// DOM-free lives in policy.ts; every DOM/media/OCR touch point is a function
// from capture.ts, overridable here for tests.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useBoardLeaderLap, useBoardRaceControl } from "../board/useBoardState.ts";
import { useTimeTarget } from "../transport/TimeTarget.ts";
import type { TimeTarget } from "../transport/TimeTarget.ts";
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
  NO_READ_NUDGE_STATUS,
  resolvePipelineBiasMs,
  SAMPLE_MS,
  shouldNudgeNoRead,
  type Crop,
  type ObserveKind,
} from "./policy.ts";

const PREVIEW_MS = 200;
const AUTO_DETECT_MS = 3_000;
const PREVIEW_WIDTH = 480;

/**
 * Routes one anchored observation's computed offset through the
 * `TimeTarget` seam instead of a raw `setDelayMs`. `ms` is exactly what
 * `applyReading` passes to `setDelayMs`, always `Math.max(0, offsetMs)`,
 * and `offsetMs` is `OffsetTracker.offsetMs()` (`core.ts`): `observedWall −
 * anchorSourceMs`. That is a constant mapping between the viewer's wall
 * clock and the data's source-time axis -- true whether the anchor is
 * seconds old (live) or days old (a replay recording) -- so the position to
 * show is always `sourceMs = nowWallMs − offsetMs`, on both platforms. One
 * branch, no anchor needed here.
 *
 * `now` must be the SAME wall clock `observedWall` itself was computed
 * from (the caller closes over one `nowWallMs = Date.now()` for both), not
 * a fresh `Date.now()` call here -- otherwise the two calls' sub-ms drift
 * leaks into the position.
 *
 * Live: `seekTo(atMs)` resolves to `setDelayMs(now() − atMs)` (floored at
 * 0), so seeking to `now() − ms` sets the delay to exactly `ms`.
 *
 * Replay: seeks the playback clock to `nowWallMs − offsetMs`, which lands
 * at the anchor's own source time (plus whatever small residual `now`
 * differs from `observedWall`) -- not `anchorMs + ms`, which is wrong
 * end to end for a historic anchor (`ms` is then days, not a lead) and
 * clamps to the end of the recording. Playback always resumes, never
 * pauses.
 */
export function applyOffsetToTarget(target: TimeTarget, ms: number, now: () => number = Date.now): void {
  target.seekTo(now() - ms);
  target.playback()?.play();
}

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

  // Read through the `TimeTarget` seam (`anchors()`, and the apply rule
  // below) and through the board-source seam (`leaderLap`, `sessionStatus`,
  // both of which must reflect the *displayed* push -- the replay fold on a
  // replay, never the live store; `useBoardLeaderLap` reads the viewer's
  // own lap, never the live one) -- never the live store directly.
  const target = useTimeTarget();
  const anchors = target.anchors();
  const leaderLap = useBoardLeaderLap();
  const sessionStatus = useBoardRaceControl().session_status;

  const [phase, setPhase] = useState<AlignerPhase>("idle");
  const [status, setStatus] = useState(IDLE_STATUS);
  const [crop, setCropState] = useState<Crop | null>(null);
  // Separate from `phase`: a capture failure resets phase to "idle" (so the
  // user can retry) but keeps the panel up so the failure status stays
  // visible.
  const [visible, setVisible] = useState(false);

  // Live values the sampling loop (a plain interval callback, outside
  // React's render cycle) needs to read without re-subscribing on every
  // change -- kept current via a ref, synced from a layout effect after
  // each render so the write never happens during render itself. Must be
  // `useLayoutEffect`, not `useEffect`: layout effects flush synchronously
  // right after commit, in the same tick, before the browser can run any
  // queued macrotask -- so `sample()`'s `setInterval` (SAMPLE_MS) can never
  // observe a commit whose ref sync hasn't run yet. A plain `useEffect` is
  // scheduled after paint and would open exactly that staleness window.
  const liveRef = useRef({ anchors, leaderLap, sessionStatus, target });
  useLayoutEffect(() => {
    liveRef.current = { anchors, leaderLap, sessionStatus, target };
  });

  // Offscreen DOM handles this hook owns imperatively (drawn into and
  // resized from timer/OCR callbacks, not from render) -- lazily created
  // refs, never React state: mutating them must never schedule a re-render.
  // Each does exactly one `ref.current = ...` write, the pattern React's own
  // docs carve out as the one safe ref write during render.
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  if (videoElRef.current === null) {
    const el = document.createElement("video");
    el.muted = true;
    videoElRef.current = el;
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
    const el = document.createElement("canvas");
    el.width = 480;
    el.height = 270;
    frameCanvasElRef.current = el;
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
  // Bumped on every start()/stop(): start()'s async setup chain checks this
  // after each await and abandons itself (releasing whatever it already
  // acquired) the moment it no longer matches -- a Stop mid-setup, or a
  // Stop-then-Start that starts a second chain before the first settles.
  const startGenRef = useRef(0);

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

  // Shared by a lap flip (kind "flip") and a lights-out fire (kind
  // "lights") -- the only two anchored observations. One wall-clock read
  // shared with `applyOffsetToTarget`'s `now` below -- both must use the
  // exact same `nowWallMs` (see that function's doc comment), not two
  // separate `Date.now()` calls a few lines apart.
  const applyObservedReading = useCallback((kind: ObserveKind, lap: number, isRestart: boolean, label: string, frameAt: number) => {
    const nowWallMs = Date.now();
    const status = applyReading({
      anchors: liveRef.current.anchors,
      kind,
      lap,
      isRestart,
      label,
      frameAt,
      nowWallMs,
      nowPerfMs: performance.now(),
      pipelineBiasMs: pipelineBiasMsRef.current,
      tracker: offsetTrackerRef.current,
      setDelayMs: (ms) => applyOffsetToTarget(liveRef.current.target, ms, () => nowWallMs),
    });
    setStatus(status);
  }, []);

  // The reading applies whether it's a lap flip or the genuine first-ever
  // lock at lap 1 -- both are "flip" kind for the offset tracker; lights-out
  // is the separate pixel path below.
  const applyLapReading = useCallback(
    (lap: number, frameAt: number) => {
      applyObservedReading("flip", lap, false, `Lap ${lap}`, frameAt);
    },
    [applyObservedReading],
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

  const handleLightsOut = useCallback(
    (frameAt: number) => {
      const isRestart = lightsGateRef.current.isRestart();
      applyObservedReading("lights", 0, isRestart, lightsLabel(isRestart), frameAt);
    },
    [applyObservedReading],
  );

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
      setStatus(NO_READ_NUDGE_STATUS);
    }

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
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) {
      void (async () => {
        try {
          await worker.terminate();
        } catch {
          /* the worker/tab is already gone; nothing to clean up further */
        }
      })();
    }
    setPhase("idle");
  }, [stopAutoDetect, video]);

  const stop = useCallback(() => {
    startGenRef.current += 1; // orphans any in-flight start() chain -- see its per-await checks below
    releaseResources();
    setVisible(false);
    setStatus(IDLE_STATUS);
  }, [releaseResources]);

  const start = useCallback(() => {
    if (phase !== "idle") return; // in-flight guard against a double click during setup
    stoppedRef.current = false;
    const gen = ++startGenRef.current;
    // Show the panel and busy state IMMEDIATELY, before the async setup, so
    // the click always has visible feedback and a failure is never written
    // into a hidden panel.
    setVisible(true);
    setPhase("starting");
    setStatus("Loading OCR…");
    void (async () => {
      // This chain's OWN acquisitions, tracked locally so a stale-chain
      // cleanup (below, and in the catch block) releases exactly what THIS
      // chain got -- never streamRef.current/workerRef.current/
      // video.srcObject, which by the time a stale chain resumes may
      // already belong to a newer chain that ran to completion in the
      // meantime. Only a chain still holding the current generation ever
      // assigns to those shared refs.
      let ownStream: MediaStream | null = null;
      let ownWorker: OcrWorker | null = null;
      // Re-checked after every await below: a Stop mid-setup (stoppedRef) or
      // a Stop-then-Start that let a second chain start (gen mismatch) must
      // not let this chain go on to show "running" with capture/OCR the
      // user already asked to stop, or clobber the newer chain's
      // stream/worker.
      const isStale = () => gen !== startGenRef.current || stoppedRef.current;
      try {
        const tesseract = await loadTesseractImpl();
        if (isStale()) return;
        setStatus("Pick the window playing the broadcast");

        const stream = await captureDisplayMediaImpl();
        ownStream = stream;
        if (isStale()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        stream.getVideoTracks()[0]?.addEventListener("ended", stop); // browser's own "stop sharing"
        video.srcObject = stream;

        await video.play();
        if (isStale()) {
          // This chain's own stream -- NOT streamRef.current, which by now
          // may already hold a newer chain's stream (and video.srcObject
          // already shows it); never touched here.
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        let worker = workerRef.current;
        if (!worker) {
          worker = await createOcrWorkerImpl(tesseract);
          ownWorker = worker;
          if (isStale()) {
            // Likewise: this chain's own freshly-created worker and stream,
            // never workerRef.current/streamRef.current/video.srcObject.
            void worker.terminate().catch(() => {});
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          workerRef.current = worker;
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
        // A stale chain's own error (e.g. its getDisplayMedia rejects after
        // it's already been superseded) must not stomp the current chain's
        // state -- only the chain that still owns `gen` reports failure.
        if (gen === startGenRef.current) {
          releaseResources();
          // panel stays visible so the failure is seen (unlike the Stop
          // button, this does not reset status to the idle message).
          setStatus(formatStartFailure(error));
        } else {
          // A stale chain that had already acquired its own stream/worker
          // before throwing still must not leak them -- release only those,
          // never the shared refs a newer chain may now own.
          ownStream?.getTracks().forEach((track) => track.stop());
          if (ownWorker) void ownWorker.terminate().catch(() => {});
        }
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
