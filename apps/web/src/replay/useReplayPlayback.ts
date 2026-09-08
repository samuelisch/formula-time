// Wires the pure `PlaybackClock` and `foldAt` to React: a `requestAnimationFrame`
// loop while playing, and the folded push handed to `BoardSourceProvider`.
// Not unit-tested on its own (issue #57's test list covers this through
// `ReplayPage.test.tsx`); the clock math itself is `playbackClock.test.ts`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { numberField, text } from "../lib/format.ts";
import type { LivePush } from "../live/types.ts";
import { foldAt, type FoldedRace, type LapMarker } from "./foldRace.ts";
import { createPlaybackClock, type PlaybackClock, type PlaybackSpeed } from "./playbackClock.ts";

export interface ReplayPlayback {
  push: LivePush | null;
  sourceMs: number;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  startSourceMs: number;
  endSourceMs: number;
  lapMarkers: LapMarker[];
  play(): void;
  pause(): void;
  setSpeed(speed: PlaybackSpeed): void;
  seek(sourceMs: number): void;
  jumpToStart(): void;
}

function pushFor(folded: FoldedRace, sourceMs: number): LivePush {
  const state = foldAt(folded, sourceMs);
  return {
    type: "state",
    seq: String(state.sequence),
    sent_at: Date.now(),
    session_key: text(numberField(folded.session, "session_key")),
    total_laps: numberField(folded.session, "total_laps"),
    state,
    polls: [],
  };
}

/** Drives playback for a folded race: a `PlaybackClock` plus a `requestAnimationFrame` loop while playing. */
export function useReplayPlayback(folded: FoldedRace | null): ReplayPlayback {
  const clockRef = useRef<PlaybackClock | null>(null);
  const rafRef = useRef<number | null>(null);

  const startSourceMs = folded?.firstSourceMs ?? 0;
  const endSourceMs = folded?.lastSourceMs ?? 0;

  const [sourceMs, setSourceMs] = useState(startSourceMs);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);

  // A new race (or a re-fold) gets a fresh clock at its own bounds. Adjusted
  // during render rather than in an effect (React's "adjusting state when a
  // prop changes" pattern) so there is no extra committed render with a
  // stale clock; `foldedRef` is the "previous props" this compares against.
  const foldedRef = useRef<FoldedRace | null>(null);
  if (foldedRef.current !== folded) {
    foldedRef.current = folded;
    clockRef.current =
      folded === null ? null : createPlaybackClock({ startSourceMs, endSourceMs, initialWallMs: performance.now() });
    setSourceMs(startSourceMs);
    setIsPlaying(false);
    setSpeedState(1);
  }

  useEffect(() => {
    if (!isPlaying) return;
    let cancelled = false;

    function frame(): void {
      if (cancelled) return;
      const clock = clockRef.current;
      if (clock === null) return;
      setSourceMs(clock.tick(performance.now()));
      if (!clock.isPlaying()) {
        setIsPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying]);

  const play = useCallback(() => {
    const clock = clockRef.current;
    if (clock === null) return;
    clock.play();
    setIsPlaying(clock.isPlaying());
  }, []);

  const pause = useCallback(() => {
    const clock = clockRef.current;
    if (clock === null) return;
    clock.pause();
    setIsPlaying(false);
  }, []);

  const setSpeed = useCallback((next: PlaybackSpeed) => {
    clockRef.current?.setSpeed(next);
    setSpeedState(next);
  }, []);

  const seek = useCallback((target: number) => {
    const clock = clockRef.current;
    if (clock === null) return;
    clock.seek(target);
    setSourceMs(clock.sourceMs());
  }, []);

  const jumpToStart = useCallback(() => {
    seek(startSourceMs);
  }, [seek, startSourceMs]);

  const push = useMemo<LivePush | null>(() => {
    if (folded === null) return null;
    return pushFor(folded, sourceMs);
  }, [folded, sourceMs]);

  return {
    push,
    sourceMs,
    isPlaying,
    speed,
    startSourceMs,
    endSourceMs,
    lapMarkers: folded?.lapMarkers ?? [],
    play,
    pause,
    setSpeed,
    seek,
    jumpToStart,
  };
}
