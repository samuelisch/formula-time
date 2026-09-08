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
  public readonly readAfterCalls: Array<{ afterSeq: bigint; limit: number }> = [];
  public readonly readWindowCalls: Array<{ fromSeq: bigint; toSeq: bigint }> = [];
  private readonly rows: EventRow[];
  private readonly visible: Set<string>;

  public constructor(rows: EventRow[], visibleIds: string[]) {
    this.rows = rows;
    this.visible = new Set(visibleIds);
  }

  public reveal(eventId: string): void {
    this.visible.add(eventId);
  }

  public async readAfter(_sessionKey: bigint, afterSeq: bigint, limit: number): Promise<EventRow[]> {
    this.readAfterCalls.push({ afterSeq, limit });
    return this.rows
      .filter((row) => row.seq > afterSeq && this.visible.has(row.eventId))
      .sort((a, b) => (a.seq < b.seq ? -1 : 1))
      .slice(0, limit);
  }

  public async readWindow(_sessionKey: bigint, fromSeq: bigint, toSeq: bigint): Promise<EventRow[]> {
    this.readWindowCalls.push({ fromSeq, toSeq });
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
});
