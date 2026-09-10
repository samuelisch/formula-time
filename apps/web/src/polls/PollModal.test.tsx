import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { BoardSourceProvider } from "../board/useBoardState.ts";
import { makePush } from "../test/fixtures.ts";
import { makePoll } from "./pollFixtures.ts";
import { PollModal, type PollModalProps } from "./PollModal.tsx";
import { usePollModalUiStore } from "./pollModalStore.ts";

function pushFor(sessionKey: string | null) {
  return sessionKey === null ? null : makePush({ session_key: sessionKey });
}

function renderModal(polls: PollModalProps["polls"], sessionKey: string | null = "session-1") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <BoardSourceProvider push={pushFor(sessionKey)}>
        <PollModal polls={polls} />
      </BoardSourceProvider>
    </QueryClientProvider>,
  );
}

function rerenderModal(rerender: RenderResult["rerender"], polls: PollModalProps["polls"], sessionKey: string | null = "session-1") {
  const queryClient = new QueryClient();
  rerender(
    <QueryClientProvider client={queryClient}>
      <BoardSourceProvider push={pushFor(sessionKey)}>
        <PollModal polls={polls} />
      </BoardSourceProvider>
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

  it("does not open when the first signature observed for a session has resolved polls", () => {
    renderModal([
      makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] }),
      makePoll({ poll_id: "poll-2", status: "resolved", winning_option_ids: ["opt-a"] }),
    ]);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not open when the first signature observed for a session has an open poll, and a rerender with the same set stays closed", () => {
    const { rerender } = renderModal([makePoll({ poll_id: "poll-1", status: "open" })]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerenderModal(rerender, [makePoll({ poll_id: "poll-1", status: "open" })]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens when a poll transitions from open to resolved", () => {
    const { rerender } = renderModal([makePoll({ poll_id: "poll-1", status: "open" })]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerenderModal(rerender, [makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] })]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("re-seeds without opening when the session key changes", () => {
    const { rerender } = renderModal([makePoll({ poll_id: "poll-1", status: "open" })], "session-1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerenderModal(rerender, [makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] })], "session-1");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => {
      usePollModalUiStore.getState().close();
    });

    // A new race reusing the same poll_id/status shape must not re-pop: the
    // session change re-seeds instead of comparing against the old race.
    rerenderModal(rerender, [makePoll({ poll_id: "poll-1", status: "resolved", winning_option_ids: ["opt-a"] })], "session-2");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays closed across an unmount/remount for an unchanged set (BoardPage/PollsPage are sibling routes)", () => {
    const { rerender, unmount } = renderModal([makePoll({ poll_id: "poll-1", status: "locked" })]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // seed only

    rerenderModal(rerender, [makePoll({ poll_id: "poll-1", status: "open" })]);
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // real transition: locked -> open
    act(() => {
      usePollModalUiStore.getState().close();
    });

    // Simulate navigating away (/polls) and back (/): PollModal unmounts and
    // remounts as a fresh component instance, but the poll set is unchanged.
    unmount();
    renderModal([makePoll({ poll_id: "poll-1", status: "open" })]);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("pops on remount when a newly resolved poll arrived while unmounted", () => {
    const { rerender, unmount } = renderModal([makePoll({ poll_id: "poll-1", status: "locked" })]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // seed only

    rerenderModal(rerender, [makePoll({ poll_id: "poll-1", status: "open" })]);
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
    const { rerender } = renderModal([makePoll({ poll_id: "poll-1", status: "locked" })]);
    rerenderModal(rerender, [makePoll({ poll_id: "poll-1", status: "open" })]);

    const dialog = screen.getByRole("dialog");
    // The backdrop is the dialog's parent; clicking it (outside the dialog) closes.
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    if (backdrop !== null) fireEvent.click(backdrop);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
