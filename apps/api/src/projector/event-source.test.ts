import { describe, expect, test } from "vitest";

import { fakeEventsDb } from "../test/fake-events-db.js";
import { prismaEventSource, toRaceEvent, type EventRow } from "./event-source.js";

describe("prismaEventSource", () => {
  test("readAfter queries seq > afterSeq ordered ascending, limited", async () => {
    const rows: EventRow[] = [
      { seq: 1n, eventId: "a", endpoint: "position", sourceTime: null, payload: { driver_number: 1 } },
      { seq: 2n, eventId: "b", endpoint: "position", sourceTime: null, payload: { driver_number: 2 } },
    ];
    const db = fakeEventsDb(rows);
    const source = prismaEventSource(db);

    const result = await source.readAfter(1n, 0n, 100);
    expect(result).toEqual(rows);
    expect(db.calls[0]?.method).toBe("readAfter");
    const readAfterArgs = db.calls[0]?.args as { where: { sessionKey: bigint } };
    expect(readAfterArgs.where.sessionKey).toBe(1n);
  });

  test("readWindow queries fromSeq < seq <= toSeq", async () => {
    const rows: EventRow[] = [
      { seq: 5n, eventId: "a", endpoint: "position", sourceTime: null, payload: {} },
      { seq: 6n, eventId: "b", endpoint: "position", sourceTime: null, payload: {} },
      { seq: 7n, eventId: "c", endpoint: "position", sourceTime: null, payload: {} },
    ];
    const db = fakeEventsDb(rows);
    const source = prismaEventSource(db);

    const result = await source.readWindow(1n, 5n, 6n);
    expect(result).toEqual([rows[1]]);
    expect(db.calls[0]?.method).toBe("readWindow");
    const readWindowArgs = db.calls[0]?.args as { where: { sessionKey: bigint } };
    expect(readWindowArgs.where.sessionKey).toBe(1n);
  });
});

describe("toRaceEvent", () => {
  test("converts sourceTime to an ISO string, or null", () => {
    const withDate = toRaceEvent({
      seq: 1n,
      eventId: "a",
      endpoint: "position",
      sourceTime: new Date("2026-09-06T12:06:43.906Z"),
      payload: { driver_number: 1 },
    });
    expect(withDate).toEqual({
      event_id: "a",
      endpoint: "position",
      source_time: "2026-09-06T12:06:43.906Z",
      payload: { driver_number: 1 },
    });

    const withoutDate = toRaceEvent({
      seq: 2n,
      eventId: "b",
      endpoint: "drivers",
      sourceTime: null,
      payload: {},
    });
    expect(withoutDate.source_time).toBeNull();
  });
});
