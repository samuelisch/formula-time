// Formatting helpers shared by board and races components. Values arrive
// typed loosely (RawRecord fields are `unknown`) so these accept `unknown`
// and fall back rather than throw -- the POC's `text`/`number`/`formatClock`
// (app.js), lifted for the typed board.
import type { RawRecord } from "@formula-time/domain";

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

/** Fixed-point formatting of a numeric value, or "—" for anything not a number. */
export function number(value: unknown, digits = 1): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
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
