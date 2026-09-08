// Narrow selector hooks over the live store. Components read through these,
// never the whole store, so a render only depends on the slice it uses.
import { leaderLap } from "@formula-time/domain";
import type { RawRecord } from "@formula-time/domain";
import { useMemo } from "react";

import { span } from "./buffer.ts";
import { useLiveStore } from "./store.ts";
import type { Connection, LivePush } from "./types.ts";

export function useConnection(): Connection {
  return useLiveStore((state) => state.connection);
}

export function useCatchingUp(): boolean {
  return useLiveStore((state) => state.catchingUp);
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
