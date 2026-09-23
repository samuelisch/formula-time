// The one path every row takes into the queue — for both lanes (REST,
// MQTT) and both loaders (`load-recording.ts`, `fetch-race.ts`). The
// moment a row is queued is the moment it is recorded: `RecordRows` fires
// with exactly the rows a call to `enqueueRows`/`enqueueDriverRows` just
// queued.

import { LiveNormalizer } from "./normalize.js";
import type { QueueItem, RawRecord } from "./types.js";
import type { EventQueue } from "../writer/queue.js";

export interface EnqueueRowsResult {
  newRows: number;
  malformed: number;
  /** `stints` rows normalized with a null `sourceTime` because their lap hadn't been seen yet — an out-of-order stint (`LiveNormalizer.normalize`'s `unjoined`). */
  unjoined: number;
  /** The normalized (already-deduped-against-`normalizer`) payloads, same ones handed to `onRecorded`. */
  payloads: RawRecord[];
}

/**
 * Called with exactly the rows an `enqueueRows`/`enqueueDriverRows` call
 * just queued (never zero) — see README: The pipeline (jsonl recording).
 * A rejection must not escape uncaught: the caller (a lane) catches its
 * own recorder failure and logs it; the row stays queued either way.
 */
export type RecordRows = (sessionKey: number, endpoint: string, payloads: RawRecord[]) => Promise<void>;

/**
 * The one normalize-and-enqueue-and-record path, so ids match across
 * lanes and every row is recorded when it's queued. `RestLane`, the MQTT
 * lane, and the one-shot recording loader all drive it — see README:
 * The pipeline.
 */
export async function enqueueRows(
  normalizer: LiveNormalizer,
  queue: EventQueue<QueueItem>,
  endpoint: string,
  sessionKey: number,
  rows: RawRecord[],
  onRecorded?: RecordRows,
): Promise<EnqueueRowsResult> {
  if (rows.length === 0) return { newRows: 0, malformed: 0, unjoined: 0, payloads: [] };
  const { rows: normalized, malformed, unjoined } = normalizer.normalize(endpoint, rows);
  if (normalized.length === 0) return { newRows: 0, malformed, unjoined, payloads: [] };
  const items: QueueItem[] = normalized.map((n) => ({
    eventId: n.eventId,
    sessionKey: BigInt(sessionKey),
    endpoint,
    sourceTime: n.sourceTime ? new Date(n.sourceTime) : null,
    payload: n.payload,
  }));
  queue.pushAll(items);
  const payloads = normalized.map((n) => n.payload);
  if (onRecorded) await onRecorded(sessionKey, endpoint, payloads);
  return { newRows: normalized.length, malformed, unjoined, payloads };
}

export interface EnqueueDriverRowsResult {
  newRows: number;
  malformed: number;
  /** See `EnqueueRowsResult.unjoined` — always 0 here, `drivers` rows never carry a `stints` timestamp, kept for shape consistency with `enqueueRows`. */
  unjoined: number;
  /** Rows whose OWN `session_key` differs from `expectedSessionKey` — still written, tagged to the session they name, and counted as `foreign`. `null` `expectedSessionKey` (the Friday meeting-wide fetch has no single session to compare against) counts nothing as foreign. */
  foreign: number;
  /** Rows naming a `session_key` that is not in the `sessions` table (per `isKnownSession`): dropped, never queued. `events.session_key` is a real FK, and one such row would fail the writer's whole batch and requeue it forever. */
  unknownSession: number;
  payloads: RawRecord[];
  /** The written payloads per session_key, so a caller can feed the jsonl recorder once per session. */
  groups: Array<{ sessionKey: number; payloads: RawRecord[] }>;
}

/**
 * Tags each `drivers` row to the `session_key` in its own payload, never
 * to the session the fetch targeted. See README: The entry list.
 */
export async function enqueueDriverRows(
  normalizer: LiveNormalizer,
  queue: EventQueue<QueueItem>,
  rows: RawRecord[],
  expectedSessionKey: number | null,
  isKnownSession: (sessionKey: number) => boolean = () => true,
  onRecorded?: RecordRows,
): Promise<EnqueueDriverRowsResult> {
  const byKey = new Map<number, RawRecord[]>();
  let foreign = 0;
  let malformed = 0;
  let unknownSession = 0;
  for (const row of rows) {
    const key = Number(row["session_key"]);
    if (!Number.isFinite(key)) {
      malformed += 1;
      continue;
    }
    if (!isKnownSession(key)) {
      unknownSession += 1;
      continue;
    }
    if (expectedSessionKey !== null && key !== expectedSessionKey) foreign += 1;
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  let newRows = 0;
  let unjoined = 0;
  const payloads: RawRecord[] = [];
  const groups: EnqueueDriverRowsResult["groups"] = [];
  for (const [key, groupRows] of byKey) {
    const result = await enqueueRows(normalizer, queue, "drivers", key, groupRows, onRecorded);
    newRows += result.newRows;
    malformed += result.malformed;
    unjoined += result.unjoined;
    payloads.push(...result.payloads);
    if (result.payloads.length > 0) groups.push({ sessionKey: key, payloads: result.payloads });
  }
  return { newRows, malformed, unjoined, foreign, unknownSession, payloads, groups };
}
