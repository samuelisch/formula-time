// The `/live` route = the pure `Board` (covered by board/Board.test.tsx)
// plus the live-only furniture: the finished/upcoming banner, polls, and the
// delay/align controls that moved out of `Shell` in issue #57 fix round 5.
// These tests cover that furniture and the fact that it is mounted here, not
// in the shell and not on a replay.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { BoardSourceProvider } from "../board/useBoardState.ts";
import { makePush } from "../test/fixtures.ts";
import { BoardPage } from "./BoardPage.tsx";

function renderWith(push: ReturnType<typeof makePush> | null): void {
  render(
    <MemoryRouter>
      <BoardSourceProvider push={push}>
        <BoardPage />
      </BoardSourceProvider>
    </MemoryRouter>,
  );
}

describe("BoardPage", () => {
  it("mounts the board itself", () => {
    renderWith(makePush());

    expect(screen.getByText("LAP 12/53")).toBeInTheDocument();
    expect(screen.getByText("2 drivers")).toBeInTheDocument();
  });

  // Moved out of Shell (where they sat under the header on every route,
  // replay included) into the board's own toolbar.
  it("mounts the live-only controls in the board toolbar: polls, delay, align", () => {
    renderWith(makePush());

    expect(screen.getByRole("button", { name: "Polls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument(); // DelayControl's back-to-live
    expect(screen.getByRole("button", { name: /Align with my screen/ })).toBeInTheDocument();
  });

  it("renders the empty state before any push arrives", () => {
    renderWith(null);
    expect(screen.getByText("LAP —")).toBeInTheDocument();
    expect(screen.getByText("Waiting for race state…")).toBeInTheDocument();
  });

  it("shows no banner while the session is live (the default fixture status)", () => {
    renderWith(makePush());
    expect(screen.queryByText(/This race has finished/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Race starts/)).not.toBeInTheDocument();
  });

  it("shows the finished banner with a replay link when the session has finished", () => {
    renderWith(
      makePush({ session_key: "11361" }, { session: { session_key: "11361", name: "Race", country: "Italy", status: "finished" } }),
    );

    expect(screen.getByText("This race has finished. Showing its final state.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Watch the replay" });
    expect(link).toHaveAttribute("href", "/races/11361");
  });

  it("shows the upcoming banner when the session has not started", () => {
    renderWith(
      makePush(
        {},
        { session: { session_key: "11361", name: "Race", country: "Italy", status: "upcoming", date_start: "2026-09-08T12:00:00.000Z" } },
      ),
    );

    expect(screen.getByText("Race starts 2026-09-08. Timing appears when the session goes live.")).toBeInTheDocument();
  });
});
