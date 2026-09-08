import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";

import type { Fanout } from "../fanout/fanout.js";
import { liveEventsHandler, liveRoutes } from "./live.js";

function fakeRequest(acceptEncoding: string | undefined) {
  const closeHandlers: Array<() => void> = [];
  return {
    headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
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

function fakeReply() {
  const raw = { writeHead: vi.fn() };
  return {
    hijack: vi.fn(),
    raw,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("GET /live/events handler", () => {
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
    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "gzip");
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
    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "plain");
  });

  test("missing accept-encoding header: treated as plain", () => {
    const fanout = { join: vi.fn(async () => {}), remove: vi.fn() };
    const reply = fakeReply();
    const request = fakeRequest(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveEventsHandler(fanout as any)(request, reply);

    expect(fanout.join).toHaveBeenCalledWith(reply.raw, "plain");
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
});
