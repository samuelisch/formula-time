// Formatting helpers shared by board and races components. Values arrive
// typed loosely (RawRecord fields are `unknown`) so these accept `unknown`
// and fall back rather than throw -- the POC's `text`/`number`/`formatClock`
// (app.js), lifted for the typed board.
import type { Gap, RawRecord } from "@formula-time/domain";

import type { RaceIndexEntry } from "../races/api.ts";

/** Either shape a race's naming fields arrive in: the historical index
 * (`RaceIndexEntry`, typed fields) or a live/replay session (`RawRecord`,
 * fields read loosely). Both carry the same field names. */
type RaceLike = RawRecord | RaceIndexEntry;

/** `String(value)`, or `fallback` for null, undefined, and the empty string. */
export function text(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

/** A named field of a `RawRecord`, or null unless it is actually a string. */
export function stringField(record: RawRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** A named field of a `RawRecord`, or null unless it is actually a number. */
export function numberField(record: RawRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

/** Fixed-point formatting of a numeric value, or "—" for anything not a number. */
export function number(value: unknown, digits = 1): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

/** A lap or sector duration in seconds, as `SS.SSS` below 60s or `M:SS.SSS` at or above 60s; "—" for anything not a number. */
export function lapTime(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  if (value < 60) return value.toFixed(3);
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

/** A gap or interval to another car: "—" for null (the leader, a retired car), the lap-count string as-is (e.g. "+1 LAP"), or the seconds value to 3 decimals with an "s" suffix. Shared by the timing table row (DriverRow.tsx) and the driver panel (DriverPanel.tsx) so both render a lapped gap and neither appends "s" to a null value. */
export function gapText(value: Gap): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  return `${value.toFixed(3)}s`;
}

/** A duration in seconds as `SS.S` below 60s or `M:SS.S` at or above 60s, with no unit suffix past a minute; "—" for anything not a number. */
export function duration(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  if (value < 60) return `${value.toFixed(1)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** `L<lap> · <duration>`, or "—" for no pit stop. Shared by the timing table's "last pit" column (DriverRow.tsx) and the driver panel's pit-stop history (DriverPanel.tsx). */
export function pitStopText(pit: RawRecord | null): string {
  return pit === null ? "—" : `L${text(pit["lap_number"])} · ${duration(pit["pit_duration"])}`;
}

/** `HH:MM:SS UTC` from an ISO source time, or "—" when absent/unparseable. */
export function clock(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) return "—";
  return `${new Date(millis).toISOString().slice(11, 19)} UTC`;
}

/** `YYYY-MM-DD` from an ISO date, or "—" when absent/unparseable. */
export function date(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) return "—";
  return new Date(millis).toISOString().slice(0, 10);
}

/** A race's display title: `meeting_name` when present, else `"<country> · <name>"`.
 * Reads a `RaceIndexEntry` or a session `RawRecord` the same way, through `stringField`. */
export function raceTitle(session: RaceLike): string {
  const record = session as unknown as RawRecord;
  const meetingName = stringField(record, "meeting_name");
  if (meetingName !== null) return meetingName;
  return `${stringField(record, "country") ?? "—"} · ${stringField(record, "name") ?? "—"}`;
}

/** A race's display subtitle: `"<circuit_short_name> · <location> · <date>"`, dropping any missing or unparseable part. */
export function raceSubtitle(session: RaceLike): string {
  const record = session as unknown as RawRecord;
  const circuit = stringField(record, "circuit_short_name");
  const location = stringField(record, "location");
  const dateStart = stringField(record, "date_start");
  const formattedDate = dateStart === null || Number.isNaN(Date.parse(dateStart)) ? null : date(dateStart);
  return [circuit, location, formattedDate].filter((part): part is string => part !== null).join(" · ");
}

/** `races` without the entry whose `session_key` matches `sessionKey` -- so
 * a session can be disambiguated against every *other* race without ever
 * matching its own entry in the historical index (present within seconds
 * of a session finishing, even while it is still the current session). */
export function excludeSession(races: RaceIndexEntry[], sessionKey: string | number): RaceIndexEntry[] {
  const key = String(sessionKey);
  return races.filter((race) => String(race.session_key) !== key);
}

/** `raceTitle(session)`, with `" (<year>)"` appended only when some race in
 * `races` reads the same title -- so a session (current or historical)
 * that would otherwise share a display name with another race in the same
 * list still reads as distinct. Falls back to the plain title when there is
 * no `date_start` to take a year from. */
export function raceTitleDisambiguated(session: RaceLike, races: RaceIndexEntry[]): string {
  const title = raceTitle(session);
  const collides = races.some((race) => raceTitle(race) === title);
  if (!collides) return title;

  const dateStart = stringField(session as unknown as RawRecord, "date_start");
  if (dateStart === null || Number.isNaN(Date.parse(dateStart))) return title;
  const year = new Date(dateStart).getUTCFullYear();
  return `${title} (${year})`;
}
