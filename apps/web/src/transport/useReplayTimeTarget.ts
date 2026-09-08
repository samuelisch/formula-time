// The replay `TimeTarget`: wraps `useReplayPlayback`'s clock and derives
// jump anchors from the folded race rather than from pushes accumulated
// since connecting (issue #81). Lap N's anchor is `FoldedRace.lapMarkers`
// (already "the first source time the leader reached this lap" -- see
// `foldRace.ts`); lights-out is lap 1's anchor; restarts come from
// "SESSION STARTED" race-control events across the whole fold, mirroring
// `live/anchors.ts`'s `deriveAnchors` but over every event rather than a
// rolling 100-row window.
import { useMemo, useRef } from "react";

import type { Anchors } from "../live/anchors.ts";
import type { FoldedRace } from "../replay/foldRace.ts";
import type { ReplayPlayback } from "../replay/useReplayPlayback.ts";
import type { TimeTarget } from "./TimeTarget.ts";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const EMPTY_ANCHORS: Anchors = { lights_out: null, laps: [], restarts: [] };

/** Pure: the same `Anchors` shape the live store folds, built from a completed fold instead of accumulated pushes. */
export function deriveReplayAnchors(folded: FoldedRace): Anchors {
  const laps = folded.lapMarkers.map((marker) => ({
    lap: marker.lap,
    source_time: new Date(marker.sourceMs).toISOString(),
  }));

  const lights_out = laps.find((anchor) => anchor.lap === 1)?.source_time ?? null;

  const seen = new Set<string>();
  const restarts: string[] = [];
  for (const raceEvent of folded.events) {
    if (raceEvent.endpoint !== "race_control") continue;
    const payload = raceEvent.payload;
    if (payload["category"] !== "SessionStatus" || payload["message"] !== "SESSION STARTED") continue;
    const date = payload["date"];
    if (typeof date !== "string" || seen.has(date)) continue;
    seen.add(date);
    restarts.push(date);
  }
  restarts.sort((a, b) => Date.parse(a) - Date.parse(b));

  return { lights_out, laps, restarts };
}

/** `folded` is the same value passed to `useReplayPlayback` -- pass both so anchors and playback always describe the same fold. */
export function useReplayTimeTarget(playback: ReplayPlayback, folded: FoldedRace | null): TimeTarget {
  const anchors = useMemo<Anchors>(() => (folded === null ? EMPTY_ANCHORS : deriveReplayAnchors(folded)), [folded]);

  // Un-nudged sync offset (issue #67): the net effect of every `seekTo`/
  // `nudge` call on this fold, in ms. Ticking while playing advances the
  // real position (`playback.sourceMs`) and an "un-nudged, played straight
  // through" reference by the same amount every frame, so their difference
  // never moves except at the instant of a seek, where it steps by exactly
  // how far that seek actually moved the (clamped) position -- no separate
  // wall-clock tracking needed, just an accumulator updated in `seekTo`/
  // `nudge` below. Reset to 0 whenever the fold changes (a different race).
  const offsetRef = useRef(0);
  const foldedForOffsetRef = useRef<FoldedRace | null>(null);
  if (foldedForOffsetRef.current !== folded) {
    foldedForOffsetRef.current = folded;
    offsetRef.current = 0;
  }

  return useMemo<TimeTarget>(
    () => ({
      displayedAt: () => (folded === null ? null : playback.sourceMs),

      seekTo: (atMs: number) => {
        const clamped = clamp(atMs, playback.startSourceMs, playback.endSourceMs);
        offsetRef.current += clamped - playback.sourceMs;
        playback.seek(atMs);
      },

      nudge: (deltaMs: number) => {
        const clamped = clamp(playback.sourceMs + deltaMs, playback.startSourceMs, playback.endSourceMs);
        offsetRef.current += clamped - playback.sourceMs;
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

      syncOffsetMs: () => (folded === null ? null : offsetRef.current),
    }),
    [folded, playback, anchors],
  );
}
