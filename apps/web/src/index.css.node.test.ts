// Confirms the reduced-motion opt-out actually ships in the stylesheet --
// a plain string check on the file, not a rendered assertion, since jsdom
// does not evaluate media queries. Runs in the plain-node vitest project
// like build-meta.node.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf-8");

describe("index.css reduced motion", () => {
  it("collapses animations and transitions under prefers-reduced-motion: reduce", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-duration: 0.01ms !important");
  });
});
