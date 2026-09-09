// Unit test (ADR-0002): in-memory fake db only, no Postgres. Covers the
// two things ADR-0015 adds to POST /api/vote — the origin check and the
// per-env viewer cookie attributes — plus the routes vote-burst and
// vote-path integration tests already cover the vote business logic
// itself, which this file does not repeat.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@formula-time/db";

import { PollModule } from "./poll-module.js";
import { registerPolls } from "./routes.js";

async function build(): Promise<FastifyInstance> {
  // No poll is ever loaded (module.start() is never called), so every vote
  // in this file reaches PollModule.vote()'s 404 branch without touching
  // the db — the fake below never needs a real implementation.
  const db = {} as unknown as PrismaClient;
  const module = new PollModule({ db, log: { info: () => {} } });
  const app = Fastify();
  await app.register(registerPolls(module, db), { prefix: "/api" });
  await app.ready();
  return app;
}

function vote(app: FastifyInstance, origin?: string) {
  return app.inject({
    method: "POST",
    url: "/api/vote",
    headers: origin === undefined ? {} : { origin },
    payload: { poll_id: "unknown", option_id: "y" },
  });
}

describe("POST /api/vote — origin check (ADR-0015)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await build();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CORS_ORIGIN;
    delete process.env.NODE_ENV;
  });

  it("rejects a missing Origin when CORS_ORIGIN is set (production)", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://web.test";
    const res = await vote(app);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "origin not allowed" });
  });

  it("rejects a foreign Origin when CORS_ORIGIN is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://web.test";
    const res = await vote(app, "https://evil.test");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "origin not allowed" });
  });

  it("accepts a listed Origin and falls through to the poll module", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://web.test";
    const res = await vote(app, "https://web.test");
    // Past the origin check: PollModule.vote() answers 404, unknown poll.
    expect(res.statusCode).toBe(404);
  });

  it("dev (CORS_ORIGIN unset): accepts a same-origin request with no Origin header", async () => {
    const res = await vote(app);
    expect(res.statusCode).toBe(404);
  });

  it("dev (CORS_ORIGIN unset): accepts a localhost Origin", async () => {
    const res = await vote(app, "http://localhost:5173");
    expect(res.statusCode).toBe(404);
  });

  it("dev (CORS_ORIGIN unset): still rejects a foreign Origin", async () => {
    const res = await vote(app, "https://evil.test");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "origin not allowed" });
  });
});

describe("POST /api/vote — viewer cookie attributes per env (ADR-0015)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await build();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CORS_ORIGIN;
    delete process.env.NODE_ENV;
  });

  it("production: SameSite=None; Secure; HttpOnly", async () => {
    process.env.NODE_ENV = "production";
    const res = await vote(app);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
  });

  it("outside production: SameSite=Lax and not Secure", async () => {
    const res = await vote(app);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
  });
});
