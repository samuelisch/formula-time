// Regression test for fix round 3 on issue #51: a vote cast during the
// initial-fill window (GET /api/polls, before the first SSE push -- the
// session key is not yet known) must still show as "your pick" once the
// first push lands and the page switches to rendering the displayed push's
// polls. votes.ts keys by poll_id alone (poll ids already embed the session
// key server-side), so this holds regardless of what, if anything, changes
// about the session between the two renders.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLiveStore } from "../live/store.ts";
import { makePoll } from "../polls/pollFixtures.ts";
import { makePush } from "../test/fixtures.ts";
import { PollsPage } from "./PollsPage.tsx";

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PollsPage />
    </QueryClientProvider>,
  );
}

describe("PollsPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveStore.setState({ displayed: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useLiveStore.setState({ displayed: null });
  });

  it("keeps a vote cast before the first push visible once the push lands", async () => {
    const poll = makePoll({ poll_id: "99911353:winner", status: "open" });

    const fetchStub = vi.fn((url: string) => {
      if (url === "/api/polls") return Promise.resolve(jsonResponse([poll]));
      if (url === "/api/vote") {
        return Promise.resolve(jsonResponse({ poll_id: "99911353:winner", option_id: "opt-a", viewer_id: "v1", counted: true }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    renderPage();

    // Initial fill: GET /api/polls, no push has arrived yet (displayed === null).
    const optionButton = await screen.findByRole("button", { name: /Verstappen/ });
    fireEvent.click(optionButton);

    await waitFor(() => expect(screen.getByText(/your pick/)).toBeInTheDocument());

    // The first push lands: the page now renders from the displayed push
    // instead of the initial fetch.
    act(() => {
      useLiveStore.setState({ displayed: makePush({ session_key: "99911353", polls: [poll] }) });
    });

    expect(screen.getByText(/your pick/)).toBeInTheDocument();
  });
});
