import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE } from "./index.js";

describe("shared package", () => {
  it("exports its name", () => {
    expect(SHARED_PACKAGE).toBe("@formula-time/shared");
  });
});
