// The authority (ADR-0001 §1, HLD §7): folds `events` for one live session
// into one RaceState. Exactly one instance runs per process.
//
// Why the late-commit detector exists: `seq` is assigned at insert but a row
// is visible only at commit, so with two writer connections seq 101 can be
// visible before seq 100; a cursor that has passed 101 never reads 100.
// Ingest uses one connection (`createDb(url, { max: 1 })`, ADR-0005) so seq
// order equals commit order; the detector is an alarm that should never
// fire. When it does, the fold is thrown away and rebuilt from cursor 0 --
// never patched in place (HLD §7 "Fold").
import type { Session } from "@formula-time/db";
import {
  createInitialState,
  RaceStateReducer,
  type RaceEvent,
  type RaceState,
  type RawRecord,
} from "@formula-time/domain";

import { toRaceEvent, type EventRow, type EventSource } from "./event-source.js";

export type ProjectorLog = (msg: string, fields?: Record<string, unknown>) => void;

export interface ProjectorOptions {
  source: EventSource;
  session: Session;
  /** Poll interval, ms. Default 250 (HLD §7 "Cursor"). */
  tickMs?: number;
  /** Rows per readAfter call. A full batch means "more to read" (no publish yet). */
  batchLimit?: number;
  /** Run the late-commit detector every Nth tick. */
  detectorEveryTicks?: number;
  /** How far behind the cursor the detector's window looks. */
  detectorWindow?: bigint;
  log: ProjectorLog;
}

// Issue #114: `events` is the `RaceEvent` rows this tick applied, in seq
// order -- `[]` on a tick that applied nothing new (or the startup tick).
// `rebuilt` is true only on the tick where the late-commit detector's
// rebuild lands (runDetector's success path): the fold is correct but the
// rows it re-folded are not "new events" to append to a client's timeline,
// so it publishes `events: [], rebuilt: true` and the client must discard
// its timeline and backfill from the paged log route instead.
export type ProjectorSubscriber = (
  state: RaceState,
  cursor: bigint,
  events: RaceEvent[],
  rebuilt: boolean,
) => void;

const DEFAULT_TICK_MS = 250;
const DEFAULT_BATCH_LIMIT = 5000;
const DEFAULT_DETECTOR_EVERY_TICKS = 40;
const DEFAULT_DETECTOR_WINDOW = 2000n;

function sessionAsRawRecord(session: Session): RawRecord {
  // BigInt does not survive JSON.stringify (the fan-out's one-serialize-per-push
  // rule): session_key travels as a string, same as everywhere else this
  // service puts a bigint on the wire (main.ts's push, this file's logging).
  return {
    session_key: session.sessionKey.toString(),
    name: session.name,
    country: session.country,
    circuit_key: session.circuitKey,
    date_start: session.dateStart.toISOString(),
    date_end: session.dateEnd.toISOString(),
    total_laps: session.totalLaps,
    status: session.status,
  };
}

export class RaceStateProjector {
  private readonly source: EventSource;
  private readonly session: Session;
  private readonly tickMs: number;
  private readonly batchLimit: number;
  private readonly detectorEveryTicks: number;
  private readonly detectorWindow: bigint;
  private readonly log: ProjectorLog;

  private reducer: RaceStateReducer;
  private cursor = 0n;
  private caughtUp = false;
  private appliedIds = new Set<string>();
  private readonly subscribers = new Set<ProjectorSubscriber>();

  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickCount = 0;
  private foldStartedAt = 0;
  private tickChain: Promise<void> = Promise.resolve();

  // Bumped on every start(): a tick mid-await when stop() runs doesn't stop
  // being mid-await -- `stopped` alone flips back to false on a later
  // start(), so that stale tick would resume, see itself as "running"
  // again, and call scheduleTick(), leaving two independent timer chains
  // ticking in parallel. Each scheduled tick captures the generation it
  // was scheduled under and bails if it no longer matches the current one.
  private generation = 0;

  public constructor(opts: ProjectorOptions) {
    this.source = opts.source;
    this.session = opts.session;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.detectorEveryTicks = opts.detectorEveryTicks ?? DEFAULT_DETECTOR_EVERY_TICKS;
    this.detectorWindow = opts.detectorWindow ?? DEFAULT_DETECTOR_WINDOW;
    this.log = opts.log;
    this.reducer = this.freshReducer();
  }

  private freshReducer(): RaceStateReducer {
    return new RaceStateReducer(
      createInitialState({ sessions: [sessionAsRawRecord(this.session)], drivers: [] }),
    );
  }

  public start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.generation += 1;
    this.scheduleTick(0, this.generation);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public subscribe(fn: ProjectorSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  public snapshot(): RaceState {
    return this.reducer.snapshot();
  }

  public status(): { sessionKey: bigint; cursor: bigint; caughtUp: boolean } {
    return { sessionKey: this.session.sessionKey, cursor: this.cursor, caughtUp: this.caughtUp };
  }

  private scheduleTick(delayMs: number, generation: number): void {
    if (this.stopped || generation !== this.generation) {
      return;
    }
    this.timer = setTimeout(() => {
      // Never overlapping ticks: chain onto the previous tick's promise
      // rather than firing a concurrent one if a tick somehow outran its
      // own interval.
      this.tickChain = this.tickChain.then(() => this.tick(generation));
    }, delayMs);
  }

  private async tick(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) {
      return;
    }

    this.tickCount += 1;
    if (!this.caughtUp) {
      this.foldStartedAt = Date.now();
    }

    // A rejected read (Postgres restart, network blip) must not stall the
    // tick chain forever or crash the process: scheduleTick chains ticks
    // with `.then()` and no `.catch()`, so an uncaught rejection here would
    // leave every future tick unscheduled. Catch, log, and retry on the
    // normal schedule instead -- cursor and state are left exactly as they
    // were before this tick (readAfter/readWindow reject before any row of
    // that call is applied).
    try {
      if (this.tickCount % this.detectorEveryTicks === 0) {
        await this.runDetector();
        if (this.stopped || generation !== this.generation) {
          return;
        }
      }

      let totalApplied = 0;
      let rows: EventRow[];
      const appliedThisTick: EventRow[] = [];
      do {
        rows = await this.source.readAfter(this.session.sessionKey, this.cursor, this.batchLimit);
        if (this.stopped || generation !== this.generation) {
          return;
        }
        for (const row of rows) {
          this.applyRow(row);
          appliedThisTick.push(row);
          totalApplied += 1;
        }
      } while (rows.length === this.batchLimit);

      const justCaughtUp = !this.caughtUp;
      if (justCaughtUp) {
        this.caughtUp = true;
        this.log("fold complete", {
          rows: totalApplied,
          ms: Date.now() - this.foldStartedAt,
          cursor: this.cursor.toString(),
        });
      }

      if (totalApplied > 0 || justCaughtUp) {
        this.publish(appliedThisTick.map(toRaceEvent));
      }
    } catch (err) {
      this.log("projector tick failed", {
        level: "error",
        error: err instanceof Error ? err.message : String(err),
        cursor: this.cursor.toString(),
      });
    }

    this.scheduleTick(this.tickMs, generation);
  }

  private applyRow(row: EventRow): void {
    this.reducer.apply(toRaceEvent(row));
    this.appliedIds.add(row.eventId);
    this.cursor = row.seq;
  }

  private publish(events: RaceEvent[], rebuilt = false): void {
    const state = this.reducer.snapshot();
    for (const fn of this.subscribers) {
      fn(state, this.cursor, events, rebuilt);
    }
  }

  private async runDetector(): Promise<void> {
    const from = this.cursor > this.detectorWindow ? this.cursor - this.detectorWindow : 0n;
    const window = await this.source.readWindow(this.session.sessionKey, from, this.cursor);
    const lateRow = window.find((row) => !this.appliedIds.has(row.eventId));
    if (lateRow === undefined) {
      return;
    }

    this.log("late commit detected", {
      level: "error",
      seq: lateRow.seq.toString(),
      event_id: lateRow.eventId,
      cursor: this.cursor.toString(),
    });

    // Never patch in place (HLD §7 "Fold"): re-fold into locals and swap
    // them into `this.*` only once the rebuild is fully caught up.
    // Resetting `this.*` up front (the old approach) meant a rejected read
    // on the very next line left snapshot()/status() serving an empty
    // state at cursor 0 until a later tick finished the fold -- every live
    // join in between would get that empty state rather than the
    // last-known-good one. Keep serving the old state until the rebuild
    // proves it can finish; a failed rebuild just retries on the next
    // detector pass, since `appliedIds`/`cursor` are left untouched and the
    // same late row is found again.
    const localReducer = this.freshReducer();
    let localCursor = 0n;
    const localAppliedIds = new Set<string>();

    try {
      let rows: EventRow[];
      do {
        rows = await this.source.readAfter(this.session.sessionKey, localCursor, this.batchLimit);
        for (const row of rows) {
          localReducer.apply(toRaceEvent(row));
          localAppliedIds.add(row.eventId);
          localCursor = row.seq;
        }
      } while (rows.length === this.batchLimit);
    } catch (err) {
      this.log("rebuild failed, keeping previous state", {
        level: "error",
        error: err instanceof Error ? err.message : String(err),
        cursor: this.cursor.toString(),
      });
      return;
    }

    this.reducer = localReducer;
    this.cursor = localCursor;
    this.appliedIds = localAppliedIds;
    // Issue #114: a rebuild re-folds rows already accounted for (plus the
    // late one) -- not new events for a client's timeline to append. Push
    // `events: [], rebuilt: true` so the client discards its timeline and
    // backfills from the paged log route instead of trying to reconcile it.
    this.publish([], true);
  }
}
