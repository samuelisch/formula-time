// The REST lane (issue deliverable 2). Lifted from
// `../f1-live-events-poc/poc/ts/live_capture.ts` (`OPENF1_BASE`,
// `POLL_ROTATION`, `pickLiveSession`, `sessionExpired`, `buildPollUrl`,
// `Fetcher`, the polling-loop shape) and
// `../f1-live-events-poc/poc/live-recorder/recorder.ts` (discovery, the
// "poll the full endpoint every time, dedup by eventId" cadence — the live
// API rejects every date filter; apps/ingest/AGENTS.md). Does NOT lift
// `LiveRace` / `state_authority` / `session_registry`: ingest never folds.

import { ENTRY_LIST_2026 } from "./entry-list.js";
import { LiveNormalizer, endpointConfigs } from "./normalize.js";
import type { Fetcher, QueueItem, RawRecord } from "./types.js";
import type { EventQueue } from "../writer/queue.js";

export const OPENF1_BASE = "https://api.openf1.org/v1";

// OpenF1 serves live data from 30 minutes before `date_start` to 30 minutes
// after `date_end`.
const LIVE_WINDOW_MS = 30 * 60 * 1000;

// Weighted rotation: hot endpoints appear most often. 21 slots; at a 2.2s
// tick a full cycle ~46s (~27 req/min) — "REST (cadence unchanged from the
// POC, the safety net)" (apps/ingest/AGENTS.md).
export const POLL_ROTATION: string[] = [
  "position", "intervals", "laps", "race_control",
  "position", "intervals", "weather",
  "position", "intervals", "pit",
  "position", "intervals", "laps", "race_control",
  "position", "intervals", "stints",
  "position", "intervals", "position", "intervals",
];

export function pickLiveSession(sessions: RawRecord[], nowMs: number): RawRecord | null {
  for (const session of sessions) {
    const start = Date.parse(String(session["date_start"] ?? ""));
    const end = Date.parse(String(session["date_end"] ?? ""));
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (nowMs >= start - LIVE_WINDOW_MS && nowMs <= end + LIVE_WINDOW_MS) {
      return session;
    }
  }
  return null;
}

// A session stops being live once the clock leaves its window (same ±30min
// grace as discovery). Pure so it can be unit-tested without clock injection.
export function sessionExpired(session: RawRecord | null, nowMs: number): boolean {
  if (session === null) return false;
  const end = Date.parse(String(session["date_end"] ?? ""));
  if (Number.isNaN(end)) return false;
  return nowMs > end + LIVE_WINDOW_MS;
}

// The live API rejects every date filter (apps/ingest/AGENTS.md); the rest
// lane always calls this with `cursor: null` and relies on the normalizer's
// per-endpoint dedup + `event.createMany({ skipDuplicates: true })` instead.
// The cursor parameter is kept (lifted from the POC signature) because a
// future incremental source could still use it.
export function buildPollUrl(endpoint: string, sessionKey: number, cursor: string | null): string {
  const field = endpointConfigs[endpoint]?.timestampField;
  const params = new URLSearchParams({ session_key: String(sessionKey) });
  if (field && cursor) params.set(`${field}>=`, cursor);
  return `${OPENF1_BASE}/${endpoint}?${params.toString()}`;
}

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OpenF1 ${response.status} for ${url}`);
  return response.json();
};

export interface EmitRowsResult {
  newRows: number;
  malformed: number;
  /** The normalized (already-deduped-against-`normalizer`) payloads, for a caller that also records them (e.g. the jsonl recorder's `onNewRows`). */
  payloads: RawRecord[];
}

/**
 * The one normalize-and-enqueue path (issue #63: "same `emitRows` path so
 * the ids match a live run") — pushed out of `RestLane` so the one-shot
 * recording loader (`load-recording.ts`) can drive the same normalizer +
 * queue a live session does, both for the static `ENTRY_LIST_2026`
 * `drivers` emission and for every `raw/*.jsonl` endpoint. `RestLane`
 * itself now calls this too (see `emitAndRecord` below) — no second
 * normalize path.
 */
export function emitRows(
  normalizer: LiveNormalizer,
  queue: EventQueue<QueueItem>,
  endpoint: string,
  sessionKey: number,
  rows: RawRecord[],
): EmitRowsResult {
  if (rows.length === 0) return { newRows: 0, malformed: 0, payloads: [] };
  const { rows: normalized, malformed } = normalizer.normalize(endpoint, rows);
  if (normalized.length === 0) return { newRows: 0, malformed, payloads: [] };
  const items: QueueItem[] = normalized.map((n) => ({
    eventId: n.eventId,
    sessionKey: BigInt(sessionKey),
    endpoint,
    sourceTime: n.sourceTime ? new Date(n.sourceTime) : null,
    payload: n.payload,
  }));
  queue.pushAll(items);
  return { newRows: normalized.length, malformed, payloads: normalized.map((n) => n.payload) };
}

export interface RestLaneOptions {
  fetcher?: Fetcher;
  year?: number;
  now?: () => number;
  /** Rotation cadence once a session is live. Default matches the POC: 2200ms. */
  tickMs?: number;
  /** Discovery cadence while no session is in its window. Issue: "every 60 s". */
  discoveryIntervalMs?: number;
  /** Sessions upsert (issue deliverable 4) — called for every session row discovery sees. */
  onSession?: (session: RawRecord, nowMs: number) => void | Promise<void>;
  /**
   * Called once, when a session is newly selected as the one being followed
   * (`this.sessionKey` changes) — NOT on every discovery tick like
   * `onSession`. This is where a per-session, one-time side effect (writing
   * the jsonl recorder's `session.json`) belongs, so it doesn't re-run every
   * 60s while nothing is live.
   */
  onSessionSelected?: (session: RawRecord, nowMs: number) => void | Promise<void>;
  /** New (already-deduped) rows for one endpoint — feeds the jsonl recorder. */
  onNewRows?: (sessionKey: number, endpoint: string, rows: RawRecord[]) => void | Promise<void>;
  onLog?: (line: string) => void;
}

export interface PollResult {
  endpoint: string;
  rows: number;
  newRows: number;
  malformed: number;
}

export class RestLane {
  private readonly fetcher: Fetcher;
  private readonly year: number;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly onSession: RestLaneOptions["onSession"];
  private readonly onSessionSelected: RestLaneOptions["onSessionSelected"];
  private readonly onNewRows: RestLaneOptions["onNewRows"];
  private readonly log: (line: string) => void;

  private normalizer = new LiveNormalizer();
  private session: RawRecord | null = null;
  private sessionKey: number | null = null;
  private rotationIndex = 0;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  // Tracks the tick currently awaiting the network so `stop()` can wait for
  // it instead of returning while a `pollOnce`/`discoverOnce` is still
  // in-flight — otherwise it enqueues rows after the writer has already
  // drained and the process has exited (SIGTERM race).
  private currentTick: Promise<void> | null = null;

  public constructor(
    private readonly queue: EventQueue<QueueItem>,
    opts: RestLaneOptions = {},
  ) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.year = opts.year ?? new Date().getUTCFullYear();
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 2200;
    this.discoveryIntervalMs = opts.discoveryIntervalMs ?? 60_000;
    this.onSession = opts.onSession;
    this.onSessionSelected = opts.onSessionSelected;
    this.onNewRows = opts.onNewRows;
    this.log = opts.onLog ?? ((line) => console.log(line));
  }

  public status(): { active: boolean; sessionKey: number | null } {
    return { active: this.sessionKey !== null, sessionKey: this.sessionKey };
  }

  /**
   * `sessions?year=<current>` (issue: "every 60 s until a session is inside
   * its ±30 min window"). Upserts every session it sees, and selects the
   * live session (if any) for the rotation.
   */
  public async discoverOnce(): Promise<{ sessionCount: number; live: boolean }> {
    const nowMs = this.now();
    let sessions: unknown;
    try {
      sessions = await this.fetcher(`${OPENF1_BASE}/sessions?year=${this.year}`);
    } catch (error) {
      this.log(`rest: session discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return { sessionCount: 0, live: this.sessionKey !== null };
    }
    if (!Array.isArray(sessions)) return { sessionCount: 0, live: this.sessionKey !== null };
    const rows = sessions as RawRecord[];

    // Tracks which rows' onSession (the sessions upsert) succeeded THIS
    // tick, so ensureLiveSession() never selects a session whose row failed
    // to write — selecting it anyway would mean every later event insert
    // fails its FK against a `sessions` row that was never created.
    const upserted = new Set<RawRecord>();
    for (const row of rows) {
      try {
        await this.onSession?.(row, nowMs);
        upserted.add(row);
      } catch (error) {
        // One malformed row (bad session_key, bad date) must not throw out
        // of this loop and starve ensureLiveSession()/the Friday entry-list
        // check every discovery tick — sessions.ts's upsertSession is what
        // actually validates and throws; this is where ingest survives it.
        this.log(`rest: session row skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.ensureLiveSession(rows, nowMs, upserted);

    return { sessionCount: rows.length, live: this.sessionKey !== null };
  }

  private async ensureLiveSession(
    sessions: RawRecord[],
    nowMs: number,
    upserted: Set<RawRecord>,
  ): Promise<void> {
    const live = pickLiveSession(sessions, nowMs);
    if (!live) return;
    if (!upserted.has(live)) {
      // Its sessions upsert failed this tick (thrown, caught, and logged
      // above) — selecting it anyway would mean every later event insert
      // fails its FK forever against a `sessions` row that doesn't exist.
      // Leave sessionKey null; the next discoverOnce() retries the upsert.
      this.log("rest: session not selected: upsert failed");
      return;
    }
    const key = Number(live["session_key"]);
    if (!Number.isFinite(key)) return;
    if (this.sessionKey !== key) {
      this.session = live;
      this.sessionKey = key;
      this.normalizer = new LiveNormalizer();
      this.rotationIndex = 0;
      this.log(
        `rest: following session_key=${key} (${String(live["country_name"] ?? "?")})`,
      );
      // Once per newly-selected session — NOT on every discovery tick like
      // onSession (issue round 3: recorder.writeSession() was running from
      // onSession, re-stamping session.json for every session of the year
      // every 60s while nothing was live).
      await this.onSessionSelected?.(live, nowMs);

      // Owner decision (round 4): the entry list is hardcoded for now, not
      // fetched. One `drivers` event per driver, through the normal
      // emitRows() path — the payload's `session_key` (which makes the
      // event id unique per session) means a restart re-emits harmlessly:
      // the same payload hashes to the same id, and event.createMany's
      // skipDuplicates drops it.
      const driverRows: RawRecord[] = ENTRY_LIST_2026.map((driver) => ({
        session_key: key,
        driver_number: driver.driver_number,
        full_name: driver.full_name,
        name_acronym: driver.name_acronym,
        team_name: driver.team_name,
        team_colour: driver.team_colour,
      }));
      await this.emitAndRecord("drivers", key, driverRows);
    }
  }

  /** One rotation step: fetch, normalize, enqueue. `null` when no session is active. */
  public async pollOnce(): Promise<PollResult | null> {
    if (this.sessionKey === null || this.session === null) return null;
    const nowMs = this.now();
    if (sessionExpired(this.session, nowMs)) {
      this.log(`rest: session ${this.sessionKey} left its live window; releasing`);
      this.session = null;
      this.sessionKey = null;
      return null;
    }

    const endpoint = POLL_ROTATION[this.rotationIndex % POLL_ROTATION.length]!;
    this.rotationIndex += 1;
    const url = buildPollUrl(endpoint, this.sessionKey, null);
    let rows: unknown;
    try {
      rows = await this.fetcher(url);
    } catch (error) {
      this.log(`rest: poll ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { endpoint, rows: 0, newRows: 0, malformed: 0 };
    }
    const rawRows = Array.isArray(rows) ? (rows as RawRecord[]) : [];
    const { newRows, malformed } = await this.emitAndRecord(endpoint, this.sessionKey, rawRows);
    this.log(`rest: poll endpoint=${endpoint} rows=${rawRows.length} new=${newRows} malformed=${malformed}`);
    return { endpoint, rows: rawRows.length, newRows, malformed };
  }

  /** Thin wrapper around the free `emitRows()` that also feeds the jsonl recorder's `onNewRows`, once per call, only when there's something new (same as before this was pulled out to be shared with the loader). */
  private async emitAndRecord(
    endpoint: string,
    sessionKey: number,
    rows: RawRecord[],
  ): Promise<{ newRows: number; malformed: number }> {
    const result = emitRows(this.normalizer, this.queue, endpoint, sessionKey, rows);
    if (result.payloads.length > 0) {
      await this.onNewRows?.(sessionKey, endpoint, result.payloads);
    }
    return { newRows: result.newRows, malformed: result.malformed };
  }

  /** Production loop: discovery while idle, rotation while a session is live. */
  public start(): void {
    this.running = true;
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      const tick = this.runOneTick();
      this.currentTick = tick;
      await tick;
      this.currentTick = null;
      if (!this.running) return;
      const delay = this.sessionKey === null ? this.discoveryIntervalMs : this.tickMs;
      this.timer = setTimeout(() => void loop(), delay);
    };
    this.timer = setTimeout(() => void loop(), 0);
  }

  private async runOneTick(): Promise<void> {
    try {
      if (this.sessionKey === null) {
        await this.discoverOnce();
      } else {
        await this.pollOnce();
      }
    } catch (error) {
      this.log(`rest: tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stops scheduling further ticks and resolves once any tick already
   * in-flight (awaiting the network) has finished — so its rows are in the
   * queue before the caller drains and exits (SIGTERM path in main.ts).
   */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.currentTick) await this.currentTick;
  }
}
