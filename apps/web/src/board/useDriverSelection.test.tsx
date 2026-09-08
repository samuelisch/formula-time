import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { useDriverSelection } from "./useDriverSelection.ts";

function Probe() {
  const { selected, toggle, clear } = useDriverSelection();
  return (
    <div>
      <span data-testid="selected">{selected ?? "none"}</span>
      <button type="button" onClick={() => toggle(1)}>
        toggle 1
      </button>
      <button type="button" onClick={() => toggle(44)}>
        toggle 44
      </button>
      <button type="button" onClick={clear}>
        clear
      </button>
    </div>
  );
}

function renderProbe(initialPath = "/live") {
  const router = createMemoryRouter([{ path: "*", element: <Probe /> }], { initialEntries: [initialPath] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("useDriverSelection", () => {
  it("reads the driver param from the URL", () => {
    renderProbe("/live?driver=1");
    expect(screen.getByTestId("selected").textContent).toBe("1");
  });

  it("is null when the param is absent or unparseable", () => {
    renderProbe("/live");
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("toggle selects a driver, writing the param", async () => {
    const user = userEvent.setup();
    const router = renderProbe("/live");

    await user.click(screen.getByRole("button", { name: "toggle 1" }));

    expect(screen.getByTestId("selected").textContent).toBe("1");
    expect(router.state.location.search).toBe("?driver=1");
  });

  it("toggle on the already-selected driver clears it", async () => {
    const user = userEvent.setup();
    renderProbe("/live?driver=1");

    await user.click(screen.getByRole("button", { name: "toggle 1" }));

    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("toggle on a different driver replaces the selection", async () => {
    const user = userEvent.setup();
    renderProbe("/live?driver=1");

    await user.click(screen.getByRole("button", { name: "toggle 44" }));

    expect(screen.getByTestId("selected").textContent).toBe("44");
  });

  it("clear removes the param", async () => {
    const user = userEvent.setup();
    renderProbe("/live?driver=1");

    await user.click(screen.getByRole("button", { name: "clear" }));

    expect(screen.getByTestId("selected").textContent).toBe("none");
  });
});
