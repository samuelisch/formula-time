// Sessions upsert at discovery (issue deliverable 4). Ingest is the ONLY
// writer of `sessions` (ADR-0001 §1); it never touches `polls`/`votes`.

import type { SessionStatus } from "@formula-time/db";

import { totalLapsForCircuit } from "../circuits.js";
import type { RawRecord } from "../openf1/types.js";

/** The slice of the Prisma client the sessions upsert needs — real client or a fake. */
export interface SessionsDb {
  session: {
    upsert(args: {
      where: { sessionKey: bigint };
      create: SessionFields & { sessionKey: bigint };
      update: SessionFields;
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
}

// OpenF1 serves live data from 30 minutes before `date_start` to 30 minutes
// after `date_end` (../f1-live-events-poc/poc/ts/live_capture.ts LIVE_WINDOW_MS
// comment) — the same window discovery and expiry use to pick a live session.
const LIVE_WINDOW_MS = 30 * 60 * 1000;

export function computeSessionStatus(dateStart: Date, dateEnd: Date, nowMs: number): SessionStatus {
  const start = dateStart.getTime();
  const end = dateEnd.getTime();
  if (nowMs < start - LIVE_WINDOW_MS) return "upcoming";
  if (nowMs > end + LIVE_WINDOW_MS) return "finished";
  return "live";
}

function sessionKeyOf(raw: RawRecord): bigint {
  const value = raw["session_key"];
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  throw new Error("upsertSession: raw session has no session_key");
}

function stringField(raw: RawRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export function sessionFieldsFromRaw(raw: RawRecord, nowMs: number): SessionFields {
  const dateStart = new Date(String(raw["date_start"]));
  const dateEnd = new Date(String(raw["date_end"]));
  const circuitKey = Number(raw["circuit_key"] ?? 0);
  return {
    name: stringField(raw, "session_name", "session_type"),
    country: stringField(raw, "country_name"),
    circuitKey,
    dateStart,
    dateEnd,
    totalLaps: totalLapsForCircuit(circuitKey),
    status: computeSessionStatus(dateStart, dateEnd, nowMs),
  };
}

/**
 * Upserts the `sessions` row for a raw OpenF1 `sessions` record. `nowMs`
 * drives the `upcoming` / `live` / `finished` status (issue deliverable 4).
 */
export async function upsertSession(db: SessionsDb, raw: RawRecord, nowMs: number): Promise<void> {
  const sessionKey = sessionKeyOf(raw);
  const fields = sessionFieldsFromRaw(raw, nowMs);
  await db.session.upsert({
    where: { sessionKey },
    create: { sessionKey, ...fields },
    update: fields,
  });
}
