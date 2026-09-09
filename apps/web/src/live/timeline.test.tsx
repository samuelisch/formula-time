// Issue #97 PR1, reworked per the owner's decision 2026-09-09 (issue #114):
// no head polling -- the live store's push stream carries the events
// applied each tick, and this hook backfills once per join then keeps
// itself current from the stream alone.
import type { RaceEvent, RaceState } from "@formula-time/domain";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RaceEventsPage, SessionStatus } from "../races/api.ts";
import { emptyAnchors } from "./anchors.ts";
import { emptyBuffer } from "./buffer.ts";
import { useLiveStore } from "./store.ts";
import { PAGE_LIMIT, RETRY_BACKOFF_MS, useSessionTimeline } from "./timeline.ts";
import type { LivePush } from "./types.ts";

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
});
