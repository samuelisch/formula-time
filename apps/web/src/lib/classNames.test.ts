import { describe, expect, it } from "vitest";

import { cx } from "./classNames.ts";

describe("cx", () => {
  it("joins present class names with a space", () => {
    expect(cx("a", "b")).toBe("a b");
  });

  it("skips false, null, undefined, and empty string", () => {
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("returns an empty string when nothing is present", () => {
    expect(cx(undefined, false, null)).toBe("");
  });
});
