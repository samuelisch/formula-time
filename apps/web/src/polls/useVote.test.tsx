import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { myVote } from "./votes.ts";
import { useVote } from "./useVote.ts";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("useVote", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores the pick in localStorage on a 200", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse(true, 200, { poll_id: "poll-1", option_id: "opt-a", viewer_id: "v1", counted: true }),
    );
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useVote("session-1"), { wrapper });

    result.current.mutate({ pollId: "poll-1", optionId: "opt-a" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchStub).toHaveBeenCalledWith(
      "/api/vote",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poll_id: "poll-1", option_id: "opt-a" }),
      }),
    );
    expect(myVote("session-1", "poll-1")).toBe("opt-a");
  });

  it("surfaces the server's error text on a 409 and does not store a pick", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse(false, 409, { error: "Poll is locked" }));
    vi.stubGlobal("fetch", fetchStub);

    const { result } = renderHook(() => useVote("session-1"), { wrapper });

    result.current.mutate({ pollId: "poll-1", optionId: "opt-a" });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("Poll is locked");
    expect(myVote("session-1", "poll-1")).toBeNull();
  });
});
