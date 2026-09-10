// Narrow selector hooks over the live store. Components read through these,
// never the whole store, so a render only depends on the slice it uses.
import { leaderLap } from "@formula-time/domain";
import type { RawRecord } from "@formula-time/domain";
import { useMemo } from "react";

import type { Timeline } from "../replay/timeline.ts";
import type { Anchors } from "./anchors.ts";
import { span } from "./buffer.ts";
import { timelineMatchesSession, useLiveStore } from "./store.ts";
import type { Connection, LivePush, RewindMode } from "./types.ts";

export function useConnection(): Connection {
  return useLiveStore((state) => state.connection);
}

export function useCatchingUp(): boolean {
  return useLiveStore((state) => state.catchingUp);
}

/** True once at least one `status` SSE frame has landed -- see `LiveStore.statusReceived`. */
export function useStatusReceived(): boolean {
  return useLiveStore((state) => state.statusReceived);
}

export function useDisplayed() {
  return useLiveStore((state) => state.displayed);
}

/** The newest push (the live edge), or null before the first one -- never the rewound `displayed` push. */
export function useLivePush(): LivePush | null {
  return useLiveStore((state) => state.live);
}

export interface DelayInfo {
  delayMs: number;
  spanMs: number;
  bufferShort: boolean;
  setDelayMs(ms: number): void;
}

export function useDelay(): DelayInfo {
  const delayMs = useLiveStore((state) => state.delayMs);
  const spanMs = useLiveStore((state) => span(state.buffer));
  const bufferShort = useLiveStore((state) => state.bufferShort);
  const setDelayMs = useLiveStore((state) => state.setDelayMs);
  return {
    delayMs,
    spanMs,
    bufferShort,
    setDelayMs: (ms: number) => setDelayMs(ms, Date.now()),
  };
}

export interface SessionMeta {
  sessionKey: string | null;
  totalLaps: number | null;
  session: RawRecord | null;
}

function sessionMetaOf(displayed: LivePush | null): SessionMeta {
  return {
    sessionKey: displayed?.session_key ?? null,
    totalLaps: displayed?.total_laps ?? null,
    session: displayed?.state.session ?? null,
  };
}

/** Derived from `displayed`, so it only recomputes when the selected entry changes. */
export function useSessionMeta(): SessionMeta {
  const displayed = useDisplayed();
  return useMemo(() => sessionMetaOf(displayed), [displayed]);
}

export function useLeaderLap(): number {
  return useLiveStore((state) => (state.displayed === null ? 0 : leaderLap(state.displayed.state)));
}

export type SessionStatusValue = "upcoming" | "live" | "finished";

/** The session row's own `status` field (the `SessionStatus` enum), string-guarded so an unknown wire value reads as null rather than crashing a render. */
export function sessionStatusOf(session: RawRecord | null | undefined): SessionStatusValue | null {
  const status = session?.["status"];
  return status === "upcoming" || status === "live" || status === "finished" ? status : null;
}

/** `"upcoming" | "live" | "finished" | null` from the displayed session's `status` field -- never "the pushed session exists" alone, which would let a finished or upcoming session read as live. */
export function useSessionStatus(): SessionStatusValue | null {
  return useLiveStore((state) => sessionStatusOf(state.displayed?.state.session));
}

/** Wall-clock time of the last received push, or null before the first one. Drives the shell's quiet-feed pill. */
export function useLastMessageAt(): number | null {
  return useLiveStore((state) => state.lastMessageAt);
}

/** Jump targets folded from pushes seen since this tab connected (lights-out, lap starts, restarts). */
export function useAnchors(): Anchors {
  return useLiveStore((state) => state.anchors);
}

/** How `displayed` was chosen: "edge", "buffer", or "timeline" (past the buffer, folded from the browser-side log). */
export function useRewindMode(): RewindMode {
  return useLiveStore((state) => state.mode);
}

/**
 * The browser-side full-race timeline for the live session
 * (`LiveTimelineLoader` sets it), or null when not loaded -- or when it is
 * loaded but does not match the *live* push's own session
 * (`timelineMatchesSession`, the same guard `reselect()` applies in
 * `store.ts`). That mismatch window is real, not hypothetical: a session
 * change (e.g. quali -> race) leaves `useSessionTimeline`'s effect keyed on
 * the old `sessionKey` for at least one render after `state.live` flips to
 * the new session, and `BoardPage` never remounts `LiveTimelineLoader`
 * across that transition (`/live` carries no session param) -- without this
 * guard, `useLiveTimeTarget`'s `anchors()`/`range()` would show the
 * outgoing session's span and lap markers for that window even though the
 * store's own `displayed`/`mode` have already fallen back correctly.
 */
export function useTimeline(): Timeline | null {
  return useLiveStore((state) =>
    state.live !== null && state.timeline !== null && timelineMatchesSession(state.timeline, state.live.session_key)
      ? state.timeline
      : null,
  );
}

/**
 * The *live* session's key (the newest push, `state.live`), as a number --
 * never the *displayed* session, which in timeline mode is synthesised and
 * would give a late joiner's rewind loader the wrong key. Null before the
 * first push, or if `session_key` is not numeric (never happens on the
 * wire, but this hook feeds a `number`-typed prop).
 */
export function useLiveSessionKey(): number | null {
  return useLiveStore((state) => {
    const key = state.live?.session_key;
    if (key === undefined) return null;
    const parsed = Number(key);
    return Number.isFinite(parsed) ? parsed : null;
  });
}

/** The *live* push's own session status -- see `useLiveSessionKey` for why this reads `live`, not `displayed`. */
export function useLiveSessionStatus(): SessionStatusValue | null {
  return useLiveStore((state) => sessionStatusOf(state.live?.state.session));
}
