import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";

import type { Fanout } from "../fanout/fanout.js";
import { liveEventsHandler, liveRoutes, liveSnapshotHandler } from "./live.js";

function fakeRequest(acceptEncoding: string | undefined, query: Record<string, unknown> = {}) {
  const closeHandlers: Array<() => void> = [];
  return {
    headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
    query,
    raw: {
      on: (event: string, fn: () => void) => {
        if (event === "close") {
          closeHandlers.push(fn);
        }
      },
      emitClose: () => closeHandlers.forEach((fn) => fn()),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeReply(decorated: Record<string, string> = {}) {
  const raw = { writeHead: vi.fn() };
  return {
    hijack: vi.fn(),
    raw,
    getHeaders: () => decorated,
    header: vi.fn(),
    code: vi.fn(),
    send: vi.fn((body: unknown) => body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("GET /live/events handler", () => {
  test("cors headers the plugin decorated ride along on the hijacked head; vary is joined", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply({
      "access-control-allow-origin": "https://web.test",
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });
    const request = fakeRequest(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(reply.raw.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      vary: "accept-encoding, Origin",
      "access-control-allow-origin": "https://web.test",
      "access-control-allow-credentials": "true",
    });
  });

  test("hijacks the reply and never touches the projector -- only the fanout", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest("gzip, deflate, br");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(reply.hijack).toHaveBeenCalledTimes(1);
  });

  test("gzip accept-encoding: sets the gzip headers and joins with encoding 'gzip'", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest("gzip, deflate, br");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(reply.raw.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      vary: "accept-encoding",
      "content-encoding": "gzip",
    });
    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "gzip", "state");
  });

  test("no gzip in accept-encoding: plain headers (no content-encoding), joins with encoding 'plain'", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest("identity");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(reply.raw.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      vary: "accept-encoding",
    });
    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "plain", "state");
  });

  test("missing accept-encoding header: treated as plain", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "plain", "state");
  });

  test("removes the socket from the fanout when the client closes the connection", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest("gzip");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);
    request.raw.emitClose();

    expect(fanout.remove).toHaveBeenCalledWith(reply.raw);
  });

  test("?format=delta selects the delta tag", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest("gzip", { format: "delta" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "gzip", "delta");
  });

  test("an unrecognised format falls back to the default 'state' tag", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest("gzip", { format: "something-else" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "gzip", "state");
  });
});

describe("GET /live/snapshot handler", () => {
  test("503 with { error } before the first push", () => {
    const fanout = { snapshotJson: vi.fn(() => null) };
    const reply = fakeReply();
    const request = fakeRequest(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = liveSnapshotHandler(fanout as any)(request, reply);

    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.header).toHaveBeenCalledWith("cache-control", "no-store");
    expect(result).toEqual({ error: "no snapshot yet" });
  });

  test("returns the newest state push's JSON, verbatim, with no-store", () => {
    const json = JSON.stringify({ type: "state", seq: "1" });
    const fanout = { snapshotJson: vi.fn(() => json) };
    const reply = fakeReply();
    const request = fakeRequest(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveSnapshotHandler(fanout as any)(request, reply);

    expect(reply.header).toHaveBeenCalledWith("cache-control", "no-store");
    expect(reply.header).toHaveBeenCalledWith("content-type", "application/json");
    expect(reply.send).toHaveBeenCalledWith(json);
    expect(reply.code).not.toHaveBeenCalled();
  });
});

describe("liveRoutes plugin", () => {
  test("registered with prefix /api: the public path is /api/live/events, not /live/events", async () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const app = Fastify();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(liveRoutes, { prefix: "/api", fanout: fanout as any as Fanout });
    await app.ready();

    expect(app.hasRoute({ method: "GET", url: "/api/live/events" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/live/events" })).toBe(false);

    await app.close();
  });

  test("registered with prefix /api: GET /api/live/snapshot exists", async () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn(), snapshotJson: vi.fn(() => null) };
    const app = Fastify();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(liveRoutes, { prefix: "/api", fanout: fanout as any as Fanout });
    await app.ready();

    expect(app.hasRoute({ method: "GET", url: "/api/live/snapshot" })).toBe(true);

    const response = await app.inject({ method: "GET", url: "/api/live/snapshot" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "no snapshot yet" });

    await app.close();
  });
});
