import { constants as zlibConstants, inflateRawSync } from "node:zlib";

import { describe, expect, test, vi } from "vitest";

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

// The heartbeat interval, mirroring fanout.ts's own private HEARTBEAT_MS --
// not exported, so a test that drives the heartbeat timer keeps its own copy.
const HEARTBEAT_MS = 5000;

/** Makes the shared deflater's `write` fail on its Nth call (1-based), then
 * fall through to the real implementation for every other call -- simulates
 * one bad deflate write (a destroyed socket mid-write, e.g.) without
 * wedging the stream for later calls. Must forward every arg it does not
 * itself consume: `flush()` (fanout.ts's deflateOnce, called after every
 * successful write) re-enters `write()` with its own 3-arg `(chunk,
 * encoding, callback)` form to send its zero-length flush marker, not just
 * the 2-arg `(chunk, callback)` form used at a deflate call site. */
function failNthDeflateWrite(fanout: Fanout, n: number): void {
  const deflater = (fanout as unknown as { deflater: { write: (...args: unknown[]) => boolean } }).deflater;
  const originalWrite = deflater.write.bind(deflater);
  let calls = 0;
  vi.spyOn(deflater, "write").mockImplementation((...args: unknown[]) => {
    calls += 1;
    if (calls === n) {
      const cb = args.find((a): a is (err?: Error) => void => typeof a === "function");
      cb?.(new Error("deflate write failed"));
      return true;
    }
    return originalWrite(...(args as [Buffer, ((err?: Error) => void)?]));
  });
}

describe("Fanout", () => {
  test("two sockets receive byte-identical buffers from the same push", async () => {
    const fanout = new Fanout();
    const a = new FakeRes();
    const b = new FakeRes();
    await fanout.join(a, "gzip");
    await fanout.join(b, "gzip");

    await fanout.push({ type: "state", seq: "1" });

    const lastA = a.chunks[a.chunks.length - 1];
    const lastB = b.chunks[b.chunks.length - 1];
    expect(lastA).toBeDefined();
    expect(lastA?.equals(lastB as Buffer)).toBe(true);
  });

  test("a socket joining after two pushes gets the header + only the latest block, which decodes alone", async () => {
    const fanout = new Fanout();
    const early = new FakeRes();
    await fanout.join(early, "gzip");

    await fanout.push({ n: 1 });
    await fanout.push({ n: 2 });

    const late = new FakeRes();
    await fanout.join(late, "gzip");

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
    await fanout.join(slow, "plain");
    await fanout.join(fine, "plain");

    expect(fanout.size()).toBe(2);

    slow.writableLength = 2_000_000; // over the 1_048_576 limit
    await fanout.push({ n: 1 });

    expect(slow.destroyed).toBe(true);
    expect(fanout.size()).toBe(1);
    expect(fine.destroyed).toBe(false);
  });

  test("a deflate write error on one frame is skipped for that tick; the next push is delivered normally", async () => {
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const fanout = new Fanout({ log: (msg, fields) => logs.push({ msg, fields }) });
    const res = new FakeRes();
    await fanout.join(res, "plain");

    failNthDeflateWrite(fanout, 1); // the state frame's deflate write, inside push #1

    await fanout.push({ n: 1 }); // this tick's deflate write fails: must not reject
    await fanout.push({ n: 2 }); // next tick: delivered normally

    const delivered = res.chunks
      .map((chunk) => chunk.toString("utf8"))
      .filter((frame) => frame.startsWith("event: state"))
      .map((frame) => JSON.parse(frame.split("data: ")[1] ?? "{}") as { n: number });

    expect(delivered).toEqual([{ n: 2 }]);
    expect(logs.some((l) => l.msg.includes("deflate"))).toBe(true);
  });

  test("a deflate error on the join snapshot frame is skipped; the socket still attaches and gets the next push", async () => {
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const fanout = new Fanout({ log: (msg, fields) => logs.push({ msg, fields }) });

    failNthDeflateWrite(fanout, 1); // the catching-up frame's deflate write, inside join()

    const res = new FakeRes();
    await fanout.join(res, "gzip"); // no push yet: hits the catching-up-frame deflate path

    expect(fanout.size()).toBe(1); // still attached despite the failed frame
    expect(logs.some((l) => l.msg.includes("deflate"))).toBe(true);
    expect(res.chunks).toHaveLength(1); // header only -- the failed frame produced no data chunk

    await fanout.push({ n: 1 });

    const last = res.chunks[res.chunks.length - 1] as Buffer;
    const decoded = inflateRawSync(last, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    expect(decoded.toString("utf8")).toBe(`event: state\ndata: ${JSON.stringify({ n: 1 })}\n\n`);
  });

  test("a deflate error on a heartbeat is skipped; it never raises an unhandled rejection", async () => {
    vi.useFakeTimers();
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const fanout = new Fanout({ log: (msg, fields) => logs.push({ msg, fields }) });
    const res = new FakeRes();
    await fanout.join(res, "gzip"); // real deflate for the catching-up frame, before the spy goes in

    failNthDeflateWrite(fanout, 1); // the heartbeat frame's deflate write

    fanout.heartbeat();
    // Vitest fails the whole run on an unhandled rejection by default, so
    // this test passing at all -- not just the log assertion below -- is
    // the proof the rejection was caught, not just observed.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    fanout.stopHeartbeat();

    expect(logs.some((l) => l.msg.includes("heartbeat"))).toBe(true);
    vi.useRealTimers();
  });

  test("the heartbeat frame is deflated once and the cached bytes are reused for every later heartbeat, on both a legacy and a delta socket", async () => {
    const fanout = new Fanout();
    const legacy = new FakeRes();
    const delta = new FakeRes();
    await fanout.join(legacy, "gzip", "state");
    await fanout.join(delta, "gzip", "delta");
    const legacyBefore = legacy.chunks.length;
    const deltaBefore = delta.chunks.length;

    const deflateSpy = vi.spyOn(fanout as unknown as { deflate(buf: Buffer): Promise<Buffer> }, "deflate");
    // Drives maybeSendHeartbeat() directly rather than through heartbeat()'s
    // setInterval: real zlib callbacks land on the real event loop, not
    // fake timers, so advancing the fake clock and letting the interval
    // fire on its own can race a still-pending deflate -- fully awaiting
    // each call here before the next one starts is what makes the count
    // deterministic.
    const sendHeartbeat = (
      fanout as unknown as { maybeSendHeartbeat(): Promise<void> }
    ).maybeSendHeartbeat.bind(fanout);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + HEARTBEAT_MS + 1);
    await sendHeartbeat(); // 1st heartbeat: deflates and caches
    vi.setSystemTime(Date.now() + HEARTBEAT_MS + 1);
    await sendHeartbeat(); // 2nd: must reuse the cached bytes
    vi.setSystemTime(Date.now() + HEARTBEAT_MS + 1);
    await sendHeartbeat(); // 3rd: same
    vi.useRealTimers();

    expect(deflateSpy).toHaveBeenCalledTimes(1);

    const legacyHeartbeats = legacy.chunks.slice(legacyBefore);
    const deltaHeartbeats = delta.chunks.slice(deltaBefore);
    expect(legacyHeartbeats).toHaveLength(3);
    expect(deltaHeartbeats).toHaveLength(3);
    const first = legacyHeartbeats[0] as Buffer;
    for (const chunk of [...legacyHeartbeats, ...deltaHeartbeats]) {
      expect(chunk.equals(first)).toBe(true);
    }
  });

  test("a socket whose write throws is dropped, logged once, and the next socket still receives the frame", async () => {
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const fanout = new Fanout({ log: (msg, fields) => logs.push({ msg, fields }) });
    const throwing = new FakeRes();
    const fine = new FakeRes();
    await fanout.join(throwing, "plain");
    await fanout.join(fine, "plain");

    let throwCalls = 0;
    vi.spyOn(throwing, "write").mockImplementation(() => {
      throwCalls += 1;
      if (throwCalls === 1) {
        throw new Error("socket write threw");
      }
      return true;
    });

    await fanout.push({ n: 1 });

    expect(throwing.destroyed).toBe(true);
    expect(fanout.size()).toBe(1);
    expect(logs.some((l) => l.msg.includes("write failed"))).toBe(true);

    const delivered = fine.chunks
      .map((chunk) => chunk.toString("utf8"))
      .filter((frame) => frame.startsWith("event: state"));
    expect(delivered).toHaveLength(1);
  });

  test("overlapping pushes coalesce to the newest payload; intermediate ones are dropped", async () => {
    const fanout = new Fanout();
    const res = new FakeRes();
    await fanout.join(res, "plain");

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
    await fanout.join(res, "plain", "delta");

    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]?.toString("utf8")).toBe('event: status\ndata: {"catching_up":true}\n\n');
  });

  test("a delta socket joining after a push gets that state push, then a delta on the next push", async () => {
    const fanout = new Fanout();
    await fanout.push(statePush(1, raceState({ sequence: 1, drivers: { "1": { driver_number: 1 } as never } })));

    const res = new FakeRes();
    await fanout.join(res, "plain", "delta");
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
    await fanout.join(legacy, "plain", "state");
    await fanout.join(delta, "plain", "delta");

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
    await fanout.join(a, "plain", "delta");
    await fanout.join(b, "plain", "delta");

    await fanout.push(statePush(2, raceState({ sequence: 2, latest_source_time: "2026-01-01T00:00:00Z" })));

    const lastA = a.chunks[a.chunks.length - 1];
    const lastB = b.chunks[b.chunks.length - 1];
    expect(lastA?.toString("utf8").startsWith("event: delta")).toBe(true);
    expect(lastA?.equals(lastB as Buffer)).toBe(true);
  });

  test("every 200th push to a delta socket is a full state push (keyframe), not a delta", async () => {
    const fanout = new Fanout();
    const res = new FakeRes();
    await fanout.join(res, "plain", "delta");

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
    await fanout.join(res, "plain", "delta");

    // A malformed state (missing `drivers`) makes diffState throw. Built as
    // a plain payload rather than through statePush()/raceState(), which
    // both require a well-formed RaceState -- push() itself only demands
    // `object`, so no cast is needed to hand it a deliberately broken one.
    const malformed = { ...statePush(2, raceState({ sequence: 2 })), state: { sequence: 2 } };
    await fanout.push(malformed);

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
    await fanout.join(res, "plain", "delta");

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
    await fanout.join(legacy, "plain", "state");
    await fanout.join(delta, "plain", "delta");

    await fanout.push(statePush(2, raceState({ sequence: 2 })));
    expect(frames(delta).map((f) => f.event)).toContain("delta");

    fanout.remove(delta);
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

describe("Fanout stats", () => {
  test("statsSnapshot starts at zero with no viewers attached", () => {
    const fanout = new Fanout();
    expect(fanout.statsSnapshot()).toEqual({
      pushes: 0,
      state_bytes_gz: 0,
      delta_bytes_gz: 0,
      slow_drops: 0,
      delta_viewers: 0,
    });
  });

  test("pushes and state_bytes_gz increment per push", async () => {
    const fanout = new Fanout();
    const res = new FakeRes();
    await fanout.join(res, "gzip");

    await fanout.push(statePush(1, raceState({ sequence: 1 })));
    await fanout.push(statePush(2, raceState({ sequence: 2 })));

    const stats = fanout.statsSnapshot();
    expect(stats.pushes).toBe(2);
    expect(stats.state_bytes_gz).toBeGreaterThan(0);
    expect(stats.delta_bytes_gz).toBe(0);
  });

  test("statsSnapshot resets the counters but not delta_viewers", async () => {
    const fanout = new Fanout();
    const legacy = new FakeRes();
    const delta = new FakeRes();
    await fanout.join(legacy, "plain", "state");
    await fanout.join(delta, "plain", "delta");

    // The first push after a delta socket joins has no baseline to diff
    // against, so it falls back to the state frame -- delta_bytes_gz stays
    // at 0 for this push, exactly.
    await fanout.push(statePush(1, raceState({ sequence: 1 })));
    const first = fanout.statsSnapshot();
    expect(first.pushes).toBe(1);
    expect(first.delta_viewers).toBe(1);
    expect(first.state_bytes_gz).toBeGreaterThan(0);
    expect(first.delta_bytes_gz).toBe(0);

    expect(fanout.statsSnapshot().state_bytes_gz).toBe(0); // reset by the read above

    // The second push has a baseline: a real delta frame is built and
    // counted.
    await fanout.push(statePush(2, raceState({ sequence: 2 })));
    const second = fanout.statsSnapshot();
    expect(second.pushes).toBe(1);
    expect(second.delta_bytes_gz).toBeGreaterThan(0);

    const third = fanout.statsSnapshot();
    expect(third.pushes).toBe(0);
    expect(third.state_bytes_gz).toBe(0);
    expect(third.delta_bytes_gz).toBe(0);
    expect(third.slow_drops).toBe(0);
    // delta_viewers is a gauge, still 1: the socket never left.
    expect(third.delta_viewers).toBe(1);
  });

  test("a keyframe tick does not raise delta_bytes_gz", async () => {
    const fanout = new Fanout();
    const delta = new FakeRes();
    await fanout.join(delta, "plain", "delta");

    // Pushes 1..199: push 1 has no baseline (state fallback), 2..199 are
    // real deltas.
    for (let seq = 1; seq <= 199; seq += 1) {
      await fanout.push(statePush(seq, raceState({ sequence: seq })));
    }
    const beforeKeyframe = fanout.statsSnapshot().delta_bytes_gz;
    expect(beforeKeyframe).toBeGreaterThan(0);

    // Push 200 is the keyframe (KEYFRAME_INTERVAL): a state push, not a
    // delta, so it must not add to delta_bytes_gz.
    await fanout.push(statePush(200, raceState({ sequence: 200 })));
    expect(fanout.statsSnapshot().delta_bytes_gz).toBe(0);
  });

  test("a socket dropped over the writableLength limit counts as a slow_drop", async () => {
    const fanout = new Fanout();
    const slow = new FakeRes();
    await fanout.join(slow, "plain");

    slow.writableLength = 2_000_000; // over the 1_048_576 limit
    await fanout.push(statePush(1, raceState({ sequence: 1 })));

    expect(fanout.statsSnapshot().slow_drops).toBe(1);
  });
});
