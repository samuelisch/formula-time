// Wires the pure `PlaybackClock` and `foldAt` to React: a `requestAnimationFrame`
// loop while playing, and the folded push handed to `BoardSourceProvider`.
// Unit-tested in `useReplayPlayback.test.tsx` (a stubbed rAF/`performance.now`)
// and end to end through `ReplayPage.test.tsx`; the clock math itself is
// `playbackClock.test.ts`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { numberField, stringField } from "../lib/format.ts";
import type { LivePush } from "../live/types.ts";
import { foldAt, type FoldedRace, type LapMarker } from "./foldRace.ts";
import { createPlaybackClock, type PlaybackClock } from "./playbackClock.ts";

export interface ReplayPlayback {
  push: LivePush | null;
  sourceMs: number;
  isPlaying: boolean;
  startSourceMs: number;
  endSourceMs: number;
  lapMarkers: LapMarker[];
  play(): void;
  pause(): void;
  seek(sourceMs: number): void;
  jumpToStart(): void;
}

function pushFor(folded: FoldedRace, sourceMs: number): LivePush {
  const state = foldAt(folded, sourceMs);
  return {
    type: "state",
    seq: String(state.sequence),
    sent_at: Date.now(),
    // `foldRace` normalizes `session_key` to a string (matching the live
    // projector's `sessionAsRawRecord()`), so this reads it as one rather
    // than `numberField` -- see foldRace.ts's `normalizedSessionRow`.
    session_key: stringField(folded.session, "session_key") ?? "",
    total_laps: numberField(folded.session, "total_laps"),
    state,
    polls: [],
  };
}

/** Drives playback for a folded race: a `PlaybackClock` plus a `requestAnimationFrame` loop while playing. */
export function useReplayPlayback(folded: FoldedRace | null): ReplayPlayback {
  const rafRef = useRef<number | null>(null);

  const startSourceMs = folded?.firstSourceMs ?? 0;
  const endSourceMs = folded?.lastSourceMs ?? 0;

  const [sourceMs, setSourceMs] = useState(startSourceMs);
  const [isPlaying, setIsPlaying] = useState(false);

  // A new race (or a re-fold) gets a fresh clock at its own bounds, derived
  // straight from `folded` so it stays the same instance across renders of
  // the same fold. `initialWallMs: 0` is a harmless placeholder -- `play()`
  // and `seek()` always re-baseline it before any `tick()` reads it.
  const clock = useMemo<PlaybackClock | null>(
    () => (folded === null ? null : createPlaybackClock({ startSourceMs, endSourceMs, initialWallMs: 0 })),
    [folded, startSourceMs, endSourceMs],
  );

  // sourceMs/isPlaying reset to match a new clock. Adjusted during render
  // rather than in an effect (React's "adjusting state when a prop
  // changes" pattern) so there is no extra committed render with a stale
  // clock; `prevFolded` is the "previous props" this compares against.
  const [prevFolded, setPrevFolded] = useState(folded);
  if (prevFolded !== folded) {
    setPrevFolded(folded);
    setSourceMs(startSourceMs);
    setIsPlaying(false);
  }

  useEffect(() => {
    if (!isPlaying || clock === null) return;
    const activeClock = clock;
    let cancelled = false;

    function frame(): void {
      if (cancelled) return;
      setSourceMs(activeClock.tick(performance.now()));
      if (!activeClock.isPlaying()) {
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
  }, [isPlaying, clock]);

  const play = useCallback(() => {
    if (clock === null) return;
    clock.play();
    setIsPlaying(clock.isPlaying());
  }, [clock]);

  const pause = useCallback(() => {
    if (clock === null) return;
    clock.pause();
    setIsPlaying(false);
  }, [clock]);

  const seek = useCallback(
    (target: number) => {
      if (clock === null) return;
      clock.seek(target);
      setSourceMs(clock.sourceMs());
    },
    [clock],
  );

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
    startSourceMs,
    endSourceMs,
    lapMarkers: folded?.lapMarkers ?? [],
    play,
    pause,
    seek,
    jumpToStart,
  };
}
