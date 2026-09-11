// The MQTT lane. Lifted from
// `../f1-live-events-poc/poc/ts/mqtt_ingest.ts` (`mqttTopicEndpoint`,
// `stripMqttMeta`, the `MqttNormalizer` shape) and
// `../f1-live-events-poc/poc/live-recorder/mqtt_probe.ts` (the broker URL,
// port, and credentials shape actually used against OpenF1: `mqtts://
// mqtt.openf1.org:8883`, `username: creds.login, password: <bearer token>`,
// proactive token refresh into `options.password` every 50 min and again on
// every reconnect). apps/ingest/AGENTS.md: "Two lanes always on, no failover
// logic: REST ... and MQTT (named timing topics only, never `v1/#`; exactly
// one connection; re-subscribe on every `connect`)." ADR-0001 §2 invariant 3:
// row identity is transport-independent, so a REST row and its MQTT twin dedup
// to one row at one point (the writer's `event.createMany({ skipDuplicates:
// true })`, ADR-0007).
//
// Deviates from the POC's `MqttNormalizer` on purpose: instead of an
// MQTT-lane-private `LiveNormalizer` instance, this lane calls into the
// SAME normalizer the REST lane is currently using (`getNormalizer`,
// RestLane#getNormalizer) — the shared LiveNormalizer — so
// in-memory dedup state is one thing, not two lanes each thinking a row is
// new. The database's `skipDuplicates` insert is still the invariant-3
// backstop regardless.
//
// Not exercised against the real broker (no network in tests, ever) —
// `isAuthRejection`'s CONNACK-error-code guess (MQTT 3.1.1 codes 4/5, MQTT5
// reason codes 0x86/0x87) is unverified until a live run against the broker.

import mqtt from "mqtt";

import { backoffDelayMs } from "../writer/writer.js";
import { emitRows } from "./rest-lane.js";
import type { LiveNormalizer } from "./normalize.js";
import type { QueueItem, RawRecord } from "./types.js";
import type { EventQueue } from "../writer/queue.js";

// The eight named timing topics — never `v1/#` (AGENTS.md).
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
 * `v1/<endpoint>` -> endpoint, but ONLY for the eight named timing topics
 * this lane subscribes to — never `v1/#`, and never an endpoint we didn't
 * ask for (AGENTS.md: "named timing topics only, never `v1/#`"). Anything
 * else, including a bare `v1/#` string, returns `null` so the caller can
 * count it as an unknown-topic drop rather than silently normalizing it.
 */
export function mqttTopicEndpoint(topic: string): string | null {
  if (typeof topic !== "string" || !topic.startsWith(TOPIC_PREFIX)) return null;
  const endpoint = topic.slice(TOPIC_PREFIX.length);
  return MQTT_ENDPOINT_SET.has(endpoint) ? endpoint : null;
}

/**
 * Every underscore-prefixed field is MQTT-only transport envelope (`_id`:
 * monotonic order, `_key`: document version) — not row content. Returns a
 * copy; the input is not mutated. `normalize.ts`'s `eventId` already strips
 * this internally, so REST and MQTT twins hash to the same id regardless of
 * whether this function ran — it exists so the queued payload itself never
 * carries the envelope either.
 */
export function stripMqttMeta(payload: RawRecord): RawRecord {
  const rest: RawRecord = {};
  for (const key of Object.keys(payload)) {
    if (!key.startsWith("_")) rest[key] = payload[key];
  }
  return rest;
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
// numeric `.code` — see `ErrorWithReasonCode` in the `mqtt` package.
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
  onLog?: (line: string) => void;
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
  /** How often `messages/rows/dropped` is logged (one line per minute). */
  statsIntervalMs?: number;
  connectTimeoutMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 50 * 60_000;
const DEFAULT_AUTH_RETRY_DELAY_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_STATS_INTERVAL_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * One MQTT connection (AGENTS.md: "exactly one connection") feeding the same
 * queue the REST lane does. No failover logic — the constraint (writer's
 * `skipDuplicates`) is the dedup, not this lane trying to be smart about
 * REST being "the real redundancy" (POC CLAUDE.md).
 */
export class MqttLane {
  private readonly connectImpl: MqttConnect;
  private readonly auth: MqttLaneAuth;
  private readonly username: string;
  private readonly getNormalizer: () => LiveNormalizer;
  private readonly getSessionKey: () => number | null;
  private readonly log: (line: string) => void;
  private readonly brokerUrl: string;
  private readonly topics: readonly string[];
  private readonly refreshIntervalMs: number;
  private readonly authRetryDelayMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly statsIntervalMs: number;
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
  private statsTimer: NodeJS.Timeout | null = null;
  private backoffAttempt = 0;
  private pendingAuthRetry = false;

  private messagesSinceLog = 0;
  private rowsSinceLog = 0;
  private droppedSinceLog = 0;

  public constructor(
    private readonly queue: EventQueue<QueueItem>,
    opts: MqttLaneOptions,
  ) {
    this.connectImpl = opts.connectImpl ?? defaultConnect;
    this.auth = opts.auth;
    this.username = opts.username;
    this.getNormalizer = opts.getNormalizer;
    this.getSessionKey = opts.getSessionKey;
    this.log = opts.onLog ?? ((): void => {});
    this.brokerUrl = opts.brokerUrl ?? MQTT_BROKER_URL;
    this.topics = opts.topics ?? MQTT_TOPICS;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.authRetryDelayMs = opts.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.statsIntervalMs = opts.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /** `messages`/`rows`/`dropped` counted since the last per-minute log flush. */
  public stats(): MqttLaneStats {
    return { messages: this.messagesSinceLog, rows: this.rowsSinceLog, dropped: this.droppedSinceLog };
  }

  public start(): void {
    this.stopped = false;
    void this.connectNow(false);
    this.refreshTimer = setInterval(() => {
      if (this.stopped) return;
      this.log("mqtt: proactive 50-min token refresh, reconnecting");
      void this.reconnectNow();
    }, this.refreshIntervalMs);
    this.statsTimer = setInterval(() => this.flushStats(), this.statsIntervalMs);
  }

  /** SIGTERM path: stop scheduling reconnects/timers and await the client's `end()` before returning. */
  public async stop(): Promise<void> {
    this.stopped = true;
    this.cancelScheduledReconnect();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.generation += 1; // orphan the current client's event listeners
    const client = this.client;
    this.client = null;
    if (client) await this.endClient(client);
  }

  private endClient(client: MqttClientLike): Promise<void> {
    return new Promise((resolve) => client.end(true, () => resolve()));
  }

  /**
   * Cancels any reconnect already armed by a `close` handler or a failed
   * `connectNow()`: without this, a broker-unreachable
   * `close` could arm a backoff timer, then a `reconnectNow()` from the
   * 50-min proactive refresh would open a fresh client while that stale
   * timer was still pending — and when it later fired, its own
   * `connectNow()` would silently overwrite `this.client` with a THIRD
   * client, orphaning the fresh one: still connected to the broker, but
   * unreferenced and never `end()`'d — a leaked socket.
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
   * Opens the one MQTT connection. `forceFreshToken`: the very first connect
   * reuses whatever token `auth` already has cached (likely fetched by the
   * REST lane already); every reconnect (broker-unreachable, auth-rejected,
   * or the 50-min timer) forces a fresh one first: refresh with a fresh
   * token before every reconnect.
   *
   * The attempt claims its generation number BEFORE awaiting anything: if
   * a second, independent `connectNow()`/`reconnectNow()`
   * runs while this one is still awaiting the token, IT claims a higher
   * generation, so this attempt notices it's been superseded (the
   * post-await check below) and bails out instead of racing it to set
   * `this.client` — the loser would otherwise open a live client that
   * silently orphans, or clobbers a client someone else just opened.
   *
   * A rejected `auth.getToken()` (the token endpoint down) is caught here,
   * not left to reject an unawaited promise: `start()`, `reconnectNow()`,
   * and the `close`/timer paths all call this via `void`, so an uncaught
   * rejection here would surface as an unhandled promise rejection —
   * capable of crashing the process under Node's default behavior, which
   * must never throw out of an event handler.
   * Treated the same as a broker-unreachable close: logged, retried with
   * backoff.
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
      // Re-subscribe on every `connect` event (AGENTS.md), not just the
      // first — a broker session resume can fire `connect` again without a
      // new client.
      client.subscribe([...this.topics], { qos: 0 }, (error) => {
        if (error) this.log(`mqtt: subscribe error: ${error.message}`);
      });
    });

    client.on("message", (topic, payload) => {
      if (generation !== this.generation) return;
      this.handleMessage(topic, payload);
    });

    client.on("error", (error) => {
      if (generation !== this.generation) return;
      if (isAuthRejection(error)) {
        this.pendingAuthRetry = true;
        this.log(`mqtt: auth rejected: ${error.message}`);
      } else {
        this.log(`mqtt: error: ${error.message}`);
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

  private handleMessage(topic: string, payload: Buffer | Uint8Array): void {
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
    const result = emitRows(this.getNormalizer(), this.queue, endpoint, sessionKey, [stripped]);
    this.droppedSinceLog += result.malformed;
    this.rowsSinceLog += result.newRows;
  }

  private flushStats(): void {
    const { messages, rows, dropped } = this.stats();
    this.messagesSinceLog = 0;
    this.rowsSinceLog = 0;
    this.droppedSinceLog = 0;
    this.log(`mqtt: last ${Math.round(this.statsIntervalMs / 1000)}s messages=${messages} rows=${rows} dropped=${dropped}`);
  }
}

// `mqtt.connect`'s real `MqttClient` is structurally close enough to
// `MqttClientLike` (on/subscribe/end) for this lane's needs; the cast is
// confined to this one production-only line. Connecting itself is lazy
// (mqtt.js opens the socket asynchronously), so importing `mqtt` at module
// load time has no network side effect — safe even when a test never
// exercises this default.
const defaultConnect: MqttConnect = (url, opts) => mqtt.connect(url, opts) as unknown as MqttClientLike;
