// Hands a full-race browser-side timeline to the live store so
// `reselect()` (`live/store.ts`) can fold past the push ring buffer once a
// viewer rewinds further back than the buffer covers ("timeline mode").
//
// A separate component, not called directly from `BoardPage`, for two
// reasons: `useSessionTimeline` needs a numeric session key, which only
// exists once a live session is actually known (mounting it unconditionally
// would need a sentinel key and a lot of "is this real yet" plumbing at
// every call site inside the hook); and unmounting it -- which `BoardPage`
// does once the live page itself unmounts -- is what drops the timeline
// (`setTimeline(null, ...)`) so its memory is freed rather than held for
// the lifetime of the tab.
import { useEffect } from "react";

import type { SessionStatus } from "../races/api.ts";
import { useLiveStore } from "./store.ts";
import { useSessionTimeline } from "./timeline.ts";

export interface LiveTimelineLoaderProps {
  sessionKey: number;
  status: SessionStatus;
}

export function LiveTimelineLoader({ sessionKey, status }: LiveTimelineLoaderProps): null {
  const { timeline } = useSessionTimeline(sessionKey, status);

  useEffect(() => {
    useLiveStore.getState().setTimeline(timeline, Date.now());
  }, [timeline]);

  // Unmount only: dropping the timeline whenever `timeline` itself merely
  // changes (a new page folded in) would null it out and immediately set it
  // again on every backfill page and live push -- a flicker back to buffer
  // mode for anyone currently past the buffer. Only losing the loader
  // itself (BoardPage's mount latch letting go, or the page unmounting)
  // should free it.
  useEffect(() => {
    return () => {
      useLiveStore.getState().setTimeline(null, Date.now());
    };
  }, []);

  return null;
}
