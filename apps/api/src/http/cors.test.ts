import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { originAllowed, parseAllowedOrigins, registerCors, replyHeaders } from "./cors.js";

async function build(allowed: string[]) {
  const app = Fastify();
  await registerCors(app, allowed);
  app.get("/ping", async () => ({ ok: true }));
  app.get("/stream", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", ...replyHeaders(reply) });
    reply.raw.end();
  });
  await app.ready();
  return app;
}

describe("parseAllowedOrigins", () => {
  it("splits a comma list and drops blanks", () => {
    expect(parseAllowedOrigins(" https://a.test, https://b.test ,")).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

describe("registerCors", () => {
  it("answers a listed origin with credentials allowed", async () => {
    const app = await build(["https://web.test"]);
    const res = await app.inject({ url: "/ping", headers: { origin: "https://web.test" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://web.test");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("sets no allow-origin for an origin off the list", async () => {
    const app = await build(["https://web.test"]);
    const res = await app.inject({ url: "/ping", headers: { origin: "https://evil.test" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("with an empty list allows nothing cross-origin but still serves same-origin", async () => {
    const app = await build([]);
    const cross = await app.inject({ url: "/ping", headers: { origin: "https://web.test" } });
    expect(cross.headers["access-control-allow-origin"]).toBeUndefined();
    const same = await app.inject({ url: "/ping" });
    expect(same.statusCode).toBe(200);
  });

  it("answers the preflight for a POST with credentials", async () => {
    const app = await build(["https://web.test"]);
    const res = await app.inject({
      method: "OPTIONS",
      url: "/vote",
      headers: {
        origin: "https://web.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://web.test");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("a hijacked route keeps the cors headers when it merges replyHeaders()", async () => {
    const app = await build(["https://web.test"]);
    const res = await app.inject({ url: "/stream", headers: { origin: "https://web.test" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://web.test");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

// ADR-0015: POST /api/vote's own origin check, sharing this allowlist —
// SameSite=None dropped the CSRF guard SameSite=Lax gave for free.
describe("originAllowed", () => {
  it("accepts an origin on the allowlist", () => {
    expect(originAllowed("https://web.test", ["https://web.test"])).toBe(true);
  });

  it("rejects an origin off the allowlist", () => {
    expect(originAllowed("https://evil.test", ["https://web.test"])).toBe(false);
  });

  it("rejects a missing origin when the allowlist is non-empty (production)", () => {
    expect(originAllowed(undefined, ["https://web.test"])).toBe(false);
  });

  it("with an empty allowlist (dev), accepts a missing origin", () => {
    expect(originAllowed(undefined, [])).toBe(true);
  });

  it("with an empty allowlist (dev), accepts a localhost origin", () => {
    expect(originAllowed("http://localhost:5173", [])).toBe(true);
    expect(originAllowed("https://localhost", [])).toBe(true);
  });

  it("with an empty allowlist (dev), rejects a non-localhost origin", () => {
    expect(originAllowed("https://evil.test", [])).toBe(false);
  });

  it("with an empty allowlist (dev), rejects a malformed origin", () => {
    expect(originAllowed("not-a-url", [])).toBe(false);
  });
});
