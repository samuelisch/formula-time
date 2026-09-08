// Shared shapes for the OpenF1 REST lane. Kept transport-independent on
// purpose: MQTT (T6) will produce the same `RawRecord`/`Fetcher` shapes so
// both lanes can feed the same normalizer and the same queue.

/** One row as OpenF1 (or a recorded capture) hands it back: no fixed schema. */
export type RawRecord = Record<string, unknown>;

/**
 * `type Fetcher = (url: string) => Promise<unknown>` (ADR-0001 §4, unchanged
 * from the POC) — the seam a Postgres/file fetcher answers the same virtual
 * URLs the live network fetcher does.
 */
export type Fetcher = (url: string) => Promise<unknown>;

/** A normalized row, ready for the writer queue and `event.createMany`. */
export type QueueItem = {
  eventId: string;
  sessionKey: bigint;
  endpoint: string;
  sourceTime: Date | null;
  payload: RawRecord;
};
