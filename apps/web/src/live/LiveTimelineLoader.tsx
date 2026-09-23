// Hands a full-race browser-side timeline to the live store so
// `reselect()` can fold past the push ring buffer once a viewer rewinds
// further back than the buffer covers ("timeline mode"). A separate
// component so unmounting it (the live page itself unmounting) is what
// drops the timeline and frees its memory.
// See README: Timeline fold.
import { useEffect } from "react";

import type { RawRecord } from "@formula-time/domain";

import type { SessionStatus } from "../races/api.ts";
import { useLiveStore } from "./store.ts";
import { useSessionTimeline } from "./useSessionTimeline.ts";

export interface LiveTimelineLoaderProps {
  sessionKey: number;
  status: SessionStatus;
}

/**
 * Waits for the live push's own session row (`state.live?.state.session`)
 * before mounting the inner loader: `useSessionTimeline` captures that row
 * once, when it builds the timeline, so there must already be a real row to
 * capture -- nothing meaningful exists before the first push lands.
 */
export function LiveTimelineLoader({ sessionKey, status }: LiveTimelineLoaderProps) {
  const session = useLiveStore((state) => state.live?.state.session ?? null);
  if (session === null) return null;
  return <LiveTimelineLoaderInner sessionKey={sessionKey} status={status} session={session} />;
}

interface LiveTimelineLoaderInnerProps extends LiveTimelineLoaderProps {
  session: RawRecord;
}

function LiveTimelineLoaderInner({ sessionKey, status, session }: LiveTimelineLoaderInnerProps): null {
  const { timeline } = useSessionTimeline(sessionKey, status, session);

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
