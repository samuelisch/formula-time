import { afterEach, describe, expect, test, vi } from "vitest";

import type { Session } from "@formula-time/db";
import type { RaceState } from "@formula-time/domain";

import type { EventRow, EventSource } from "./projector/event-source.js";
import { createSessionLifecycle, type PollHooks, type Pusher } from "./session-lifecycle.js";

function fakePusher(): Pusher {
  return { push: vi.fn(async () => {}), size: () => 0 };
}

interface FakePollHooks extends PollHooks {
  startCalls: Array<{ sessionKey: bigint; totalLaps: number | null; country: string }>;
  onStateCalls: RaceState[];
  finishedCount: number;
}

function fakePollHooks(): FakePollHooks {
  const startCalls: FakePollHooks["startCalls"] = [];
  const onStateCalls: RaceState[] = [];
  let finishedCount = 0;
  return {
    startCalls,
    onStateCalls,
    get finishedCount() {
      return finishedCount;
    },
    async start(session) {
      startCalls.push(session);
    },
    onState(state) {
      onStateCalls.push(state);
    },
    async onSessionFinished() {
      finishedCount += 1;
    },
  };
}

describe("createSessionLifecycle", () => {
  test("/health shape before any session is found: session_key null, cursor \"0\", caught_up false", async () => {
    const pickSession = vi.fn(async () => null);
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source: {} as any,
      pusher: fakePusher(),
      pickSession,
      publicPolls: () => [],
      pollModule: fakePollHooks(),
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
      publicPolls: () => [],
      pollModule: fakePollHooks(),
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
      publicPolls: () => [],
      pollModule: fakePollHooks(),
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
      publicPolls: () => [],
      pollModule: fakePollHooks(),
      log,
    });

    await lifecycle.check();
    await lifecycle.check();
    await lifecycle.check();

    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("createSessionLifecycle with a real projector (poll hooks)", () => {
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

  function chequeredRow(seq: number): EventRow {
    return {
      seq: BigInt(seq),
      eventId: `event-${seq}`,
      endpoint: "race_control",
      sourceTime: null,
      payload: { category: "Flag", flag: "CHEQUERED", scope: "Track", message: "CHEQUERED FLAG" },
    };
  }

  /** Rows only become readable once added -- lets each tick see exactly the rows queued for it. */
  class FakeSource implements EventSource {
    private rows: EventRow[] = [];

    public addRow(row: EventRow): void {
      this.rows.push(row);
    }

    public async readAfter(_sessionKey: bigint, afterSeq: bigint, limit: number): Promise<EventRow[]> {
      return this.rows
        .filter((row) => row.seq > afterSeq)
        .sort((a, b) => (a.seq < b.seq ? -1 : 1))
        .slice(0, limit);
    }

    public async readWindow(): Promise<EventRow[]> {
      return [];
    }
  }

  function noopLog(): void {}

  afterEach(() => {
    vi.useRealTimers();
  });

  test("pollModule.start is called once per new session with the row's key/laps/country", async () => {
    const source = new FakeSource();
    const pollModule = fakePollHooks();
    const pickSession = vi.fn(async () => SESSION);
    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      source,
      pusher: fakePusher(),
      pickSession,
      publicPolls: () => [],
      pollModule,
      log: noopLog,
    });

    await lifecycle.check();
    await lifecycle.check(); // same session key -- must not start again
    lifecycle.stop();

    expect(pollModule.startCalls).toEqual([{ sessionKey: 42n, totalLaps: 50, country: "Testland" }]);
  });

  test("onState is called before each push and the push carries publicPolls()'s return; onSessionFinished fires exactly once when the state turns chequered", async () => {
    vi.useFakeTimers();
    const source = new FakeSource();
    const pollModule = fakePollHooks();
    const sentinelPolls = [{ poll_id: "sentinel" }];
    const pushes: Array<{ polls: unknown }> = [];
    const calls: string[] = [];
    const pusher: Pusher = {
      push: vi.fn(async (payload) => {
        calls.push("push");
        pushes.push(payload as { polls: unknown });
      }),
      size: () => 0,
    };
    // Record onState's call relative to push's, from the same call log.
    const recordingPollModule: PollHooks = {
      ...pollModule,
      onState(state) {
        calls.push("onState");
        pollModule.onState(state);
      },
    };

    const lifecycle = createSessionLifecycle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      source,
      pusher,
      pickSession: vi.fn(async () => SESSION),
      publicPolls: () => sentinelPolls,
      pollModule: recordingPollModule,
      log: noopLog,
    });

    await lifecycle.check();

    // Tick 1 (delay 0): no rows yet, but the fold is newly caught up, so it
    // still publishes once with the initial, non-chequered state.
    await vi.advanceTimersByTimeAsync(0);
    expect(pollModule.onStateCalls).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.polls).toBe(sentinelPolls);
    expect(pollModule.finishedCount).toBe(0);

    // Tick 2 (one tick interval later): a chequered race-control row lands.
    source.addRow(chequeredRow(1));
    await vi.advanceTimersByTimeAsync(250);
    expect(pushes).toHaveLength(2);
    expect(pollModule.finishedCount).toBe(1);

    // Tick 3: another row lands, state is still chequered -- must not fire again.
    source.addRow(driverRow(2, 99));
    await vi.advanceTimersByTimeAsync(250);
    expect(pushes).toHaveLength(3);
    expect(pollModule.finishedCount).toBe(1);

    // onState always ran before its matching push.
    expect(calls).toEqual(["onState", "push", "onState", "push", "onState", "push"]);

    lifecycle.stop();
  });
});
