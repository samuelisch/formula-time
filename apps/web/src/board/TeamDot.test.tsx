import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TeamDot } from "./TeamDot.tsx";

describe("TeamDot", () => {
  it("renders the team colour as a background, falling back to grey", () => {
    const { container } = render(<TeamDot teamColour="3671C6" />);
    const dot = container.querySelector("span")!;
    expect(dot.style.background).toBe("rgb(54, 113, 198)");
  });

  it("falls back to grey for a null team colour", () => {
    const { container } = render(<TeamDot teamColour={null} />);
    const dot = container.querySelector("span")!;
    expect(dot.style.background).toBe("rgb(136, 136, 136)");
  });
});
