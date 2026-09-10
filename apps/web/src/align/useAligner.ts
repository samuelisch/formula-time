// Composes the auto-align pieces `AlignPanel.tsx` renders: `useCapture.ts`
// owns screen capture and the OCR worker's lifecycle, `useOcrLoop.ts`
// drives that worker to produce readings, and `applyOffset.ts` sequences a
// reading into a delay applied through the `TimeTarget` seam. This hook
// owns only `status` -- the one piece of state all three write to -- and
// the board/`TimeTarget` seams none of the others may read directly.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useBoardLeaderLap, useBoardRaceControl } from "../board/useBoardState.ts";
import { useTimeTarget } from "../transport/TimeTarget.ts";
import { applyOffsetToTarget, createReadingTrackers, handleLapRead, handleLightsOutRead, type ReadingTrackers } from "./applyOffset.ts";
import type { OcrWorker, TesseractModule } from "./capture.ts";
import { resolvePipelineBiasMs, type Crop } from "./policy.ts";
import { useCapture, type AlignerPhase } from "./useCapture.ts";
import { useOcrLoop, type OcrLoopControls } from "./useOcrLoop.ts";

export { applyOffsetToTarget };
export type { AlignerPhase };

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
  const readingTrackersRef = useRef<ReadingTrackers>(createReadingTrackers());
  const pipelineBiasMsRef = useRef(resolvePipelineBiasMs(window.location.search));

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
      if (outcome !== null) setStatus(outcome);
    },
    [readingContext],
  );

  const onLightsOut = useCallback(
    (frameAt: number, isRestart: boolean) => {
      setStatus(handleLightsOutRead(frameAt, isRestart, readingTrackersRef.current, readingContext()));
    },
    [readingContext],
  );

  // Bridges useCapture -> useOcrLoop: useCapture is created first (its
  // start() chain needs `onRunning` before useOcrLoop exists yet), so
  // `onRunning`/`onStop`/`onManualCrop` reach the OCR loop through a ref
  // synced after useOcrLoop is created below.
  const ocrLoopRef = useRef<OcrLoopControls | null>(null);

  const onRunning = useCallback((worker: OcrWorker) => {
    readingTrackersRef.current = createReadingTrackers();
    ocrLoopRef.current?.begin(worker);
  }, []);

  const onStop = useCallback(() => {
    ocrLoopRef.current?.stop();
    setStatus(IDLE_STATUS);
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
    crop: capture.crop,
    visible: capture.visible,
    previewCanvasRef: capture.previewCanvasRef,
    onPreviewPointerDown: capture.onPreviewPointerDown,
    onPreviewPointerUp: capture.onPreviewPointerUp,
    start: capture.start,
    stop: capture.stop,
  };
}
