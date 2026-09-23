// Mounted once in the shell. The only place in the app that owns an
// EventSource -- no component below the shell creates one. Opens the
// stream in delta format (ADR-0013): a `state` frame seeds or replaces
// the held push outright; a `delta` frame is folded against the held
// push by `applyDelta` (deltas.ts).
// See README: Live stream gap recovery.
import { useEffect } from "react";

import { apiFetch, apiUrl } from "../api.ts";
import { applyDelta } from "./deltas.ts";
import { useLiveStore } from "./store.ts";
import type { DeltaPush, StatePush } from "./types.ts";

const TICK_INTERVAL_MS = 250;

export interface UseLiveStreamOptions {
  EventSourceImpl?: typeof EventSource;
}

/** `seq` values are numeric-string projector cursors; compared as numbers. */
function seqIsNewer(candidate: string, than: string): boolean {
  return Number(candidate) > Number(than);
}

export function useLiveStream(options: UseLiveStreamOptions = {}): void {
  const EventSourceImpl = options.EventSourceImpl ?? globalThis.EventSource;

  useEffect(() => {
    const source = new EventSourceImpl(apiUrl("/api/live/events?format=delta"));

    // Set synchronously before the fetch's promise even starts, so a delta
    // arriving before it resolves is unambiguously seen as "already
    // fetching" and dropped, never starting a second, overlapping fetch.
    let fetchingSnapshot = false;
    // True from the moment a gap is detected until some push actually
    // resolves it (see the module comment above).
    let pendingGap = false;

    const fetchSnapshot = (): void => {
      fetchingSnapshot = true;
      apiFetch("/api/live/snapshot")
        .then(async (res) => {
          if (!res.ok) throw new Error(`GET /api/live/snapshot: ${res.status}`);
          const push = (await res.json()) as StatePush;
          const held = useLiveStore.getState().live;
          if (held !== null && !seqIsNewer(push.seq, held.seq)) {
            // A state frame already landed and moved `live` past this
            // fetch's snapshot while it was in flight -- applying it now
            // would silently regress the board. Leave `pendingGap` as-is:
            // if that state frame already resolved the gap it is already
            // false; if not, the next delta retries the fetch.
            return;
          }
          push.rebuilt = true;
          pendingGap = false;
          useLiveStore.getState().onState(push, Date.now());
        })
        .catch(() => {
          // Left unresolved; the next delta's gap retries the fetch.
        })
        .finally(() => {
          fetchingSnapshot = false;
        });
    };

    const handleState = (event: MessageEvent<string>): void => {
      const push = JSON.parse(event.data) as StatePush;
      if (pendingGap) {
        push.rebuilt = true;
        pendingGap = false;
      }
      useLiveStore.getState().onState(push, Date.now());
    };
    const handleDelta = (event: MessageEvent<string>): void => {
      if (fetchingSnapshot) return;
      const frame = JSON.parse(event.data) as DeltaPush;
      const next = applyDelta(useLiveStore.getState().live, frame);
      if (next === null) {
        pendingGap = true;
        fetchSnapshot();
        return;
      }
      useLiveStore.getState().onState(next, Date.now());
    };
    const handleStatus = (event: MessageEvent<string>): void => {
      const status = JSON.parse(event.data) as { catching_up: boolean };
      useLiveStore.getState().onStatus(status);
    };

    source.addEventListener("state", handleState as EventListener);
    source.addEventListener("delta", handleDelta as EventListener);
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
      source.removeEventListener("delta", handleDelta as EventListener);
      source.removeEventListener("status", handleStatus as EventListener);
      source.close();
      if (interval !== null) clearInterval(interval);
      unsubscribe();
    };
  }, [EventSourceImpl]);
}
