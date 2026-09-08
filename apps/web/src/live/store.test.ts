import { describe, expect, it } from "vitest";
import { createLiveStore } from "./store.ts";
import type { LivePush } from "./types.ts";

function racePush(overrides: { sourceTime: string | null; sentAt: number; seq?: string }): LivePush {
  return {
    type: "state",
    seq: overrides.seq ?? String(overrides.sentAt),
    sent_at: overrides.sentAt,
    session_key: "9999",
    total_laps: 58,
    state: {
      sequence: 1,
      latest_source_time: overrides.sourceTime,
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
    },
    polls: [],
  };
}

function frame(sourceTimeIso: string, sentAt: number): { raw: string; push: LivePush } {
  const push = racePush({ sourceTime: sourceTimeIso, sentAt });
  return { raw: JSON.stringify(push), push };
}

describe("live store", () => {
  it("renders the live edge with zero buffer work when delayMs is 0", () => {
    const store = createLiveStore();
    const { raw, push } = frame("2026-09-08T12:00:00.000Z", 1_000);
    store.getState().onState(raw, push, 1_000);
    expect(store.getState().displayed).toBe(push);
    expect(store.getState().bufferShort).toBe(false);
  });

  it("selects a delayed entry from the buffer", () => {
    const store = createLiveStore();
    store.getState().setDelayMs(5_000, 0);

    const first = frame("2026-09-08T12:00:00.000Z", 0);
    const second = frame("2026-09-08T12:00:10.000Z", 10_000);
    store.getState().onState(first.raw, first.push, 0);
    store.getState().onState(second.raw, second.push, 10_000);

    // live axis is 12:00:10, delay 5s with no elapsed wall-clock time since
    // the last message -> target is 12:00:05, which selects the first entry.
    expect(store.getState().displayed).toEqual(first.push);
    expect(store.getState().bufferShort).toBe(false);
  });

  it("marks bufferShort and shows the oldest entry when delay outruns the buffer", () => {
    const store = createLiveStore();
    store.getState().setDelayMs(60_000, 0);

    const only = frame("2026-09-08T12:00:00.000Z", 0);
    store.getState().onState(only.raw, only.push, 0);

    expect(store.getState().bufferShort).toBe(true);
    expect(store.getState().displayed).toEqual(only.push);
  });

  it("keeps displayed referentially stable across ticks that select the same entry", () => {
    const store = createLiveStore();
    store.getState().setDelayMs(5_000, 0);

    const first = frame("2026-09-08T12:00:00.000Z", 0);
    const second = frame("2026-09-08T12:00:20.000Z", 20_000);
    store.getState().onState(first.raw, first.push, 0);
    store.getState().onState(second.raw, second.push, 20_000);

    const selected = store.getState().displayed;
    expect(selected).not.toBeNull();

    store.getState().tick(20_100);
    store.getState().tick(20_200);

    expect(store.getState().displayed).toBe(selected);
  });

  it("advances the selection on tick as wall-clock time elapses without a new push", () => {
    const store = createLiveStore();
    store.getState().setDelayMs(5_000, 0);

    const first = frame("2026-09-08T12:00:00.000Z", 0);
    const second = frame("2026-09-08T12:00:10.000Z", 10_000);
    store.getState().onState(first.raw, first.push, 0);
    store.getState().onState(second.raw, second.push, 10_000);

    // Immediately after the second push, target is 12:00:05 -> first entry.
    expect(store.getState().displayed).toEqual(first.push);

    // 6s of wall-clock time pass with no new push: target advances to 12:00:11 -> second entry.
    store.getState().tick(16_000);
    expect(store.getState().displayed).toEqual(second.push);
  });

  it("clears catchingUp when a state frame arrives", () => {
    const store = createLiveStore();
    store.getState().onStatus({ catching_up: true });
    expect(store.getState().catchingUp).toBe(true);

    const only = frame("2026-09-08T12:00:00.000Z", 0);
    store.getState().onState(only.raw, only.push, 0);
    expect(store.getState().catchingUp).toBe(false);
  });

  it("tracks connection state via onOpen and onError", () => {
    const store = createLiveStore();
    expect(store.getState().connection).toBe("connecting");
    store.getState().onOpen();
    expect(store.getState().connection).toBe("open");
    store.getState().onError();
    expect(store.getState().connection).toBe("reconnecting");
  });

  it("clamps setDelayMs to zero or greater", () => {
    const store = createLiveStore();
    store.getState().setDelayMs(-500, 0);
    expect(store.getState().delayMs).toBe(0);
  });
});
