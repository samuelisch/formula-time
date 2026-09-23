// The historical-race routes (ADR-0009 §4): `GET /api/races` and
// `GET /api/races/:session_key`, verbatim from the seam contract.
// `RaceIndexEntry`, `RaceFile`, `SessionStatus` and `RaceEventsPage` are
// declared once in `packages/domain/src/wire.ts` -- never copy them,
// import from there. `fetchRaceEventsPage` is the paged event-log route,
// used by both a finished session's replay and a live session's timeline.
export type { RaceEventsPage, RaceFile, RaceIndexEntry, SessionStatus } from "@formula-time/domain";
import type { RaceEventsPage, RaceFile, RaceIndexEntry } from "@formula-time/domain";

import { apiFetch } from "../api.ts";
import type { PollPublic } from "../live/types.ts";

/** `GET path`; throws with `errorLabel` (default `path`) on any non-2xx status, else the parsed JSON body. */
async function fetchJson<T>(path: string, errorLabel: string = path): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) {
    throw new Error(`GET ${errorLabel} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** `GET /api/races`, sorted by `date_start` descending (server-side, as served). */
export async function fetchRaceIndex(): Promise<RaceIndexEntry[]> {
  return fetchJson<RaceIndexEntry[]>("/api/races");
}

/**
 * `GET /api/races/:session_key`. Gzip-encoded; throws on a 404 (no
 * export) or other non-2xx status. Served `cache-control: immutable`, so
 * `exportedAt` becomes a `v` query param that busts the cache.
 * See README: Data sources.
 */
export async function fetchRaceFile(sessionKey: number, exportedAt: string): Promise<RaceFile> {
  return fetchJson<RaceFile>(`/api/races/${sessionKey}?v=${Date.parse(exportedAt)}`);
}

/**
 * `GET /api/races/:session_key/polls`. `PollPublic[]`, `[]` when the race
 * has no polls -- unlike `fetchRaceFile` this never 404s for "no polls",
 * so a non-2xx here is a real failure.
 */
export async function fetchRacePolls(sessionKey: string): Promise<PollPublic[]> {
  return fetchJson<PollPublic[]>(`/api/races/${sessionKey}/polls`);
}

/**
 * `GET /api/races/:session_key/events?since_seq=&limit=`. Throws on any
 * non-2xx status (the caller decides how to retry/back off; this helper
 * makes a single request).
 */
export async function fetchRaceEventsPage(
  sessionKey: number,
  sinceSeq: number,
  limit: number,
): Promise<RaceEventsPage> {
  const path = `/api/races/${sessionKey}/events`;
  return fetchJson<RaceEventsPage>(`${path}?since_seq=${sinceSeq}&limit=${limit}`, path);
}
