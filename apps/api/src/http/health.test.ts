import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";

import { createDbProbe, healthWithBuild } from "./health.js";

describe("healthWithBuild", () => {
  const health = { ok: true as const, session_key: null, cursor: "0", caught_up: false, viewers: 0 };

  test("adds the build field from GIT_SHA", () => {
    expect(healthWithBuild(health, "ok", { GIT_SHA: "abc123" })).toEqual({ ...health, build: "abc123", db: "ok" });
  });

  test('falls back to "unknown" when GIT_SHA is unset', () => {
    expect(healthWithBuild(health, "ok", {})).toEqual({ ...health, build: "unknown", db: "ok" });
  });

  test("falls back to RAILWAY_GIT_COMMIT_SHA when GIT_SHA is unset", () => {
    expect(healthWithBuild(health, "ok", { RAILWAY_GIT_COMMIT_SHA: "railwaysha" })).toEqual({
      ...health,
      build: "railwaysha",
      db: "ok",
    });
  });

  test("GIT_SHA takes precedence over RAILWAY_GIT_COMMIT_SHA when both are set", () => {
    expect(healthWithBuild(health, "ok", { GIT_SHA: "explicit", RAILWAY_GIT_COMMIT_SHA: "railwaysha" })).toEqual({
      ...health,
      build: "explicit",
      db: "ok",
    });
  });

  test("carries the db field through as given", () => {
    expect(healthWithBuild(health, "unreachable", {})).toEqual({
      ...health,
      build: "unknown",
      db: "unreachable",
    });
  });

  test("ok stays true when db is unreachable but a fold exists", () => {
    const withSession = { ...health, session_key: "42", cursor: "10", caught_up: true };
    expect(healthWithBuild(withSession, "unreachable", {})).toMatchObject({ ok: true, db: "unreachable" });
  });
});

describe("createDbProbe", () => {
  test('status is "ok" before the first probe settles', () => {
    const probe = createDbProbe({ probe: () => new Promise(() => {}) });
    expect(probe.status()).toBe("ok");
  });

  test('status becomes "unreachable" when the probe rejects, and is cached until the next run', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const probe = createDbProbe({
        probe: () => {
          calls += 1;
          return Promise.reject(new Error("connection refused"));
        },
        intervalMs: 30_000,
      });

      probe.start();
      await vi.advanceTimersByTimeAsync(0); // let the immediate probe settle
      expect(calls).toBe(1);
      expect(probe.status()).toBe("unreachable");

      // Cached: no second probe until the interval elapses.
      expect(probe.status()).toBe("unreachable");
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('status recovers to "ok" once a later probe succeeds', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const probe = createDbProbe({
        probe: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(1)),
        intervalMs: 30_000,
      });

      probe.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(probe.status()).toBe("unreachable");

      fail = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(probe.status()).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop() clears the timer so no further probe runs", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const probe = createDbProbe({
        probe: () => {
          calls += 1;
          return Promise.resolve(1);
        },
        intervalMs: 30_000,
      });

      probe.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      probe.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// /health answers through the same globally-registered helmet hook every
// other route does (main.ts) -- the platform probe is not the one response
// without the standard security headers.
describe("GET /health security headers", () => {
  test("carries strict-transport-security and x-content-type-options", async () => {
    const app = Fastify();
    await app.register(helmet, {
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      hsts: { maxAge: 31536000, includeSubDomains: false },
      frameguard: { action: "deny" },
    });
    app.get("/health", async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");

    await app.close();
  });
});
