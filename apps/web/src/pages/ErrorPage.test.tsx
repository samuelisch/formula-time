import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

import { ErrorPage } from "./ErrorPage.tsx";

describe("ErrorPage", () => {
  it("shows a 404 message and a link back to races for an unmatched route", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          errorElement: <ErrorPage />,
          children: [{ index: true, element: <div /> }],
        },
      ],
      { initialEntries: ["/nope"] },
    );

    render(<RouterProvider router={router} />);

    expect(screen.getByText("Page not found")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Back to races" });
    expect(link).toHaveAttribute("href", "/");
  });
});
