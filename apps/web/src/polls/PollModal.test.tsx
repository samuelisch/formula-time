import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { makePoll } from "./pollFixtures.ts";
import { PollModal, type PollModalProps } from "./PollModal.tsx";
import { usePollModalUiStore } from "./pollModalStore.ts";

function renderModal(polls: PollModalProps["polls"]) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PollModal polls={polls} />
    </QueryClientProvider>,
  );
}

describe("PollModal", () => {
  beforeEach(() => {
    usePollModalUiStore.setState({ isOpen: false, lastSignature: "", lastSessionKey: null });
  });

  it("stays closed when there is no open poll", () => {
    renderModal([makePoll({ status: "void" })]);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("pops when the displayed polls first contain an open poll", () => {
    renderModal([makePoll({ poll_id: "poll-1", status: "open" })]);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("pops each time the count of resolved polls grows, even while the modal was dismissed", () => {
    const { rerender } = renderModal([
      makePoll({ poll_id: "poll-1", status: "resolved" }),
      makePoll({ poll_id: "poll-2", status: "locked" }),
    ]);

    // First render already contains a resolved poll -> the transition from
    // "" fires the auto-pop (0 -> 1 resolved). Dismiss it.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => {
      usePollModalUiStore.getState().close();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const queryClient = new QueryClient();
    rerender(
      <QueryClientProvider client={queryClient}>
        <PollModal polls={[makePoll({ poll_id: "poll-1", status: "resolved" }), makePoll({ poll_id: "poll-2", status: "resolved" })]} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not re-pop for an unchanged set", () => {
    const polls = [makePoll({ poll_id: "poll-1", status: "open" })];
    const { rerender } = renderModal(polls);

    act(() => {
      usePollModalUiStore.getState().close();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const queryClient = new QueryClient();
    rerender(
      <QueryClientProvider client={queryClient}>
        <PollModal polls={[makePoll({ poll_id: "poll-1", status: "open" })]} />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays closed across an unmount/remount for an unchanged set (fix round 1: BoardPage/PollsPage are sibling routes)", () => {
    const polls = [makePoll({ poll_id: "poll-1", status: "open" })];
    const { unmount } = renderModal(polls);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => {
      usePollModalUiStore.getState().close();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Simulate navigating away (/polls) and back (/): PollModal unmounts and
    // remounts as a fresh component instance, but the poll set is unchanged.
    unmount();
    renderModal([makePoll({ poll_id: "poll-1", status: "open" })]);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("pops on remount when a newly resolved poll arrived while unmounted", () => {
    const { unmount } = renderModal([makePoll({ poll_id: "poll-1", status: "open" })]);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => {
      usePollModalUiStore.getState().close();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    unmount();
    renderModal([makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] })]);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on backdrop click and stays closed until the next transition", () => {
    renderModal([makePoll({ poll_id: "poll-1", status: "open" })]);

    const dialog = screen.getByRole("dialog");
    // The backdrop is the dialog's parent; clicking it (outside the dialog) closes.
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    if (backdrop !== null) fireEvent.click(backdrop);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
