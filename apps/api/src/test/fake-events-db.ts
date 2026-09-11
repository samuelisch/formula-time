// Typed fake for the projector's event-log read seam: an in-memory row
// list served through the same `EventsDb` interface
// (projector/event-source.ts) production code is narrowed to.
import type { EventRow, EventsDb } from "../projector/event-source.js";

export interface FakeEventsDb extends EventsDb {
  calls: Array<{ method: "readAfter" | "readWindow"; args: unknown }>;
}

export function fakeEventsDb(rows: EventRow[]): FakeEventsDb {
  const calls: FakeEventsDb["calls"] = [];
  return {
    calls,
    event: {
      async findMany(args) {
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
