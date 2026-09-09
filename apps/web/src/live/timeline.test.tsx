// Issue #97 PR1, reworked per the owner's decision 2026-09-09 (issue #114):
// no head polling -- the live store's push stream carries the events
// applied each tick, and this hook backfills once per join then keeps
// itself current from the stream alone.
import type { RaceEvent, RaceState } from "@formula-time/domain";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RaceEventsPage, SessionStatus } from "../races/api.ts";
import * as replayTimelineModule from "../replay/timeline.ts";
import { emptyAnchors } from "./anchors.ts";
import { emptyBuffer } from "./buffer.ts";
import { sessionStatusOf } from "./selectors.ts";
import { useLiveStore } from "./store.ts";
import { PAGE_LIMIT, RETRY_BACKOFF_MS, useSessionTimeline } from "./timeline.ts";
import type { LivePush } from "./types.ts";

// Review round 2 regression tests need to observe (and, for one test,
// briefly pause) `appendEvents` calls on the shared `Timeline` -- so
// `appendEvents` is mocked here, but wired by default to delegate to the
// real implementation (captured via `vi.hoisted`, since `vi.mock`'s
// factory is itself hoisted above ordinary top-level variables) so every
// other test still folds for real and gets real results; only the one
// test that overrides `mockImplementation` sees different timing, and
// the shared `afterEach` below restores the passthrough for whichever
// test runs next.
//
// `react`'s `useLayoutEffect` is instrumented the same way, for the
// `statusRef` regression below: `vi.spyOn` cannot patch a live ESM
// namespace export directly ("Module namespace is not configurable"), so
// this wraps it through `vi.mock` instead, delegating to the real
// implementation so every hook (this file's own, and React/React DOM's
// internals) keeps working exactly as before.
const mocks = vi.hoisted(() => {
  return {
    actualAppendEvents: undefined as unknown as typeof import("../replay/timeline.ts").appendEvents,
    actualUseLayoutEffect: undefined as unknown as typeof import("react").useLayoutEffect,
  };
});
vi.mock("../replay/timeline.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../replay/timeline.ts")>();
  mocks.actualAppendEvents = actual.appendEvents;
  return { ...actual, appendEvents: vi.fn(actual.appendEvents) };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  mocks.actualUseLayoutEffect = actual.useLayoutEffect;
  return { ...actual, useLayoutEffect: vi.fn(actual.useLayoutEffect) };
});

function resetLiveStore(): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    anchors: emptyAnchors(),
  });
}

function event(id: string): RaceEvent {
  return { event_id: id, endpoint: "position", source_time: null, payload: { driver_number: 1, position: 1 } };
}

function minimalRaceState(): RaceState {
  return {
    sequence: 0,
    latest_source_time: null,
    session: null,
    drivers: {},
    driver_order: [],
    race_control: {
      session_status: null,
      current_flag: null,
      safety_car: null,
      active_flags: {},
      driver_flags: {},
      recent_messages: [],
    },
    weather: null,
    anomalies: { duplicate_events: 0, stale_updates: 0, missing_driver: 0, unsupported_events: 0 },
  };
}

/** A push as it would arrive on the live store, carrying issue #114's `events` (and optionally `rebuilt`). */
function streamPush(seq: string, events: RaceEvent[], rebuilt?: boolean): LivePush {
  const push: LivePush = {
    type: "state",
    seq,
    sent_at: Date.now(),
    session_key: "9999",
    total_laps: null,
    state: minimalRaceState(),
    polls: [],
    events,
  };
  if (rebuilt !== undefined) push.rebuilt = rebuilt;
  return push;
}

/** Same as `streamPush`, but with the session's own `status` field set -- for the `statusRef` race regression below, where a caller derives `status` from the live store the same way a real page's `useSessionStatus()` would. */
function streamPushWithStatus(seq: string, status: SessionStatus, rebuilt?: boolean): LivePush {
  const push = streamPush(seq, []);
  push.state = { ...push.state, session: { status } };
  if (rebuilt !== undefined) push.rebuilt = rebuilt;
  return push;
}

/** Mirrors how a real page composes this hook: `status` comes from the live store itself (like `useSessionStatus()`), so this hook's own store subscriber and the caller's re-render are both driven by the same `set()` call -- the composition the `statusRef` race below depends on. */
function useHarness(sessionKey: number) {
  const status = useLiveStore((state) => sessionStatusOf(state.live?.state.session) ?? "live") as SessionStatus;
  return useSessionTimeline(sessionKey, status);
}

function fullPage(prefix: string, nextSeq: number, status: SessionStatus = "live"): RaceEventsPage {
  return {
    session_key: "9999",
    status,
    events: Array.from({ length: PAGE_LIMIT }, (_, i) => event(`${prefix}-${i}`)),
    next_seq: nextSeq,
  };
}

function shortPage(events: RaceEvent[], nextSeq: number | null, status: SessionStatus = "live"): RaceEventsPage {
  return { session_key: "9999", status, events, next_seq: nextSeq };
}

function jsonResponse(page: RaceEventsPage): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(page) } as Response;
}

function errorResponse(status: number, message: string): Response {
  return { ok: false, status, json: () => Promise.resolve({ error: message }) } as Response;
}

/** A `fetch` stub that serves `pages` in order, one per call; throws if called more than queued. */
function queuedFetch(pages: Array<RaceEventsPage | { error: number; message: string }>) {
  let index = 0;
  return vi.fn((..._args: unknown[]) => {
    if (index >= pages.length) {
      throw new Error(`fetch called more times (${index + 1}) than pages were queued (${pages.length})`);
    }
    const page = pages[index]!;
    index += 1;
    if ("error" in page) return Promise.resolve(errorResponse(page.error, page.message));
    return Promise.resolve(jsonResponse(page));
  });
}

describe("useSessionTimeline", () => {
  beforeEach(() => {
    resetLiveStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // Restore the default passthrough in case a test overrode it.
    vi.mocked(replayTimelineModule.appendEvents).mockReset();
    vi.mocked(replayTimelineModule.appendEvents).mockImplementation(mocks.actualAppendEvents);
  });

  it("pages from since_seq=0 with limit=5000 until a short page, folding every page", async () => {
    const fetchStub = queuedFetch([
      fullPage("p1", PAGE_LIMIT),
      fullPage("p2", 2 * PAGE_LIMIT),
      fullPage("p3", 3 * PAGE_LIMIT),
      shortPage([event("head-1"), event("head-2")], 3 * PAGE_LIMIT + 2),
    ]);
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 10_000 });

    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(fetchStub.mock.calls[0]![0]).toBe(`/api/races/9999/events?since_seq=0&limit=${PAGE_LIMIT}`);
    expect(fetchStub.mock.calls[1]![0]).toBe(`/api/races/9999/events?since_seq=${PAGE_LIMIT}&limit=${PAGE_LIMIT}`);
    expect(fetchStub.mock.calls[2]![0]).toBe(`/api/races/9999/events?since_seq=${2 * PAGE_LIMIT}&limit=${PAGE_LIMIT}`);
    expect(fetchStub.mock.calls[3]![0]).toBe(`/api/races/9999/events?since_seq=${3 * PAGE_LIMIT}&limit=${PAGE_LIMIT}`);

    expect(result.current.error).toBeNull();
    expect(result.current.headSeq).toBe(3 * PAGE_LIMIT + 2);
    expect(result.current.timeline).not.toBeNull();
    expect(result.current.timeline!.events).toHaveLength(3 * PAGE_LIMIT + 2);
  }, 15_000);

  it("merges the pending list buffered during backfill, deduping the overlap with the last page, in seq order", async () => {
    // The mock's own call is where we simulate a push landing on the live
    // store mid-backfill -- synchronously, before the fetch promise even
    // resolves, so it is unambiguously buffered while backfilling is still
    // true, regardless of real scheduling.
    const fetchStub = vi.fn((..._args: unknown[]) => {
      useLiveStore.setState({ live: streamPush("2", [event("e2"), event("e3")]) });
      return Promise.resolve(jsonResponse(shortPage([event("e1"), event("e2")], 2)));
    });
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // e2 came back from both the backfill page and the buffered push --
    // deduped to one, in seq order.
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1", "e2", "e3"]);
  });

  it("keeps appending each push's events directly once the backfill is done", async () => {
    const fetchStub = queuedFetch([shortPage([event("e1")], 1)]);
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1"]);

    act(() => {
      useLiveStore.setState({ live: streamPush("2", [event("e2")]) });
    });

    // Wait on `headSeq` (a plain number), not `timeline.events`: `timeline`
    // and `headSeq` commit together from the same `setSnapshot` call, but
    // `appendEvents` mutates `Timeline.events` in place, so a *stale*
    // `result.current.timeline` (from the render before this push) would
    // already show `e2` too once the array is mutated -- `headSeq` is the
    // reliable signal that this specific update has actually landed.
    await waitFor(() => expect(result.current.headSeq).toBe(2));
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1", "e2"]);
    // No further read: still exactly the one backfill fetch.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("discards the timeline and re-backfills on a push with rebuilt: true", async () => {
    const fetchStub = queuedFetch([shortPage([event("e1")], 1), shortPage([event("r1")], 1)]);
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1"]);

    act(() => {
      useLiveStore.setState({ live: streamPush("1", [], true) });
    });

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchStub).toHaveBeenCalledTimes(2);
    // The old timeline (e1) is gone, not merged with the re-backfilled one.
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["r1"]);
  });

  it("discards the timeline and re-backfills when the live connection leaves open", async () => {
    const fetchStub = queuedFetch([shortPage([event("e1")], 1), shortPage([event("r1")], 1)]);
    vi.stubGlobal("fetch", fetchStub);

    useLiveStore.setState({ connection: "open" });
    const { result } = renderHook(() => useSessionTimeline(9999, "live"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1"]);

    act(() => {
      useLiveStore.setState({ connection: "reconnecting" });
    });

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["r1"]);
  });

  it("does not spuriously restart on a rebuilt push right after a flushed status flip to finished", async () => {
    const fetchStub = queuedFetch([shortPage([event("e1")], 1)]);
    vi.stubGlobal("fetch", fetchStub);

    // `useHarness` derives `status` from the live store itself, the same
    // way a real page's `useSessionStatus()` does -- so this hook's own
    // `useLiveStore.subscribe` callback and the caller's `status` re-render
    // are both driven by the same `set()` call the assertions below fire.
    const { result } = renderHook(() => useHarness(9999));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchStub).toHaveBeenCalledTimes(1);

    // `flushSync` forces the status-flipping push through render, commit,
    // and effects before returning -- the deterministic stand-in, in this
    // test environment, for "the status transition has fully landed"
    // ahead of the next push.
    flushSync(() => {
      useLiveStore.setState({ live: streamPushWithStatus("2", "finished") });
    });
    // A rebuilt push arrives right after. `statusRef` must read "finished"
    // by now, or this would wrongly restart (re-backfill) a session that
    // has already finished -- the case the join-sequence comment says must
    // be ignored once finished.
    useLiveStore.setState({ live: streamPushWithStatus("3", "finished", true) });

    // `restart()` defers the actual re-backfill to a microtask (its own
    // out-of-memory-recursion guard, see its comment) -- so a spurious
    // restart would not show up as a second fetch until that microtask
    // runs. Give it every chance to before asserting it never happened.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // No restart: still exactly the one backfill fetch.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("keeps `statusRef` current via a layout effect, not a passive one", () => {
    // The guard above pins the documented contract, but this test
    // environment cannot reliably reproduce the exact production race a
    // passive effect risks (a `useLiveStore.subscribe` callback firing,
    // synchronously and outside React, between commit and a deferred
    // passive-effect flush) -- `act()`/`flushSync` make effect flushing
    // deterministic here in a way a real page's uncontrolled `EventSource`
    // dispatch is not. This test pins the fix structurally instead: the
    // status sync inside `useSessionTimeline` must go through
    // `useLayoutEffect` (synchronous at commit, before the browser can
    // process another event), never `useEffect` (deferred, no ordering
    // guarantee against the next SSE-driven `set()`).
    const callsBefore = vi.mocked(useLayoutEffect).mock.calls.length;
    renderHook(() => useSessionTimeline(9999, "live"));
    expect(vi.mocked(useLayoutEffect).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("retries a failed backfill page at the retry backoff and clears error on the next success", async () => {
    vi.useFakeTimers();
    const fetchStub = queuedFetch([{ error: 503, message: "down" }, shortPage([event("e1")], 1)]);
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));

    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toContain("503");
    expect(result.current.loading).toBe(true); // still retrying, not given up

    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS);

    expect(fetchStub).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1"]);
  });

  it("serializes appendEvents calls: a push arriving mid pending-merge does not run concurrently with it (review round 2)", async () => {
    // Backfill's one page is appendEvents call 0; the pending-merge (an
    // empty pending list here, since no push lands during backfill) is
    // call 1 -- pause exactly that call to reproduce the window review
    // round 2 found unsafe: `backfilling` flips before this call
    // resolves, so a push arriving right here used to take the
    // direct-append branch and run a second, concurrent appendEvents.
    let activeCalls = 0;
    let maxConcurrent = 0;
    let callIndex = 0;
    let releasePendingMerge: (() => void) | null = null;

    vi.mocked(replayTimelineModule.appendEvents).mockImplementation(async (timeline, events) => {
      const myCallIndex = callIndex;
      callIndex += 1;
      activeCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      try {
        if (myCallIndex === 1) {
          await new Promise<void>((resolve) => {
            releasePendingMerge = resolve;
          });
        }
        return await mocks.actualAppendEvents(timeline, events);
      } finally {
        activeCalls -= 1;
      }
    });

    const fetchStub = queuedFetch([shortPage([event("e1")], 1)]);
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));

    // Wait until the pending-merge call (call index 1) is paused mid-flight.
    await waitFor(() => expect(releasePendingMerge).not.toBeNull());
    expect(maxConcurrent).toBe(1);

    // A push arrives while that call is still paused.
    act(() => {
      useLiveStore.setState({ live: streamPush("2", [event("e2")]) });
    });

    // Give a (buggy) concurrent call every chance to start before release.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maxConcurrent).toBe(1);
    expect(callIndex).toBe(2); // e2's call has not started yet -- still queued behind the paused one

    releasePendingMerge!();

    await waitFor(() => expect(result.current.headSeq).toBe(2));
    expect(maxConcurrent).toBe(1);
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1", "e2"]);
  });

  it("skips a store notification whose live push is unchanged (the store's own tick), but processes a genuinely new push (review round 2)", async () => {
    const fetchStub = queuedFetch([shortPage([event("e1")], 1)]);
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1"]);

    const appendMock = vi.mocked(replayTimelineModule.appendEvents);
    const callsBefore = appendMock.mock.calls.length;

    // Repeated set() calls that leave `live` unchanged -- exactly what the
    // store's own 250ms tick() does while a viewer has a delay (it only
    // ever touches `displayed`/`bufferShort`).
    act(() => {
      useLiveStore.setState({});
      useLiveStore.setState({});
      useLiveStore.setState({});
    });

    expect(appendMock.mock.calls.length).toBe(callsBefore);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    // A genuinely new push is still processed.
    act(() => {
      useLiveStore.setState({ live: streamPush("2", [event("e2")]) });
    });
    await waitFor(() => expect(result.current.headSeq).toBe(2));
    expect(result.current.timeline!.events.map((e) => e.event_id)).toEqual(["e1", "e2"]);
  });

  it("stops with an error instead of looping forever when a full page comes back with next_seq: null", async () => {
    // A full page (events.length === limit) must always carry a non-null
    // next_seq per the api's contract (PR #102) -- this malformed
    // response is the defensive guard's target.
    const malformedFullPage: RaceEventsPage = { ...fullPage("p1", PAGE_LIMIT), next_seq: null };
    const fetchStub = queuedFetch([malformedFullPage]);
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useSessionTimeline(9999, "live"));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loading).toBe(false);
    expect(result.current.error?.message).toContain("next_seq null");
    // No infinite loop: exactly the one (malformed) page was fetched.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
