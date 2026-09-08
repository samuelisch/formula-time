import { describe, expect, test } from "vitest";

import { prismaEventSource, toRaceEvent, type EventRow } from "./event-source.js";

// Minimal fake standing in for the slice of PrismaClient this module touches.
function fakeDb(rows: EventRow[]) {
  const calls: Array<{ method: "readAfter" | "readWindow"; args: unknown }> = [];
  return {
    calls,
    event: {
      findMany: async (args: {
        where: { sessionKey: bigint; seq: { gt: bigint; lte?: bigint } };
        orderBy: { seq: "asc" };
        take?: number;
        select: unknown;
      }) => {
        calls.push({ method: args.take !== undefined ? "readAfter" : "readWindow", args });
        return rows.filter((row) => {
          const gt = row.seq > args.where.seq.gt;
          const lte = args.where.seq.lte === undefined || row.seq <= args.where.seq.lte;
          return gt && lte;
        });
      },
    },
  };
}

describe("prismaEventSource", () => {
  test("readAfter queries seq > afterSeq ordered ascending, limited", async () => {
    const rows: EventRow[] = [
      { seq: 1n, eventId: "a", endpoint: "position", sourceTime: null, payload: { driver_number: 1 } },
      { seq: 2n, eventId: "b", endpoint: "position", sourceTime: null, payload: { driver_number: 2 } },
    ];
    const db = fakeDb(rows);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source = prismaEventSource(db as any);

    const result = await source.readAfter(1n, 0n, 100);
    expect(result).toEqual(rows);
    expect(db.calls[0]?.method).toBe("readAfter");
  });

  test("readWindow queries fromSeq < seq <= toSeq", async () => {
    const rows: EventRow[] = [
      { seq: 5n, eventId: "a", endpoint: "position", sourceTime: null, payload: {} },
      { seq: 6n, eventId: "b", endpoint: "position", sourceTime: null, payload: {} },
      { seq: 7n, eventId: "c", endpoint: "position", sourceTime: null, payload: {} },
    ];
    const db = fakeDb(rows);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source = prismaEventSource(db as any);

    const result = await source.readWindow(1n, 5n, 6n);
    expect(result).toEqual([rows[1]]);
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
