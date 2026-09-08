// The REST lane (issue deliverable 2). Lifted from
// `../f1-live-events-poc/poc/ts/live_capture.ts` (`OPENF1_BASE`,
// `POLL_ROTATION`, `pickLiveSession`, `sessionExpired`, `buildPollUrl`,
// `Fetcher`, the polling-loop shape) and
// `../f1-live-events-poc/poc/live-recorder/recorder.ts` (discovery, the
// "poll the full endpoint every time, dedup by eventId" cadence — the live
// API rejects every date filter; apps/ingest/AGENTS.md). Does NOT lift
// `LiveRace` / `state_authority` / `session_registry`: ingest never folds.

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

export interface RestLaneOptions {
  fetcher?: Fetcher;
  year?: number;
  now?: () => number;
  /** Rotation cadence once a session is live. Default matches the POC: 2200ms. */
  tickMs?: number;
  /** Discovery cadence while no session is in its window. Issue: "every 60 s". */
  discoveryIntervalMs?: number;
  /** "again 5 min before `date_start`" (issue deliverable 2). */
  driversPreRaceLeadMs?: number;
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
}

export class RestLane {
  private readonly fetcher: Fetcher;
  private readonly year: number;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly driversPreRaceLeadMs: number;
  private readonly onSession: RestLaneOptions["onSession"];
  private readonly onSessionSelected: RestLaneOptions["onSessionSelected"];
  private readonly onNewRows: RestLaneOptions["onNewRows"];
  private readonly log: (line: string) => void;

  private normalizer = new LiveNormalizer();
  private session: RawRecord | null = null;
  private sessionKey: number | null = null;
  private rotationIndex = 0;
  private driversAtDiscoveryDone = false;
  private driversPreRaceDone = false;
  private readonly meetingEntryListFetched = new Set<number>();

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
    this.driversPreRaceLeadMs = opts.driversPreRaceLeadMs ?? 5 * 60 * 1000;
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
   * its ±30 min window"). Upserts every session it sees, fetches the Friday
   * entry list for any meeting whose first session has passed, and selects
   * the live session (if any) for the rotation.
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

    // Session selection first: it may reset the normalizer's dedup state for
    // a newly-selected session, and it does its own "at discovery" drivers
    // fetch. Running the Friday entry-list check after means a meeting whose
    // first session IS the one just selected doesn't double-fetch drivers.
    await this.ensureLiveSession(rows, nowMs, upserted);
    await this.fetchFridayEntryLists(rows, nowMs);

    return { sessionCount: rows.length, live: this.sessionKey !== null };
  }

  // "on discovery of a meeting whose first session has passed, drivers?meeting_key="
  // (PRD: polls open Friday). The rows are recorded against that first
  // session's session_key — the session that made the entry list available.
  private async fetchFridayEntryLists(sessions: RawRecord[], nowMs: number): Promise<void> {
    const firstByMeeting = new Map<number, RawRecord>();
    for (const row of sessions) {
      const meetingKey = Number(row["meeting_key"]);
      if (!Number.isFinite(meetingKey)) continue;
      const start = Date.parse(String(row["date_start"] ?? ""));
      if (Number.isNaN(start)) continue;
      const existing = firstByMeeting.get(meetingKey);
      if (!existing || start < Date.parse(String(existing["date_start"] ?? ""))) {
        firstByMeeting.set(meetingKey, row);
      }
    }
    for (const [meetingKey, firstSession] of firstByMeeting) {
      if (this.meetingEntryListFetched.has(meetingKey)) continue;
      const start = Date.parse(String(firstSession["date_start"] ?? ""));
      if (Number.isNaN(start) || nowMs < start) continue; // first session hasn't happened yet
      const sessionKeyForRows = Number(firstSession["session_key"]);
      if (!Number.isFinite(sessionKeyForRows)) continue;
      // Marked done only on success: a transient failure must retry on the
      // next discovery tick, not be skipped forever.
      const ok = await this.fetchDrivers(`${OPENF1_BASE}/drivers?meeting_key=${meetingKey}`, sessionKeyForRows);
      if (ok) this.meetingEntryListFetched.add(meetingKey);
    }
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
      this.driversAtDiscoveryDone = false;
      this.driversPreRaceDone = false;
      this.log(
        `rest: following session_key=${key} (${String(live["country_name"] ?? "?")})`,
      );
      // Once per newly-selected session — NOT on every discovery tick like
      // onSession (issue round 3: recorder.writeSession() was running from
      // onSession, re-stamping session.json for every session of the year
      // every 60s while nothing was live).
      await this.onSessionSelected?.(live, nowMs);
    }
    if (!this.driversAtDiscoveryDone) {
      // Marked done only on success: a transient failure must retry on the
      // next discovery tick, not be skipped forever.
      const ok = await this.fetchDrivers(`${OPENF1_BASE}/drivers?session_key=${key}`, key);
      if (ok) this.driversAtDiscoveryDone = true;
    }
  }

  /** "again 5 min before `date_start`" — call once per tick while a session is active. */
  public async maybeFetchPreRaceDrivers(): Promise<void> {
    if (this.sessionKey === null || this.session === null || this.driversPreRaceDone) return;
    const start = Date.parse(String(this.session["date_start"] ?? ""));
    if (Number.isNaN(start)) return;
    if (this.now() >= start - this.driversPreRaceLeadMs) {
      // Marked done only on success: a transient failure must retry on the
      // next tick, not be skipped forever (same pattern as
      // driversAtDiscoveryDone / meetingEntryListFetched above).
      const ok = await this.fetchDrivers(`${OPENF1_BASE}/drivers?session_key=${this.sessionKey}`, this.sessionKey);
      if (ok) this.driversPreRaceDone = true;
    }
  }

  /** Returns whether the fetch succeeded, so callers only mark a "done" flag on success. */
  private async fetchDrivers(url: string, sessionKeyForRows: number): Promise<boolean> {
    let rows: unknown;
    try {
      rows = await this.fetcher(url);
    } catch (error) {
      this.log(`rest: drivers fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    await this.emitRows("drivers", sessionKeyForRows, Array.isArray(rows) ? (rows as RawRecord[]) : []);
    return true;
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
      return { endpoint, rows: 0, newRows: 0 };
    }
    const rawRows = Array.isArray(rows) ? (rows as RawRecord[]) : [];
    const newRows = await this.emitRows(endpoint, this.sessionKey, rawRows);
    this.log(`rest: poll endpoint=${endpoint} rows=${rawRows.length} new=${newRows}`);
    return { endpoint, rows: rawRows.length, newRows };
  }

  private async emitRows(endpoint: string, sessionKey: number, rows: RawRecord[]): Promise<number> {
    if (rows.length === 0) return 0;
    const normalized = this.normalizer.normalize(endpoint, rows);
    if (normalized.length === 0) return 0;
    const items: QueueItem[] = normalized.map((n) => ({
      eventId: n.eventId,
      sessionKey: BigInt(sessionKey),
      endpoint,
      sourceTime: n.sourceTime ? new Date(n.sourceTime) : null,
      payload: n.payload,
    }));
    this.queue.pushAll(items);
    await this.onNewRows?.(
      sessionKey,
      endpoint,
      normalized.map((n) => n.payload),
    );
    return normalized.length;
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
        await this.maybeFetchPreRaceDrivers();
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
