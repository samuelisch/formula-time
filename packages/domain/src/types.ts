export type RawRecord = Record<string, unknown>;

export type TimestampField = "date" | "date_start" | "lap_start";

/** One row of the `events` table as the fold sees it (HLD §4). The POC's NormalizedEvent is a structural superset. */
export interface RaceEvent {
  event_id: string;
  endpoint: string;
  source_time: string | null;
  payload: RawRecord;
}
