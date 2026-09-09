// The live `TimeTarget`: wraps the live store's delay (`useDelay`), its
// displayed push (`useDisplayed`), and its jump anchors (`useAnchors`) --
// the same seam `DelayControl` used before this issue folded it into the
// shared `TransportBar`. `playback()` is always null: live has no
// play/pause concept, only a delay.
import { useMemo } from "react";

import { useAnchors, useDelay, useDisplayed } from "../live/selectors.ts";
import { axisOf } from "../live/types.ts";
import type { TimeTarget } from "./TimeTarget.ts";

/** Exported so the test asserts the exact string the viewer sees, not a paraphrase. */
export const BUFFER_SHORT_NOTICE = "Delay exceeds what this tab has buffered; showing the oldest";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `now` is injectable (default `Date.now`) so tests can drive it
 * deterministically -- the live store's own methods take `now` as a
 * parameter for the same reason (`live/store.ts`).
 */
export function useLiveTimeTarget(now: () => number = Date.now): TimeTarget {
  const { delayMs, spanMs, bufferShort, setDelayMs } = useDelay();
  const displayed = useDisplayed();
  const anchors = useAnchors();

  const displayedAtMs = displayed === null ? null : axisOf(displayed);

  return useMemo<TimeTarget>(
    () => ({
      displayedAt: () => displayedAtMs,

      seekTo: (atMs: number) => {
        setDelayMs(clamp(now() - atMs, 0, spanMs));
      },

      nudge: (deltaMs: number) => {
        setDelayMs(Math.max(0, delayMs - deltaMs));
      },

      anchors: () => anchors,

      range: () => {
        const endMs = now();
        return { startMs: endMs - spanMs, endMs };
      },

      playback: () => null,

      // The live store sets `bufferShort` when the asked-for delay is older
      // than this tab's ring buffer holds and `displayed` has fallen back to
      // the oldest entry (`reselect` in `live/store.ts`). Same wording the
      // deleted `DelayControl` showed.
      notice: () => (bufferShort ? BUFFER_SHORT_NOTICE : null),
    }),
    [displayedAtMs, delayMs, spanMs, bufferShort, anchors, setDelayMs, now],
  );
}
