import { afterEach, describe, expect, test, vi } from "vitest";

import type { Session } from "@formula-time/db";

import type { EventRow, EventSource } from "./projector/event-source.js";
import { createSessionLifecycle, type PollHooks, type Pusher } from "./session-lifecycle.js";

function fakePusher(): Pusher {
  return { push: vi.fn(async () => {}), size: () => 0 };
}

/** Records call order (shared with a pusher's push, when the test wants it) alongside args. */
function fakePollHooks(calls: string[] = []): PollHooks & { calls: string[] } {
  return {
    calls,
    start: vi.fn(async () => {
      calls.push("start");
    }),
    onState: vi.fn(async () => {
      calls.push("onState");
    }),
    onSessionFinished: vi.fn(async () => {
      calls.push("onSessionFinished");
    }),
    publicPolls: vi.fn(() => [{ poll_id: "fake" }]),
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionKey: 42n,
    name: "Test GP",
    country: "Testland",
    circuitKey: 1,
    dateStart: new Date("2026-09-06T13:00:00.000Z"),
    dateEnd: new Date("2026-09-06T15:00:00.000Z"),
    totalLaps: 50,
    status: "live",
    exportedAt: null,
    ...overrides,
  };
}

function driverRow(seq: number, driverNumber: number): EventRow {
  return {
    seq: BigInt(seq),
    eventId: `event-${seq}`,
    endpoint: "drivers",
    sourceTime: null,
    payload: { driver_number: driverNumber },
  };
}

/** In-memory fake source, same shape as projector.test.ts's. */
class FakeSource implements EventSource {
  private readonly rows: EventRow[];

  public constructor(rows: EventRow[]) {
    this.rows = rows;
  }

  public async readAfter(sessionKey: bigint, afterSeq: bigint, limit: number): Promise<EventRow[]> {
    return this.rows
      .filter((row) => row.seq > afterSeq)
      .sort((a, b) => (a.seq < b.seq ? -1 : 1))
      .slice(0, limit);
  }

  public async readWindow(sessionKey: bigint, fromSeq: bigint, toSeq: bigint): Promise<EventRow[]> {
    return this.rows.filter((row) => row.seq > fromSeq && row.seq <= toSeq);
  }
}

function noopLog(): void {}

describe("createSessionLifecycle", () => {
  test('/health shape before any session is found: session_key null, cursor "0", caught_up false', async () => {
    const pickSession = vi.fn(async () => null);
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher: fakePusher(),
      pickSession,
      polls: fakePollHooks(),
      log: () => {},
    });

    await lifecycle.check();

    expect(lifecycle.health()).toEqual({
      ok: true,
      session_key: null,
      cursor: "0",
      caught_up: false,
      viewers: 0,
    });
    expect(pickSession).toHaveBeenCalledTimes(1);
  });

  test("reports the pusher's current viewer count even with no session", () => {
    const pusher: Pusher = { push: vi.fn(async () => {}), size: () => 3 };
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher,
      pickSession: vi.fn(async () => null),
      polls: fakePollHooks(),
      log: () => {},
    });

    expect(lifecycle.health().viewers).toBe(3);
  });

  test("stop() is safe to call with no projector running", () => {
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher: fakePusher(),
      pickSession: vi.fn(async () => null),
      polls: fakePollHooks(),
      log: () => {},
    });

    expect(() => lifecycle.stop()).not.toThrow();
  });

  test("no session found logs the warning only once across repeated checks", async () => {
    const log = vi.fn();
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher: fakePusher(),
      pickSession: vi.fn(async () => null),
      polls: fakePollHooks(),
      log,
    });

    await lifecycle.check();
    await lifecycle.check();
    await lifecycle.check();

    expect(log).toHaveBeenCalledTimes(1);
  });

  describe("poll wiring", () => {
    const projectors: Array<{ stop(): void }> = [];

    afterEach(() => {
      for (const p of projectors.splice(0)) {
        p.stop();
      }
      vi.useRealTimers();
    });

    test("polls.start() runs with the three session fields before the projector's first push", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const polls = fakePollHooks(calls);
      const pusher: Pusher = {
        push: vi.fn(async () => {
          calls.push("push");
        }),
        size: () => 0,
      };
      const source = new FakeSource([driverRow(1, 1)]);
      const sess = session({ sessionKey: 42n, totalLaps: 50, country: "Testland" });

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source,
        pusher,
        pickSession: vi.fn(async () => sess),
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      await vi.advanceTimersByTimeAsync(0); // first tick: fold + publish

      expect(polls.start).toHaveBeenCalledWith({ sessionKey: 42n, totalLaps: 50, country: "Testland" });
      expect(calls.indexOf("start")).toBeLessThan(calls.indexOf("push"));
    });

    test("onState() runs before push() on every subscriber call, and the push carries polls.publicPolls()", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const polls = fakePollHooks(calls);
      const pushed: unknown[] = [];
      const pusher: Pusher = {
        push: vi.fn(async (payload: object) => {
          calls.push("push");
          pushed.push(payload);
        }),
        size: () => 0,
      };
      const rows = [driverRow(1, 1)];
      const source = new FakeSource(rows);
      const sess = session();

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source,
        pusher,
        pickSession: vi.fn(async () => sess),
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      await vi.advanceTimersByTimeAsync(0); // first tick

      rows.push(driverRow(2, 2));
      await vi.advanceTimersByTimeAsync(250); // second tick, picks up the new row

      expect(pushed.length).toBeGreaterThanOrEqual(2);
      // Every push must be immediately preceded by an onState in the recorded order.
      const pushIndices = calls.reduce<number[]>((acc, call, i) => {
        if (call === "push") acc.push(i);
        return acc;
      }, []);
      for (const i of pushIndices) {
        expect(calls[i - 1]).toBe("onState");
      }
      for (const payload of pushed) {
        expect((payload as { polls: unknown }).polls).toEqual(polls.publicPolls());
      }
    });

    test("the push waits for onState()'s fold and carries the post-fold polls", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      let folded = false;
      polls.onState = vi.fn(async () => {
        // A fold that lands later, as PollModule's write chain does.
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        folded = true;
      });
      polls.publicPolls = vi.fn(() => (folded ? [{ poll_id: "after" }] : [{ poll_id: "before" }]));
      const pushed: unknown[] = [];
      const pusher: Pusher = {
        push: vi.fn(async (payload: object) => {
          pushed.push(payload);
        }),
        size: () => 0,
      };

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source: new FakeSource([driverRow(1, 1)]),
        pusher,
        pickSession: vi.fn(async () => session()),
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      await vi.advanceTimersByTimeAsync(0); // first tick: fold scheduled, push must wait
      expect(pushed).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(10); // fold lands
      expect(pushed).toHaveLength(1);
      expect((pushed[0] as { polls: unknown }).polls).toEqual([{ poll_id: "after" }]);
    });

    test("a status flip to finished calls onSessionFinished exactly once", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      const live = session({ status: "live" });
      const finished = session({ status: "finished" });
      const pickSession = vi.fn(async () => live);

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source: new FakeSource([]),
        pusher: fakePusher(),
        pickSession,
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check(); // discovers `live`
      pickSession.mockImplementation(async () => finished);
      await lifecycle.check(); // same key, now finished -- fires once
      await lifecycle.check(); // still finished -- must not fire again

      expect(polls.onSessionFinished).toHaveBeenCalledTimes(1);
    });

    test("a session already finished on first discovery: start() then onSessionFinished(), once", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const polls = fakePollHooks(calls);
      const pusher: Pusher = {
        push: vi.fn(async () => {
          calls.push("push");
        }),
        size: () => 0,
      };
      const finished = session({ status: "finished" });

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source: new FakeSource([driverRow(1, 1)]),
        pusher,
        pickSession: vi.fn(async () => finished),
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check(); // first ever discovery, already finished
      await vi.advanceTimersByTimeAsync(0); // first tick
      await lifecycle.check(); // same key, still finished: no second void

      expect(calls.slice(0, 2)).toEqual(["start", "onSessionFinished"]);
      expect(calls.indexOf("onSessionFinished")).toBeLessThan(calls.indexOf("push"));
      expect(polls.onSessionFinished).toHaveBeenCalledTimes(1);
    });

    test("a key change onto an already-finished session voids the new session's polls too", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const polls = fakePollHooks(calls);
      const live = session({ sessionKey: 1n, status: "live" });
      const finished = session({ sessionKey: 2n, status: "finished" });
      const pickSession = vi.fn(async () => live);

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source: new FakeSource([]),
        pusher: fakePusher(),
        pickSession,
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      pickSession.mockImplementation(async () => finished);
      await lifecycle.check();

      expect(calls).toEqual(["start", "onSessionFinished", "start", "onSessionFinished"]);
    });

    test("a session-key change retires the old session then starts the new one", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const polls = fakePollHooks(calls);
      const first = session({ sessionKey: 1n });
      const second = session({ sessionKey: 2n });
      const pickSession = vi.fn(async () => first);

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source: new FakeSource([]),
        pusher: fakePusher(),
        pickSession,
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check(); // starts session 1 (previousSession is null: no onSessionFinished yet)
      pickSession.mockImplementation(async () => second);
      await lifecycle.check(); // key changed: onSessionFinished (for 1) then start (for 2)

      expect(calls).toEqual(["start", "onSessionFinished", "start"]);
      expect(polls.start).toHaveBeenLastCalledWith({ sessionKey: 2n, totalLaps: 50, country: "Testland" });
    });

    test("a rejected polls.start() is logged and check() still resolves", async () => {
      vi.useFakeTimers();
      const log = vi.fn();
      const polls = fakePollHooks();
      (polls.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
      const sess = session();

      const lifecycle = createSessionLifecycle({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: {} as any,
        source: new FakeSource([]),
        pusher: fakePusher(),
        pickSession: vi.fn(async () => sess),
        polls,
        log,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await expect(lifecycle.check()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith("poll hook start failed", expect.objectContaining({ error: "boom" }));
    });
  });
});
