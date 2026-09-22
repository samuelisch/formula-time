import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findOffenders, isPinned, run } from "./check-exact-pins.mjs";

describe("isPinned", () => {
  it("rejects a caret range", () => {
    expect(isPinned("^1.2.3")).toBe(false);
  });

  it("rejects a tilde range", () => {
    expect(isPinned("~1.2.3")).toBe(false);
  });

  it("rejects a comparator range", () => {
    expect(isPinned(">=1.2.3 <2.0.0")).toBe(false);
  });

  it("rejects an x wildcard", () => {
    expect(isPinned("1.2.x")).toBe(false);
  });

  it("rejects the * wildcard", () => {
    expect(isPinned("*")).toBe(false);
  });

  it("rejects the latest tag", () => {
    expect(isPinned("latest")).toBe(false);
  });

  it("rejects an || union", () => {
    expect(isPinned("1.2.3 || 1.2.4")).toBe(false);
  });

  it("accepts an exact version", () => {
    expect(isPinned("1.2.3")).toBe(true);
  });

  it("accepts an exact version with a prerelease tag", () => {
    expect(isPinned("1.2.3-beta.1")).toBe(true);
  });

  it("accepts a workspace specifier", () => {
    expect(isPinned("workspace:*")).toBe(true);
  });

  it("accepts a catalog specifier", () => {
    expect(isPinned("catalog:")).toBe(true);
  });

  it("accepts a link specifier", () => {
    expect(isPinned("link:../x")).toBe(true);
  });
});

describe("findOffenders", () => {
  it("reports every non-pinned specifier in dependencies and devDependencies, and none of the pinned ones", () => {
    const manifest = {
      dependencies: {
        react: "^19.3.0",
        "exact-dep": "1.0.0",
        "@formula-time/domain": "workspace:*",
      },
      devDependencies: {
        vitest: "~5.0.0",
        typescript: "6.0.3",
        "linked-dep": "link:../x",
      },
    };
    expect(findOffenders("apps/web/package.json", manifest)).toEqual([
      'apps/web/package.json: react "^19.3.0"',
      'apps/web/package.json: vitest "~5.0.0"',
    ]);
  });

  it("returns an empty list for a manifest with no dependency blocks", () => {
    expect(findOffenders("packages/domain/package.json", { name: "@formula-time/domain" })).toEqual([]);
  });
});

describe("run", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-exact-pins-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(relPath: string, manifest: unknown) {
    const full = join(root, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, JSON.stringify(manifest));
  }

  it("exits 0 and prints nothing when every workspace manifest is pinned", () => {
    writeManifest("package.json", { devDependencies: { typescript: "6.0.3" } });
    writeManifest("apps/web/package.json", { dependencies: { react: "19.3.0" } });
    writeManifest("packages/domain/package.json", { name: "@formula-time/domain" });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run([], { root })).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("exits 1 and prints one line per offender across every workspace manifest", () => {
    writeManifest("package.json", { devDependencies: { typescript: "^6.0.3" } });
    writeManifest("apps/web/package.json", { dependencies: { react: "^19.3.0" }, devDependencies: { vite: "8.3.0" } });
    writeManifest("apps/api/package.json", { dependencies: { fastify: "5.12.4" } });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run([], { root })).toBe(1);
    expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
      'package.json: typescript "^6.0.3"',
      'apps/web/package.json: react "^19.3.0"',
    ]);
    errorSpy.mockRestore();
  });
});
