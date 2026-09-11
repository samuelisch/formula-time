import { afterEach, describe, expect, test, vi } from "vitest";

import { fakeEventSource } from "./test/fake-event-source.js";
import { fakePollHooks } from "./test/fake-poll-hooks.js";
import { fakePrisma } from "./test/fake-prisma.js";
import { fakePusher } from "./test/fake-pusher.js";
import { fakeSession } from "./test/fixtures.js";
import type { EventRow } from "./projector/event-source.js";
import { createSessionLifecycle, type Pusher } from "./session-lifecycle.js";

function driverRow(seq: number, driverNumber: number): EventRow {
  return {
    seq: BigInt(seq),
    eventId: `event-${seq}`,
    endpoint: "drivers",
    sourceTime: null,
    payload: { driver_number: driverNumber },
  };
}

function noopLog(): void {}

describe("createSessionLifecycle", () => {
  test('/health shape before any session is found: session_key null, cursor "0", caught_up false', async () => {
    const pickSession = vi.fn(async () => null);
    const lifecycle = createSessionLifecycle({
      db: fakePrisma(),
      source: fakeEventSource(),
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
    const lifecycle = createSessionLifecycle({
      db: fakePrisma(),
      source: fakeEventSource(),
      pusher: fakePusher(3),
      pickSession: vi.fn(async () => null),
      polls: fakePollHooks(),
      log: () => {},
    });

    expect(lifecycle.health().viewers).toBe(3);
  });

  test("stop() is safe to call with no projector running", () => {
    const lifecycle = createSessionLifecycle({
      db: fakePrisma(),
      source: fakeEventSource(),
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
      db: fakePrisma(),
      source: fakeEventSource(),
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
      const polls = fakePollHooks({ calls });
      const pushed: unknown[] = [];
      const pusher: Pusher = {
        push: vi.fn(async (payload: object) => {
          calls.push("push");
          pushed.push(payload);
        }),
        size: () => 0,
      };
      const source = fakeEventSource([driverRow(1, 1)]);
      const sess = fakeSession({ sessionKey: 42n, totalLaps: 50, country: "Testland" });

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
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
      const polls = fakePollHooks({ calls });
      const pushed: unknown[] = [];
      const pusher: Pusher = {
        push: vi.fn(async (payload: object) => {
          calls.push("push");
          pushed.push(payload);
        }),
        size: () => 0,
      };
      const source = fakeEventSource([driverRow(1, 1)]);
      const sess = fakeSession();

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source,
        pusher,
        pickSession: vi.fn(async () => sess),
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      await vi.advanceTimersByTimeAsync(0); // first tick

      source.rows.push(driverRow(2, 2));
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

    test("the pushed payload carries events: [] on the catch-up tick, then the newly applied rows on a later tick; no rebuilt flag on an ordinary tick (issue #114, review round 1)", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      const pushed: unknown[] = [];
      const pusher: Pusher = {
        push: vi.fn(async (payload: object) => {
          pushed.push(payload);
        }),
        size: () => 0,
      };
      const source = fakeEventSource([]);

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source,
        pusher,
        pickSession: vi.fn(async () => fakeSession()),
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      await vi.advanceTimersByTimeAsync(0); // first (catch-up) tick: nothing in the log yet, still publishes once

      expect(pushed).toHaveLength(1);
      expect((pushed[0] as { events: unknown }).events).toEqual([]);

      source.rows.push(driverRow(1, 1));
      await vi.advanceTimersByTimeAsync(250); // second tick, picks up the new row

      expect(pushed).toHaveLength(2);
      const payload = pushed[1] as { events: unknown; seq: string; rebuilt?: boolean };
      expect(payload.events).toEqual([
        { event_id: "event-1", endpoint: "drivers", source_time: null, payload: { driver_number: 1 } },
      ]);
      expect(payload.seq).toBe("1");
      expect(payload.rebuilt).toBeUndefined();
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
        db: fakePrisma(),
        source: fakeEventSource([driverRow(1, 1)]),
        pusher,
        pickSession: vi.fn(async () => fakeSession()),
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

    test("a later tick's onState() being requested before an earlier tick's resolves must not leak into the earlier tick's push (retro 2026-09-08, PR #42: stale poll state on every push)", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks({ manualOnState: true });
      let resolvedFolds = 0;
      polls.publicPolls = vi.fn(() => [{ poll_id: `fold-${resolvedFolds}` }]);
      function resolveFold(): void {
        // Bump the tally *before* resolving: production code reads
        // publicPolls() synchronously once onState()'s promise settles, so
        // this proves that read sees this fold's own tally, not whichever
        // fold last happened to land.
        resolvedFolds += 1;
        polls.resolveNext();
      }

      const pushed: unknown[] = [];
      const pusher: Pusher = {
        push: vi.fn(async (payload: object) => {
          pushed.push(payload);
        }),
        size: () => 0,
      };
      const source = fakeEventSource([driverRow(1, 1)]);

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source,
        pusher,
        pickSession: vi.fn(async () => fakeSession()),
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      await vi.advanceTimersByTimeAsync(0); // tick 1: onState(state after fold 1) called, left pending
      expect(pushed).toHaveLength(0);
      expect(polls.onState).toHaveBeenCalledTimes(1);

      source.rows.push(driverRow(2, 2));
      await vi.advanceTimersByTimeAsync(250); // tick 2 fires -- the next push is requested -- before tick 1 resolves
      expect(pushed).toHaveLength(0);
      expect(polls.onState).toHaveBeenCalledTimes(2);

      resolveFold(); // tick 1's fold lands (FIFO: oldest pending first)
      await vi.advanceTimersByTimeAsync(0); // let the .then() chain flush
      expect(pushed).toHaveLength(1);
      expect((pushed[0] as { polls: unknown }).polls).toEqual([{ poll_id: "fold-1" }]);

      resolveFold(); // tick 2's fold lands
      await vi.advanceTimersByTimeAsync(0);
      expect(pushed).toHaveLength(2);
      expect((pushed[1] as { polls: unknown }).polls).toEqual([{ poll_id: "fold-2" }]);
    });

    test("a status flip to finished calls onSessionFinished exactly once", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      const live = fakeSession({ status: "live" });
      const finished = fakeSession({ status: "finished" });
      const pickSession = vi.fn(async () => live);

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([]),
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
      const polls = fakePollHooks({ calls });
      const pusher: Pusher = {
        push: vi.fn(async () => {
          calls.push("push");
        }),
        size: () => 0,
      };
      const finished = fakeSession({ status: "finished" });

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([driverRow(1, 1)]),
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
      const polls = fakePollHooks({ calls });
      const live = fakeSession({ sessionKey: 1n, status: "live" });
      const finished = fakeSession({ sessionKey: 2n, status: "finished" });
      const pickSession = vi.fn(async () => live);

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([]),
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
      const polls = fakePollHooks({ calls });
      const first = fakeSession({ sessionKey: 1n });
      const second = fakeSession({ sessionKey: 2n });
      const pickSession = vi.fn(async () => first);

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([]),
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

    test("a check() that overlaps one still in flight returns without a second pickSession", async () => {
      let release: () => void = () => {};
      const pickSession = vi.fn(
        () =>
          new Promise<ReturnType<typeof fakeSession> | null>((resolve) => {
            release = () => resolve(null);
          }),
      );
      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([]),
        pusher: fakePusher(),
        pickSession,
        polls: fakePollHooks(),
        log: noopLog,
      });

      const first = lifecycle.check();
      const second = lifecycle.check(); // in flight: must not start another
      expect(pickSession).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);

      const third = lifecycle.check(); // after the first finished, checks run again
      expect(pickSession).toHaveBeenCalledTimes(2);
      release();
      await third;
    });

    test("a rejected polls.start() is logged and check() still resolves", async () => {
      vi.useFakeTimers();
      const log = vi.fn();
      const polls = fakePollHooks();
      (polls.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
      const sess = fakeSession();

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([]),
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
