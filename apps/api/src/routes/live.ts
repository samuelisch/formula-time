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
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

import { replyHeaders } from "../cors.js";
import type { Encoding, Fanout } from "../fanout/fanout.js";

function pickEncoding(acceptEncoding: unknown): Encoding {
  return typeof acceptEncoding === "string" && /\bgzip\b/.test(acceptEncoding) ? "gzip" : "plain";
}

export function liveEventsHandler(fanout: Fanout) {
  return (request: FastifyRequest, reply: FastifyReply): void => {
    reply.hijack();
    const res = reply.raw;
    const encoding = pickEncoding(request.headers["accept-encoding"]);

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

    void fanout.join(res, encoding);

    request.raw.on("close", () => {
      fanout.remove(res);
    });
  };
}

export interface LiveRoutesOptions {
  fanout: Fanout;
}

/** Fastify plugin: registered with `app.register(liveRoutes, { prefix: "/api", fanout })`. */
export const liveRoutes: FastifyPluginCallback<LiveRoutesOptions> = (app: FastifyInstance, opts, done) => {
  app.get("/live/events", liveEventsHandler(opts.fanout));
  done();
};
