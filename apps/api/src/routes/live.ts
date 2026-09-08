// GET /live/events -- the thin SSE route (ADR-0001 §1 "thin router").
// Hand-written on the raw response: compression middleware would gzip per
// viewer, which the fan-out's one-serialize-once-per-push design forbids
// (apps/api/AGENTS.md). This handler never touches the projector: it only
// ever talks to the Fanout, which already holds the newest frame.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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
    res.writeHead(200, headers);

    void fanout.join(res, encoding);

    request.raw.on("close", () => {
      fanout.remove(res);
    });
  };
}

export function registerLiveRoute(app: FastifyInstance, fanout: Fanout): void {
  app.get("/live/events", liveEventsHandler(fanout));
}
