import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RaceEventsPage } from "../races/api.ts";
import { emptyAnchors } from "./anchors.ts";
import { emptyBuffer } from "./buffer.ts";
import { LiveTimelineLoader } from "./LiveTimelineLoader.tsx";
import { useLiveStore } from "./store.ts";
import type { LivePush } from "./types.ts";

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

/** A live push carrying a full session row, the way a real join would. */
function liveSessionPush(): LivePush {
  return {
    type: "state",
    seq: "1",
    sent_at: Date.now(),
    session_key: "9999",
    total_laps: 58,
    state: {
      sequence: 0,
      latest_source_time: null,
      session: { session_key: "9999", name: "Race", country: "Italy", status: "live" },
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

describe("LiveTimelineLoader", () => {
  beforeEach(() => {
    resetLiveStore();
    vi.mocked(fetchRaceEventsPage).mockReset();
  });

  it("renders nothing, and never backfills, before the live push's session row is known", () => {
    vi.mocked(fetchRaceEventsPage).mockResolvedValue({
      session_key: "9999",
      status: "live",
      events: [],
      next_seq: null,
    });
    const { container } = render(<LiveTimelineLoader sessionKey={9999} status="live" />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchRaceEventsPage).not.toHaveBeenCalled();
  });

  it("sets the store's timeline once the (short) backfill completes, and clears it on unmount", async () => {
    const page: RaceEventsPage = {
      session_key: "9999",
      status: "live",
      events: [{ event_id: "e1", endpoint: "position", source_time: null, payload: { driver_number: 1, position: 1 } }],
      next_seq: null,
    };
    vi.mocked(fetchRaceEventsPage).mockResolvedValue(page);
    useLiveStore.setState({ live: liveSessionPush() });

    const { unmount } = render(<LiveTimelineLoader sessionKey={9999} status="live" />);

    expect(useLiveStore.getState().timeline).toBeNull();

    await waitFor(() => expect(useLiveStore.getState().timeline).not.toBeNull());
    expect(useLiveStore.getState().timeline!.events.map((e) => e.event_id)).toEqual(["e1"]);
    expect(fetchRaceEventsPage).toHaveBeenCalledWith(9999, 0, expect.any(Number));

    unmount();
    expect(useLiveStore.getState().timeline).toBeNull();
  });

  it("captures the live push's own session row -- status, country, name -- onto the built timeline", async () => {
    vi.mocked(fetchRaceEventsPage).mockResolvedValue({
      session_key: "9999",
      status: "live",
      events: [],
      next_seq: null,
    });
    useLiveStore.setState({ live: liveSessionPush() });

    render(<LiveTimelineLoader sessionKey={9999} status="live" />);

    await waitFor(() => expect(useLiveStore.getState().timeline).not.toBeNull());
    expect(useLiveStore.getState().timeline!.session).toEqual({
      session_key: "9999",
      name: "Race",
      country: "Italy",
      status: "live",
    });
  });
});
