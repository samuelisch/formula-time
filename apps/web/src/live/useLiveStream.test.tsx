import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeEventSource } from "../test/fakeEventSource.ts";
import { emptyBuffer } from "./buffer.ts";
import { useLiveStore } from "./store.ts";
import { useLiveStream } from "./useLiveStream.ts";

function resetStore(): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
  });
}

/** Captures the FakeEventSource `useLiveStream` constructs. `es()` is lazy: the hook must
 * have run its effect before it is called, so it must not be destructured up front. */
function capturingEventSource(): { EventSourceImpl: typeof EventSource; es(): FakeEventSource } {
  const constructed: FakeEventSource[] = [];
  class CapturingEventSource extends FakeEventSource {
    public constructor() {
      super();
      constructed.push(this);
    }
  }
  return {
    EventSourceImpl: CapturingEventSource as unknown as typeof EventSource,
    es() {
      const captured = constructed[constructed.length - 1];
      if (captured === undefined) throw new Error("EventSource was not constructed");
      return captured;
    },
  };
}

describe("useLiveStream", () => {
  beforeEach(() => {
    resetStore();
  });

  it("sets connection to open when the source opens", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().open();

    expect(useLiveStore.getState().connection).toBe("open");
  });

  it("sets connection to reconnecting on error", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().fail();

    expect(useLiveStore.getState().connection).toBe("reconnecting");
  });

  it("sets live and grows the buffer on a state frame", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    expect(useLiveStore.getState().buffer.entries.length).toBe(0);

    const push = {
      type: "state",
      seq: "1",
      sent_at: 1000,
      session_key: "9999",
      total_laps: 58,
      state: {
        sequence: 1,
        latest_source_time: "2026-09-08T12:00:00.000Z",
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
    es().emit("state", JSON.stringify(push));

    expect(useLiveStore.getState().live).toEqual(push);
    expect(useLiveStore.getState().buffer.entries.length).toBe(1);
  });

  it("sets catchingUp on a status frame", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().emit("status", JSON.stringify({ catching_up: true }));

    expect(useLiveStore.getState().catchingUp).toBe(true);
  });

  it("closes the source on unmount", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    const { unmount } = renderHook(() => useLiveStream({ EventSourceImpl }));

    unmount();

    expect(es().closed).toBe(true);
  });
});
