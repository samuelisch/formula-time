import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { makePoll } from "./pollFixtures.ts";
import { PollCard } from "./PollCard.tsx";
import { rememberVote } from "./votes.ts";

function renderCard(poll: ReturnType<typeof makePoll>, sessionKey: string | null = "session-1") {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <PollCard poll={poll} sessionKey={sessionKey} />
    </QueryClientProvider>,
  );
}

describe("PollCard", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("enables voting when the poll is open", () => {
    renderCard(makePoll({ status: "open" }));

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeEnabled();
    }
  });

  it("disables voting when the poll is locked", () => {
    renderCard(makePoll({ status: "locked" }));

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("shows the correct verdict for the stored pick when resolved and the pick won", () => {
    const poll = makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] });
    rememberVote("session-1", "poll-1", "opt-a");

    renderCard(poll, "session-1");

    expect(screen.getByText("✓ You called it")).toBeInTheDocument();
  });

  it("shows the wrong verdict for the stored pick when resolved and the pick lost", () => {
    const poll = makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-b"] });
    rememberVote("session-1", "poll-1", "opt-a");

    renderCard(poll, "session-1");

    expect(screen.getByText("✗ Not this time")).toBeInTheDocument();
  });

  it("shows no verdict when resolved and the viewer never voted", () => {
    const poll = makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] });

    renderCard(poll, "session-1");

    expect(screen.queryByText("✓ You called it")).not.toBeInTheDocument();
    expect(screen.queryByText("✗ Not this time")).not.toBeInTheDocument();
  });
});
