import { describe, expect, test, vi } from "vitest";

import { OpenF1Auth, createOpenF1Fetcher, credentialsFromEnv } from "./auth.js";
import type { FetchLike } from "./auth.js";

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
  });
}

describe("credentialsFromEnv", () => {
  test("both OPENF1_LOGIN and OPENF1_PASSWORD set -> credentials", () => {
    expect(credentialsFromEnv({ OPENF1_LOGIN: "a", OPENF1_PASSWORD: "b" })).toEqual({
      login: "a",
      password: "b",
    });
  });

  test("either unset -> null (unauthenticated fallback)", () => {
    expect(credentialsFromEnv({})).toBeNull();
    expect(credentialsFromEnv({ OPENF1_LOGIN: "a" })).toBeNull();
  });
});

describe("OpenF1Auth", () => {
  test("no credentials -> getToken resolves null, never calls fetch", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const auth = new OpenF1Auth(null, { fetchImpl });
    expect(await auth.getToken()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("acquires a token on first call, reuses it while fresh", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(tokenResponse("token-1"));
    let now = 0;
    const auth = new OpenF1Auth({ login: "l", password: "p" }, { fetchImpl, now: () => now });

    expect(await auth.getToken()).toBe("token-1");
    now += 1000; // well inside the 3600s expiry
    expect(await auth.getToken()).toBe("token-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("refreshes 2 minutes before expiry", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(tokenResponse("token-1", 3600))
      .mockResolvedValueOnce(tokenResponse("token-2", 3600));
    let now = 0;
    const auth = new OpenF1Auth({ login: "l", password: "p" }, { fetchImpl, now: () => now });

    expect(await auth.getToken()).toBe("token-1");
    now += 3600 * 1000 - 2 * 60 * 1000 + 1; // one ms inside the 2-minute refresh margin
    expect(await auth.getToken()).toBe("token-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("invalidate() forces the next getToken() to refresh", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(tokenResponse("token-2"));
    const auth = new OpenF1Auth({ login: "l", password: "p" }, { fetchImpl });

    expect(await auth.getToken()).toBe("token-1");
    auth.invalidate();
    expect(await auth.getToken()).toBe("token-2");
  });
});

describe("createOpenF1Fetcher", () => {
  test("attaches the bearer token when credentials are configured", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(tokenResponse("token-1"))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ a: 1 }]), { status: 200 }));
    const auth = new OpenF1Auth({ login: "l", password: "p" }, { fetchImpl });
    const fetcher = createOpenF1Fetcher(auth, { fetchImpl });

    const result = await fetcher("https://api.openf1.org/v1/position?session_key=1");

    expect(result).toEqual([{ a: 1 }]);
    const dataCall = fetchImpl.mock.calls[1];
    expect(dataCall?.[1]).toMatchObject({ headers: { authorization: "Bearer token-1" } });
  });

  test("no credentials -> requests go out with no authorization header", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(new Response("[]", { status: 200 }));
    const auth = new OpenF1Auth(null, { fetchImpl });
    const fetcher = createOpenF1Fetcher(auth, { fetchImpl });

    await fetcher("https://api.openf1.org/v1/position?session_key=1");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openf1.org/v1/position?session_key=1",
      { headers: {} },
    );
  });

  test("404 means no data yet -> empty array, not a throw", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 404 }));
    const auth = new OpenF1Auth(null, { fetchImpl });
    const fetcher = createOpenF1Fetcher(auth, { fetchImpl });

    expect(await fetcher("https://api.openf1.org/v1/laps?session_key=1")).toEqual([]);
  });

  test("401 retries once with a freshly refreshed token", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(tokenResponse("token-1")) // initial token acquire
      .mockResolvedValueOnce(new Response(null, { status: 401 })) // first attempt: stale token
      .mockResolvedValueOnce(tokenResponse("token-2")) // refresh
      .mockResolvedValueOnce(new Response(JSON.stringify([{ a: 1 }]), { status: 200 })); // retry succeeds
    const auth = new OpenF1Auth({ login: "l", password: "p" }, { fetchImpl });
    const fetcher = createOpenF1Fetcher(auth, { fetchImpl });

    const result = await fetcher("https://api.openf1.org/v1/position?session_key=1");

    expect(result).toEqual([{ a: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const retryCall = fetchImpl.mock.calls[3];
    expect(retryCall?.[1]).toMatchObject({ headers: { authorization: "Bearer token-2" } });
  });

  test("a non-404, non-ok response throws", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 500 }));
    const auth = new OpenF1Auth(null, { fetchImpl });
    const fetcher = createOpenF1Fetcher(auth, { fetchImpl });

    await expect(fetcher("https://api.openf1.org/v1/laps?session_key=1")).rejects.toThrow(/500/);
  });
});
