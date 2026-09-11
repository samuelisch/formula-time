// The Postgres read seam for the projector. The projector never issues a raw
// query itself — it only ever calls this interface, so a fake in-memory
// implementation is enough to unit test the fold.
import type { RaceEvent, RawRecord } from "@formula-time/domain";

export interface EventRow {
  seq: bigint;
  eventId: string;
  endpoint: string;
  sourceTime: Date | null;
  payload: unknown;
}

export interface EventSource {
  /** rows WHERE session_key = sessionKey AND seq > afterSeq ORDER BY seq ASC LIMIT limit */
  readAfter(sessionKey: bigint, afterSeq: bigint, limit: number): Promise<EventRow[]>;
  /** rows WHERE session_key = sessionKey AND seq > fromSeq AND seq <= toSeq ORDER BY seq ASC */
  readWindow(sessionKey: bigint, fromSeq: bigint, toSeq: bigint): Promise<EventRow[]>;
}

/** The slice of `PrismaClient` `prismaEventSource` actually calls -- narrower
 * than the full client so a test can hand it a plain in-memory fake instead
 * of a live database. */
export interface EventsDb {
  event: {
    findMany(args: {
      where: { sessionKey: bigint; seq: { gt: bigint; lte?: bigint } };
      orderBy: { seq: "asc" };
      take?: number;
      select: { seq: true; eventId: true; endpoint: true; sourceTime: true; payload: true };
    }): Promise<EventRow[]>;
  };
}

export function prismaEventSource(db: EventsDb): EventSource {
  return {
    async readAfter(sessionKey, afterSeq, limit) {
      return db.event.findMany({
        where: { sessionKey, seq: { gt: afterSeq } },
        orderBy: { seq: "asc" },
        take: limit,
        select: { seq: true, eventId: true, endpoint: true, sourceTime: true, payload: true },
      });
    },
    async readWindow(sessionKey, fromSeq, toSeq) {
      return db.event.findMany({
        where: { sessionKey, seq: { gt: fromSeq, lte: toSeq } },
        orderBy: { seq: "asc" },
        select: { seq: true, eventId: true, endpoint: true, sourceTime: true, payload: true },
      });
    },
  };
}

/** `source_time = sourceTime?.toISOString() ?? null` (brief): the fold's RaceEvent shape. */
export function toRaceEvent(row: EventRow): RaceEvent {
  return {
    event_id: row.eventId,
    endpoint: row.endpoint,
    source_time: row.sourceTime?.toISOString() ?? null,
    payload: row.payload as RawRecord,
  };
}
