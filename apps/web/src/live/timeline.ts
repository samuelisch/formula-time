// The live browser-side timeline: a client keeps a full event timeline of
// a live race from the stream alone, backfilling the log once per join
// and never reading Postgres again per viewer per tick (ADR-0001 §2
// invariant 2). The stream is already open when a page mounts
// (`useLiveStream`, mounted once in `Shell`), so this hook: subscribes to
// the live store's pushes *before* starting the backfill; while
// backfilling, buffers every push's `events` into a pending list; once
// the backfill reaches a short page, appends the pending list once
// (`appendEvents`'s own `event_id` dedupe absorbs the overlap between the
// last backfilled page and the first buffered pushes -- both are
// `seq`-ordered, so that overlap never produces a duplicate); then keeps
// appending each subsequent push's `events` directly, no further reads. A
// push with `rebuilt: true`, or the live connection leaving `"open"` (a
// drop -- events between the drop and the reconnect may have been
// missed), discards the timeline and backfills again.
//
// `status` gates whether a finished session still reacts to rebuilds/
// reconnects: once finished the log is static and the timeline this hook
// already built is complete, so further stream activity is ignored.
//
// Every `appendEvents(built, ...)` call -- backfill pages, the
// pending-merge, and each stream push -- is serialized through one
// promise chain (`enqueueAppend`), and the backfill-to-stream handoff
// captures/clears `pending` and flips `backfilling` in one synchronous
// step, so a push arriving right at that handoff can neither run a
// concurrent `appendEvents` on the same mutable arrays nor get silently
// dropped. The subscriber also skips a notification whose `state.live` is
// unchanged (the store's own 250ms `tick()` never touches `live`, but
// still notifies every subscriber) and any push whose `seq` is not past
// the last one already folded in.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RaceEvent } from "@formula-time/domain";

import { fetchRaceEventsPage, type SessionStatus } from "../races/api.ts";
import { appendEvents, createTimeline, type Timeline } from "../replay/timeline.ts";
import { useLiveStore } from "./store.ts";

/** A "full" backfill page has exactly this many events; anything shorter is the head (exported for tests). */
export const PAGE_LIMIT = 5000;

/** Retry cadence for a failed backfill page fetch (exported for tests). */
export const RETRY_BACKOFF_MS = 30_000;

export interface UseSessionTimelineResult {
  timeline: Timeline | null;
  loading: boolean;
  error: Error | null;
  /** The highest `seq` folded into `timeline` so far (0 before the first page lands). */
  headSeq: number;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function pushSeq(seq: string): number | null {
  const n = Number(seq);
  return Number.isFinite(n) ? n : null;
}

/**
 * Backfills a session's event log into a `Timeline`, then keeps it
 * current from the live push stream alone. Every backfill fetch goes
 * through `fetchRaceEventsPage` (`apps/web/src/races/api.ts`), which
 * itself goes through `apiFetch`; nothing is read again per tick.
 */
interface Snapshot {
  timeline: Timeline | null;
  headSeq: number;
}

const EMPTY_SNAPSHOT: Snapshot = { timeline: null, headSeq: 0 };

export function useSessionTimeline(sessionKey: number, status: SessionStatus): UseSessionTimelineResult {
  // `timeline` and `headSeq` are one state value, not two `useState`s:
  // `publish` always updates them together, and coupling them into a
  // single `setSnapshot` call is what guarantees they commit in the same
  // render. Two separate `useState`s (the original shape here) do not
  // give that guarantee -- `publish` runs from a promise continuation
  // (a live push's `appendEvents(...).then(...)`), outside any of
  // React's automatically-batched contexts, so a reader could
  // (and, under test, intermittently did) observe a render with the new
  // `timeline` but the previous `headSeq`.
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Kept current via a layout effect, not a passive one: the guards that
  // read `statusRef.current` below live in a `useLiveStore.subscribe`
  // callback, which fires synchronously and outside React's render cycle
  // whenever the store's `set()` is called (e.g. from an `EventSource`
  // handler) -- a passive `useEffect` is deferred to a later task with no
  // guarantee it lands before the next SSE-driven `set()`, so a push that
  // flips `status` to `"finished"` could still see a stale `statusRef`
  // during a `rebuilt`/reconnect check delivered in the same event-loop
  // turn. `useLayoutEffect` runs synchronously during commit, before the
  // browser can process another event, so the ref is current by the time
  // any such synchronous check can run. `status` is deliberately not a
  // dependency of the join-sequence effect below (see its own comment), so
  // this ref is how that effect learns of a live -> finished transition
  // without re-running.
  const statusRef = useRef(status);
  useLayoutEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeStore: (() => void) | null = null;
    let generation = 0;

    function teardown(): void {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      unsubscribeStore?.();
      unsubscribeStore = null;
    }

    /** (Re)starts the whole join sequence: reset, subscribe, backfill, then stream-only. */
    function start(): void {
      teardown();
      generation += 1;
      const myGeneration = generation;
      const isCurrent = () => !cancelled && myGeneration === generation;

      setSnapshot(EMPTY_SNAPSHOT);
      setLoading(true);
      setError(null);

      const built = createTimeline({ session_key: String(sessionKey) });
      let pending: RaceEvent[] = [];
      let backfilling = true;

      function publish(seq: number | null): void {
        // One `setSnapshot` call: `timeline` (a shallow copy so React
        // sees a new reference; `appendEvents` mutates `built`'s arrays
        // in place, so the copy still shares -- and stays in sync with --
        // the timeline this closure keeps folding into) and `headSeq`
        // commit together, in the same render, always.
        setSnapshot((prev) => ({ timeline: { ...built }, headSeq: seq ?? prev.headSeq }));
      }

      // Serializes every appendEvents(built, ...) call through one chain:
      // the backfill's own per-page appends, the pending-merge append, and
      // every subsequent stream-push append all mutate the same `built`
      // arrays, so two of them must never run concurrently. Without this,
      // the window between the backfill loop deciding "no more pages" and
      // the pending-merge's own `appendEvents` call actually resolving
      // would let a push that arrived in that window take the "direct
      // append" branch (since `backfilling` had already flipped) and run a
      // second, concurrent `appendEvents` on the same mutable timeline.
      let appendChain: Promise<void> = Promise.resolve();
      function enqueueAppend(events: RaceEvent[]): Promise<void> {
        const step = appendChain.then(async () => {
          if (!isCurrent()) return;
          await appendEvents(built, events);
        });
        appendChain = step;
        return step;
      }

      // Deferred to a microtask, not called synchronously: this runs from
      // inside a `useLiveStore.subscribe` callback, itself invoked while
      // the store is still iterating its listener set for the state
      // change that triggered it. Calling `start()` synchronously here
      // would register the *new* subscription mid-iteration -- and a
      // `Set` iterates entries added during its own iteration, so the new
      // listener would immediately observe the very same (still
      // unchanged) `state.live`/`connection` and call `restart()` again,
      // recursively without end -- unbounded synchronous recursion,
      // exhausting the stack. `restarting` dedupes multiple triggers (e.g.
      // a reconnect and a rebuilt push in the same tick) within this one
      // generation.
      let restarting = false;
      function restart(): void {
        if (!isCurrent() || restarting) return;
        restarting = true;
        queueMicrotask(() => {
          if (isCurrent()) start();
        });
      }

      let previousConnection = useLiveStore.getState().connection;
      // Reference-equality guard: the store's own 250ms `tick()`
      // (apps/web/src/live/store.ts, while a viewer has a delay) calls
      // `set({ displayed, bufferShort })` -- it never touches `live` --
      // but a plain whole-state `subscribe` still re-fires this
      // listener on every `set()` regardless of which fields changed.
      // Without this guard, each tick re-processed the *same* push object,
      // re-running `appendEvents` (which rebuilds a dedup `Set` over the
      // whole timeline) for no reason. `lastProcessedSeq` is a second,
      // independent guard against reprocessing a push whose `seq` we've
      // already folded in, in case some other path ever hands this
      // listener a new `live` object carrying a seq we've already seen.
      let previousLive = useLiveStore.getState().live;
      let lastProcessedSeq = 0;
      unsubscribeStore = useLiveStore.subscribe((state) => {
        if (!isCurrent()) return;

        const wasOpen = previousConnection === "open";
        previousConnection = state.connection;
        if (wasOpen && state.connection !== "open" && statusRef.current !== "finished") {
          restart();
          return;
        }

        const push = state.live;
        if (push === previousLive) return;
        previousLive = push;
        if (push === null) return;

        if (push.rebuilt === true && statusRef.current !== "finished") {
          restart();
          return;
        }

        const seq = pushSeq(push.seq);
        if (seq !== null && seq <= lastProcessedSeq) return;

        const events = push.events ?? [];
        if (events.length === 0) return;
        if (seq !== null) lastProcessedSeq = seq;

        if (backfilling) {
          pending = pending.concat(events);
          return;
        }

        void enqueueAppend(events).then(() => {
          if (!isCurrent()) return;
          publish(seq);
        });
      });

      /** One backfill page, retrying at `RETRY_BACKOFF_MS` on error (`error` clears on the next success). */
      async function fetchPageWithRetry(sinceSeq: number): Promise<{ events: RaceEvent[]; next_seq: number | null }> {
        for (;;) {
          try {
            const page = await fetchRaceEventsPage(sessionKey, sinceSeq, PAGE_LIMIT);
            if (isCurrent()) setError(null);
            return page;
          } catch (err) {
            if (!isCurrent()) throw err;
            setError(asError(err));
            await new Promise<void>((resolve) => {
              retryTimer = setTimeout(resolve, RETRY_BACKOFF_MS);
            });
            if (!isCurrent()) throw new Error("cancelled", { cause: err });
          }
        }
      }

      (async () => {
        try {
          let sinceSeq = 0;
          for (;;) {
            const page = await fetchPageWithRetry(sinceSeq);
            if (!isCurrent()) return;

            // Defensive guard: the api's contract is that `next_seq` is
            // null only when `events` is empty -- a full page always
            // carries the last row's seq. If that ever isn't
            // true, `sinceSeq` would never advance and this loop would
            // refetch the same page forever; surface an error and stop
            // instead.
            if (page.events.length >= PAGE_LIMIT && page.next_seq === null) {
              setError(
                new Error(
                  `GET /api/races/${sessionKey}/events: a full page (limit ${PAGE_LIMIT}) came back with next_seq null -- cannot page further`,
                ),
              );
              setLoading(false);
              return;
            }

            await enqueueAppend(page.events);
            if (!isCurrent()) return;
            if (page.next_seq !== null) sinceSeq = page.next_seq;
            publish(page.next_seq);
            if (page.events.length < PAGE_LIMIT) break;
          }
        } catch {
          return;
        }

        if (!isCurrent()) return;

        // Capture the pending list, clear it, and flip `backfilling` all
        // synchronously in this one step -- before awaiting anything. Any
        // push arriving from this point forward sees `backfilling === false`
        // and enqueues its own append (see the subscriber above), which
        // `enqueueAppend`'s shared chain guarantees runs only after this
        // merge's append below actually finishes -- so no push can be
        // silently dropped (routed to a `pending` array nobody reads again)
        // and no two `appendEvents` calls on `built` ever run concurrently.
        const toAppend = pending;
        pending = [];
        backfilling = false;

        await enqueueAppend(toAppend);
        if (!isCurrent()) return;
        publish(null);
        setLoading(false);
      })();
    }

    start();

    return () => {
      cancelled = true;
      teardown();
    };
    // `status` is deliberately not a dependency: it is read through
    // `statusRef` so a live -> finished transition takes effect on the
    // very next push/reconnect check without re-running (and re-joining)
    // this effect.
  }, [sessionKey]);

  return { timeline: snapshot.timeline, loading, error, headSeq: snapshot.headSeq };
}
