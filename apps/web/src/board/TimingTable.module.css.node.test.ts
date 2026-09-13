// jsdom (the `web` project's environment) does not apply CSS cascade or
// selector specificity, so a rendered test cannot catch a rule that is
// silently outranked by another one on the same element -- this reads the
// stylesheet's own text instead. Runs in the plain-node vitest project
// like index.css.node.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./TimingTable.module.css", import.meta.url)), "utf-8");

describe("TimingTable.module.css specificity", () => {
  // The position cell is a <th scope="row"> carrying both `.position` and
  // the header row's own cascade context, so `.position` alone (one class,
  // specificity 0,1,0) loses to the `.table th` rule (one class + one
  // element, 0,1,1) that sets the muted colour and lighter weight for every
  // other header. Qualifying the override as `.table th.position` (0,2,1)
  // is what makes it win.
  it("qualifies the position override so it outranks the header-row th rule", () => {
    expect(css).toMatch(/\.table\s+th\.position\s*{/);
  });
});
