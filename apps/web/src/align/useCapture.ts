// Owns the screen-capture lifecycle for auto-align: the generation-guarded
// start/stop chain (tesseract load -> getDisplayMedia -> video.play() ->
// OCR worker creation), the offscreen video element, the preview canvas
// with its crop overlay, and drag-to-override the crop box. No OCR
// sampling and no reading policy here -- `useOcrLoop.ts` drives the worker
// this hook hands it once `onRunning` fires; `status` is owned by the
// caller (`useAligner.ts`) and only ever written here through `setStatus`.
import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  captureDisplayMedia as defaultCaptureDisplayMedia,
  createOcrWorker as defaultCreateOcrWorker,
  drawInto,
  loadTesseract as defaultLoadTesseract,
  strokeRect,
  writeStoredCrop,
  type OcrWorker,
  type TesseractModule,
} from "./capture.ts";
import { formatStartFailure, type Crop } from "./policy.ts";

const PREVIEW_MS = 200;
const PREVIEW_WIDTH = 480;

export type AlignerPhase = "idle" | "starting" | "running";

export interface UseCaptureOptions {
  captureDisplayMedia: (() => Promise<MediaStream>) | undefined;
  loadTesseract: (() => Promise<TesseractModule>) | undefined;
  createOcrWorker: ((tesseract: TesseractModule) => Promise<OcrWorker>) | undefined;
  /** The only place this hook writes a status line -- everything else
   * (reading outcomes, auto-detect progress) is the caller's job. */
  setStatus: (status: string) => void;
  /** Fires once capture + the OCR worker are both ready, right as phase
   * flips to "running" -- the caller starts sampling from here. */
  onRunning: (worker: OcrWorker) => void;
  /** Fires at the end of an explicit stop (button, unmount, or the
   * browser's own "stop sharing") -- never on a start failure, which keeps
   * the panel up showing the failure instead. */
  onStop: () => void;
  /** Fires when the user drags a crop box by hand, so an in-progress
   * auto-detect scan can be cancelled. */
  onManualCrop: () => void;
}

export interface CaptureState {
  phase: AlignerPhase;
  visible: boolean;
  crop: Crop | null;
  /** Sets the crop box (no persistence -- callers that need the box
   * remembered call `writeStoredCrop`/`clearStoredCrop` from `capture.ts`
   * themselves, same as the drag handler below does). */
  setCrop: (next: Crop | null) => void;
  /** The crop box read live, outside React's render cycle -- for a
   * sampling timer that must never close over a stale value. */
  getCrop: () => Crop | null;
  previewCanvasRef: (el: HTMLCanvasElement | null) => void;
  onPreviewPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onPreviewPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  start: () => void;
  stop: () => void;
  /** The offscreen video element sampling reads frames from -- stable
   * across the whole component lifetime, `videoWidth === 0` until a stream
   * is attached and playing. */
  frame: () => HTMLVideoElement;
}

export function useCapture(options: UseCaptureOptions): CaptureState {
  const captureDisplayMediaImpl = options.captureDisplayMedia ?? defaultCaptureDisplayMedia;
  const loadTesseractImpl = options.loadTesseract ?? defaultLoadTesseract;
  const createOcrWorkerImpl = options.createOcrWorker ?? defaultCreateOcrWorker;
  const { setStatus, onRunning, onStop, onManualCrop } = options;

  const [phase, setPhase] = useState<AlignerPhase>("idle");
  const [crop, setCropState] = useState<Crop | null>(null);
  // Separate from `phase`: a capture failure resets phase to "idle" (so the
  // user can retry) but keeps the panel up so the failure status stays
  // visible.
  const [visible, setVisible] = useState(false);

  // Offscreen DOM handles this hook owns imperatively (drawn into and
  // resized from timer callbacks, not from render) -- lazily created refs,
  // never React state: mutating them must never schedule a re-render. Each
  // does exactly one `ref.current = ...` write, the pattern React's own
  // docs carve out as the one safe ref write during render.
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  if (videoElRef.current === null) {
    const el = document.createElement("video");
    el.muted = true;
    videoElRef.current = el;
  }
  const video = videoElRef.current;

  const previewCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<OcrWorker | null>(null);
  const cropRef = useRef<Crop | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(true);
  // Bumped on every start()/stop(): start()'s async setup chain checks this
  // after each await and abandons itself (releasing whatever it already
  // acquired) the moment it no longer matches -- a Stop mid-setup, or a
  // Stop-then-Start that starts a second chain before the first settles.
  const startGenRef = useRef(0);

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

  // Releases the stream, the OCR worker, and the preview timer without
  // touching `visible`/`status` -- shared by the Stop button (which also
  // hides the panel) and a capture failure (which keeps the panel up to
  // show the failure).
  const releaseResources = useCallback(() => {
    stoppedRef.current = true;
    if (previewTimerRef.current !== null) clearInterval(previewTimerRef.current);
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
  }, [video]);

  const stop = useCallback(() => {
    startGenRef.current += 1; // orphans any in-flight start() chain -- see its per-await checks below
    releaseResources();
    setVisible(false);
    onStop();
  }, [releaseResources, onStop]);

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
        onRunning(worker);
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
  }, [captureDisplayMediaImpl, drawPreview, loadTesseractImpl, createOcrWorkerImpl, onRunning, phase, releaseResources, setStatus, stop, video]);

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
      onManualCrop();
      setStatus("Box set — watching the lap counter there");
    },
    [boxFromDrag, normalizedPoint, onManualCrop, setCrop, setStatus],
  );

  const frame = useCallback(() => video, [video]);
  const getCrop = useCallback(() => cropRef.current, []);

  return { phase, visible, crop, setCrop, getCrop, previewCanvasRef, onPreviewPointerDown, onPreviewPointerUp, start, stop, frame };
}
