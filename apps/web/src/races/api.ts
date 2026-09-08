// The historical-race routes (ADR-0009 §4): `GET /api/races` and
// `GET /api/races/:session_key`, verbatim from the seam contract pasted
// into issue #57. `RaceIndexEntry` is exactly the index route's response
// shape (apps/api/src/routes/races.ts `RaceIndexEntry`) -- never copy it
// elsewhere, import from here.
import type { RaceEvent, RawRecord } from "@formula-time/domain";

import { apiFetch } from "../api.ts";
import type { PollPublic } from "../live/types.ts";

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

/** The file body, verbatim from ADR-0009 §4 (`apps/api/src/export/exporter.ts` `ExportDoc`). */
export interface RaceFile {
  schema: 1;
  exported_at: string;
  session: RawRecord;
  events: RaceEvent[];
}

/**
 * `GET /api/races/:session_key`. The response is gzip-encoded (`content-encoding: gzip`);
 * `fetch` decodes it transparently, so this reads a plain JSON body. Throws
 * on a 404 (no export for this session) or any other non-2xx status.
 */
export async function fetchRaceFile(sessionKey: number): Promise<RaceFile> {
  const response = await apiFetch(`/api/races/${sessionKey}`);
  if (!response.ok) {
    throw new Error(`GET /api/races/${sessionKey} failed: ${response.status}`);
  }
  return (await response.json()) as RaceFile;
}

/**
 * `GET /api/races/:session_key/polls` (issue #80/#79). `PollPublic[]`, `[]`
 * when the race has no polls -- unlike `fetchRaceFile` this never 404s for
 * "no polls", so a non-2xx here is a real failure.
 */
export async function fetchRacePolls(sessionKey: string): Promise<PollPublic[]> {
  const response = await apiFetch(`/api/races/${sessionKey}/polls`);
  if (!response.ok) {
    throw new Error(`GET /api/races/${sessionKey}/polls failed: ${response.status}`);
  }
  return (await response.json()) as PollPublic[];
}
