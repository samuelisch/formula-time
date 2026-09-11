// Unit test (ADR-0002): no Postgres, no main.ts side effects -- a bare
// Fastify instance built with the same `trustProxy` value main.ts uses.
//
// The property under test: `request.ip` must resolve to the real client
// address when the socket is Railway's own (private) edge, and a client
// must not be able to change what it resolves to by adding arbitrary
// entries in front of its own address in X-Forwarded-For.
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TRUST_PROXY } from "./trust-proxy.js";

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: TRUST_PROXY });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}

function ipFor(app: FastifyInstance, remoteAddress: string, forwardedFor?: string) {
  return app.inject({
    method: "GET",
    url: "/ip",
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    remoteAddress,
  });
}

describe("TRUST_PROXY (main.ts's Fastify trustProxy option)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await build();
  });

  afterEach(async () => {
    await app.close();
  });

  it("a direct request with no proxy in front uses the raw socket address", async () => {
    const res = await ipFor(app, "203.0.113.50");
    expect(res.json()).toEqual({ ip: "203.0.113.50" });
  });

  it("Railway's own (private) edge is trusted: the X-Forwarded-For entry it appended is the client ip", async () => {
    const res = await ipFor(app, "10.0.0.5", "198.51.100.7");
    expect(res.json()).toEqual({ ip: "198.51.100.7" });
  });

  it("a spoofed prefix in front of the real client entry does not change the resolved ip", async () => {
    const res = await ipFor(app, "10.0.0.5", "evil-spoof-1, evil-spoof-2, 198.51.100.7");
    expect(res.json()).toEqual({ ip: "198.51.100.7" });
  });

  it("rotating the spoofed prefix on every request never yields a different ip -- the bypass this fixes", async () => {
    const first = await ipFor(app, "10.0.0.5", "aaaaaaaa, 198.51.100.7");
    const second = await ipFor(app, "10.0.0.5", "zzzzzzzz-different, 198.51.100.7");
    expect(first.json()).toEqual({ ip: "198.51.100.7" });
    expect(second.json()).toEqual(first.json());
  });

  it("a socket that is not itself a trusted private address ignores X-Forwarded-For entirely", async () => {
    // No platform proxy in front (or an untrusted one): the header is
    // attacker-controlled end to end, so it must never be read.
    const res = await ipFor(app, "203.0.113.50", "198.51.100.7");
    expect(res.json()).toEqual({ ip: "203.0.113.50" });
  });
});
