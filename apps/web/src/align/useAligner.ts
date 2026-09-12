// Composes the auto-align pieces `AlignPanel.tsx` renders: `useCapture.ts`
// owns screen capture and the OCR worker's lifecycle, `useOcrLoop.ts`
// drives that worker to produce readings, and `applyOffset.ts` sequences a
// reading into a delay applied through the `TimeTarget` seam. This hook
// owns `status` and `diagnostics` -- the state all three write to -- and
// the board/`TimeTarget` seams none of the others may read directly.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useBoardLeaderLap, useBoardRaceControl } from "../board/useBoardState.ts";
import { useTimeTarget } from "../transport/TimeTarget.ts";
import { applyOffsetToTarget, createReadingTrackers, handleLapRead, handleLightsOutRead, type ReadingTrackers } from "./applyOffset.ts";
import type { OcrWorker, TesseractModule } from "./capture.ts";
import { summarizeVerdict } from "./core.ts";
import { resolvePipelineBiasMs, type Crop } from "./policy.ts";
import { useCapture, type AlignerPhase } from "./useCapture.ts";
import { useOcrLoop, type OcrLoopControls, type OcrSample } from "./useOcrLoop.ts";

export { applyOffsetToTarget };
export type { AlignerPhase };

export interface UseAlignerOptions {
  captureDisplayMedia?: () => Promise<MediaStream>;
  loadTesseract?: () => Promise<TesseractModule>;
  createOcrWorker?: (tesseract: TesseractModule) => Promise<OcrWorker>;
}

/** What the diagnostics line and its verdict history render -- fed by
 * `useOcrLoop`'s `onSample` (raw OCR attempts) and by the short label
 * `summarizeVerdict` derives from each `handleLapRead`/`handleLightsOutRead`
 * outcome. Reset whenever a run starts, same as the reading trackers. */
export interface Diagnostics {
  /** Last raw OCR text, trimmed for display, or null before any sample. */
  lastText: string | null;
  /** Last recognize() rejection's message; cleared by the next success. */
  lastError: string | null;
  lastSampleAt: number | null;
  attempts: number;
  accepted: number;
  /** Most recent verdict labels, oldest first, capped at 3. */
  history: string[];
}

const EMPTY_DIAGNOSTICS: Diagnostics = { lastText: null, lastError: null, lastSampleAt: null, attempts: 0, accepted: 0, history: [] };
const DIAGNOSTICS_TEXT_LENGTH = 24;
const HISTORY_LIMIT = 3;

export interface AlignerState {
  phase: AlignerPhase;
  status: string;
  diagnostics: Diagnostics;
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
  // Read through the `TimeTarget` seam (`anchors()`, and the apply rule in
  // applyOffset.ts) and through the board-source seam (`leaderLap`,
  // `sessionStatus`, both of which must reflect the *displayed* push -- the
  // replay fold on a replay, never the live store; `useBoardLeaderLap`
  // reads the viewer's own lap, never the live one) -- never the live store
  // directly.
  const target = useTimeTarget();
  const anchors = target.anchors();
  const leaderLap = useBoardLeaderLap();
  const sessionStatus = useBoardRaceControl().session_status;

  const [status, setStatus] = useState(IDLE_STATUS);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(EMPTY_DIAGNOSTICS);
  const readingTrackersRef = useRef<ReadingTrackers>(createReadingTrackers());
  const pipelineBiasMsRef = useRef(resolvePipelineBiasMs(window.location.search));

  const pushHistory = useCallback((label: string) => {
    setDiagnostics((prev) => ({ ...prev, history: [...prev.history, label].slice(-HISTORY_LIMIT) }));
  }, []);

  const onSample = useCallback((sample: OcrSample) => {
    setDiagnostics((prev) =>
      "error" in sample
        ? { ...prev, lastText: null, lastError: sample.error, lastSampleAt: Date.now(), attempts: prev.attempts + 1 }
        : {
            ...prev,
            lastText: sample.text.trim().slice(0, DIAGNOSTICS_TEXT_LENGTH),
            lastError: null,
            lastSampleAt: Date.now(),
            attempts: prev.attempts + 1,
            accepted: prev.accepted + (sample.parsed ? 1 : 0),
          },
    );
  }, []);

  // `onLapReading`/`onLightsOut` fire from useOcrLoop's sampling timer,
  // outside React's render cycle -- kept current the same way useOcrLoop's
  // own liveRef is, so a reading always applies against the latest anchors
  // and TimeTarget rather than a stale render's closure.
  const liveRef = useRef({ anchors, target });
  useLayoutEffect(() => {
    liveRef.current = { anchors, target };
  });

  const readingContext = useCallback(() => ({ anchors: liveRef.current.anchors, target: liveRef.current.target, pipelineBiasMs: pipelineBiasMsRef.current }), []);

  const onLapReading = useCallback(
    (lap: number, frameAt: number) => {
      const outcome = handleLapRead(lap, frameAt, readingTrackersRef.current, readingContext());
      if (outcome !== null) {
        setStatus(outcome);
        pushHistory(summarizeVerdict(outcome));
      }
    },
    [readingContext, pushHistory],
  );

  const onLightsOut = useCallback(
    (frameAt: number, isRestart: boolean) => {
      const outcome = handleLightsOutRead(frameAt, isRestart, readingTrackersRef.current, readingContext());
      setStatus(outcome);
      pushHistory(summarizeVerdict(outcome));
    },
    [readingContext, pushHistory],
  );

  // Bridges useCapture -> useOcrLoop: useCapture is created first (its
  // start() chain needs `onRunning` before useOcrLoop exists yet), so
  // `onRunning`/`onStop`/`onManualCrop` reach the OCR loop through a ref
  // synced after useOcrLoop is created below.
  const ocrLoopRef = useRef<OcrLoopControls | null>(null);

  const onRunning = useCallback((worker: OcrWorker) => {
    readingTrackersRef.current = createReadingTrackers();
    setDiagnostics(EMPTY_DIAGNOSTICS);
    ocrLoopRef.current?.begin(worker);
  }, []);

  const onStop = useCallback(() => {
    ocrLoopRef.current?.stop();
    setStatus(IDLE_STATUS);
    setDiagnostics(EMPTY_DIAGNOSTICS);
  }, []);

  const onManualCrop = useCallback(() => {
    ocrLoopRef.current?.cancelAutoDetect();
  }, []);

  const capture = useCapture({
    captureDisplayMedia: options.captureDisplayMedia,
    loadTesseract: options.loadTesseract,
    createOcrWorker: options.createOcrWorker,
    setStatus,
    onRunning,
    onStop,
    onManualCrop,
  });

  const ocrLoop = useOcrLoop({
    frame: capture.frame,
    getCrop: capture.getCrop,
    setCrop: capture.setCrop,
    setStatus,
    onLapReading,
    onLightsOut,
    onSample,
    leaderLap,
    sessionStatus,
  });
  useLayoutEffect(() => {
    ocrLoopRef.current = ocrLoop;
  });

  useEffect(() => capture.stop, [capture.stop]); // unmount: release the stream, worker, and timers

  return {
    phase: capture.phase,
    status,
    diagnostics,
    crop: capture.crop,
    visible: capture.visible,
    previewCanvasRef: capture.previewCanvasRef,
    onPreviewPointerDown: capture.onPreviewPointerDown,
    onPreviewPointerUp: capture.onPreviewPointerUp,
    start: capture.start,
    stop: capture.stop,
  };
}
