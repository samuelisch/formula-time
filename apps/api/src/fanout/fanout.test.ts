import { constants as zlibConstants, inflateRawSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import type { RaceState } from "@formula-time/domain";

import { Fanout } from "./fanout.js";

class FakeRes {
  public chunks: Buffer[] = [];
  public writableLength = 0;
  public destroyed = false;

  public write(chunk: Buffer): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  public destroy(): this {
    this.destroyed = true;
    return this;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asRes(fake: FakeRes): any {
  return fake;
}

describe("Fanout", () => {
  test("two sockets receive byte-identical buffers from the same push", async () => {
    const fanout = new Fanout();
    const a = new FakeRes();
    const b = new FakeRes();
    await fanout.join(asRes(a), "gzip");
    await fanout.join(asRes(b), "gzip");

    await fanout.push({ type: "state", seq: "1" });

    const lastA = a.chunks[a.chunks.length - 1];
    const lastB = b.chunks[b.chunks.length - 1];
    expect(lastA).toBeDefined();
    expect(lastA?.equals(lastB as Buffer)).toBe(true);
  });

  test("a socket joining after two pushes gets the header + only the latest block, which decodes alone", async () => {
    const fanout = new Fanout();
    const early = new FakeRes();
    await fanout.join(asRes(early), "gzip");

    await fanout.push({ n: 1 });
    await fanout.push({ n: 2 });

    const late = new FakeRes();
    await fanout.join(asRes(late), "gzip");

    // header, then exactly one data block (the latest push's, n:2).
    expect(late.chunks).toHaveLength(2);
    expect(late.chunks[0]?.equals(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]))).toBe(
      true,
    );

    const block = late.chunks[1] as Buffer;
    const decoded = inflateRawSync(block, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    expect(decoded.toString("utf8")).toBe(`event: state\ndata: ${JSON.stringify({ n: 2 })}\n\n`);
  });

  test("a socket over the writableLength limit is destroyed and removed on the next push", async () => {
    const fanout = new Fanout();
    const slow = new FakeRes();
    const fine = new FakeRes();
    await fanout.join(asRes(slow), "plain");
    await fanout.join(asRes(fine), "plain");

    expect(fanout.size()).toBe(2);

    slow.writableLength = 2_000_000; // over the 1_048_576 limit
    await fanout.push({ n: 1 });

    expect(slow.destroyed).toBe(true);
    expect(fanout.size()).toBe(1);
    expect(fine.destroyed).toBe(false);
  });

  test("overlapping pushes coalesce to the newest payload; intermediate ones are dropped", async () => {
    const fanout = new Fanout();
    const res = new FakeRes();
    await fanout.join(asRes(res), "plain");

    const p1 = fanout.push({ n: 1 });
    const p2 = fanout.push({ n: 2 });
    const p3 = fanout.push({ n: 3 });
    await Promise.all([p1, p2, p3]);

    const delivered = res.chunks
      .map((chunk) => chunk.toString("utf8"))
      .filter((frame) => frame.startsWith("event: state"))
      .map((frame) => JSON.parse(frame.split("data: ")[1] ?? "{}") as { n: number });

    // The first push (already in flight when 2 and 3 arrived) is delivered;
    // 2 is dropped in favour of 3, the newest payload queued behind it.
    expect(delivered).toEqual([{ n: 1 }, { n: 3 }]);
  });
});

function raceState(overrides: Partial<RaceState> = {}): RaceState {
  return {
    sequence: 1,
    latest_source_time: null,
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

function statePush(seq: number, state: RaceState) {
  return {
    type: "state",
    seq: String(seq),
    sent_at: 1000 + seq,
    session_key: "42",
    total_laps: 50,
    state,
    polls: [],
  };
}

function frames(res: FakeRes): Array<{ event: string; data: unknown }> {
  return res.chunks
    .map((chunk) => chunk.toString("utf8"))
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      return {
        event: (eventLine as string).slice("event: ".length),
        data: JSON.parse((dataLine as string).slice("data: ".length)) as unknown,
      };
    });
}

describe("Fanout delta pushes (issue #89)", () => {
  test("a delta socket joining before any push gets the catching_up frame, same as today", async () => {
    const fanout = new Fanout();
    const res = new FakeRes();
    await fanout.join(asRes(res), "plain", "delta");

    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]?.toString("utf8")).toBe('event: status\ndata: {"catching_up":true}\n\n');
  });

  test("a delta socket joining after a push gets that state push, then a delta on the next push", async () => {
    const fanout = new Fanout();
    await fanout.push(statePush(1, raceState({ sequence: 1, drivers: { "1": { driver_number: 1 } as never } })));

    const res = new FakeRes();
    await fanout.join(asRes(res), "plain", "delta");
    expect(frames(res)).toEqual([{ event: "state", data: statePush(1, raceState({ sequence: 1, drivers: { "1": { driver_number: 1 } as never } })) }]);

    await fanout.push(
      statePush(2, raceState({ sequence: 2, drivers: { "1": { driver_number: 1, position: 1 } as never } })),
    );

    const delivered = frames(res);
    expect(delivered).toHaveLength(2);
    const deltaFrame = delivered[1] as { event: string; data: { type: string; base_seq: string; seq: string } };
    expect(deltaFrame.event).toBe("delta");
    expect(deltaFrame.data.type).toBe("delta");
    expect(deltaFrame.data.base_seq).toBe("1");
    expect(deltaFrame.data.seq).toBe("2");
  });

  test("a legacy state socket only ever gets state frames, even with a delta socket attached", async () => {
    const fanout = new Fanout();
    await fanout.push(statePush(1, raceState({ sequence: 1 })));

    const legacy = new FakeRes();
    const delta = new FakeRes();
    await fanout.join(asRes(legacy), "plain", "state");
    await fanout.join(asRes(delta), "plain", "delta");

    await fanout.push(statePush(2, raceState({ sequence: 2 })));
    await fanout.push(statePush(3, raceState({ sequence: 3 })));

    const legacyEvents = frames(legacy).map((f) => f.event);
    expect(legacyEvents.every((event) => event === "state")).toBe(true);
    expect(legacyEvents.length).toBeGreaterThan(0);
  });

  test("two delta sockets receive byte-identical delta frames", async () => {
    const fanout = new Fanout();
    await fanout.push(statePush(1, raceState({ sequence: 1 })));

    const a = new FakeRes();
    const b = new FakeRes();
    await fanout.join(asRes(a), "plain", "delta");
    await fanout.join(asRes(b), "plain", "delta");

    await fanout.push(statePush(2, raceState({ sequence: 2, latest_source_time: "2026-01-01T00:00:00Z" })));

    const lastA = a.chunks[a.chunks.length - 1];
    const lastB = b.chunks[b.chunks.length - 1];
    expect(lastA?.toString("utf8").startsWith("event: delta")).toBe(true);
    expect(lastA?.equals(lastB as Buffer)).toBe(true);
  });

  test("every 200th push to a delta socket is a full state push (keyframe), not a delta", async () => {
    const fanout = new Fanout();
    const res = new FakeRes();
    await fanout.join(asRes(res), "plain", "delta");

    for (let seq = 1; seq <= 200; seq += 1) {
      await fanout.push(statePush(seq, raceState({ sequence: seq })));
    }

    const events = frames(res).map((f) => f.event);
    // push #200 is the keyframe; every other push after the first (which
    // has no baseline yet, so it's a state push too) is a delta.
    expect(events[events.length - 1]).toBe("state");
    expect(events.filter((event) => event === "state").length).toBe(2); // push 1 (no baseline) + push 200 (keyframe)
  });

  test("a diffState failure falls back to a state push for that tick and logs once", async () => {
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const fanout = new Fanout({ log: (msg, fields) => logs.push({ msg, fields }) });
    await fanout.push(statePush(1, raceState({ sequence: 1 })));

    const res = new FakeRes();
    await fanout.join(asRes(res), "plain", "delta");

    // A malformed state (missing `drivers`) makes diffState throw.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const malformed = { sequence: 2 } as any;
    await fanout.push(statePush(2, malformed));

    const delivered = frames(res);
    expect(delivered[delivered.length - 1]?.event).toBe("state");
    expect(logs.filter((l) => l.msg.includes("delta diff failed"))).toHaveLength(1);
  });

  test("snapshotJson is null before the first push, then the newest state push's JSON", async () => {
    const fanout = new Fanout();
    expect(fanout.snapshotJson()).toBeNull();

    const payload = statePush(1, raceState({ sequence: 1 }));
    await fanout.push(payload);

    expect(fanout.snapshotJson()).toBe(JSON.stringify(payload));
  });

  test("a delta frame carries the pushed payload's events, and rebuilt only when the source payload set it (issue #114)", async () => {
    const fanout = new Fanout();
    await fanout.push({ ...statePush(1, raceState({ sequence: 1 })), events: [] });

    const res = new FakeRes();
    await fanout.join(asRes(res), "plain", "delta");

    const applied = [{ event_id: "e1", endpoint: "drivers", source_time: null, payload: { driver_number: 1 } }];

    // Ordinary tick: events present, rebuilt absent from the wire entirely.
    await fanout.push({
      ...statePush(2, raceState({ sequence: 2, latest_source_time: "2026-01-01T00:00:00Z" })),
      events: applied,
    });
    const afterOrdinary = frames(res);
    const ordinaryDelta = afterOrdinary[afterOrdinary.length - 1] as {
      event: string;
      data: { events: unknown; rebuilt?: boolean };
    };
    expect(ordinaryDelta.event).toBe("delta");
    expect(ordinaryDelta.data.events).toEqual(applied);
    expect("rebuilt" in ordinaryDelta.data).toBe(false);

    // Rebuild tick: events empty, rebuilt true.
    await fanout.push({
      ...statePush(3, raceState({ sequence: 3, latest_source_time: "2026-01-01T00:00:01Z" })),
      events: [],
      rebuilt: true,
    });
    const afterRebuild = frames(res);
    const rebuildDelta = afterRebuild[afterRebuild.length - 1] as {
      event: string;
      data: { events: unknown; rebuilt?: boolean };
    };
    expect(rebuildDelta.event).toBe("delta");
    expect(rebuildDelta.data.events).toEqual([]);
    expect(rebuildDelta.data.rebuilt).toBe(true);
  });

  test("removing the only delta socket stops delta-frame work; a legacy socket keeps getting state frames throughout", async () => {
    // The delta-socket count is maintained incrementally in join()/remove(),
    // not scanned from `sockets` on every push. This exercises both the join
    // increment and the remove
    // decrement, plus the case where the only delta socket disconnects
    // mid-stream.
    const legacy = new FakeRes();
    const delta = new FakeRes();
    const fanout = new Fanout();
    await fanout.push(statePush(1, raceState({ sequence: 1 })));
    await fanout.join(asRes(legacy), "plain", "state");
    await fanout.join(asRes(delta), "plain", "delta");

    await fanout.push(statePush(2, raceState({ sequence: 2 })));
    expect(frames(delta).map((f) => f.event)).toContain("delta");

    fanout.remove(asRes(delta));
    await fanout.push(statePush(3, raceState({ sequence: 3 })));
    await fanout.push(statePush(4, raceState({ sequence: 4 })));

    // The disconnected delta socket receives nothing more; the legacy
    // socket is unaffected and only ever sees state frames.
    const deltaFrameCountAfterRemoval = frames(delta).length;
    await fanout.push(statePush(5, raceState({ sequence: 5 })));
    expect(frames(delta).length).toBe(deltaFrameCountAfterRemoval);
    expect(frames(legacy).every((f) => f.event === "state")).toBe(true);
    expect(frames(legacy).length).toBeGreaterThan(0);
  });
});
