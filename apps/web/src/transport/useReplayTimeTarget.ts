// The replay `TimeTarget`: wraps `useReplayPlayback`'s clock and derives
// jump anchors from the folded race rather than from pushes accumulated
// since connecting, via `deriveTimelineAnchors` (`live/anchors.ts`), shared
// with the live `TimeTarget` once a full-race timeline is loaded there too.
import { useMemo, useState } from "react";

import { deriveTimelineAnchors, type Anchors } from "../live/anchors.ts";
import type { FoldedRace } from "../replay/foldRace.ts";
import type { ReplayPlayback } from "../replay/useReplayPlayback.ts";
import type { TimeTarget } from "./TimeTarget.ts";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const EMPTY_ANCHORS: Anchors = { lights_out: null, laps: [], restarts: [] };

/** `folded` is the same value passed to `useReplayPlayback` -- pass both so anchors and playback always describe the same fold. */
export function useReplayTimeTarget(playback: ReplayPlayback, folded: FoldedRace | null): TimeTarget {
  const anchors = useMemo<Anchors>(() => (folded === null ? EMPTY_ANCHORS : deriveTimelineAnchors(folded)), [folded]);

  // Un-nudged sync offset: the net effect of every `seekTo`/`nudge` call on
  // a fold, in ms. Ticking while playing advances the real position
  // (`playback.sourceMs`) and an "un-nudged, played straight through"
  // reference by the same amount every frame, so their difference never
  // moves except at the instant of a seek, where it steps by exactly how
  // far that seek actually moved the (clamped) position -- no separate
  // wall-clock tracking needed, just an accumulator reset to 0 whenever
  // `folded` changes identity (a revisit to a cached fold -- TanStack
  // Query's `staleTime: Infinity` can hand back the same `FoldedRace`
  // object -- must not resurface a stale offset). React's sanctioned
  // "adjust state during render" pattern: comparing state to the current
  // prop and calling `setState` during render, instead of reading a ref
  // during render.
  const [offset, setOffset] = useState<{ fold: FoldedRace | null; ms: number }>({ fold: folded, ms: 0 });
  if (offset.fold !== folded) {
    setOffset({ fold: folded, ms: 0 });
  }
  const offsetMs = offset.fold === folded ? offset.ms : 0;

  return useMemo<TimeTarget>(() => {
    function addOffset(deltaMs: number): void {
      if (folded === null) return;
      setOffset((prev) => ({ fold: folded, ms: (prev.fold === folded ? prev.ms : 0) + deltaMs }));
    }

    return {
      displayedAt: () => (folded === null ? null : playback.sourceMs),

      seekTo: (atMs: number) => {
        const clamped = clamp(atMs, playback.startSourceMs, playback.endSourceMs);
        addOffset(clamped - playback.sourceMs);
        playback.seek(atMs);
      },

      nudge: (deltaMs: number) => {
        const clamped = clamp(playback.sourceMs + deltaMs, playback.startSourceMs, playback.endSourceMs);
        addOffset(clamped - playback.sourceMs);
        playback.seek(playback.sourceMs + deltaMs);
      },

      anchors: () => anchors,

      range: () => (folded === null ? null : { startMs: playback.startSourceMs, endMs: playback.endSourceMs }),

      playback: () => ({
        playing: playback.isPlaying,
        play: playback.play,
        pause: playback.pause,
      }),

      // Always null: a replay holds the whole fold, so every position in
      // `range()` is exactly what was asked for -- there is no buffered-span
      // shortfall to warn about the way live has.
      notice: () => null,

      syncOffsetMs: () => (folded === null ? null : offsetMs),

      // Replay has no rewind mode of its own -- the whole fold is always
      // seekable, there is no buffer/timeline distinction to report.
      rewindMode: () => null,
    };
  }, [folded, playback, anchors, offsetMs]);
}
