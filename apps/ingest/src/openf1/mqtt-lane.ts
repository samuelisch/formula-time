// The MQTT lane: eight named timing topics, one connection, re-subscribed
// on every `connect` (ADR-0001 §1; see README: Rules, MQTT row). Row
// identity is transport-independent (ADR-0001 §2 invariant 3): a REST row
// and its MQTT twin dedup to one row via the writer's `skipDuplicates`
// (ADR-0007). Shares the REST lane's `LiveNormalizer` (`getNormalizer`)
// so in-memory dedup state is one thing, not two.

import mqtt from "mqtt";

import { backoffDelayMs } from "../writer/writer.js";
import { enqueueRows } from "./enqueue.js";
import type { RecordRows } from "./enqueue.js";
import type { LaneLog } from "../log.js";
import type { LiveNormalizer } from "./normalize.js";
import type { QueueItem, RawRecord } from "./types.js";
import type { EventQueue } from "../writer/queue.js";

// The eight named timing topics — never `v1/#` (see README: Rules).
export const MQTT_ENDPOINTS = [
  "intervals",
  "laps",
  "position",
  "race_control",
  "stints",
  "weather",
  "pit",
  "overtakes",
] as const;

const MQTT_ENDPOINT_SET = new Set<string>(MQTT_ENDPOINTS);

export const MQTT_TOPICS: readonly string[] = MQTT_ENDPOINTS.map((endpoint) => `v1/${endpoint}`);

// The unofficial broker OpenF1's own MQTT probe validated against a real
// capture (`../f1-live-events-poc/poc/live-recorder/mqtt_probe.ts`:
// `mqtts://mqtt.openf1.org:8883`).
export const MQTT_BROKER_URL = "mqtts://mqtt.openf1.org:8883";

const TOPIC_PREFIX = "v1/";

/**
 * `v1/<endpoint>` -> endpoint, but only for the eight named timing topics
 * this lane subscribes to — never `v1/#` (see README: Rules). Anything
 * else, including a bare `v1/#` string, returns `null` so the caller can
 * count it as an unknown-topic drop.
 */
export function mqttTopicEndpoint(topic: string): string | null {
  if (typeof topic !== "string" || !topic.startsWith(TOPIC_PREFIX)) return null;
  const endpoint = topic.slice(TOPIC_PREFIX.length);
  return MQTT_ENDPOINT_SET.has(endpoint) ? endpoint : null;
}

/**
 * Every underscore-prefixed field is MQTT-only transport envelope (`_id`:
 * monotonic order, `_key`: document version) — not row content. Returns a
 * copy. `eventId` (normalize.ts) strips this internally too; this exists
 * so the queued payload itself never carries the envelope either.
 */
export function stripMqttMeta(payload: RawRecord): RawRecord {
  const rest: RawRecord = {};
  for (const key of Object.keys(payload)) {
    if (!key.startsWith("_")) rest[key] = payload[key];
  }
  return rest;
}

/**
 * A payload's own `session_key`, or `null` when it doesn't carry one —
 * absent, explicit `null`, or non-numeric all mean "no key of its own",
 * never "a key of zero" (`Number(null)` is `0`). Accepts a finite number
 * or numeric string, matching either OpenF1 transport.
 */
function parseOwnSessionKey(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `run()`'s reconnect delay after `attempt` consecutive broker-unreachable
 * closes: `baseMs` doubling each time, capped at `maxMs`. Same shape as
 * `writer.ts`'s `backoffDelayMs` (re-exported here under this lane's own
 * name so a caller doesn't have to know it's the writer's function too).
 */
export function mqttBackoffDelayMs(baseMs: number, attempt: number, maxMs: number): number {
  return backoffDelayMs(baseMs, attempt, maxMs);
}

// MQTT 3.1.1 CONNACK return codes 4 ("Bad user name or password") and 5
// ("not authorized"); MQTT5 reason codes 0x86/0x87 carry the same meanings.
// `mqtt.js` surfaces a CONNACK failure as an `error` event whose Error has a
// numeric `.code` — see `ErrorWithReasonCode` in the `mqtt` package. Tests
// never touch the real broker, so this mapping is unverified live.
const AUTH_REJECTION_CODES = new Set([4, 5, 0x86, 0x87]);

function isAuthRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && AUTH_REJECTION_CODES.has(code);
}

/** The slice of `mqtt.js`'s `MqttClient` this lane needs — real client or a fake. */
export interface MqttClientLike {
  on(event: "connect", listener: (packet?: unknown) => void): void;
  on(event: "message", listener: (topic: string, payload: Buffer | Uint8Array) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  subscribe(topics: string[], opts: { qos: 0 }, callback?: (error: Error | null) => void): void;
  end(force: boolean, callback?: () => void): void;
}

export interface MqttConnectOptions {
  username: string;
  password: string;
  reconnectPeriod: number;
  connectTimeout: number;
}

/** Matches `mqtt.connect`'s shape narrowly enough to inject a fake in tests. */
export type MqttConnect = (url: string, opts: MqttConnectOptions) => MqttClientLike;

/** The slice of `OpenF1Auth` this lane needs — the SAME instance the REST lane's fetcher uses. */
export interface MqttLaneAuth {
  getToken(): Promise<string | null>;
  invalidate(): void;
}

export interface MqttLaneStats {
  messages: number;
  rows: number;
  dropped: number;
  /** `stints` rows normalized with a null `sourceTime` (their lap hadn't been seen yet) — an out-of-order stint. */
  unjoined: number;
  /** Messages whose own payload `session_key` disagreed with the REST lane's selected session — dropped, never tagged to the selected session. */
  foreign: number;
}

export interface MqttLaneOptions {
  connectImpl?: MqttConnect;
  auth: MqttLaneAuth;
  /** The sponsor account login, sent as the MQTT username (mqtt_probe.ts: "username: creds.login, password: <bearer token>"). */
  username: string;
  /** Current normalizer to dedup/normalize into — the shared LiveNormalizer, i.e. `RestLane#getNormalizer`. */
  getNormalizer: () => LiveNormalizer;
  /** Current live session key, or `null` when none is selected — the REST lane is the authority on which session is live. */
  getSessionKey: () => number | null;
  /** The jsonl recorder callback, passed straight through to `enqueueRows` for every message this lane queues, so a row is recorded at the moment it is queued — the same callback `main.ts` also gives the REST lane. */
  onRecorded?: RecordRows;
  onLog?: LaneLog;
  brokerUrl?: string;
  topics?: readonly string[];
  now?: () => number;
  /** Proactive token refresh cadence (refresh ~50 min). */
  refreshIntervalMs?: number;
  /** Retry delay after a CONNACK auth rejection (retry after 30 s). */
  authRetryDelayMs?: number;
  /** Reconnect backoff base (broker-unreachable path). */
  baseBackoffMs?: number;
  /** Reconnect backoff cap (capped at 60 s). */
  maxBackoffMs?: number;
  connectTimeoutMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 50 * 60_000;
const DEFAULT_AUTH_RETRY_DELAY_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * One MQTT connection (see README: Rules) feeding the same queue the
 * REST lane does. No failover logic — the writer's `skipDuplicates` is
 * the dedup, not this lane trying to be smart about redundancy.
 */
export class MqttLane {
  private readonly connectImpl: MqttConnect;
  private readonly auth: MqttLaneAuth;
  private readonly username: string;
  private readonly getNormalizer: () => LiveNormalizer;
  private readonly getSessionKey: () => number | null;
  private readonly onRecordedCallback: MqttLaneOptions["onRecorded"];
  private readonly log: LaneLog;
  private readonly brokerUrl: string;
  private readonly topics: readonly string[];
  private readonly refreshIntervalMs: number;
  private readonly authRetryDelayMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly connectTimeoutMs: number;

  // Monotonic id per `connectImpl()` call: event listeners close over the id
  // their client was created with, and ignore events once a newer client has
  // replaced them (a deliberate reconnect, or `stop()`) — otherwise the old
  // client's own `end()`-triggered `close` would schedule a second, redundant
  // reconnect on top of the one already in flight.
  private generation = 0;
  private client: MqttClientLike | null = null;
  private connected = false;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private backoffAttempt = 0;
  private pendingAuthRetry = false;

  private messagesSinceLog = 0;
  private rowsSinceLog = 0;
  private droppedSinceLog = 0;
  private unjoinedSinceLog = 0;
  private foreignSinceLog = 0;

  // Every `handleMessage()` call still running. See README: MQTT
  // connection lifecycle.
  private readonly inFlightMessages = new Set<Promise<void>>();

  public constructor(
    private readonly queue: EventQueue<QueueItem>,
    opts: MqttLaneOptions,
  ) {
    this.connectImpl = opts.connectImpl ?? defaultConnect;
    this.auth = opts.auth;
    this.username = opts.username;
    this.getNormalizer = opts.getNormalizer;
    this.getSessionKey = opts.getSessionKey;
    this.onRecordedCallback = opts.onRecorded;
    this.log = opts.onLog ?? ((): void => {});
    this.brokerUrl = opts.brokerUrl ?? MQTT_BROKER_URL;
    this.topics = opts.topics ?? MQTT_TOPICS;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.authRetryDelayMs = opts.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /** `messages`/`rows`/`dropped` since the previous call, then reset to zero. */
  public takeStats(): MqttLaneStats {
    const stats: MqttLaneStats = {
      messages: this.messagesSinceLog,
      rows: this.rowsSinceLog,
      dropped: this.droppedSinceLog,
      unjoined: this.unjoinedSinceLog,
      foreign: this.foreignSinceLog,
    };
    this.messagesSinceLog = 0;
    this.rowsSinceLog = 0;
    this.droppedSinceLog = 0;
    this.unjoinedSinceLog = 0;
    this.foreignSinceLog = 0;
    return stats;
  }

  public start(): void {
    this.stopped = false;
    void this.connectNow(false);
    this.refreshTimer = setInterval(() => {
      if (this.stopped) return;
      this.log("mqtt: proactive 50-min token refresh, reconnecting");
      void this.reconnectNow();
    }, this.refreshIntervalMs);
  }

  /**
   * SIGTERM path: stops scheduling reconnects/timers, ends the client,
   * then awaits any `handleMessage()` still in flight (see
   * `inFlightMessages`). `allSettled`, not `all`, since one handler
   * rejecting must not skip the writer's drain in main.ts.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.cancelScheduledReconnect();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.generation += 1; // orphan the current client's event listeners
    const client = this.client;
    this.client = null;
    if (client) await this.endClient(client);
    if (this.inFlightMessages.size > 0) await Promise.allSettled(this.inFlightMessages.keys());
  }

  private endClient(client: MqttClientLike): Promise<void> {
    return new Promise((resolve) => client.end(true, () => resolve()));
  }

  /**
   * Cancels any reconnect already armed by a `close` handler or a failed
   * `connectNow()` — without this, a stale timer could fire after a
   * newer `reconnectNow()` opened a fresh client, silently overwriting
   * `this.client` with a third, leaked, never-`end()`'d client.
   */
  private cancelScheduledReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(delayMs: number): void {
    this.cancelScheduledReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectNow(true);
    }, delayMs);
  }

  private async reconnectNow(): Promise<void> {
    this.cancelScheduledReconnect();
    this.generation += 1; // orphan the outgoing client before touching it
    const old = this.client;
    this.client = null;
    if (old) await this.endClient(old);
    await this.connectNow(true);
  }

  /**
   * Opens the one MQTT connection, forcing a fresh token before every
   * reconnect. Guards against superseded/racing attempts via a
   * generation number, and never lets a rejected `getToken()` escape as
   * an unhandled rejection. See README: MQTT connection lifecycle.
   */
  private async connectNow(forceFreshToken: boolean): Promise<void> {
    if (this.stopped) return;
    const attemptGeneration = ++this.generation;
    try {
      if (forceFreshToken) this.auth.invalidate();
      const token = await this.auth.getToken();
      if (this.stopped || attemptGeneration !== this.generation) return;
      const client = this.connectImpl(this.brokerUrl, {
        username: this.username,
        password: token ?? "",
        reconnectPeriod: 0, // this lane manages its own backoff (see the `close` handler)
        connectTimeout: this.connectTimeoutMs,
      });
      this.client = client;
      this.wireClient(client, attemptGeneration);
    } catch (error) {
      if (this.stopped || attemptGeneration !== this.generation) return;
      this.log(
        `mqtt: token fetch failed, will retry: ${error instanceof Error ? error.message : String(error)}`,
        { level: "error" },
      );
      this.scheduleReconnect(mqttBackoffDelayMs(this.baseBackoffMs, ++this.backoffAttempt, this.maxBackoffMs));
    }
  }

  private wireClient(client: MqttClientLike, generation: number): void {
    client.on("connect", () => {
      if (generation !== this.generation) return;
      this.backoffAttempt = 0;
      if (!this.connected) {
        this.connected = true;
        this.log("mqtt: connected");
      }
      // Re-subscribe on every `connect` event (see README: Rules), not
      // just the first — a broker session resume can fire `connect`
      // again without a new client.
      client.subscribe([...this.topics], { qos: 0 }, (error) => {
        if (error) this.log(`mqtt: subscribe error: ${error.message}`, { level: "error" });
      });
    });

    client.on("message", (topic, payload) => {
      if (generation !== this.generation) return;
      // Fire-and-forget from the event handler's point of view, but
      // tracked in `inFlightMessages` so `stop()` can wait for one still
      // running. See README: MQTT connection lifecycle.
      const inFlight = this.handleMessage(topic, payload);
      this.inFlightMessages.add(inFlight);
      void inFlight.then(
        () => {
          this.inFlightMessages.delete(inFlight);
        },
        (error: unknown) => {
          this.inFlightMessages.delete(inFlight);
          this.log(`mqtt: message handler failed: ${error instanceof Error ? error.message : String(error)}`, {
            level: "error",
            fields: { endpoint: mqttTopicEndpoint(topic) ?? topic },
          });
        },
      );
    });

    client.on("error", (error) => {
      if (generation !== this.generation) return;
      if (isAuthRejection(error)) {
        this.pendingAuthRetry = true;
        this.log(`mqtt: auth rejected: ${error.message}`, { level: "error" });
      } else {
        this.log(`mqtt: error: ${error.message}`, { level: "error" });
      }
    });

    client.on("close", () => {
      if (generation !== this.generation) return;
      if (this.connected) {
        this.connected = false;
        this.log("mqtt: disconnected");
      }
      if (this.stopped) return;
      const authRetry = this.pendingAuthRetry;
      this.pendingAuthRetry = false;
      const delay = authRetry
        ? this.authRetryDelayMs
        : mqttBackoffDelayMs(this.baseBackoffMs, ++this.backoffAttempt, this.maxBackoffMs);
      this.scheduleReconnect(delay);
    });
  }

  /**
   * The `onRecorded` callback handed to `enqueueRows`: forwards to
   * whatever `onRecorded` this lane was constructed with, catching and
   * logging a rejection instead of letting it escape — the row is
   * already queued by the time this runs.
   */
  private readonly recordRow: RecordRows = async (sessionKey, endpoint, payloads): Promise<void> => {
    if (!this.onRecordedCallback) return;
    try {
      await this.onRecordedCallback(sessionKey, endpoint, payloads);
    } catch (error) {
      this.log(`mqtt: recording failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: "error",
        fields: { endpoint },
      });
    }
  };

  private async handleMessage(topic: string, payload: Buffer | Uint8Array): Promise<void> {
    this.messagesSinceLog += 1;
    const endpoint = mqttTopicEndpoint(topic);
    if (endpoint === null) {
      this.droppedSinceLog += 1;
      return;
    }
    const sessionKey = this.getSessionKey();
    if (sessionKey === null) {
      // The REST lane is the authority on which session is live — a message
      // that arrives before REST has selected one is dropped and counted,
      // never guessed at.
      this.droppedSinceLog += 1;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload).toString("utf8"));
    } catch {
      this.droppedSinceLog += 1;
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.droppedSinceLog += 1;
      return;
    }
    const stripped = stripMqttMeta(parsed as RawRecord);

    // The payload's own session_key, when it carries one, must agree
    // with the REST lane's selected session (see README: Rules). A row
    // naming a different session is dropped and counted `foreign`; one
    // with no session_key of its own is tagged to the selected session.
    const ownSessionKey = parseOwnSessionKey(stripped["session_key"]);
    if (ownSessionKey !== null && ownSessionKey !== sessionKey) {
      this.foreignSinceLog += 1;
      return;
    }

    const result = await enqueueRows(this.getNormalizer(), this.queue, endpoint, sessionKey, [stripped], this.recordRow);
    this.droppedSinceLog += result.malformed;
    this.rowsSinceLog += result.newRows;
    this.unjoinedSinceLog += result.unjoined;
  }
}

// `mqtt.connect`'s real `MqttClient` is structurally close enough to
// `MqttClientLike` (on/subscribe/end) for this lane's needs; the cast is
// confined to this one production-only line. Connecting itself is lazy
// (mqtt.js opens the socket asynchronously), so importing `mqtt` at module
// load time has no network side effect — safe even when a test never
// exercises this default.
const defaultConnect: MqttConnect = (url, opts) => mqtt.connect(url, opts) as unknown as MqttClientLike;
