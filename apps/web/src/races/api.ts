// The historical-race routes (ADR-0009 §4): `GET /api/races` and
// `GET /api/races/:session_key`, verbatim from the seam contract pasted
// into issue #57. `RaceIndexEntry` is exactly the index route's response
// shape (apps/api/src/routes/races.ts `RaceIndexEntry`) -- never copy it
// elsewhere, import from here.
import { apiFetch } from "../api.ts";

export interface RaceIndexEntry {
  session_key: number;
  name: string;
  country: string;
  date_start: string;
  date_end: string;
  total_laps: number | null;
  exported_at: string;
}

/** `GET /api/races`, sorted by `date_start` descending (server-side, as served). */
export async function fetchRaceIndex(): Promise<RaceIndexEntry[]> {
  const response = await apiFetch("/api/races");
  if (!response.ok) {
    throw new Error(`GET /api/races failed: ${response.status}`);
  }
  return (await response.json()) as RaceIndexEntry[];
}
