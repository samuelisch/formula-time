// The live `TimeTarget`: wraps the live store's delay (`useDelay`), its
// displayed push (`useDisplayed`), and its jump anchors (`useAnchors`) --
// the same seam the deleted `DelayControl` used before it was folded into
// the shared `TransportBar`. `playback()` is always null: live has no
// play/pause concept, only a delay.
//
// Issue #97: once a full-race timeline is loaded (`LiveTimelineLoader`
// hands it to the store), `range()` spans the whole race from
// `timeline.firstSourceMs`, and `anchors()` comes from the timeline's lap
// markers rather than only the laps seen since this tab connected -- so a
// late joiner's "Race start" and lap jumps work for the whole race, not
// just what this tab has seen. This is true whenever a timeline exists,
// not only once `seekTo`/`nudge` have actually put the store into timeline
// mode: the timeline's lap markers are a superset of the stream-derived
// ones, and a viewer still at the live edge needs `anchors().lights_out`
// to press "Race start" in the first place. Whether the delay currently
// resolves through the buffer or the timeline is the store's `mode`
// (`reselect` in `live/store.ts`); this hook only reports it via
// `rewindMode()`, it never decides it.
import { useMemo } from "react";

import { deriveTimelineAnchors } from "../live/anchors.ts";
import { useAnchors, useDelay, useDisplayed, useRewindMode, useTimeline } from "../live/selectors.ts";
import { axisOf } from "../live/types.ts";
import type { TimeTarget } from "./TimeTarget.ts";

/** Exported so the test asserts the exact string the viewer sees, not a paraphrase. */
export const BUFFER_SHORT_NOTICE = "Delay exceeds what this tab has buffered; showing the oldest";

/**
 * `now` is injectable (default `Date.now`) so tests can drive it
 * deterministically -- the live store's own methods take `now` as a
 * parameter for the same reason (`live/store.ts`).
 */
export function useLiveTimeTarget(now: () => number = Date.now): TimeTarget {
  const { delayMs, spanMs, bufferShort, setDelayMs } = useDelay();
  const displayed = useDisplayed();
  const streamAnchors = useAnchors();
  const timeline = useTimeline();
  const mode = useRewindMode();

  const displayedAtMs = displayed === null ? null : axisOf(displayed);

  // Memoised on the `timeline` reference: `useSessionTimeline` publishes a
  // new shallow copy per page and per live push, so this recomputes about
  // once a second while live -- one pass over the timeline's events array,
  // acceptable.
  const anchors = useMemo(() => (timeline === null ? streamAnchors : deriveTimelineAnchors(timeline)), [timeline, streamAnchors]);

  return useMemo<TimeTarget>(
    () => ({
      displayedAt: () => displayedAtMs,

      // No upper clamp to spanMs: an over-long delay is exactly what the
      // store's own `bufferShort`/timeline-mode fold is for -- `reselect`
      // (`live/store.ts`) decides buffer vs. timeline vs. the oldest-entry
      // fallback; this only ever sets the delay (`setDelayMs` floors at 0).
      seekTo: (atMs: number) => {
        setDelayMs(Math.max(0, now() - atMs));
      },

      nudge: (deltaMs: number) => {
        setDelayMs(Math.max(0, delayMs - deltaMs));
      },

      anchors: () => anchors,

      range: () => {
        const endMs = now();
        if (timeline !== null && timeline.firstSourceMs !== null) {
          return { startMs: timeline.firstSourceMs, endMs };
        }
        return { startMs: endMs - spanMs, endMs };
      },

      playback: () => null,

      // The live store sets `bufferShort` when the asked-for delay is older
      // than this tab's ring buffer holds and `displayed` has fallen back to
      // the oldest entry (`reselect` in `live/store.ts`) -- but timeline
      // mode has already resolved a real position past the buffer, so the
      // warning never applies there even if `bufferShort` happens to be
      // stale-true from before the timeline landed.
      notice: () => (mode === "timeline" ? null : bufferShort ? BUFFER_SHORT_NOTICE : null),

      // The current delay, in ms -- the same reading the position label
      // already shows for live (`range().endMs − displayedAt()`), just
      // exposed through the seam so `syncOffsetMs` is non-optional on both
      // implementations.
      syncOffsetMs: () => delayMs,

      rewindMode: () => mode,
    }),
    [displayedAtMs, delayMs, spanMs, bufferShort, anchors, timeline, mode, setDelayMs, now],
  );
}
