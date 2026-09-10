import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RaceState } from "@formula-time/domain";
import { FakeEventSource } from "../test/fakeEventSource.ts";
import { emptyBuffer } from "./buffer.ts";
import { useLiveStore } from "./store.ts";
import type { DeltaPush, LivePush } from "./types.ts";
import { useLiveStream } from "./useLiveStream.ts";

vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return { ...actual, apiFetch: vi.fn() };
});

// Imported after the mock so this binds to the mocked export.
import { apiFetch } from "../api.ts";

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

/** Captures the FakeEventSource `useLiveStream` constructs, and the URL it was constructed
 * with. `es()` is lazy: the hook must have run its effect before it is called, so it must
 * not be destructured up front. */
function capturingEventSource(): { EventSourceImpl: typeof EventSource; es(): FakeEventSource & { url: string } } {
  const constructed: Array<FakeEventSource & { url: string }> = [];
  class CapturingEventSource extends FakeEventSource {
    public readonly url: string;
    public constructor(url?: string) {
      super();
      this.url = url ?? "";
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

function minimalRaceState(overrides: Partial<RaceState> = {}): RaceState {
  return {
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
    ...overrides,
  };
}

function statePush(seq: string, sequence: number): LivePush {
  return {
    type: "state",
    seq,
    sent_at: sequence * 1000,
    session_key: "9999",
    total_laps: 58,
    state: minimalRaceState({ sequence }),
    polls: [],
  };
}

function deltaFrame(baseSeq: string, seq: string, sequence: number): DeltaPush {
  return {
    type: "delta",
    seq,
    base_seq: baseSeq,
    sent_at: sequence * 1000,
    session_key: "9999",
    patch: [{ op: "replace", path: "/sequence", value: sequence }],
    polls: [],
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: () => Promise.resolve({}) } as Response;
}

describe("useLiveStream", () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(apiFetch).mockReset();
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

  it("requests the stream in delta format", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    expect(es().url).toContain("format=delta");
  });

  it("sets live and grows the buffer on a state frame", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    expect(useLiveStore.getState().buffer.entries.length).toBe(0);

    const push = statePush("1", 1);
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

  it("applies a delta frame whose base_seq matches the held push's seq", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().emit("state", JSON.stringify(statePush("1", 1)));
    es().emit("delta", JSON.stringify(deltaFrame("1", "2", 2)));

    expect(useLiveStore.getState().live?.seq).toBe("2");
    expect(useLiveStore.getState().live?.state.sequence).toBe(2);
  });

  it("a keyframe state frame mid-stream fully replaces the held push, not diffed against", () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().emit("state", JSON.stringify(statePush("1", 1)));
    es().emit("delta", JSON.stringify(deltaFrame("1", "2", 2)));

    const keyframe = statePush("200", 200);
    es().emit("state", JSON.stringify(keyframe));

    expect(useLiveStore.getState().live).toEqual(keyframe);
  });

  it("fetches GET /api/live/snapshot exactly once on a base_seq mismatch, and resumes from it", async () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().emit("state", JSON.stringify(statePush("1", 1)));

    const snapshot = statePush("50", 50);
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(snapshot));

    es().emit("delta", JSON.stringify(deltaFrame("49", "50", 50))); // base_seq "49" != held seq "1" -- a gap

    await waitFor(() => expect(useLiveStore.getState().live).toEqual(snapshot));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/api/live/snapshot");
  });

  it("drops deltas received while a snapshot fetch is in flight, and resumes once from the fetch's snapshot", async () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().emit("state", JSON.stringify(statePush("1", 1)));

    let resolveFetch: ((res: Response) => void) | null = null;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.mocked(apiFetch).mockReturnValueOnce(pending);

    es().emit("delta", JSON.stringify(deltaFrame("49", "50", 50))); // gap: starts the fetch
    es().emit("delta", JSON.stringify(deltaFrame("49", "51", 51))); // dropped: a fetch is already in flight
    es().emit("delta", JSON.stringify(deltaFrame("49", "52", 52))); // dropped too

    expect(apiFetch).toHaveBeenCalledTimes(1);

    const snapshot = statePush("50", 50);
    resolveFetch!(jsonResponse(snapshot));

    await waitFor(() => expect(useLiveStore.getState().live).toEqual(snapshot));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("retries the snapshot fetch on the next delta after a failed fetch", async () => {
    const { EventSourceImpl, es } = capturingEventSource();
    renderHook(() => useLiveStream({ EventSourceImpl }));

    es().emit("state", JSON.stringify(statePush("1", 1)));

    vi.mocked(apiFetch).mockResolvedValueOnce(errorResponse(503));
    es().emit("delta", JSON.stringify(deltaFrame("49", "50", 50)));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    // The failed fetch left `live` unchanged -- still the original push.
    expect(useLiveStore.getState().live?.seq).toBe("1");

    const snapshot = statePush("50", 50);
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(snapshot));
    es().emit("delta", JSON.stringify(deltaFrame("49", "50", 50)));

    await waitFor(() => expect(useLiveStore.getState().live).toEqual(snapshot));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
