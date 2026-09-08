// The replay `TimeTarget`: wraps `useReplayPlayback`'s clock and derives
// jump anchors from the folded race rather than from pushes accumulated
// since connecting (issue #81). Lap N's anchor is `FoldedRace.lapMarkers`
// (already "the first source time the leader reached this lap" -- see
// `foldRace.ts`); lights-out is lap 1's anchor; restarts come from
// "SESSION STARTED" race-control events across the whole fold, mirroring
// `live/anchors.ts`'s `deriveAnchors` but over every event rather than a
// rolling 100-row window.
import { useMemo } from "react";

import type { Anchors } from "../live/anchors.ts";
import type { FoldedRace } from "../replay/foldRace.ts";
import type { ReplayPlayback } from "../replay/useReplayPlayback.ts";
import type { TimeTarget } from "./TimeTarget.ts";

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

  return useMemo<TimeTarget>(
    () => ({
      displayedAt: () => (folded === null ? null : playback.sourceMs),

      seekTo: (atMs: number) => playback.seek(atMs),

      nudge: (deltaMs: number) => playback.seek(playback.sourceMs + deltaMs),

      anchors: () => anchors,

      range: () => (folded === null ? null : { startMs: playback.startSourceMs, endMs: playback.endSourceMs }),

      playback: () => ({
        playing: playback.isPlaying,
        play: playback.play,
        pause: playback.pause,
      }),
    }),
    [folded, playback, anchors],
  );
}
