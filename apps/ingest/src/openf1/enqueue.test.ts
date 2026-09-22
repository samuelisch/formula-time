import { describe, expect, test } from "vitest";

import type { QueueItem, RawRecord } from "./types.js";
import { enqueueDriverRows } from "./enqueue.js";
import { LiveNormalizer } from "./normalize.js";
import { EventQueue } from "../writer/queue.js";

// The fetched entry list, replacing the static ENTRY_LIST_2026
// fallback. Verified: every OpenF1 `drivers` row carries
// its own `session_key` and `meeting_key`, e.g.
// `{"meeting_key":1293,"session_key":11361,"driver_number":1,...}`
// (recordings/11361/raw/drivers.jsonl) — so a row is tagged by the
// `session_key` in ITS OWN payload, never by the session/meeting the fetch
// was made for.
describe("enqueueDriverRows", () => {
  test("tags each row by its own session_key; a row naming a different session is still written and counted foreign", async () => {
    const normalizer = new LiveNormalizer();
    const queue = new EventQueue<QueueItem>();
    const rows: RawRecord[] = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 11362, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
    ];

    const result = await enqueueDriverRows(normalizer, queue, rows, 11361);

    expect(result.newRows).toBe(2);
    expect(result.foreign).toBe(1); // the 11362 row named a different session than expected
    const items = queue.drain(10);
    expect(new Set(items.map((i) => i.sessionKey))).toEqual(new Set([11361n, 11362n]));
    expect(items.every((i) => i.endpoint === "drivers")).toBe(true);
  });

  test("a row with no numeric session_key of its own can't be tagged or written; counted malformed", async () => {
    const normalizer = new LiveNormalizer();
    const queue = new EventQueue<QueueItem>();
    const rows: RawRecord[] = [{ driver_number: 1, full_name: "No Session" }];

    const result = await enqueueDriverRows(normalizer, queue, rows, 11361);

    expect(result.malformed).toBe(1);
    expect(result.newRows).toBe(0);
    expect(queue.size).toBe(0);
  });

  test("a row naming a session isKnownSession rejects is dropped and counted unknownSession; groups carry the written payloads per session", async () => {
    const queue = new EventQueue<QueueItem>();
    const result = await enqueueDriverRows(
      new LiveNormalizer(),
      queue,
      [
        { session_key: 1, driver_number: 1 },
        { session_key: 2, driver_number: 2 },
      ],
      1,
      (key) => key === 1,
    );
    expect(result.unknownSession).toBe(1);
    expect(result.foreign).toBe(0);
    expect(result.newRows).toBe(1);
    expect(result.groups.map((g) => g.sessionKey)).toEqual([1]);
    expect(queue.drain(10).map((i) => i.sessionKey)).toEqual([1n]);
  });

  test("expectedSessionKey null (the Friday meeting-wide fetch) counts nothing as foreign", async () => {
    const normalizer = new LiveNormalizer();
    const queue = new EventQueue<QueueItem>();
    const rows: RawRecord[] = [
      { session_key: 11360, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
    ];

    const result = await enqueueDriverRows(normalizer, queue, rows, null);

    expect(result.foreign).toBe(0);
    expect(result.newRows).toBe(2);
  });

  test("onRecorded is called once per session_key group with that group's payloads", async () => {
    const normalizer = new LiveNormalizer();
    const queue = new EventQueue<QueueItem>();
    const rows: RawRecord[] = [
      { session_key: 11361, meeting_key: 1293, driver_number: 1, full_name: "Lando NORRIS" },
      { session_key: 11362, meeting_key: 1293, driver_number: 2, full_name: "Foreign Row" },
    ];
    const recorded: Array<[number, string, RawRecord[]]> = [];
    const onRecorded = async (sessionKey: number, endpoint: string, payloads: RawRecord[]): Promise<void> => {
      recorded.push([sessionKey, endpoint, payloads]);
    };

    await enqueueDriverRows(normalizer, queue, rows, 11361, () => true, onRecorded);

    expect(recorded).toHaveLength(2);
    expect(new Set(recorded.map((c) => c[0]))).toEqual(new Set([11361, 11362]));
    expect(recorded.every((c) => c[1] === "drivers")).toBe(true);
  });
});
