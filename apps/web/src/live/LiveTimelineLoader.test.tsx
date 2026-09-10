import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RaceEventsPage } from "../races/api.ts";
import { emptyAnchors } from "./anchors.ts";
import { emptyBuffer } from "./buffer.ts";
import { LiveTimelineLoader } from "./LiveTimelineLoader.tsx";
import { useLiveStore } from "./store.ts";

vi.mock("../races/api.ts", () => ({
  fetchRaceEventsPage: vi.fn(),
}));

// Imported after the mock so this binds to the mocked export.
import { fetchRaceEventsPage } from "../races/api.ts";

function resetLiveStore(): void {
  useLiveStore.setState({
    connection: "connecting",
    catchingUp: false,
    lastMessageAt: null,
    live: null,
    buffer: emptyBuffer(),
    delayMs: 0,
    displayed: null,
    bufferShort: false,
    anchors: emptyAnchors(),
    timeline: null,
    mode: "edge",
  });
}

describe("LiveTimelineLoader", () => {
  beforeEach(() => {
    resetLiveStore();
    vi.mocked(fetchRaceEventsPage).mockReset();
  });

  it("renders nothing", () => {
    vi.mocked(fetchRaceEventsPage).mockResolvedValue({
      session_key: "9999",
      status: "live",
      events: [],
      next_seq: null,
    });
    const { container } = render(<LiveTimelineLoader sessionKey={9999} status="live" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("sets the store's timeline once the (short) backfill completes, and clears it on unmount", async () => {
    const page: RaceEventsPage = {
      session_key: "9999",
      status: "live",
      events: [{ event_id: "e1", endpoint: "position", source_time: null, payload: { driver_number: 1, position: 1 } }],
      next_seq: null,
    };
    vi.mocked(fetchRaceEventsPage).mockResolvedValue(page);

    const { unmount } = render(<LiveTimelineLoader sessionKey={9999} status="live" />);

    expect(useLiveStore.getState().timeline).toBeNull();

    await waitFor(() => expect(useLiveStore.getState().timeline).not.toBeNull());
    expect(useLiveStore.getState().timeline!.events.map((e) => e.event_id)).toEqual(["e1"]);
    expect(fetchRaceEventsPage).toHaveBeenCalledWith(9999, 0, expect.any(Number));

    unmount();
    expect(useLiveStore.getState().timeline).toBeNull();
  });
});
