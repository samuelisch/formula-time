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

  done();
};
