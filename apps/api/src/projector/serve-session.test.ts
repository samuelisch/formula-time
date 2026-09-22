import { afterEach, describe, expect, test, vi } from "vitest";

import { fakeEventSource } from "../test/fake-event-source.js";
import { fakePollHooks } from "../test/fake-poll-hooks.js";
import { fakePrisma } from "../test/fake-prisma.js";
import { fakePushSink } from "../test/fake-push-sink.js";
import { fakeSession } from "../test/fixtures.js";
import type { EventRow } from "./event-source.js";
import { createSessionLifecycle, type PushSink } from "./serve-session.js";

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
      pusher: fakePushSink(),
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
      pusher: fakePushSink(3),
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
      pusher: fakePushSink(),
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
      pusher: fakePushSink(),
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

    test("polls.start() runs with the four session fields before the projector's first push", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const polls = fakePollHooks({ calls });
      const pushed: unknown[] = [];
      const pusher: PushSink = {
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

      expect(polls.start).toHaveBeenCalledWith({ sessionKey: 42n, totalLaps: 50, country: "Testland", meetingName: null });
      expect(calls.indexOf("start")).toBeLessThan(calls.indexOf("push"));
    });

    test("onState() runs before push() on every subscriber call, and the push carries polls.publicPolls()", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const polls = fakePollHooks({ calls });
      const pushed: unknown[] = [];
      const pusher: PushSink = {
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
      const pusher: PushSink = {
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
      const pusher: PushSink = {
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
      const pusher: PushSink = {
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

    test("a same-key status flip refreshes the projector's row and total_laps without a restart", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      const pushed: unknown[] = [];
      const pusher: PushSink = {
        push: vi.fn(async (payload: object) => {
          pushed.push(payload);
        }),
        size: () => 0,
      };
      const upcoming = fakeSession({ status: "upcoming", totalLaps: null });
      const live = fakeSession({ status: "live", totalLaps: 66 });
      const pickSession = vi.fn(async () => upcoming);

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([]),
        pusher,
        pickSession,
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check(); // discovers `upcoming`
      await vi.advanceTimersByTimeAsync(0); // catch-up tick's push

      expect(pushed).toHaveLength(1);
      expect((pushed[0] as { total_laps: unknown }).total_laps).toBeNull();

      pickSession.mockImplementation(async () => live);
      await lifecycle.check(); // same key: status and total_laps changed
      await vi.advanceTimersByTimeAsync(0); // let updateSession's push land

      expect(pushed).toHaveLength(2);
      const payload = pushed[1] as {
        total_laps: unknown;
        state: { session: { status: unknown } | null };
      };
      expect(payload.total_laps).toBe(66);
      expect(payload.state.session?.status).toBe("live");
      expect(polls.updateSession).toHaveBeenCalledWith({ totalLaps: 66, meetingName: null });
    });

    test("a refresh that lands mid-push never mixes fields from two different session reads", async () => {
      vi.useFakeTimers();
      // manualOnState: the default fake resolves onState() on a microtask,
      // which flushes before this test can land a refresh in between --
      // AGENTS.md: "a fake that resolves synchronously cannot test
      // ordering." Held open, tick 1's push stays pending while a same-key
      // refresh runs and changes total_laps.
      const polls = fakePollHooks({ manualOnState: true });
      const pushed: unknown[] = [];
      const pusher: PushSink = {
        push: vi.fn(async (payload: object) => {
          pushed.push(payload);
        }),
        size: () => 0,
      };
      const initial = fakeSession({ totalLaps: 50 });
      const pickSession = vi.fn(async () => initial);

      const lifecycle = createSessionLifecycle({
        db: fakePrisma(),
        source: fakeEventSource([driverRow(1, 1)]),
        pusher,
        pickSession,
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check(); // starts the projector
      await vi.advanceTimersByTimeAsync(0); // tick 1 folds; its onState() call is left pending

      expect(polls.onState).toHaveBeenCalledTimes(1);
      expect(pushed).toHaveLength(0);

      // A same-key refresh lands while tick 1's push is still waiting on its
      // own fold: updateSession() mutates the projector's session (and
      // queues its own onState(), pending behind tick 1's) before tick 1's
      // push is built.
      const refreshed = fakeSession({ totalLaps: 66 });
      pickSession.mockImplementation(async () => refreshed);
      await lifecycle.check();

      polls.resolveNext(); // tick 1's own fold lands first (FIFO)
      await vi.advanceTimersByTimeAsync(0);

      expect(pushed).toHaveLength(1);
      const first = pushed[0] as {
        total_laps: unknown;
        state: { session: { total_laps: unknown } | null };
      };
      // Tick 1's frame must carry tick 1's own total_laps throughout --
      // never a value read live from a session that changed after this
      // frame's state was captured.
      expect(first.total_laps).toBe(first.state.session?.total_laps);
      expect(first.total_laps).toBe(50);

      polls.resolveNext(); // the refresh's own fold lands next
      await vi.advanceTimersByTimeAsync(0);

      expect(pushed).toHaveLength(2);
      const second = pushed[1] as {
        total_laps: unknown;
        state: { session: { total_laps: unknown } | null };
      };
      expect(second.total_laps).toBe(second.state.session?.total_laps);
      expect(second.total_laps).toBe(66);
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
        pusher: fakePushSink(),
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
      const pusher: PushSink = {
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
        pusher: fakePushSink(),
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
        pusher: fakePushSink(),
        pickSession,
        polls,
        log: noopLog,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check(); // starts session 1 (previousSession is null: no onSessionFinished yet)
      pickSession.mockImplementation(async () => second);
      await lifecycle.check(); // key changed: onSessionFinished (for 1) then start (for 2)

      expect(calls).toEqual(["start", "onSessionFinished", "start"]);
      expect(polls.start).toHaveBeenLastCalledWith({ sessionKey: 2n, totalLaps: 50, country: "Testland", meetingName: null });
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
        pusher: fakePushSink(),
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

    test("a rejected push is logged with the cursor; the next tick still pushes and no unhandled rejection is raised", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      const log = vi.fn();
      const pushed: unknown[] = [];
      let pushCalls = 0;
      const pusher: PushSink = {
        push: vi.fn(async (payload: object) => {
          pushCalls += 1;
          if (pushCalls === 1) {
            throw new Error("deflate write after end");
          }
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
        log,
      });
      projectors.push({ stop: () => lifecycle.stop() });

      await lifecycle.check();
      // First tick: the push rejects. Vitest fails the whole run on an
      // unhandled rejection by default, so this test passing at all is the
      // proof that the rejection was caught, not just that the log fired.
      await vi.advanceTimersByTimeAsync(0);

      expect(log).toHaveBeenCalledWith(
        "push failed",
        expect.objectContaining({ cursor: "0", error: "deflate write after end" }),
      );
      expect(pushed).toHaveLength(0);

      source.rows.push(driverRow(1, 1));
      await vi.advanceTimersByTimeAsync(250); // second tick: push succeeds

      expect(pushed).toHaveLength(1);
      // A rejected push means we cannot know whether any client saw the
      // rejected tick's events, so the next one that actually goes through
      // is marked rebuilt: true, same as a fan-out-level skip.
      expect((pushed[0] as { rebuilt?: boolean }).rebuilt).toBe(true);
    });

    test("a rejected push followed by a successful one delivers rebuilt: true only on the successful one; the push after that is normal again", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      const pushed: unknown[] = [];
      let pushCalls = 0;
      const pusher: PushSink = {
        push: vi.fn(async (payload: object) => {
          pushCalls += 1;
          if (pushCalls === 1) {
            throw new Error("deflate write after end");
          }
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
      await vi.advanceTimersByTimeAsync(0); // first tick: push rejects

      source.rows.push(driverRow(1, 1));
      await vi.advanceTimersByTimeAsync(250); // second tick: push succeeds, forced rebuilt: true

      source.rows.push(driverRow(2, 2));
      await vi.advanceTimersByTimeAsync(250); // third tick: normal again

      expect(pushed).toHaveLength(2);
      expect((pushed[0] as { rebuilt?: boolean }).rebuilt).toBe(true);
      expect((pushed[1] as { rebuilt?: boolean }).rebuilt).toBeUndefined();
    });

    test("push N settling after push N+1 was already requested does not lose the signal: it lands on N+2, never later", async () => {
      vi.useFakeTimers();
      const polls = fakePollHooks();
      const pushed: unknown[] = [];
      const gates: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
      const pusher: PushSink = {
        push: vi.fn(
          (payload: object) =>
            new Promise<void>((resolve, reject) => {
              gates.push({
                resolve: () => {
                  pushed.push(payload);
                  resolve();
                },
                reject,
              });
            }),
        ),
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
      await vi.advanceTimersByTimeAsync(0); // tick N: push requested, left pending
      expect(gates).toHaveLength(1);

      source.rows.push(driverRow(1, 1));
      await vi.advanceTimersByTimeAsync(250); // tick N+1: requested while push N is still in flight
      expect(gates).toHaveLength(2);

      // Push N rejects only now -- after N+1 was already built and sent, so
      // N+1 went out plain; too late to change a payload already handed to
      // the pusher.
      gates[0]?.reject(new Error("deflate write after end"));
      await vi.advanceTimersByTimeAsync(0); // let the rejection's .catch() set the flag
      gates[1]?.resolve(); // N+1 itself succeeds
      await vi.advanceTimersByTimeAsync(0);

      source.rows.push(driverRow(2, 2));
      await vi.advanceTimersByTimeAsync(250); // tick N+2: the flag is now observed
      expect(gates).toHaveLength(3);
      gates[2]?.resolve();
      await vi.advanceTimersByTimeAsync(0);

      source.rows.push(driverRow(3, 3));
      await vi.advanceTimersByTimeAsync(250); // tick N+3: normal again
      expect(gates).toHaveLength(4);
      gates[3]?.resolve();
      await vi.advanceTimersByTimeAsync(0);

      // Push N itself rejected, so only N+1, N+2 and N+3 were ever recorded
      // as delivered.
      expect(pushed).toHaveLength(3);
      expect((pushed[0] as { rebuilt?: boolean }).rebuilt).toBeUndefined(); // N+1: built before N's rejection was observed
      expect((pushed[1] as { rebuilt?: boolean }).rebuilt).toBe(true); // N+2: the first push built after the rejection was observed
      expect((pushed[2] as { rebuilt?: boolean }).rebuilt).toBeUndefined(); // N+3: normal again
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
        pusher: fakePushSink(),
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
