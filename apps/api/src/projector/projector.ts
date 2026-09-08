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
import { createInitialState, RaceStateReducer, type RaceState, type RawRecord } from "@formula-time/domain";

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

export type ProjectorSubscriber = (state: RaceState, cursor: bigint) => void;

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
    this.scheduleTick(0);
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

  private scheduleTick(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      // Never overlapping ticks: chain onto the previous tick's promise
      // rather than firing a concurrent one if a tick somehow outran its
      // own interval.
      this.tickChain = this.tickChain.then(() => this.tick());
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.tickCount += 1;
    if (!this.caughtUp) {
      this.foldStartedAt = Date.now();
    }

    if (this.tickCount % this.detectorEveryTicks === 0) {
      await this.runDetector();
      if (this.stopped) {
        return;
      }
    }

    let totalApplied = 0;
    let rows: EventRow[];
    do {
      rows = await this.source.readAfter(this.session.sessionKey, this.cursor, this.batchLimit);
      if (this.stopped) {
        return;
      }
      for (const row of rows) {
        this.applyRow(row);
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
      this.publish();
    }

    this.scheduleTick(this.tickMs);
  }

  private applyRow(row: EventRow): void {
    this.reducer.apply(toRaceEvent(row));
    this.appliedIds.add(row.eventId);
    this.cursor = row.seq;
  }

  private publish(): void {
    const state = this.reducer.snapshot();
    for (const fn of this.subscribers) {
      fn(state, this.cursor);
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

    // Never patch in place (HLD §7 "Fold"): throw the state away and re-fold.
    this.reducer = this.freshReducer();
    this.cursor = 0n;
    this.appliedIds = new Set<string>();
    this.caughtUp = false;
    this.foldStartedAt = Date.now();
  }
}
