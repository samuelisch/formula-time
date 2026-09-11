// Typed in-memory EventSource fake for the projector seam
// (projector/event-source.ts's EventSource). `rows` is the same array
// reference handed to the factory, so a test can keep pushing new rows into
// it after the projector has already started folding.
import type { EventRow, EventSource } from "../projector/event-source.js";

export interface FakeEventSource extends EventSource {
  rows: EventRow[];
}

export function fakeEventSource(rows: EventRow[] = []): FakeEventSource {
  return {
    rows,
    async readAfter(_sessionKey, afterSeq, limit) {
      return rows
        .filter((row) => row.seq > afterSeq)
        .sort((a, b) => (a.seq < b.seq ? -1 : 1))
        .slice(0, limit);
    },
    async readWindow(_sessionKey, fromSeq, toSeq) {
      return rows.filter((row) => row.seq > fromSeq && row.seq <= toSeq);
    },
  };
}
