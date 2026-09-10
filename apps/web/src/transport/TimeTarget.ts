// The transport seam: one interface both the live board and a replay
// implement, so a single `TransportBar` drives either without any
// platform-specific logic of its own. `useLiveTimeTarget` (backed by the
// live store) and `useReplayTimeTarget` (backed by the playback clock and a
// folded race's lap markers) are the two implementations; `TransportBar`
// only ever calls through this interface.
//
// `notice()` exists because without it the live store's `bufferShort` -- a
// "showing the oldest" warning -- had nowhere to surface, so a viewer
// nudging past the buffered span landed on stale data silently. Live
// returns the buffered-delay message; replay, whose whole fold is always
// seekable, returns null.
//
// A plain .ts file (not .tsx), so `TimeTargetProvider` is built with
// `createElement` rather than JSX -- the same convention `useBoardState.ts`
// uses for `BoardSourceProvider`.
import { createContext, createElement, useContext, type ReactNode } from "react";

import type { Anchors } from "../live/anchors.ts";
import type { RewindMode } from "../live/types.ts";

export interface TimeTarget {
  /** Source-time position the viewer sees, ms on the axis; null when unknown. */
  displayedAt(): number | null;
  /** Move so that source time `atMs` is what the viewer sees; replay pauses, live sets the delay. */
  seekTo(atMs: number): void;
  /** Signed nudge in ms: replay moves the position; live changes the delay by −delta (forward = less delay). */
  nudge(deltaMs: number): void;
  /** Lap anchors known to this target. */
  anchors(): Anchors;
  /** Bounds of what can be seeked, ms; live: [head − bufferedSpan, head] on the source axis, head = the newest push's axis time plus wall time elapsed since it arrived; replay: [first, last source time]. */
  range(): { startMs: number; endMs: number } | null;
  /** Playback, replay only; live returns null. */
  playback(): { playing: boolean; play(): void; pause(): void } | null;
  /** A human-readable limitation of the current position, or null. */
  notice(): string | null;
  /**
   * Net effect, in ms, of every `seekTo`/`nudge` call made against this
   * target so far, relative to an un-nudged reference; both implementations
   * provide it, like `notice()`. Replay: 0 for a fold
   * that has only ever played straight through, since ticking while
   * playing advances both the real position and this "un-nudged"
   * reference by the same amount -- null before a fold has loaded. Live:
   * the current delay in ms (`range().endMs − displayedAt()`, the same
   * reading `TransportBar` showed before this issue) -- never null once a
   * target exists.
   */
  syncOffsetMs(): number | null;
  /** How the live target chose what it shows -- "edge", "buffer" or "timeline" (the full-race log); replay returns null. */
  rewindMode(): RewindMode | null;
}

const TimeTargetContext = createContext<TimeTarget | null>(null);

export interface TimeTargetProviderProps {
  value: TimeTarget;
  children: ReactNode;
}

/** Mounted by the live `BoardPage` and by `ReplayPage`, each with their own `TimeTarget` implementation, around the shared `TransportBar`. */
export function TimeTargetProvider({ value, children }: TimeTargetProviderProps) {
  return createElement(TimeTargetContext.Provider, { value }, children);
}

/** Throws outside a `TimeTargetProvider` -- unlike `useBoardPush()`, there is no sensible default target. */
export function useTimeTarget(): TimeTarget {
  const target = useContext(TimeTargetContext);
  if (target === null) {
    throw new Error("useTimeTarget must be used within a TimeTargetProvider");
  }
  return target;
}
