// Narrow selector hooks over the live store. Components read through these,
// never the whole store, so a render only depends on the slice it uses.
import { leaderLap } from "@formula-time/domain";
import type { RawRecord } from "@formula-time/domain";
import { useMemo } from "react";

import type { Anchors } from "./anchors.ts";
import { span } from "./buffer.ts";
import { useLiveStore } from "./store.ts";
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
