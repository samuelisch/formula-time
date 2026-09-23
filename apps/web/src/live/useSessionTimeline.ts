// The live browser-side timeline: a client keeps a full event timeline of
// a live race from the stream alone, backfilling the log once per join
// and never reading Postgres again per viewer per tick (ADR-0001 §2
// invariant 2). The stream is already open when a page mounts
// (`useLiveStream`, mounted once in `Shell`).
// See README: Live timeline join sequence.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RaceEvent, RawRecord } from "@formula-time/domain";

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

export function useSessionTimeline(sessionKey: number, status: SessionStatus, session: RawRecord): UseSessionTimelineResult {
  // `timeline` and `headSeq` are one state value, not two `useState`s, so
  // `publish` commits them together in the same render (it runs from a
  // promise continuation, outside React's automatic batching).
  // See README: Live timeline join sequence.
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Kept current via a layout effect, not a passive one: the guards that
  // read `statusRef.current` run from a store-subscribe callback outside
  // React's render cycle, where a passive effect could still be stale.
  // See README: Live timeline join sequence.
  const statusRef = useRef(status);
  useLayoutEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Mirrors `statusRef`, but for the opposite purpose: `session` stays
  // out of the join-sequence effect's dependency array, since a plain
  // dependency would re-backfill on every push (a new object each time).
  // See README: Live timeline join sequence.
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);

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

      const built = createTimeline(sessionRef.current);
      let pending: RaceEvent[] = [];
      let backfilling = true;
      // Mirrors `snapshot.headSeq` synchronously: `resume()` below is
      // triggered from the store subscriber, which fires outside React's
      // render cycle, so it cannot wait on a `setSnapshot` commit to learn
      // where to resume paging from.
      let headSeqLocal = 0;

      function publish(seq: number | null): void {
        // One `setSnapshot` call: `timeline` (a shallow copy so React
        // sees a new reference; `appendEvents` mutates `built`'s arrays
        // in place, so the copy still shares -- and stays in sync with --
        // the timeline this closure keeps folding into) and `headSeq`
        // commit together, in the same render, always.
        if (seq !== null) headSeqLocal = seq;
        setSnapshot((prev) => ({ timeline: { ...built }, headSeq: seq ?? prev.headSeq }));
      }

      // Serializes every appendEvents(built, ...) call through one chain:
      // the backfill's per-page appends, the pending-merge append, and
      // every stream-push append all mutate the same `built` arrays, so
      // two must never run concurrently.
      // See README: Live timeline join sequence.
      let appendChain: Promise<void> = Promise.resolve();
      function enqueueAppend(events: RaceEvent[]): Promise<void> {
        const step = appendChain.then(async () => {
          if (!isCurrent()) return;
          await appendEvents(built, events);
        });
        appendChain = step;
        return step;
      }

      // Deferred to a microtask, not called synchronously: this runs
      // inside a `useLiveStore.subscribe` callback, still iterating its
      // listener set -- a synchronous `start()` would register a new
      // subscription mid-iteration and recurse without end. `restarting`
      // dedupes multiple triggers within this one generation.
      // See README: Live timeline join sequence.
      let restarting = false;
      function restart(): void {
        if (!isCurrent() || restarting) return;
        restarting = true;
        queueMicrotask(() => {
          if (isCurrent()) start();
        });
      }

      // Resumes paging into the same `built` timeline from `headSeqLocal`
      // rather than rebuilding from zero -- no new subscription is
      // registered, so (unlike `restart()`) this can run synchronously with
      // no re-entrant-listener risk. `backfilling` itself is the dedupe
      // guard: a resume already in flight (or the first join's own
      // backfill, still running) means nothing more to do here.
      function resume(): void {
        if (!isCurrent() || backfilling) return;
        backfilling = true;
        void backfillFrom(headSeqLocal);
      }

      let previousConnection = useLiveStore.getState().connection;
      // Reference-equality guard: the store's own 250ms `tick()` never
      // touches `live`, but a plain whole-state `subscribe` still re-fires
      // on every `set()` -- without this, each tick would re-run
      // `appendEvents` on the same push for no reason. `lastProcessedSeq`
      // is a second guard against reprocessing an already-folded `seq`.
      // See README: Live timeline join sequence.
      let previousLive = useLiveStore.getState().live;
      let lastProcessedSeq = 0;
      unsubscribeStore = useLiveStore.subscribe((state) => {
        if (!isCurrent()) return;

        const wasOpen = previousConnection === "open";
        previousConnection = state.connection;
        if (wasOpen && state.connection !== "open" && statusRef.current !== "finished") {
          resume();
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

      // Pages `sinceSeq` onward into `built` until a short page, then hands
      // over to the stream: both the first join (`sinceSeq = 0`) and a
      // resume (`sinceSeq = headSeqLocal`) share this one loop, so the
      // handoff -- merging whatever the subscriber buffered into `pending`
      // while this ran, then flipping `backfilling` off -- only exists once.
      async function backfillFrom(sinceSeqStart: number): Promise<void> {
        try {
          let sinceSeq = sinceSeqStart;
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
        // synchronously, before awaiting anything: a push arriving from
        // this point sees `backfilling === false` and enqueues its own
        // append, which the shared chain guarantees runs only after this
        // merge's append finishes.
        // See README: Live timeline join sequence.
        const toAppend = pending;
        pending = [];
        backfilling = false;

        await enqueueAppend(toAppend);
        if (!isCurrent()) return;
        publish(null);
        setLoading(false);
      }

      void backfillFrom(0);
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
