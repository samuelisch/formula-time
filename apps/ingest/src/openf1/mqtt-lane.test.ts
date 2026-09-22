import { EventEmitter } from "node:events";

import { describe, expect, test } from "vitest";

import { eventId, LiveNormalizer } from "./normalize.js";
import { MQTT_TOPICS, MqttLane, mqttBackoffDelayMs, mqttTopicEndpoint } from "./mqtt-lane.js";
import type { MqttClientLike, MqttConnect, MqttLaneAuth } from "./mqtt-lane.js";
import { enqueueRows } from "./enqueue.js";
import type { QueueItem, RawRecord } from "./types.js";
import { EventQueue } from "../writer/queue.js";

// --- mqttTopicEndpoint: v1/<one of the eight named topics> -> endpoint ------

describe("mqttTopicEndpoint", () => {
  test("maps each of the eight named topics to its endpoint", () => {
    expect(mqttTopicEndpoint("v1/position")).toBe("position");
    expect(mqttTopicEndpoint("v1/intervals")).toBe("intervals");
    expect(mqttTopicEndpoint("v1/laps")).toBe("laps");
    expect(mqttTopicEndpoint("v1/race_control")).toBe("race_control");
    expect(mqttTopicEndpoint("v1/stints")).toBe("stints");
    expect(mqttTopicEndpoint("v1/weather")).toBe("weather");
    expect(mqttTopicEndpoint("v1/pit")).toBe("pit");
    expect(mqttTopicEndpoint("v1/overtakes")).toBe("overtakes");
  });

  test("never v1/# (apps/ingest/AGENTS.md: 'named timing topics only, never v1/#')", () => {
    expect(mqttTopicEndpoint("v1/#")).toBeNull();
  });

  test("a topic outside the eight named ones -> null (unknown, not silently accepted)", () => {
    expect(mqttTopicEndpoint("v1/location")).toBeNull();
  });

  test("no v1/ prefix -> null", () => {
    expect(mqttTopicEndpoint("position")).toBeNull();
  });

  test("empty topic / empty endpoint -> null", () => {
    expect(mqttTopicEndpoint("")).toBeNull();
    expect(mqttTopicEndpoint("v1/")).toBeNull();
  });
});

describe("MQTT_TOPICS", () => {
  test("exactly the eight named timing topics from the issue", () => {
    expect([...MQTT_TOPICS].sort()).toEqual(
      [
        "v1/intervals",
        "v1/laps",
        "v1/position",
        "v1/race_control",
        "v1/stints",
        "v1/weather",
        "v1/pit",
        "v1/overtakes",
      ].sort(),
    );
  });
});

describe("mqttBackoffDelayMs", () => {
  test("doubles per attempt, capped at maxMs", () => {
    expect(mqttBackoffDelayMs(1000, 0, 60_000)).toBe(1000);
    expect(mqttBackoffDelayMs(1000, 1, 60_000)).toBe(2000);
    expect(mqttBackoffDelayMs(1000, 2, 60_000)).toBe(4000);
    expect(mqttBackoffDelayMs(1000, 10, 60_000)).toBe(60_000);
  });
});

// --- Fakes: no network, ever ------------------------------------------------

class FakeMqttClient extends EventEmitter implements MqttClientLike {
  public subscribeCalls: Array<{ topics: string[]; opts: { qos: 0 } }> = [];
  public endCalls = 0;
  public endImpl: (force: boolean, cb?: () => void) => void = (_force, cb) => cb?.();

  public subscribe(topics: string[], opts: { qos: 0 }, cb?: (error: Error | null) => void): void {
    this.subscribeCalls.push({ topics, opts });
    cb?.(null);
  }

  public end(force: boolean, cb?: () => void): void {
    this.endCalls += 1;
    this.endImpl(force, cb);
  }
}

function fakeConnect(): { connectImpl: MqttConnect; clients: FakeMqttClient[]; calls: Array<{ url: string; opts: Record<string, unknown> }> } {
  const clients: FakeMqttClient[] = [];
  const calls: Array<{ url: string; opts: Record<string, unknown> }> = [];
  const connectImpl: MqttConnect = (url, opts) => {
    calls.push({ url, opts: opts as unknown as Record<string, unknown> });
    const client = new FakeMqttClient();
    clients.push(client);
    return client;
  };
  return { connectImpl, clients, calls };
}

function fakeAuth(tokens: string[] = ["token-1", "token-2", "token-3", "token-4"]): MqttLaneAuth & { invalidateCalls: number; getTokenCalls: number } {
  let index = 0;
  const state = {
    invalidateCalls: 0,
    getTokenCalls: 0,
    invalidate(): void {
      state.invalidateCalls += 1;
    },
    async getToken(): Promise<string | null> {
      state.getTokenCalls += 1;
      const token = tokens[Math.min(index, tokens.length - 1)]!;
      index += 1;
      return token;
    },
  };
  return state;
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const POSITION_TOPIC = "v1/position";

describe("MqttLane: connect", () => {
  test("connects with the bearer token as password and the login as username", async () => {
    const { connectImpl, calls } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "sponsor-login",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: () => {},
    });

    lane.start();
    await waitUntil(() => calls.length > 0);

    expect(calls[0]?.opts).toMatchObject({ username: "sponsor-login", password: "token-1" });
    await lane.stop();
  });
});

describe("MqttLane: subscribe", () => {
  test("subscribes to exactly the eight named topics on every connect event", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: () => {},
    });

    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;

    client.emit("connect", { sessionPresent: false });
    expect(client.subscribeCalls).toHaveLength(1);
    expect([...client.subscribeCalls[0]!.topics].sort()).toEqual([...MQTT_TOPICS].sort());
    expect(client.subscribeCalls[0]!.opts).toEqual({ qos: 0 });

    // A second CONNACK on the same client (e.g. a session resume) re-subscribes too.
    client.emit("connect", { sessionPresent: true });
    expect(client.subscribeCalls).toHaveLength(2);

    await lane.stop();
  });
});

describe("MqttLane: message handling", () => {
  test("a REST row and its MQTT twin (_id/_key envelope) enqueue with the same event_id", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const normalizer = new LiveNormalizer();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => normalizer,
      getSessionKey: () => 11361,
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const restRow = { session_key: 11361, driver_number: 1, date: "2026-09-06T13:00:00+00:00" };
    const mqttRow = {
      session_key: 11361,
      driver_number: 1,
      date: "2026-09-06T13:00:00",
      _id: 42,
      _key: "abc123",
    };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(mqttRow), "utf8"));

    const [item] = queue.drain(10);
    expect(item).toBeDefined();
    expect(item?.eventId).toBe(eventId("position", restRow));
    expect(item?.sessionKey).toBe(11361n);
    expect(item?.endpoint).toBe("position");
    // The envelope must not survive into the queued payload.
    expect((item?.payload as Record<string, unknown>)["_id"]).toBeUndefined();
    expect((item?.payload as Record<string, unknown>)["_key"]).toBeUndefined();

    await lane.stop();
  });

  test("a message before any session is selected is dropped and counted, never enqueued", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null, // REST lane has not selected a session yet
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    client.emit(
      "message",
      POSITION_TOPIC,
      Buffer.from(JSON.stringify({ driver_number: 1, date: "2026-09-06T13:00:00Z" }), "utf8"),
    );

    expect(queue.size).toBe(0);
    const stats = lane.takeStats();
    expect(stats.dropped).toBe(1);
    expect(stats.messages).toBe(1);
    expect(stats.rows).toBe(0);

    await lane.stop();
  });

  test("a payload whose own session_key disagrees with the REST lane's selected session is dropped and counted foreign, never tagged to the selected session", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => 11361, // REST lane is following this session
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const foreignRow = { session_key: 9999, driver_number: 1, date: "2026-09-06T13:00:00Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(foreignRow), "utf8"));

    expect(queue.size).toBe(0);
    const stats = lane.takeStats();
    expect(stats.foreign).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(stats.rows).toBe(0);

    await lane.stop();
  });

  test("a payload with no session_key of its own keeps today's behaviour: tagged to the selected session", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => 11361,
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const noKeyRow = { driver_number: 1, date: "2026-09-06T13:00:00Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(noKeyRow), "utf8"));
    await flushMicrotasks();

    const [item] = queue.drain(10);
    expect(item).toBeDefined();
    expect(item?.sessionKey).toBe(11361n);
    const stats = lane.takeStats();
    expect(stats.foreign).toBe(0);
    expect(stats.rows).toBe(1);

    await lane.stop();
  });

  test("a payload with an explicit session_key: null is treated as having no session_key of its own, not as a disagreeing key", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => 11361,
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const nullKeyRow = { session_key: null, driver_number: 1, date: "2026-09-06T13:00:00Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(nullKeyRow), "utf8"));
    await flushMicrotasks();

    const [item] = queue.drain(10);
    expect(item).toBeDefined();
    expect(item?.sessionKey).toBe(11361n);
    const stats = lane.takeStats();
    expect(stats.foreign).toBe(0);
    expect(stats.rows).toBe(1);

    await lane.stop();
  });

  test("a message for an unknown (non-named) topic is dropped and counted, never enqueued", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => 11361,
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    client.emit("message", "v1/location", Buffer.from(JSON.stringify({ x: 1 }), "utf8"));

    expect(queue.size).toBe(0);
    expect(lane.takeStats().dropped).toBe(1);

    await lane.stop();
  });

  test("a malformed (non-JSON) payload is dropped and counted, never enqueued, never throws", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => 11361,
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    expect(() => client.emit("message", POSITION_TOPIC, Buffer.from("not json{{{", "utf8"))).not.toThrow();

    expect(queue.size).toBe(0);
    expect(lane.takeStats().dropped).toBe(1);

    await lane.stop();
  });
});

// The bug this fixes: both lanes dedup through one shared LiveNormalizer
// (getNormalizer/getSessionKey mirror how main.ts wires RestLane's own
// normalizer into MqttLane), but only the REST lane's private wrapper
// around `enqueueRows` ever fed the jsonl recorder — `enqueueRows` itself
// did not, so a row MQTT delivered first was recorded nowhere: REST's
// later fetch of the same row found it already `seen` and reported
// `new=0`, and the recorder never saw it either. `enqueueRows`'s
// `onRecorded` parameter closes that gap: it is called with exactly the
// rows it queues, whichever caller (lane) reaches it first.
describe("MqttLane: recording (a row is recorded by whichever lane sees it first)", () => {
  test("a row first seen by MQTT is recorded once; the same row fetched by REST afterwards is neither queued nor recorded", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const normalizer = new LiveNormalizer();
    const recorded: Array<{ sessionKey: number; endpoint: string; payloads: RawRecord[] }> = [];
    const onRecorded = async (sessionKey: number, endpoint: string, payloads: RawRecord[]): Promise<void> => {
      recorded.push({ sessionKey, endpoint, payloads });
    };
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => normalizer,
      getSessionKey: () => 11361,
      onLog: () => {},
      onRecorded,
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const row = { session_key: 11361, driver_number: 1, date: "2026-09-06T13:00:00Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(row), "utf8"));
    await flushMicrotasks();

    expect(queue.size).toBe(1);
    const positionRecordings = recorded.filter((r) => r.endpoint === "position");
    expect(positionRecordings).toHaveLength(1);
    expect(positionRecordings[0]?.payloads).toHaveLength(1);

    // REST fetches the same row afterward, sharing the same normalizer and
    // queue (as it would in production, via RestLane#getNormalizer) — the
    // row is already `seen`, so enqueueRows queues and records nothing.
    queue.drain(10);
    recorded.length = 0;
    const restResult = await enqueueRows(normalizer, queue, "position", 11361, [row], onRecorded);

    expect(restResult.newRows).toBe(0);
    expect(queue.size).toBe(0);
    expect(recorded).toHaveLength(0);

    await lane.stop();
  });

  test("a row first seen by REST is recorded once; the same row delivered by MQTT afterwards is neither queued nor recorded", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const normalizer = new LiveNormalizer();
    const recorded: Array<{ sessionKey: number; endpoint: string; payloads: RawRecord[] }> = [];
    const onRecorded = async (sessionKey: number, endpoint: string, payloads: RawRecord[]): Promise<void> => {
      recorded.push({ sessionKey, endpoint, payloads });
    };
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => normalizer,
      getSessionKey: () => 11361,
      onLog: () => {},
      onRecorded,
    });

    // REST sees the row first.
    const row = { session_key: 11361, driver_number: 1, date: "2026-09-06T13:00:00Z" };
    const restResult = await enqueueRows(normalizer, queue, "position", 11361, [row], onRecorded);
    expect(restResult.newRows).toBe(1);
    expect(recorded.filter((r) => r.endpoint === "position")).toHaveLength(1);
    queue.drain(10);
    recorded.length = 0;

    // MQTT delivers the same row afterward: already `seen`, so it is
    // neither queued nor recorded again.
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(row), "utf8"));
    await flushMicrotasks();

    expect(queue.size).toBe(0);
    expect(recorded).toHaveLength(0);

    await lane.stop();
  });

  test("a rejected recording attempt is logged at error level with the endpoint, and the lane keeps handling messages", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const logs: Array<{ message: string; opts?: { level?: string; fields?: Record<string, unknown> } }> = [];
    const onRecorded = async (): Promise<void> => {
      throw new Error("disk full");
    };
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => 11361,
      onLog: (message, opts) => logs.push({ message, opts }),
      onRecorded,
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const first = { session_key: 11361, driver_number: 1, date: "2026-09-06T13:00:00Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(first), "utf8"));
    await flushMicrotasks();

    // The row stays queued even though its recording attempt rejected.
    expect(queue.size).toBe(1);
    const errorLog = logs.find((l) => l.opts?.level === "error" && l.message.includes("recording failed"));
    expect(errorLog).toBeDefined();
    expect(errorLog?.opts?.fields).toEqual({ endpoint: "position" });

    // The lane does not stop: a later, different message is still queued.
    const second = { session_key: 11361, driver_number: 2, date: "2026-09-06T13:00:01Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(second), "utf8"));
    await flushMicrotasks();
    expect(queue.size).toBe(2);

    await lane.stop();
  });
});

describe("MqttLane: reconnect", () => {
  test("a reconnect (after close) uses a freshly refreshed token, not the cached one", async () => {
    const { connectImpl, clients, calls } = fakeConnect();
    const auth = fakeAuth(["token-1", "token-2"]);
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: () => {},
      baseBackoffMs: 1,
      maxBackoffMs: 5,
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    expect(calls[0]?.opts["password"]).toBe("token-1");

    const first = clients[0]!;
    first.emit("connect", { sessionPresent: false });
    first.emit("close");

    await waitUntil(() => clients.length > 1);
    expect(calls[1]?.opts["password"]).toBe("token-2");
    expect(auth.invalidateCalls).toBeGreaterThanOrEqual(1);

    await lane.stop();
  });

  test("broker unreachable: reconnects with backoff, capped, and never throws out of the event handler", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const logs: string[] = [];
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: (line) => logs.push(line),
      baseBackoffMs: 1,
      maxBackoffMs: 5,
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    clients[0]!.emit("connect", { sessionPresent: false });

    expect(() => clients[0]!.emit("error", new Error("ECONNREFUSED"))).not.toThrow();
    expect(() => clients[0]!.emit("close")).not.toThrow();

    await waitUntil(() => clients.length > 1);
    expect(logs.some((line) => line.includes("disconnected"))).toBe(true);

    await lane.stop();
  });

  test("auth rejected (connack error) refreshes the token and retries after the configured delay, not the network backoff", async () => {
    const { connectImpl, clients, calls } = fakeConnect();
    const auth = fakeAuth(["token-1", "token-2"]);
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: () => {},
      authRetryDelayMs: 2,
      baseBackoffMs: 10_000, // if the lane mistakenly used network backoff instead, this test's waitUntil would time out
      maxBackoffMs: 60_000,
    });
    lane.start();
    await waitUntil(() => clients.length > 0);

    const authError = Object.assign(new Error("Connection refused: Not authorized"), { code: 5 });
    clients[0]!.emit("error", authError);
    clients[0]!.emit("close");

    await waitUntil(() => clients.length > 1, 500);
    expect(calls[1]?.opts["password"]).toBe("token-2");

    await lane.stop();
  });
});

describe("MqttLane: reconnect races (review round 1)", () => {
  test("a proactive refresh reconnect while a broker-unreachable reconnect is still armed does not leak a second live client", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth(["token-1", "token-2", "token-3"]);
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: () => {},
      baseBackoffMs: 10, // the stale broker-unreachable reconnect would fire ~20ms later
      maxBackoffMs: 100,
      refreshIntervalMs: 1_000_000, // never fires on its own in this test window
    });

    lane.start();
    await waitUntil(() => clients.length > 0);
    const clientA = clients[0]!;

    // Broker-unreachable: arms a reconnect timer (~20ms out).
    clientA.emit("connect", { sessionPresent: false });
    clientA.emit("close");

    // Simulate the 50-min proactive refresh firing right now, while that
    // timer is still armed — calling the SAME private method the real
    // refreshTimer invokes (`void this.reconnectNow()`), just without
    // waiting the real 50 minutes for it to fire on its own.
    await (lane as unknown as { reconnectNow(): Promise<void> }).reconnectNow();

    await waitUntil(() => clients.length > 1);
    expect(clients).toHaveLength(2);
    const clientB = clients[1]!;
    expect(clientB.endCalls).toBe(0); // clientB is the live one now

    // Wait past where the STALE broker-unreachable timer would have fired:
    // it was cancelled by reconnectNow() and never fires; a
    // leaked third client never appears, and clientB (the one actually in
    // use) is never silently orphaned.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(clients).toHaveLength(2);
    expect(clientB.endCalls).toBe(0);

    await lane.stop();
  });

  test("a token-fetch failure during connect/reconnect is caught, logged, and retried with backoff — never an unhandled rejection", async () => {
    const { connectImpl, clients, calls } = fakeConnect();
    let attempt = 0;
    const auth: MqttLaneAuth = {
      invalidate: () => {},
      getToken: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("token endpoint 500");
        return "token-2";
      },
    };
    const queue = new EventQueue<QueueItem>();
    const logs: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const lane = new MqttLane(queue, {
        connectImpl,
        auth,
        username: "u",
        getNormalizer: () => new LiveNormalizer(),
        getSessionKey: () => null,
        onLog: (line) => logs.push(line),
        baseBackoffMs: 1,
        maxBackoffMs: 5,
      });
      lane.start();

      await waitUntil(() => clients.length > 0, 1000);
      await new Promise((resolve) => setTimeout(resolve, 20)); // let any stray unhandledRejection surface

      expect(unhandled).toEqual([]);
      expect(clients).toHaveLength(1);
      expect(calls[0]?.opts["password"]).toBe("token-2");
      expect(logs.some((line) => line.includes("token fetch failed"))).toBe(true);

      await lane.stop();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

describe("MqttLane.stop()", () => {
  test("awaits the client's end() before resolving (SIGTERM order: client ended before the writer drains)", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;

    let releaseEnd: (() => void) | null = null;
    client.endImpl = (_force, cb) => {
      releaseEnd = () => cb?.();
    };

    let stopped = false;
    const stopPromise = lane.stop().then(() => {
      stopped = true;
    });

    await flushMicrotasks();
    expect(stopped).toBe(false);
    expect(client.endCalls).toBe(1);

    releaseEnd!();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  test("awaits an in-flight recording write before resolving, so a row is never dropped from the recording at shutdown", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const recorded: RawRecord[] = [];
    let releaseRecording: (() => void) | null = null;
    const onRecorded = async (_sessionKey: number, _endpoint: string, payloads: RawRecord[]): Promise<void> => {
      await new Promise<void>((resolve) => {
        releaseRecording = resolve;
      });
      recorded.push(...payloads);
    };
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => 11361,
      onLog: () => {},
      onRecorded,
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const row = { session_key: 11361, driver_number: 1, date: "2026-09-06T13:00:00Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(row), "utf8"));
    await flushMicrotasks();
    expect(releaseRecording).not.toBeNull(); // the recording write is in flight

    let stopped = false;
    const stopPromise = lane.stop().then(() => {
      stopped = true;
    });

    await flushMicrotasks();
    expect(stopped).toBe(false); // stop() must wait for the pending recording write
    expect(recorded).toHaveLength(0);

    releaseRecording!();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  test("a handler that rejects does not make stop() reject; a later message is still processed and logged", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    let getNormalizerCalls = 0;
    const normalizer = new LiveNormalizer();
    const logs: Array<{ message: string; opts?: { level?: string; fields?: Record<string, unknown> } }> = [];
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      // The first call (message A's handleMessage) throws, synchronously
      // rejecting that call's returned promise; every later call returns
      // the real, shared normalizer, so message B processes normally.
      getNormalizer: () => {
        getNormalizerCalls += 1;
        if (getNormalizerCalls === 1) throw new Error("normalizer unavailable");
        return normalizer;
      },
      getSessionKey: () => 11361,
      onLog: (message, opts) => logs.push({ message, opts }),
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    const rowA = { session_key: 11361, driver_number: 1, date: "2026-09-06T13:00:00Z" };
    const rowB = { session_key: 11361, driver_number: 2, date: "2026-09-06T13:00:01Z" };
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(rowA), "utf8"));
    client.emit("message", POSITION_TOPIC, Buffer.from(JSON.stringify(rowB), "utf8"));
    await flushMicrotasks();

    // Message B still queued despite message A's handler having rejected.
    expect(queue.drain(10).some((i) => (i.payload as RawRecord)["driver_number"] === 2)).toBe(true);

    // The rejection is logged as soon as it happens, not saved up for
    // stop() — a lane can run for a long time between a failure and a
    // shutdown.
    const errorLog = logs.find((l) => l.opts?.level === "error" && l.message.includes("normalizer unavailable"));
    expect(errorLog).toBeDefined();
    expect(errorLog?.opts?.fields).toEqual({ endpoint: "position" });

    // stop() itself never rejects because of it.
    await expect(lane.stop()).resolves.toBeUndefined();
  });

  test("stop() prevents any further reconnect (a close firing after stop is a no-op)", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => new LiveNormalizer(),
      getSessionKey: () => null,
      onLog: () => {},
      baseBackoffMs: 1,
      maxBackoffMs: 5,
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });

    await lane.stop();
    client.emit("close"); // the client's own end() can still emit close; must not reconnect

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clients).toHaveLength(1);
  });
});

describe("MqttLane.takeStats()", () => {
  test("returns messages/rows/dropped since the previous call, then resets them", async () => {
    const { connectImpl, clients } = fakeConnect();
    const auth = fakeAuth();
    const queue = new EventQueue<QueueItem>();
    const normalizer = new LiveNormalizer();
    const lane = new MqttLane(queue, {
      connectImpl,
      auth,
      username: "u",
      getNormalizer: () => normalizer,
      getSessionKey: () => 11361,
      onLog: () => {},
    });
    lane.start();
    await waitUntil(() => clients.length > 0);
    const client = clients[0]!;
    client.emit("connect", { sessionPresent: false });
    client.emit(
      "message",
      POSITION_TOPIC,
      Buffer.from(JSON.stringify({ driver_number: 1, date: "2026-09-06T13:00:00Z" }), "utf8"),
    );

    await waitUntil(() => queue.size === 1);
    await flushMicrotasks();

    const first = lane.takeStats();
    expect(first).toEqual({ messages: 1, rows: 1, dropped: 0, unjoined: 0, foreign: 0 });

    const second = lane.takeStats();
    expect(second).toEqual({ messages: 0, rows: 0, dropped: 0, unjoined: 0, foreign: 0 });

    await lane.stop();
  });
});
