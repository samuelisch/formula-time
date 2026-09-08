// GET /api/races, GET /api/races/:session_key -- the historical-race
// routes (ADR-0009 §4, issue #44 slice B). "Serving reads the file, not
// Postgres.": the index route is the one query per request this plugin
// makes against `exports`/`sessions`; the per-race route reads Postgres
// only to find the `exports` row (never to fold events), then streams the
// pre-gzipped file straight through -- "never gunzip on the server."
//
// "Disk is a cache, the database is the record." (ADR-0009 §3): when the
// row exists but the file is missing (Railway's disk is ephemeral), this
// route regenerates it once via the same `exportSession` the exporter's
// own tick uses, with the row's stored `exportedAt` so the embedded
// timestamp, the row, and the etag can never diverge.
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance, FastifyPluginCallback } from "fastify";

import type { PrismaClient } from "@formula-time/db";

import type { Exporter } from "../export/exporter.js";
import { prismaEventSource, toRaceEvent } from "../projector/event-source.js";

export interface RacesRoutesOptions {
  db: PrismaClient;
  exporter: Exporter;
  /** `EXPORT_DIR` (ADR-0009 §2) -- same directory the exporter writes to. */
  dir: string;
}

interface RaceIndexEntry {
  session_key: number;
  name: string;
  country: string;
  date_start: string;
  date_end: string;
  total_laps: number | null;
  exported_at: string;
}

const INTEGER = /^-?\d+$/;
const NON_NEGATIVE_INTEGER = /^\d+$/;

const DEFAULT_EVENTS_LIMIT = 5000;
const MAX_EVENTS_LIMIT = 5000;

interface EventsQuery {
  since_seq?: string;
  limit?: string;
}

/** `since_seq` (issue #96): default `0`, must be a non-negative integer
 * that fits in a JS number (the acceptance criterion `next_seq` also
 * relies on). `null` means the raw value failed validation. */
function parseSinceSeq(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!NON_NEGATIVE_INTEGER.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** `limit`: default and maximum `5000`, minimum `1`. */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_EVENTS_LIMIT;
  if (!NON_NEGATIVE_INTEGER.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_EVENTS_LIMIT) return null;
  return n;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function filePath(dir: string, sessionKey: bigint): string {
  return join(dir, `${sessionKey.toString()}.json.gz`);
}

/** Registered with `app.register(racesRoutes, { prefix: "/api", db, exporter, dir })`,
 * so the public paths are `/api/races` and `/api/races/:session_key`. */
export const racesRoutes: FastifyPluginCallback<RacesRoutesOptions> = (app: FastifyInstance, opts, done) => {
  const { db, exporter, dir } = opts;
  // Same seam the projector reads through (apps/api/src/projector/event-source.ts):
  // one `findMany` per page, `WHERE session_key = … AND seq > afterSeq ORDER BY seq ASC LIMIT limit`.
  const eventSource = prismaEventSource(db);

  // One `findMany` on `export`, joined to `session` -- one query, no
  // per-row fan-out (ADR-0001 §2 invariant 2).
  app.get("/races", async () => {
    const rows = await db.export.findMany({ include: { session: true } });
    const races: RaceIndexEntry[] = rows.map((row) => ({
      session_key: Number(row.sessionKey),
      name: row.session.name,
      country: row.session.country,
      date_start: row.session.dateStart.toISOString(),
      date_end: row.session.dateEnd.toISOString(),
      total_laps: row.session.totalLaps,
      exported_at: row.exportedAt.toISOString(),
    }));
    // ISO 8601 UTC timestamps sort lexicographically the same as
    // chronologically.
    races.sort((a, b) => b.date_start.localeCompare(a.date_start));
    return races;
  });

  app.get<{ Params: { session_key: string } }>("/races/:session_key", async (request, reply) => {
    const raw = request.params.session_key;
    if (!INTEGER.test(raw)) {
      reply.code(400);
      return { error: "session_key must be an integer" };
    }
    const sessionKey = BigInt(raw);

    const row = await db.export.findUnique({ where: { sessionKey }, include: { session: true } });
    if (row === null) {
      reply.code(404);
      return { error: "not found" };
    }

    const path = filePath(dir, sessionKey);
    if (!(await fileExists(path))) {
      // "Disk is a cache, the database is the record." (ADR-0009 §3):
      // same embedded `exported_at` as the row, so it cannot diverge.
      await exporter.exportSession(sessionKey, row.exportedAt);
      app.log.info({ sessionKey: sessionKey.toString() }, "export regenerated");
    }

    const etag = `"${sessionKey.toString()}-${row.exportedAt.getTime()}"`;
    reply.header("content-type", "application/json");
    reply.header("content-encoding", "gzip");
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("etag", etag);
    reply.header("vary", "accept-encoding");

    if (request.headers["if-none-match"] === etag) {
      reply.code(304);
      return reply.send();
    }

    // Pre-gzipped bytes, streamed straight through -- "never gunzip on
    // the server" (ADR-0009 §4).
    return reply.send(createReadStream(path));
  });

  // GET /api/races/:session_key/events (issue #96): the same RaceEvent
  // rows for any session, live included, in bounded pages, so a browser
  // can fold a live race from its start (HLD §7 rewind tier "minutes:
  // keyframe + chunks folded in the browser"). Two queries per page --
  // the session lookup (needed for `status`, and to 404 unknown sessions)
  // and the events page -- never per tick.
  app.get<{ Params: { session_key: string }; Querystring: EventsQuery }>(
    "/races/:session_key/events",
    async (request, reply) => {
      const rawKey = request.params.session_key;
      if (!INTEGER.test(rawKey)) {
        reply.code(400);
        return { error: "session_key must be an integer" };
      }
      const sessionKey = BigInt(rawKey);

      const sinceSeq = parseSinceSeq(request.query.since_seq);
      if (sinceSeq === null) {
        reply.code(400);
        return { error: "since_seq must be a non-negative integer" };
      }

      const limit = parseLimit(request.query.limit);
      if (limit === null) {
        reply.code(400);
        return { error: `limit must be an integer between 1 and ${MAX_EVENTS_LIMIT}` };
      }

      const session = await db.session.findUnique({ where: { sessionKey }, select: { status: true } });
      if (session === null) {
        reply.code(404);
        return { error: "not found" };
      }

      const rows = await eventSource.readAfter(sessionKey, BigInt(sinceSeq), limit);
      const events = rows.map(toRaceEvent);
      const lastRow = rows[rows.length - 1];
      const nextSeq = lastRow === undefined ? null : Number(lastRow.seq);

      // A full page is immutable by construction: rows below the head
      // never change (ADR-0010 single writer per session, ADR-0007
      // "ingest never updates an events row"). A short page is the head,
      // still growing -- never cache it.
      reply.header(
        "cache-control",
        events.length === limit ? "public, max-age=31536000, immutable" : "no-store",
      );

      return {
        session_key: sessionKey.toString(),
        status: session.status,
        events,
        next_seq: nextSeq,
      };
    },
  );

  done();
};
