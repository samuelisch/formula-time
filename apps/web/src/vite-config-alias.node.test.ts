// vite.config.ts aliases @formula-time/domain to its source only while
// VITEST is set, so the real `vite build()` calls in build-meta.node.test.ts
// and _headers.node.test.ts read the domain package from source. This file
// guards the other half of that condition: a dev server or a production
// build, which has no VITEST, must get no alias at all and keep resolving
// the package through its `exports` (dist/). Loads the actual config file
// rather than trusting the helper alone, since it is the loaded config's
// resolve.alias that vite acts on.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadConfigFromFile } from "vite";

import { domainAlias } from "../vite.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// Loads apps/web/vite.config.ts the way vite itself does, with VITEST set to
// the given value (or removed), and returns the resulting resolve.alias.
async function aliasWithVitest(value: string | undefined): Promise<unknown> {
  const previous = process.env.VITEST;
  if (value === undefined) delete process.env.VITEST;
  else process.env.VITEST = value;
  try {
    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, path.join(root, "vite.config.ts"), root, "silent");
    return loaded?.config.resolve?.alias;
  } finally {
    if (previous === undefined) delete process.env.VITEST;
    else process.env.VITEST = previous;
  }
}

describe("the domain alias is test-time only", () => {
  test("no VITEST means no alias, so a dev or production build resolves the built package", () => {
    expect(domainAlias({})).toEqual({});
  });

  test("VITEST maps the domain package to its source entry", () => {
    expect(domainAlias({ VITEST: "true" })).toEqual({
      "@formula-time/domain": path.join(root, "..", "..", "packages", "domain", "src", "index.ts"),
    });
  });

  test("the loaded config carries an empty alias when VITEST is unset", async () => {
    await expect(aliasWithVitest(undefined)).resolves.toEqual({});
  }, 30_000);

  test("the loaded config carries the source alias when VITEST is set", async () => {
    await expect(aliasWithVitest("true")).resolves.toEqual({
      "@formula-time/domain": path.join(root, "..", "..", "packages", "domain", "src", "index.ts"),
    });
  }, 30_000);
});
