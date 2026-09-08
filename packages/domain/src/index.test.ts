import { describe, expect, it } from "vitest";
import { DOMAIN_PACKAGE } from "./index.js";

describe("shared package", () => {
  it("exports its name", () => {
    expect(DOMAIN_PACKAGE).toBe("@formula-time/domain");
  });
});
