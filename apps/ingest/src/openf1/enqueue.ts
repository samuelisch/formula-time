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
 * Called with exactly the rows a call to `enqueueRows`/`enqueueDriverRows`
 * just queued (never with zero rows) — the one place both ingest lanes'
 * newly-queued rows reach the jsonl recorder, so a row is never queued
 * without an attempt to record it, and never recorded without having been
 * queued first. A rejection must not be allowed to escape uncaught: the
 * caller (a lane) is responsible for catching its own recorder failure,
 * logging it, and continuing — the row already queued stays queued either
 * way.
 */
export type RecordRows = (sessionKey: number, endpoint: string, payloads: RawRecord[]) => Promise<void>;

/**
 * The one normalize-and-enqueue-and-record path — so the ids match a live
 * run, and so a row is recorded at the moment it is queued, whichever lane
 * queued it first. Pushed out of `RestLane` so the MQTT lane
 * (`mqtt-lane.ts`'s `handleMessage`) and the one-shot recording loader
 * (`load-recording.ts`) can drive the same normalizer + queue a live
 * session does, both for the static `ENTRY_LIST_2026` `drivers` emission
 * and for every `raw/*.jsonl` endpoint. `RestLane` itself calls this too
 * (see `enqueueAndRecord` in rest-lane.ts) — no second normalize path, and
 * (since `onRecorded` lives here) no second recording path either.
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
 * Tags each `drivers` row to the `session_key` IN ITS OWN PAYLOAD, never to
 * the session or meeting the fetch was made for. Verified from
 * `recordings/11361/raw/drivers.jsonl`: every OpenF1 `drivers`
 * row carries its own `session_key` and `meeting_key` fields, e.g.
 * `{"meeting_key":1293,"session_key":11361,"driver_number":1,...}` — so the
 * tagging rule is: a drivers row is tagged to the `session_key` in its own
 * payload. Rows are grouped by that own key and each group runs through the
 * normal `enqueueRows` path (endpoint `drivers`), so dedup/malformed
 * handling stay identical to every other endpoint. A row with no numeric
 * `session_key` of its own can't be tagged or written; it's counted as
 * malformed, same meaning `enqueueRows`/`LiveNormalizer.normalize` give
 * that word elsewhere. A row naming a session that `isKnownSession` rejects
 * (not in the `sessions` table) is dropped and counted `unknownSession`:
 * the FK on `events.session_key` would fail the writer's whole batch, and
 * the writer requeues a failed batch at the front forever.
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
