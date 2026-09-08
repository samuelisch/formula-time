import { afterEach, describe, expect, test, vi } from "vitest";

import type { Session } from "@formula-time/db";

import type { EventRow, EventSource } from "./event-source.js";
import { RaceStateProjector } from "./projector.js";

const SESSION: Session = {
  sessionKey: 42n,
  name: "Test GP",
  country: "Testland",
  circuitKey: 1,
  dateStart: new Date("2026-09-06T13:00:00.000Z"),
  dateEnd: new Date("2026-09-06T15:00:00.000Z"),
  totalLaps: 50,
  status: "live",
  exportedAt: null,
};

function driverRow(seq: number, driverNumber: number): EventRow {
  return {
    seq: BigInt(seq),
    eventId: `event-${seq}`,
    endpoint: "drivers",
    sourceTime: null,
    payload: { driver_number: driverNumber },
  };
}

/** In-memory fake: rows keyed by seq, a `visible` set standing in for "committed". */
class FakeSource implements EventSource {
  public readonly readAfterCalls: Array<{ sessionKey: bigint; afterSeq: bigint; limit: number }> = [];
  public readonly readWindowCalls: Array<{ sessionKey: bigint; fromSeq: bigint; toSeq: bigint }> = [];
  private readonly rows: EventRow[];
  private readonly visible: Set<string>;

  public constructor(rows: EventRow[], visibleIds: string[]) {
    this.rows = rows;
    this.visible = new Set(visibleIds);
  }

  public reveal(eventId: string): void {
    this.visible.add(eventId);
  }

  public async readAfter(sessionKey: bigint, afterSeq: bigint, limit: number): Promise<EventRow[]> {
    this.readAfterCalls.push({ sessionKey, afterSeq, limit });
    return this.rows
      .filter((row) => row.seq > afterSeq && this.visible.has(row.eventId))
      .sort((a, b) => (a.seq < b.seq ? -1 : 1))
      .slice(0, limit);
  }

  public async readWindow(sessionKey: bigint, fromSeq: bigint, toSeq: bigint): Promise<EventRow[]> {
    this.readWindowCalls.push({ sessionKey, fromSeq, toSeq });
    return this.rows
      .filter((row) => row.seq > fromSeq && row.seq <= toSeq && this.visible.has(row.eventId))
      .sort((a, b) => (a.seq < b.seq ? -1 : 1));
  }
}

function noopLog(): void {
  // quiet in tests unless a test spies on it
}

const projectors: RaceStateProjector[] = [];
function tracked(projector: RaceStateProjector): RaceStateProjector {
  projectors.push(projector);
  return projector;
}

afterEach(() => {
  for (const projector of projectors.splice(0)) {
    projector.stop();
  }
});

describe("RaceStateProjector", () => {
  test("cursor advances to the last applied seq and the subscriber sees the final state", async () => {
    const rows = [driverRow(1, 1), driverRow(2, 2), driverRow(3, 3)];
    const source = new FakeSource(rows, rows.map((r) => r.eventId));
    const projector = tracked(
      new RaceStateProjector({
        source,
        session: SESSION,
        tickMs: 100_000, // one tick only, well within the test's lifetime
        log: noopLog,
      }),
    );

    const seen: Array<{ cursor: bigint }> = [];
    projector.subscribe((_state, cursor) => seen.push({ cursor }));

    projector.start();
    await vi.waitFor(() => expect(projector.status().caughtUp).toBe(true));

    expect(projector.status().cursor).toBe(3n);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cursor).toBe(3n);
    expect(projector.snapshot().drivers["1"]).toBeDefined();
    expect(projector.snapshot().drivers["3"]).toBeDefined();
    expect(source.readAfterCalls[0]?.sessionKey).toBe(SESSION.sessionKey);
  });

  test("a full batch triggers an immediate second read before any subscriber call", async () => {
    const rows = [driverRow(1, 1), driverRow(2, 2), driverRow(3, 3)];
    const source = new FakeSource(rows, rows.map((r) => r.eventId));
    const order: string[] = [];
    const originalReadAfter = source.readAfter.bind(source);
    source.readAfter = async (sessionKey, afterSeq, limit) => {
      order.push(`read(${afterSeq})`);
      return originalReadAfter(sessionKey, afterSeq, limit);
    };

    const projector = tracked(
      new RaceStateProjector({
        source,
        session: SESSION,
        tickMs: 100_000,
        batchLimit: 2,
        log: noopLog,
      }),
    );
    projector.subscribe(() => order.push("publish"));

    projector.start();
    await vi.waitFor(() => expect(projector.status().caughtUp).toBe(true));

    // batchLimit=2: the first read returns exactly 2 rows (full batch) -> read
    // again immediately without publishing; the second read returns 1 row
    // (< batchLimit) -> publish.
    expect(order).toEqual(["read(0)", "read(2)", "publish"]);
    expect(projector.status().cursor).toBe(3n);
  });

  test("subscribers are not called until the fold is caught up", async () => {
    const rows = [driverRow(1, 1)];
    const source = new FakeSource(rows, []); // nothing visible yet
    const projector = tracked(
      new RaceStateProjector({
        source,
        session: SESSION,
        tickMs: 100_000,
        log: noopLog,
      }),
    );
    const fn = vi.fn();
    projector.subscribe(fn);

    projector.start();
    await vi.waitFor(() => expect(projector.status().caughtUp).toBe(true));

    // no rows were visible, so the fold applied nothing on this tick, but it
    // is the startup tick, so caughtUp flips true and the subscriber fires once.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("detector: an unseen event_id below the cursor forces a full rebuild", async () => {
    // seq 3 ("c") is hidden at first tick -- simulates it committing after seq 4/5.
    const rows = [driverRow(1, 1), driverRow(2, 2), driverRow(3, 3), driverRow(4, 4), driverRow(5, 5)];
    const initiallyVisible = rows.filter((r) => r.eventId !== "event-3").map((r) => r.eventId);
    const source = new FakeSource(rows, initiallyVisible);

    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const projector = tracked(
      new RaceStateProjector({
        source,
        session: SESSION,
        tickMs: 10,
        detectorEveryTicks: 1,
        log: (msg, fields) => logs.push({ msg, fields }),
      }),
    );

    const seen: Array<{ cursor: bigint; driverCount: number }> = [];
    projector.subscribe((state, cursor) =>
      seen.push({ cursor, driverCount: Object.keys(state.drivers).length }),
    );

    projector.start();
    // Tick 1: the detector runs against an empty window (cursor is still 0);
    // then the normal fold applies rows 1, 2, 4, 5 (3 stays hidden).
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    expect(projector.snapshot().drivers["3"]).toBeUndefined();

    // "c" commits late: it becomes visible, e.g. because a second writer
    // connection landed it out of order (never happens with the
    // single-connection writer in production -- this exercises the alarm).
    source.reveal("event-3");

    // Tick 2 (10ms later): the detector's window now sees "event-3", which
    // was never applied -- alarm fires, full rebuild, re-fold to caught up
    // in the same tick.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));

    expect(logs.some((l) => l.msg === "late commit detected")).toBe(true);
    expect(seen[1]?.driverCount).toBe(5);
    expect(projector.snapshot().drivers["3"]).toBeDefined();
    expect(projector.status().cursor).toBe(5n);
    expect(source.readWindowCalls[0]?.sessionKey).toBe(SESSION.sessionKey);
  });

  test("runDetector: a rejected re-fold read keeps serving the previous state and retries next pass", async () => {
    // Fake timers so each tick can be advanced one at a time -- with real
    // timers, vi.waitFor's polling interval (50ms) lets several 10ms ticks
    // elapse between checks, so the intermediate "rebuild failed" state
    // (which lasts exactly one tick) can't be reliably observed.
    vi.useFakeTimers();
    try {
      const rows = [driverRow(1, 1), driverRow(2, 2), driverRow(3, 3), driverRow(4, 4), driverRow(5, 5)];
      const initiallyVisible = rows.filter((r) => r.eventId !== "event-3").map((r) => r.eventId);
      const source = new FakeSource(rows, initiallyVisible);

      const originalReadAfter = source.readAfter.bind(source);
      let rejectNextRead = false;
      source.readAfter = async (sessionKey, afterSeq, limit) => {
        if (rejectNextRead) {
          rejectNextRead = false;
          throw new Error("connection reset");
        }
        return originalReadAfter(sessionKey, afterSeq, limit);
      };

      const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
      const projector = tracked(
        new RaceStateProjector({
          source,
          session: SESSION,
          tickMs: 10,
          detectorEveryTicks: 1,
          log: (msg, fields) => logs.push({ msg, fields }),
        }),
      );

      const seen: Array<{ cursor: bigint; driverCount: number }> = [];
      projector.subscribe((state, cursor) =>
        seen.push({ cursor, driverCount: Object.keys(state.drivers).length }),
      );

      projector.start();
      // Tick 1 (delay 0): normal fold applies rows 1, 2, 4, 5 (3 stays hidden).
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(1);
      const preDetectorSnapshot = projector.snapshot();
      expect(preDetectorSnapshot.drivers["3"]).toBeUndefined();
      expect(projector.status().cursor).toBe(5n);

      rejectNextRead = true;
      source.reveal("event-3");

      // Tick 2: the detector finds event-3 unapplied and starts a rebuild;
      // its first read rejects. The previous state must keep being served --
      // no publish, cursor and snapshot unchanged -- and the failure is
      // logged distinctly from a generic tick failure.
      await vi.advanceTimersByTimeAsync(10);
      expect(logs.some((l) => l.msg === "rebuild failed, keeping previous state")).toBe(true);
      expect(seen).toHaveLength(1);
      expect(projector.status().cursor).toBe(5n);
      expect(projector.snapshot()).toEqual(preDetectorSnapshot);

      // Tick 3: the next detector pass retries the rebuild (appliedIds/cursor
      // were never touched by the failed attempt, so the same late row is
      // found again); this time the read succeeds and the subscriber
      // receives the fully rebuilt state.
      await vi.advanceTimersByTimeAsync(10);
      expect(seen).toHaveLength(2);
      expect(seen[1]?.driverCount).toBe(5);
      expect(projector.snapshot().drivers["3"]).toBeDefined();
      expect(projector.status().cursor).toBe(5n);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a rejected read is caught, logged, and retried on the next tick -- no stall, no crash", async () => {
    const rows = [driverRow(1, 1)];
    const source = new FakeSource(rows, rows.map((r) => r.eventId));
    const originalReadAfter = source.readAfter.bind(source);
    let calls = 0;
    source.readAfter = async (sessionKey, afterSeq, limit) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("connection reset");
      }
      return originalReadAfter(sessionKey, afterSeq, limit);
    };

    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const projector = tracked(
      new RaceStateProjector({
        source,
        session: SESSION,
        tickMs: 10, // fast retry so the test doesn't wait a full 250ms default tick
        log: (msg, fields) => logs.push({ msg, fields }),
      }),
    );
    const fn = vi.fn();
    projector.subscribe(fn);

    projector.start();
    // Tick 1: readAfter rejects -- caught, logged, cursor/state untouched, no
    // publish. Tick 2 (10ms later): readAfter succeeds, applies the row.
    await vi.waitFor(() => expect(projector.status().caughtUp).toBe(true));

    const failLog = logs.find((l) => l.msg === "projector tick failed");
    expect(failLog).toBeDefined();
    expect(failLog?.fields?.cursor).toBe("0");
    expect(failLog?.fields?.error).toContain("connection reset");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(projector.status().cursor).toBe(1n);
    expect(projector.snapshot().drivers["1"]).toBeDefined();
  });

  test("stop() while a tick's read is pending, then start(): the stale chain doesn't survive", async () => {
    vi.useFakeTimers();
    try {
      // Call #1 (tick 1's read) hangs until manually resolved, simulating
      // a read still in flight at the moment stop() runs. Every call after
      // that returns exactly one new row, so a surviving chain publishes
      // on every tick -- a reliable per-tick heartbeat to count.
      let callCount = 0;
      let staleResolve: ((rows: EventRow[]) => void) | null = null;
      const source: EventSource = {
        readAfter: (_sessionKey, afterSeq, _limit) => {
          callCount += 1;
          if (callCount === 1) {
            return new Promise<EventRow[]>((resolve) => {
              staleResolve = resolve;
            });
          }
          const seq = afterSeq + 1n;
          return Promise.resolve([driverRow(Number(seq), Number(seq))]);
        },
        readWindow: async () => [],
      };

      const publishes: number[] = [];
      const projector = tracked(
        new RaceStateProjector({ source, session: SESSION, tickMs: 10, log: noopLog }),
      );
      projector.subscribe(() => publishes.push(publishes.length));

      projector.start(); // generation 1
      await vi.advanceTimersByTimeAsync(0); // tick 1 fires and hangs on its read
      expect(callCount).toBe(1);

      projector.stop();
      projector.start(); // generation 2 -- a fresh chain scheduled at delay 0

      // The stale read finally resolves. The gen-1 tick must recognize the
      // generation mismatch and bail without rescheduling -- otherwise it
      // would call scheduleTick() again, leaving two independent chains.
      staleResolve?.([]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Advance through several tick intervals and count publishes. A
      // surviving duplicate chain would roughly double the rate.
      await vi.advanceTimersByTimeAsync(100); // ~10 ticks at 10ms
      projector.stop();

      expect(publishes.length).toBeGreaterThanOrEqual(6);
      expect(publishes.length).toBeLessThanOrEqual(11);
    } finally {
      vi.useRealTimers();
    }
  });
});
