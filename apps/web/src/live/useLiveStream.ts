// Mounted once in the shell. The only place in the app that owns an
// EventSource -- no component below the shell creates one (apps/web/AGENTS.md).
import { useEffect } from "react";

import { apiUrl } from "../api.ts";
import { useLiveStore } from "./store.ts";
import type { LivePush } from "./types.ts";

const TICK_INTERVAL_MS = 250;

export interface UseLiveStreamOptions {
  EventSourceImpl?: typeof EventSource;
}

export function useLiveStream(options: UseLiveStreamOptions = {}): void {
  const EventSourceImpl = options.EventSourceImpl ?? globalThis.EventSource;

  useEffect(() => {
    const source = new EventSourceImpl(apiUrl("/api/live/events"));

    const handleState = (event: MessageEvent<string>): void => {
      const push = JSON.parse(event.data) as LivePush;
      useLiveStore.getState().onState(event.data, push, Date.now());
    };
    const handleStatus = (event: MessageEvent<string>): void => {
      const status = JSON.parse(event.data) as { catching_up: boolean };
      useLiveStore.getState().onStatus(status);
    };

    source.addEventListener("state", handleState as EventListener);
    source.addEventListener("status", handleStatus as EventListener);
    source.onopen = () => useLiveStore.getState().onOpen();
    source.onerror = () => useLiveStore.getState().onError();

    // The selection tick only needs to run while a positive delay is set;
    // delayMs === 0 renders the live edge with zero buffer work.
    let interval: ReturnType<typeof setInterval> | null = null;
    const syncInterval = (delayMs: number): void => {
      if (delayMs > 0 && interval === null) {
        interval = setInterval(() => useLiveStore.getState().tick(Date.now()), TICK_INTERVAL_MS);
      } else if (delayMs === 0 && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    syncInterval(useLiveStore.getState().delayMs);
    const unsubscribe = useLiveStore.subscribe((state) => syncInterval(state.delayMs));

    return () => {
      source.removeEventListener("state", handleState as EventListener);
      source.removeEventListener("status", handleStatus as EventListener);
      source.close();
      if (interval !== null) clearInterval(interval);
      unsubscribe();
    };
  }, [EventSourceImpl]);
}
