// GET /api/live/events: the thin SSE route (ADR-0001 §2 invariant 1),
// hand-written on the raw response so compression middleware never gzips
// it per viewer. This handler never touches the projector, only the
// Fanout, which already holds the newest frame. `?format=delta`
// (ADR-0013 point 2) is opt-in. `GET /api/live/snapshot` is the
// gap-recovery route (ADR-0013 point 3): the newest `state` push's bytes.
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

import { replyHeaders } from "../cors.js";
import type { Encoding, FanoutSink, Format } from "../../fanout/fanout.js";

/** The slice of `FastifyRequest` `liveEventsHandler` actually reads. */
export interface LiveEventsRequest {
  headers: FastifyRequest["headers"];
  query: unknown;
  raw: { on(event: "close", listener: () => void): void };
}

/** The slice of `FastifyReply` `liveEventsHandler` actually calls. `raw`
 * needs both `writeHead` (this handler writes the head itself, hijacked)
 * and the `FanoutSink` members `fanout.join`/`fanout.remove` need. */
export interface LiveEventsReply {
  hijack(): void;
  raw: FanoutSink & { writeHead(statusCode: number, headers: Record<string, string>): void };
  getHeaders(): ReturnType<FastifyReply["getHeaders"]>;
}

/** The slice of `FastifyReply` `liveSnapshotHandler` actually calls. */
export interface LiveSnapshotReply {
  header(name: string, value: string): unknown;
  code(statusCode: number): unknown;
  send(payload?: unknown): unknown;
}

/** The slice of `Fanout` these routes actually call -- a plain interface,
 * so a test fake satisfies it directly instead of needing to be an actual
 * `Fanout` instance (a class with private fields no object literal could
 * ever structurally match). A real `Fanout` already has these members. */
export interface LiveFanout {
  join(res: FanoutSink, encoding: Encoding, format?: Format): Promise<void>;
  remove(res: FanoutSink): void;
  snapshotJson(): string | null;
}

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

export function liveEventsHandler(fanout: Pick<LiveFanout, "join" | "remove">) {
  return (request: LiveEventsRequest, reply: LiveEventsReply): void => {
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
 * recovery (ADR-0013 point 3) gets on any other failure. */
export function liveSnapshotHandler(fanout: Pick<LiveFanout, "snapshotJson">) {
  return (_request: unknown, reply: LiveSnapshotReply): unknown => {
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
  fanout: LiveFanout;
}

/** Fastify plugin: registered with `app.register(liveRoutes, { prefix: "/api", fanout })`. */
export const liveRoutes: FastifyPluginCallback<LiveRoutesOptions> = (app: FastifyInstance, opts, done) => {
  app.get("/live/events", liveEventsHandler(opts.fanout));
  app.get("/live/snapshot", liveSnapshotHandler(opts.fanout));
  done();
};
