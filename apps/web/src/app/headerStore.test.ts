import { beforeEach, describe, expect, it } from "vitest";

import { useHeaderStore } from "./headerStore.ts";

describe("headerStore", () => {
  beforeEach(() => {
    useHeaderStore.setState({ override: null });
  });

  it("starts with no override", () => {
    expect(useHeaderStore.getState().override).toBeNull();
  });

  it("sets the override line", () => {
    useHeaderStore.getState().setOverride("Netherlands · Race · replay");
    expect(useHeaderStore.getState().override).toEqual({ line: "Netherlands · Race · replay" });
  });

  it("clears the override", () => {
    useHeaderStore.getState().setOverride("Netherlands · Race · replay");
    useHeaderStore.getState().setOverride(null);
    expect(useHeaderStore.getState().override).toBeNull();
  });
});
