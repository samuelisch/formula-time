import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { makePoll } from "./pollFixtures.ts";
import { PollCard } from "./PollCard.tsx";
import { rememberVote } from "./votes.ts";

function renderCard(poll: ReturnType<typeof makePoll>) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <PollCard poll={poll} />
    </QueryClientProvider>,
  );
}

/** The Collapsible's trigger is the only button rendered outside its body. */
function expand(): void {
  fireEvent.click(screen.getByRole("button", { name: /./ }));
}

describe("PollCard", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults open when the poll is open, and shows the status pill, question, and lock lap collapsed", () => {
    renderCard(makePoll({ status: "open", question: "Who wins the race?", locks_at_lap: 10, total_votes: 3 }));

    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(screen.getByText("Who wins the race?")).toBeInTheDocument();
    expect(screen.getByText("locks at lap 10 · 3 votes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verstappen/ })).toBeVisible();
  });

  it("defaults collapsed when the poll is not open, showing awaiting result instead of the lock lap", () => {
    renderCard(makePoll({ status: "locked", total_votes: 5 }));

    expect(screen.getByText("locked · awaiting result · 5 votes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verstappen/ })).not.toBeInTheDocument();
  });

  it("names the winner in the collapsed summary for a resolved winner poll", () => {
    const poll = makePoll({
      status: "resolved",
      options: [
        { id: "opt-a", label: "ANT" },
        { id: "opt-b", label: "RUS" },
      ],
      winning_option_ids: ["opt-a"],
      total_votes: 7,
    });

    renderCard(poll);

    expect(screen.getByText("Winner: ANT · 7 votes")).toBeInTheDocument();
  });

  it("names the podium in the collapsed summary for a resolved podium poll", () => {
    const poll = makePoll({
      kind: "podium",
      status: "resolved",
      options: [
        { id: "opt-a", label: "ANT" },
        { id: "opt-b", label: "RUS" },
        { id: "opt-c", label: "VER" },
      ],
      winning_option_ids: ["opt-a", "opt-b", "opt-c"],
      total_votes: 4,
    });

    renderCard(poll);

    expect(screen.getByText("Podium: ANT, RUS, VER · 4 votes")).toBeInTheDocument();
  });

  it("enables voting when the poll is open", () => {
    renderCard(makePoll({ status: "open" }));

    for (const option of ["Verstappen", "Hamilton"]) {
      expect(screen.getByRole("button", { name: new RegExp(option) })).toBeEnabled();
    }
  });

  it("disables voting when the poll is locked, once expanded", () => {
    renderCard(makePoll({ status: "locked" }));

    expand();

    for (const option of ["Verstappen", "Hamilton"]) {
      expect(screen.getByRole("button", { name: new RegExp(option) })).toBeDisabled();
    }
  });

  it("shows the correct verdict for the stored pick when resolved and the pick won", () => {
    const poll = makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] });
    rememberVote("poll-1", "opt-a");

    renderCard(poll);
    expand();

    expect(screen.getByText("✓ You called it")).toBeInTheDocument();
  });

  it("shows the wrong verdict for the stored pick when resolved and the pick lost", () => {
    const poll = makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-b"] });
    rememberVote("poll-1", "opt-a");

    renderCard(poll);
    expand();

    expect(screen.getByText("✗ Not this time")).toBeInTheDocument();
  });

  it("shows no verdict when resolved and the viewer never voted", () => {
    const poll = makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] });

    renderCard(poll);
    expand();

    expect(screen.queryByText("✓ You called it")).not.toBeInTheDocument();
    expect(screen.queryByText("✗ Not this time")).not.toBeInTheDocument();
  });
});
