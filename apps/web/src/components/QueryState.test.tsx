import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QueryState } from "./QueryState.tsx";

describe("QueryState", () => {
  it("shows the loading text and not the children while pending", () => {
    render(
      <QueryState status="pending" error={null} onRetry={vi.fn()} loadingText="Loading things…" errorText="Could not load things">
        <p>Content</p>
      </QueryState>,
    );

    expect(screen.getByText("Loading things…")).toBeInTheDocument();
    expect(screen.queryByText("Content")).not.toBeInTheDocument();
  });

  it("shows the error text and a Retry button that calls onRetry, not the children", () => {
    const onRetry = vi.fn();
    render(
      <QueryState status="error" error={new Error("boom")} onRetry={onRetry} loadingText="Loading things…" errorText="Could not load things">
        <p>Content</p>
      </QueryState>,
    );

    expect(screen.getByText("Could not load things")).toBeInTheDocument();
    expect(screen.queryByText("Content")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders the children on success, not the loading or error text", () => {
    render(
      <QueryState status="success" error={null} onRetry={vi.fn()} loadingText="Loading things…" errorText="Could not load things">
        <p>Content</p>
      </QueryState>,
    );

    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.queryByText("Loading things…")).not.toBeInTheDocument();
    expect(screen.queryByText("Could not load things")).not.toBeInTheDocument();
  });
});
