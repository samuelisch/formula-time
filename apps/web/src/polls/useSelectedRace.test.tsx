// Covers the three settling phases (file header of useSelectedRace.ts) and
// the `?race=` override -- the fetch/render consequences of each are
// PollsPage.test.tsx's job; this file only checks the hook's own state.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyBuffer } from "../live/buffer.ts";
import { useLiveStore } from "../live/store.ts";
import type { RaceIndexEntry } from "../races/api.ts";
import { makePush } from "../test/fixtures.ts";
import { NO_SESSION_TIMEOUT_MS, useSelectedRace } from "./useSelectedRace.ts";

function resetStore(overrides: Partial<ReturnType<typeof useLiveStore.getState>> = {}): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    statusReceived: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    ...overrides,
  });
}

function settledConnection(): Partial<ReturnType<typeof useLiveStore.getState>> {
  return { connection: "open", statusReceived: true };
}

const races: RaceIndexEntry[] = [
  { session_key: 11361, name: "Race", country: "Italy", date_start: "2026-09-06T13:00:00.000Z", date_end: "2026-09-06T15:00:00.000Z", total_laps: 53, exported_at: "2026-09-06T15:10:00.000Z" },
];

function stubRacesFetch(data: RaceIndexEntry[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/races") return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

function renderSelectedRace(initialPath = "/polls") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return renderHook(() => useSelectedRace(), { wrapper });
}

describe("useSelectedRace", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetStore();
  });

  it("phase 1 (settling): not settled, no param -- isSettling true, nothing selected yet", () => {
    stubRacesFetch(races); // connection stays "connecting" -- never settles in this test
    const { result } = renderSelectedRace();

    expect(result.current.isSettling).toBe(true);
    expect(result.current.current).toBeNull();
    expect(result.current.selectedKey).toBeNull();
  });

  it("phase 2 (settled, no push yet): isSettling flips false, falls through to the current-session view with nothing selected", async () => {
    resetStore(); // still "connecting"
    stubRacesFetch(races);
    const { result, rerender } = renderSelectedRace();
    expect(result.current.isSettling).toBe(true);

    act(() => {
      useLiveStore.setState(settledConnection());
    });
    rerender();

    expect(result.current.isSettling).toBe(false);
    expect(result.current.isCurrentSelected).toBe(true); // no fallback yet, so vacuously "current"
    expect(result.current.selectedKey).toBeNull();
  });

  it("phase 3 (timed out): falls back to the newest race once settled and NO_SESSION_TIMEOUT_MS pass with still no push", async () => {
    resetStore(settledConnection());
    stubRacesFetch(races);
    vi.useFakeTimers();

    const { result } = renderSelectedRace();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NO_SESSION_TIMEOUT_MS);
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.isCurrentSelected).toBe(false);
    expect(result.current.selectedKey).toBe("11361");
    expect(result.current.historicalKey).toBe("11361");
  });

  it("a push confirming the current session cancels the fallback timer and is selected as current", () => {
    resetStore({
      ...settledConnection(),
      displayed: makePush({ session_key: "9999" }, { session: { session_key: "9999", country: "Italy", name: "Race", status: "live" } }),
    });
    stubRacesFetch(races);

    const { result } = renderSelectedRace();

    expect(result.current.isSettling).toBe(false);
    expect(result.current.isCurrentSelected).toBe(true);
    expect(result.current.selectedKey).toBe("9999");
    expect(result.current.historicalKey).toBeNull();
    expect(result.current.current).toEqual({ sessionKey: "9999", label: "Italy · Race", status: "live" });
  });

  it("an explicit ?race= param wins immediately, ignoring settling", () => {
    resetStore(); // connection stays "connecting" -- never settles
    stubRacesFetch(races);

    const { result } = renderSelectedRace("/polls?race=11361");

    expect(result.current.isSettling).toBe(false);
    expect(result.current.isCurrentSelected).toBe(false);
    expect(result.current.selectedKey).toBe("11361");
    expect(result.current.historicalKey).toBe("11361");
  });

  it("?race= self-heals to current once a push confirms a matching session key", () => {
    resetStore({
      displayed: makePush({ session_key: "11361" }, { session: { session_key: "11361", country: "Italy", name: "Race", status: "live" } }),
    });
    stubRacesFetch(races);

    const { result } = renderSelectedRace("/polls?race=11361");

    expect(result.current.isCurrentSelected).toBe(true);
    expect(result.current.historicalKey).toBeNull();
  });

  it("handleRaceChange writes the race param, which selectedKey then reflects", () => {
    resetStore();
    stubRacesFetch(races);
    const { result } = renderSelectedRace();

    act(() => {
      result.current.handleRaceChange("11361");
    });

    expect(result.current.selectedKey).toBe("11361");
    expect(result.current.historicalKey).toBe("11361");
  });
});
