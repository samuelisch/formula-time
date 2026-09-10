import type { DriverState, RaceEvent, RawRecord } from "@formula-time/domain";
import { describe, expect, it } from "vitest";
import { appendEvents, createTimeline, foldAt, type Timeline } from "../replay/timeline.ts";
import { createLiveStore, timelineMatchesSession } from "./store.ts";
import type { LivePush } from "./types.ts";

const TIMELINE_SESSION: RawRecord = {
  session_key: 9999,
  name: "Race",
  country: "Italy",
  circuit_key: 39,
  date_start: "2026-09-08T12:00:00.000Z",
  date_end: "2026-09-08T14:00:00.000Z",
  total_laps: 58,
  status: "live",
};

function timelineIsoAt(offsetSeconds: number): string {
  return new Date(Date.parse("2026-09-08T12:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

function timelineEvent(id: string, endpoint: string, offsetSeconds: number, payload: RawRecord): RaceEvent {
  return { event_id: id, endpoint, source_time: timelineIsoAt(offsetSeconds), payload };
}

/** A small timeline: two leader laps 40s apart (past the fold's keyframe interval), for testing the timeline-mode fold path. */
async function buildRewindTimeline(): Promise<Timeline> {
  const timeline = createTimeline(TIMELINE_SESSION);
  await appendEvents(timeline, [
    timelineEvent("t1", "position", 0, { driver_number: 1, position: 1 }),
    timelineEvent("t2", "laps", 0, { driver_number: 1, lap_number: 1 }),
    timelineEvent("t3", "laps", 40, { driver_number: 1, lap_number: 2 }),
    timelineEvent("t4", "laps", 90, { driver_number: 1, lap_number: 3 }),
  ]);
  return timeline;
}

function racePush(overrides: {
  sourceTime: string | null;
  sentAt: number;
  seq?: string;
  drivers?: Record<string, DriverState>;
}): LivePush {
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
      drivers: overrides.drivers ?? {},
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

  it("mode is edge initially and after setDelayMs(0)", () => {
    const store = createLiveStore();
    expect(store.getState().mode).toBe("edge");

    store.getState().setDelayMs(5_000, 0);
    const { raw, push } = frame("2026-09-08T12:00:00.000Z", 0);
    store.getState().onState(raw, push, 0);
    expect(store.getState().mode).not.toBe("edge");

    store.getState().setDelayMs(0, 0);
    expect(store.getState().mode).toBe("edge");
    expect(store.getState().displayed).toBe(push);
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
    expect(store.getState().mode).toBe("buffer");
    expect(store.getState().timeline).toBeNull();
  });

  it("marks bufferShort and shows the oldest entry when delay outruns the buffer and there is no timeline", () => {
    const store = createLiveStore();
    store.getState().setDelayMs(60_000, 0);

    const only = frame("2026-09-08T12:00:00.000Z", 0);
    store.getState().onState(only.raw, only.push, 0);

    expect(store.getState().bufferShort).toBe(true);
    expect(store.getState().displayed).toEqual(only.push);
    expect(store.getState().mode).toBe("buffer");
  });

  describe("timeline mode", () => {
    it("folds from the timeline when the delay outruns the buffer", async () => {
      const store = createLiveStore();
      const timeline = await buildRewindTimeline();
      store.getState().setTimeline(timeline, 0);
      store.getState().setDelayMs(150_000, 0);

      const live = frame("2026-09-08T12:03:20.000Z", 200_000); // 200s offset
      store.getState().onState(live.raw, live.push, 200_000);

      // target = 200s - 150s = 50s offset, past the 1-entry buffer span.
      const expectedTargetMs = Date.parse("2026-09-08T12:00:00.000Z") + 50_000;

      expect(store.getState().mode).toBe("timeline");
      expect(store.getState().bufferShort).toBe(false);
      const displayed = store.getState().displayed;
      expect(displayed).not.toBeNull();
      expect(displayed!.polls).toEqual([]);
      expect(displayed!.session_key).toBe(live.push.session_key);
      expect(displayed!.seq).toBe(live.push.seq);
      expect(displayed!.sent_at).toBe(live.push.sent_at);
      expect(displayed!.state).toEqual(foldAt(timeline, expectedTargetMs));
    });

    it("clamps a target before the timeline's first source time to firstSourceMs", async () => {
      const store = createLiveStore();
      const timeline = await buildRewindTimeline();
      store.getState().setTimeline(timeline, 0);
      // Huge delay: target lands well before the timeline's first event.
      store.getState().setDelayMs(500_000, 0);

      const live = frame("2026-09-08T12:03:20.000Z", 200_000);
      store.getState().onState(live.raw, live.push, 200_000);

      expect(store.getState().mode).toBe("timeline");
      expect(store.getState().displayed!.state).toEqual(foldAt(timeline, timeline.firstSourceMs!));
    });

    it("setTimeline flips a stale bufferShort fallback into timeline mode without a setDelayMs call", async () => {
      const store = createLiveStore();
      store.getState().setDelayMs(150_000, 0);
      const live = frame("2026-09-08T12:03:20.000Z", 200_000);
      store.getState().onState(live.raw, live.push, 200_000);

      expect(store.getState().mode).toBe("buffer");
      expect(store.getState().bufferShort).toBe(true);

      const timeline = await buildRewindTimeline();
      store.getState().setTimeline(timeline, 200_000);

      expect(store.getState().mode).toBe("timeline");
      expect(store.getState().bufferShort).toBe(false);

      store.getState().setTimeline(null, 200_000);
      expect(store.getState().mode).toBe("buffer");
      expect(store.getState().bufferShort).toBe(true);
    });

    it("tick re-folds at the advanced target in timeline mode", async () => {
      const store = createLiveStore();
      const timeline = await buildRewindTimeline();
      store.getState().setTimeline(timeline, 0);
      // delay 190s: target = 200s - 190s = 10s offset (before the 40s lap-2 marker).
      store.getState().setDelayMs(190_000, 0);

      const live = frame("2026-09-08T12:03:20.000Z", 200_000);
      store.getState().onState(live.raw, live.push, 200_000);

      const baseMs = Date.parse("2026-09-08T12:00:00.000Z");
      expect(store.getState().displayed!.state).toEqual(foldAt(timeline, baseMs + 10_000));
      const before = store.getState().displayed!.state.latest_source_time;

      // 40s of wall-clock time pass with no new push: target advances to 50s offset, past the 40s lap-2 marker.
      store.getState().tick(240_000);

      expect(store.getState().mode).toBe("timeline");
      expect(store.getState().displayed!.state).toEqual(foldAt(timeline, baseMs + 50_000));
      const after = store.getState().displayed!.state.latest_source_time;
      expect(after).not.toBeNull();
      expect(before).not.toBeNull();
      expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!));
    });

    // Review round 1 on PR #154: `foldAt` clones on every call, so without a
    // cache `displayed` got a new reference on every 250ms tick even when
    // the fold did not cross an event boundary -- `useDisplayed()` would
    // re-render every tick while a viewer sat parked in timeline mode.
    it("keeps displayed referentially stable across ticks that do not cross an event boundary, and returns a new reference once one is crossed", async () => {
      const store = createLiveStore();
      const timeline = await buildRewindTimeline();
      store.getState().setTimeline(timeline, 0);
      // delay 190s: target = 200s - 190s = 10s offset (before the 40s lap-2 marker).
      store.getState().setDelayMs(190_000, 0);

      const live = frame("2026-09-08T12:03:20.000Z", 200_000);
      store.getState().onState(live.raw, live.push, 200_000);
      const first = store.getState().displayed;
      expect(store.getState().mode).toBe("timeline");

      // 10s pass: target -> 20s offset, still before the 40s marker -- same events applied.
      store.getState().tick(210_000);
      const second = store.getState().displayed;
      expect(second).toBe(first);

      // 30 more seconds pass: target -> 50s offset, past the 40s lap-2 marker -- a new event applied.
      store.getState().tick(240_000);
      const third = store.getState().displayed;
      expect(third).not.toBe(second);
    });

    // Review round 1 on PR #154 (Note): a timeline for a different session
    // than the live push's must never be folded from -- fall through to the
    // oldest-entry fallback exactly as if no timeline were loaded.
    it("ignores a timeline for a different session, falling through to the oldest-entry fallback", async () => {
      const store = createLiveStore();
      const otherSessionTimeline = createTimeline({ ...TIMELINE_SESSION, session_key: 1111 });
      await appendEvents(otherSessionTimeline, [timelineEvent("o1", "laps", 0, { driver_number: 1, lap_number: 1 })]);

      store.getState().setTimeline(otherSessionTimeline, 0);
      store.getState().setDelayMs(150_000, 0);

      const live = frame("2026-09-08T12:03:20.000Z", 200_000); // session_key "9999"
      store.getState().onState(live.raw, live.push, 200_000);

      expect(store.getState().mode).toBe("buffer");
      expect(store.getState().bufferShort).toBe(true);
      expect(store.getState().displayed).toEqual(live.push);
    });

    // Review round 2 on PR #154: the round-1 cache keyed only on `timeline.events`
    // and the folded `sequence`, so a second real push landing in the same
    // fold interval (the common case -- pushes arrive roughly every second,
    // event/keyframe spacing is much wider) returned the *first* push's
    // stale envelope (`seq`/`sent_at`) instead of the new one.
    it("updates the envelope on a new push even when the fold does not cross an event boundary, and does not reuse the stale reference", async () => {
      const store = createLiveStore();
      const timeline = await buildRewindTimeline();
      store.getState().setTimeline(timeline, 0);
      store.getState().setDelayMs(195_000, 0);

      const first = frame("2026-09-08T12:03:20.000Z", 200_000); // 200s offset -> target 5s
      store.getState().onState(first.raw, first.push, 200_000);
      const firstDisplayed = store.getState().displayed;
      expect(store.getState().mode).toBe("timeline");

      const second = frame("2026-09-08T12:03:30.000Z", 210_000); // 210s offset -> target 15s, same fold interval (before the 40s marker)
      store.getState().onState(second.raw, second.push, 210_000);
      const secondDisplayed = store.getState().displayed;

      expect(store.getState().mode).toBe("timeline");
      expect(secondDisplayed!.state).toEqual(firstDisplayed!.state); // same fold content -- no boundary crossed
      expect(secondDisplayed).not.toBe(firstDisplayed); // but a new push must not reuse the stale envelope
      expect(secondDisplayed!.seq).toBe(second.push.seq);
      expect(secondDisplayed!.sent_at).toBe(second.push.sent_at);
    });

    it("returns to buffer mode when the target catches up into the buffer span, then to edge on setDelayMs(0)", async () => {
      const store = createLiveStore();
      const timeline = await buildRewindTimeline();
      store.getState().setTimeline(timeline, 0);
      store.getState().setDelayMs(150_000, 0);

      const first = frame("2026-09-08T12:03:20.000Z", 200_000); // 200s offset
      store.getState().onState(first.raw, first.push, 200_000);
      expect(store.getState().mode).toBe("timeline");

      const second = frame("2026-09-08T12:03:30.000Z", 210_000); // 210s offset
      store.getState().onState(second.raw, second.push, 210_000);
      // Still timeline mode: target = 210s - 150s = 60s offset, outside the buffer's [200s, 210s] span.
      expect(store.getState().mode).toBe("timeline");

      // Nudge the delay down until the target re-enters the buffer span.
      store.getState().setDelayMs(5_000, 210_000);
      expect(store.getState().mode).toBe("buffer");

      store.getState().setDelayMs(0, 210_000);
      expect(store.getState().mode).toBe("edge");
      expect(store.getState().displayed).toBe(second.push);
    });
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

  it("starts with empty anchors and folds each push's drivers/race-control into them", () => {
    const store = createLiveStore();
    expect(store.getState().anchors).toEqual({ lights_out: null, laps: [], restarts: [] });

    const lap1Driver: DriverState = {
      driver_number: 44,
      full_name: null,
      name_acronym: null,
      team_name: null,
      team_colour: null,
      position: null,
      interval: null,
      gap_to_leader: null,
      current_lap: 1,
      lap_duration: null,
      sector_durations: { sector_1: null, sector_2: null, sector_3: null },
      is_pit_out_lap: null,
      tyre: { stint_number: null, compound: null, lap_start: null, lap_end: null, age_at_start: null, age: null },
      pit_stops: [],
      latest_pit_stop: null,
      source_timestamps: { lap: "2026-09-08T12:00:00.000Z" },
    };
    const push = racePush({ sourceTime: "2026-09-08T12:00:00.000Z", sentAt: 0, drivers: { "44": lap1Driver } });
    store.getState().onState(JSON.stringify(push), push, 0);

    expect(store.getState().anchors).toEqual({
      lights_out: "2026-09-08T12:00:00.000Z",
      laps: [{ lap: 1, source_time: "2026-09-08T12:00:00.000Z" }],
      restarts: [],
    });
  });

  it("keeps each store instance's anchors independent", () => {
    const storeA = createLiveStore();
    const storeB = createLiveStore();
    const push = racePush({
      sourceTime: "2026-09-08T12:00:00.000Z",
      sentAt: 0,
      drivers: {
        "1": {
          driver_number: 1,
          full_name: null,
          name_acronym: null,
          team_name: null,
          team_colour: null,
          position: null,
          interval: null,
          gap_to_leader: null,
          current_lap: 1,
          lap_duration: null,
          sector_durations: { sector_1: null, sector_2: null, sector_3: null },
          is_pit_out_lap: null,
          tyre: { stint_number: null, compound: null, lap_start: null, lap_end: null, age_at_start: null, age: null },
          pit_stops: [],
          latest_pit_stop: null,
          source_timestamps: { lap: "2026-09-08T12:00:00.000Z" },
        },
      },
    });

    storeA.getState().onState(JSON.stringify(push), push, 0);

    expect(storeA.getState().anchors.laps).toHaveLength(1);
    expect(storeB.getState().anchors).toEqual({ lights_out: null, laps: [], restarts: [] });
  });
});

// Exported (PR #157 review round 1) so `live/selectors.ts`'s `useTimeline()`
// can apply the identical session guard `reselect()` uses here.
describe("timelineMatchesSession", () => {
  it("is true when the timeline's normalised session_key equals the live push's", () => {
    const timeline = createTimeline(TIMELINE_SESSION); // session_key: 9999 (number), normalised to "9999"
    expect(timelineMatchesSession(timeline, "9999")).toBe(true);
  });

  it("is false for a different session", () => {
    const timeline = createTimeline({ ...TIMELINE_SESSION, session_key: 1111 });
    expect(timelineMatchesSession(timeline, "9999")).toBe(false);
  });
});
