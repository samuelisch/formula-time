// Sessions upsert at discovery. Ingest is the ONLY
// writer of `sessions` (ADR-0001 §1); it never touches `polls`/`votes`.

import type { SessionStatus } from "@formula-time/db";

import { totalLapsForCircuit } from "../circuits.js";
import type { RawRecord } from "../openf1/types.js";

/**
 * The naming columns as `update` sees them: `undefined` (as opposed to
 * `null`) tells Prisma to leave that column untouched — see
 * `updateFieldsPreservingNaming`'s doc comment for why `update` needs a
 * different type here than `create`.
 */
interface NamingFieldsForUpdate {
  meetingName?: string | null;
  circuitShortName?: string | null;
  location?: string | null;
}

/** The slice of the Prisma client the sessions upsert needs — real client or a fake. */
export interface SessionsDb {
  session: {
    upsert(args: {
      where: { sessionKey: bigint };
      create: SessionFields & { sessionKey: bigint };
      update: Omit<SessionFields, keyof NamingFieldsForUpdate> & NamingFieldsForUpdate;
    }): Promise<unknown>;
  };
}

interface SessionFields {
  name: string;
  country: string;
  circuitKey: number;
  dateStart: Date;
  dateEnd: Date;
  totalLaps: number | null;
  status: SessionStatus;
  meetingName: string | null;
  circuitShortName: string | null;
  location: string | null;
}

// OpenF1 serves live data from 30 minutes before `date_start` to 30 minutes
// after `date_end` (../f1-live-events-poc/poc/ts/live_capture.ts LIVE_WINDOW_MS
// comment) — the same window discovery and expiry use to pick a live session.
const LIVE_WINDOW_MS = 30 * 60 * 1000;

// Only race sessions are captured: practice, qualifying and sprint are
// scrubbed off. A sprint carries `session_type: "Race"` but
// `session_name: "Sprint"`, so the filter is on `session_name`, exact and
// case-sensitive, matching OpenF1's own value.
export function isRaceSession(raw: RawRecord): boolean {
  return raw["session_name"] === "Race";
}

export function computeSessionStatus(dateStart: Date, dateEnd: Date, nowMs: number): SessionStatus {
  const start = dateStart.getTime();
  const end = dateEnd.getTime();
  // Defense in depth: sessionFieldsFromRaw() validates both dates before
  // this ever runs, so NaN here should be unreachable — but comparisons
  // against NaN are always false in JS, which would otherwise fall through
  // to "live" for malformed input. "upcoming" is the safe default instead.
  if (Number.isNaN(start) || Number.isNaN(end)) return "upcoming";
  if (nowMs < start - LIVE_WINDOW_MS) return "upcoming";
  if (nowMs > end + LIVE_WINDOW_MS) return "finished";
  return "live";
}

function sessionKeyOf(raw: RawRecord): bigint {
  const value = raw["session_key"];
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("upsertSession: raw session has no session_key");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`upsertSession: session_key is not finite: ${value}`);
  }
  try {
    return BigInt(value);
  } catch (error) {
    // BigInt() throws SyntaxError for a non-integer-looking string and
    // RangeError for a non-integer number (e.g. 11361.5) — both mean the
    // row is malformed, not that ingest is broken.
    throw new Error(
      `upsertSession: session_key is not a valid integer: ${JSON.stringify(value)} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

function stringField(raw: RawRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

// Same lookup as stringField, but `null` (not `""`) when absent — for the
// nullable naming columns, where "no value" and "empty string" must not
// collide.
function nullableStringField(raw: RawRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function validDate(raw: RawRecord, key: string): Date {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`upsertSession: missing ${key}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`upsertSession: invalid ${key}: ${JSON.stringify(value)}`);
  }
  return date;
}

/**
 * `meetingNames` joins on the raw row's own `meeting_key`: the session
 * row carries no Grand Prix name of its own. See README: Session upsert.
 */
export function sessionFieldsFromRaw(
  raw: RawRecord,
  nowMs: number,
  meetingNames: ReadonlyMap<number, string> = new Map(),
): SessionFields {
  const dateStart = validDate(raw, "date_start");
  const dateEnd = validDate(raw, "date_end");
  const circuitKey = Number(raw["circuit_key"] ?? 0);
  const meetingKey = Number(raw["meeting_key"]);
  return {
    name: stringField(raw, "session_name", "session_type"),
    country: stringField(raw, "country_name"),
    circuitKey,
    dateStart,
    dateEnd,
    totalLaps: totalLapsForCircuit(circuitKey),
    status: computeSessionStatus(dateStart, dateEnd, nowMs),
    meetingName: Number.isFinite(meetingKey) ? (meetingNames.get(meetingKey) ?? null) : null,
    circuitShortName: nullableStringField(raw, "circuit_short_name"),
    location: nullableStringField(raw, "location"),
  };
}

export interface UpsertSessionOptions {
  /**
   * Forces `status` instead of deriving it from `nowMs` and the live
   * window: the loader upserts a past recording as `finished` regardless
   * of what `computeSessionStatus` would compute. One `upsertSession`,
   * not a second function, carries the override.
   */
  status?: SessionStatus;
  /** Forwarded to `sessionFieldsFromRaw` — see its doc comment. */
  meetingNames?: ReadonlyMap<number, string>;
}

/**
 * A rerun must not blank out a naming column an earlier run already
 * found: omits it from the update object rather than nulling it, so
 * `update` leaves it untouched. See README: Session upsert.
 */
function updateFieldsPreservingNaming(
  fields: SessionFields,
): Omit<SessionFields, keyof NamingFieldsForUpdate> & NamingFieldsForUpdate {
  const { meetingName, circuitShortName, location, ...rest } = fields;
  return {
    ...rest,
    ...(meetingName !== null ? { meetingName } : {}),
    ...(circuitShortName !== null ? { circuitShortName } : {}),
    ...(location !== null ? { location } : {}),
  };
}

/**
 * Upserts the `sessions` row for a raw OpenF1 `sessions` record; `nowMs`
 * drives `upcoming`/`live`/`finished` unless `opts.status` overrides it.
 * Validates first, so a malformed row throws before any write and the
 * caller can skip just that row. See README: Session upsert.
 */
export async function upsertSession(
  db: SessionsDb,
  raw: RawRecord,
  nowMs: number,
  opts: UpsertSessionOptions = {},
): Promise<void> {
  const sessionKey = sessionKeyOf(raw);
  const fields = sessionFieldsFromRaw(raw, nowMs, opts.meetingNames);
  if (opts.status) fields.status = opts.status;
  await db.session.upsert({
    where: { sessionKey },
    create: { sessionKey, ...fields },
    update: updateFieldsPreservingNaming(fields),
  });
}
