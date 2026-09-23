// Wires the pure `PlaybackClock` and `foldAt` to React: a `requestAnimationFrame`
// loop while playing, and the folded push handed to `BoardSourceProvider`.
// Unit-tested in `useReplayPlayback.test.tsx` (a stubbed rAF/`performance.now`)
// and end to end through `ReplayPage.test.tsx`; the clock math itself is
// `playbackClock.test.ts`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { numberField, stringField } from "../lib/format.ts";
import { deriveTimelineAnchors } from "../live/anchors.ts";
import type { StatePush } from "../live/types.ts";
import { foldAt, type FoldedRace, type LapMarker } from "./foldRace.ts";
import { createPlaybackClock, type PlaybackClock } from "./playbackClock.ts";
import { replayStartMs } from "./replayStart.ts";

export interface ReplayPlayback {
  push: StatePush | null;
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

/** A date string parsed to epoch ms, or null when absent or unparsable. */
function parsedOrNull(dateString: string | null): number | null {
  if (dateString === null) return null;
  const parsed = Date.parse(dateString);
  return Number.isNaN(parsed) ? null : parsed;
}

function pushFor(folded: FoldedRace, sourceMs: number): StatePush {
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

  // The cut: the formation lap, not the recording's first row.
  // `deriveTimelineAnchors` is the same lap-1 anchor `anchors().lights_out`
  // already uses (`transport/raceStart.ts`), so the notice and the seek
  // clamp never disagree on where the race actually starts.
  const dateStartMs = folded === null ? null : parsedOrNull(stringField(folded.session, "date_start"));
  const lightsOutMs = folded === null ? null : parsedOrNull(deriveTimelineAnchors(folded).lights_out);
  const startSourceMs =
    replayStartMs({
      firstSourceMs: folded?.firstSourceMs ?? null,
      lastSourceMs: folded?.lastSourceMs ?? null,
      dateStartMs,
      lightsOutMs,
    }) ?? 0;
  const endSourceMs = folded?.lastSourceMs ?? 0;

  const [sourceMs, setSourceMs] = useState(startSourceMs);
  const [isPlaying, setIsPlaying] = useState(false);

  function freshClock(): PlaybackClock | null {
    // `initialWallMs: 0` is a harmless placeholder -- `play()` and `seek()`
    // always re-baseline it before any `tick()` reads it.
    return folded === null ? null : createPlaybackClock({ startSourceMs, endSourceMs, initialWallMs: 0 });
  }

  // A new race (or a re-fold) gets a fresh clock at its own bounds; clock,
  // sourceMs, and isPlaying reset to match it. `clock` is state, not a
  // `useMemo` (a guaranteed identity, not a discardable cache), and all
  // three are adjusted during render (React's "adjusting state when a
  // prop changes" pattern) so there is no extra committed render with a
  // stale clock.
  const [clock, setClock] = useState<PlaybackClock | null>(freshClock);
  const [prevFolded, setPrevFolded] = useState(folded);
  if (prevFolded !== folded) {
    setPrevFolded(folded);
    setClock(freshClock());
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

  const push = useMemo<StatePush | null>(() => {
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
