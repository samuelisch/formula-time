// GET /api/live/events -- the thin SSE route (ADR-0001 §1 "thin router").
// Hand-written on the raw response: compression middleware would gzip per
// viewer, which the fan-out's one-serialize-once-per-push design forbids
// (apps/api/AGENTS.md). This handler never touches the projector: it only
// ever talks to the Fanout, which already holds the newest frame.
//
// Registered as a plugin under the `/api` prefix (owner decision: every
// client-facing route lives under `/api`) -- the route itself stays
// relative (`/live/events`), so the public path becomes
// `/api/live/events`. `/health` is the platform's probe (Railway
// healthcheck, `.railway/railway.ts`), not a client route, and stays at
// the root, registered separately in main.ts.
//
// `?format=delta` (ADR point 2): opt-in, default unchanged.
// `GET /api/live/snapshot` is the gap-recovery route (ADR point 3): the
// newest `state` push's bytes, verbatim; 503 before the first push.
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

import { replyHeaders } from "../cors.js";
import type { Encoding, Fanout, Format } from "../fanout/fanout.js";

function pickEncoding(acceptEncoding: unknown): Encoding {
  return typeof acceptEncoding === "string" && /\bgzip\b/.test(acceptEncoding) ? "gzip" : "plain";
}

function pickFormat(query: unknown): Format {
  if (typeof query !== "object" || query === null) {
    return "state";
  }
  const raw = (query as Record<string, unknown>).format;
  return raw === "delta" ? "delta" : "state";
}

export function liveEventsHandler(fanout: Fanout) {
  return (request: FastifyRequest, reply: FastifyReply): void => {
    reply.hijack();
    const res = reply.raw;
    const encoding = pickEncoding(request.headers["accept-encoding"]);
    const format = pickFormat(request.query);

    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      vary: "accept-encoding",
    };
    if (encoding === "gzip") {
      headers["content-encoding"] = "gzip";
    }
    // Hijacked: Fastify sends nothing it decorated, so the cors plugin's
    // headers (ADR-0008) ride along here, or a cross-origin EventSource is
    // refused. `vary` is joined, not replaced: both accept-encoding and
    // Origin decide the bytes.
    for (const [name, value] of Object.entries(replyHeaders(reply))) {
      if (value === undefined) continue;
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      headers[name] = name === "vary" && headers[name] !== undefined ? `${headers[name]}, ${text}` : text;
    }
    res.writeHead(200, headers);

    void fanout.join(res, encoding, format);

    request.raw.on("close", () => {
      fanout.remove(res);
    });
  };
}

/** `GET /api/live/snapshot`: the newest `state` push, verbatim (plain JSON,
 * `cache-control: no-store` -- this is a point-in-time read, never cached).
 * 503 with `{ error }` before the first push, same shape a client's gap
 * recovery (ADR point 3) gets on any other failure. */
export function liveSnapshotHandler(fanout: Fanout) {
  return (_request: FastifyRequest, reply: FastifyReply): unknown => {
    const json = fanout.snapshotJson();
    reply.header("cache-control", "no-store");
    if (json === null) {
      reply.code(503);
      return { error: "no snapshot yet" };
    }
    reply.header("content-type", "application/json");
    return reply.send(json);
  };
}

export interface LiveRoutesOptions {
  fanout: Fanout;
}

/** Fastify plugin: registered with `app.register(liveRoutes, { prefix: "/api", fanout })`. */
export const liveRoutes: FastifyPluginCallback<LiveRoutesOptions> = (app: FastifyInstance, opts, done) => {
  app.get("/live/events", liveEventsHandler(opts.fanout));
  app.get("/live/snapshot", liveSnapshotHandler(opts.fanout));
  done();
};
