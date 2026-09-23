// The live `TimeTarget`: wraps the live store's delay (`useDelay`), its
// displayed push (`useDisplayed`), and its jump anchors (`useAnchors`).
// `playback()` is always null: live has no play/pause concept, only a
// delay. Once a full-race timeline is loaded, `range()`/`anchors()` span
// the whole race instead of only what this tab has seen since connecting.
// See README: Delay, offset, nudge, seek.
import { useCallback, useMemo } from "react";

import { deriveTimelineAnchors } from "../live/anchors.ts";
import { useAnchors, useDelay, useDisplayed, useLastMessageAt, useRewindMode, useStatePush, useTimeline } from "../live/selectors.ts";
import { headAxisOf } from "../live/store.ts";
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
  const { delayMs, spanMs, bufferShort, seekToAxis, nudgeDelay } = useDelay();
  const displayed = useDisplayed();
  const streamAnchors = useAnchors();
  const timeline = useTimeline();
  const mode = useRewindMode();
  const statePush = useStatePush();
  const lastMessageAt = useLastMessageAt();

  const displayedAtMs = displayed === null ? null : axisOf(displayed);

  // The live edge on the source axis, for display only: the exact formula
  // `headAxisOf` computes internally, so `range()` never disagrees with
  // the store. `seekTo`/`nudge` don't use this -- they call the store's
  // own `seekToAxis`/`nudgeDelay`, read at call time so a push landing
  // between render and click can't throw the result off.
  // See README: Delay, offset, nudge, seek.
  const headMs = useCallback(
    () => headAxisOf({ live: statePush, lastMessageAt }, now()) ?? now(),
    [statePush, lastMessageAt, now],
  );

  // Memoised on the `timeline` reference: `useSessionTimeline` publishes a
  // new shallow copy per page and per live push, so this recomputes about
  // once a second while live -- one pass over the timeline's events array,
  // acceptable.
  const anchors = useMemo(() => (timeline === null ? streamAnchors : deriveTimelineAnchors(timeline)), [timeline, streamAnchors]);

  return useMemo<TimeTarget>(
    () => ({
      displayedAt: () => displayedAtMs,

      // No upper clamp to spanMs: an over-long delay is exactly what the
      // store's own `bufferShort`/timeline-mode fold is for; this only
      // ever sets the delay (`setDelayMs` floors at 0). Delegates to the
      // store's `seekToAxis`, measured from its own current head, not
      // this render's `headMs` snapshot.
      seekTo: (atMs: number) => {
        seekToAxis(atMs, now());
      },

      // Delegates to the store's `nudgeDelay`, which reads the current
      // delay at call time so repeated nudges compound correctly even when
      // none of them triggers a render in between.
      nudge: (deltaMs: number) => {
        nudgeDelay(deltaMs, now());
      },

      anchors: () => anchors,

      range: () => {
        const endMs = headMs();
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

      // The live sync offset is the store's delay in ms, which the
      // transport readout shows directly.
      syncOffsetMs: () => delayMs,

      rewindMode: () => mode,
    }),
    [displayedAtMs, delayMs, spanMs, bufferShort, anchors, timeline, mode, headMs, seekToAxis, nudgeDelay, now],
  );
}
