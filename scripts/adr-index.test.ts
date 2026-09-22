import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAdrFile, readAdrEntries, renderReadme, run } from "./adr-index.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adr-index-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string) {
  writeFileSync(join(dir, name), content);
}

describe("parseAdrFile", () => {
  it("parses the bulleted bold front-matter form", () => {
    const content = [
      "# ADR-0013 — Delta pushes",
      "",
      "- **Status:** Accepted",
      "- **Date:** 2026-09-09",
      "- **Owner:** Samuel Chan",
      "- **Supersedes:** nothing",
      "- **Amends:** ADR-0001 (§2 invariant 1)",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0013-delta-pushes.md", content);
    expect(parsed).toEqual({
      number: "0013",
      filename: "0013-delta-pushes.md",
      title: "Delta pushes",
      status: "Accepted",
      date: "2026-09-09",
      amends: ["0001"],
    });
  });

  it("parses the plain front-matter form to the same fields as the bold form", () => {
    const content = [
      "# ADR-0018 — Export follows the log",
      "",
      "Status: Accepted",
      "Date: 2026-09-10",
      "Amends: ADR-0009 §2 (export once) and §3 (regenerate only a missing file)",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0018-export-follows-the-log.md", content);
    expect(parsed).toEqual({
      number: "0018",
      filename: "0018-export-follows-the-log.md",
      title: "Export follows the log",
      status: "Accepted",
      date: "2026-09-10",
      amends: ["0009"],
    });
  });

  it("yields status unknown when no Status field is present", () => {
    const content = ["# ADR-0099 — No status field", "", "## Context", "", "No front matter here at all."].join(
      "\n",
    );
    const parsed = parseAdrFile("0099-no-status.md", content);
    expect(parsed?.status).toBe("unknown");
  });

  it("collects amends from the Amends field, the title, and the first paragraph, excluding the file's own number", () => {
    const content = [
      "# ADR-0030 — Tick cadence; amends ADR-0012's rule and ADR-0029's line",
      "",
      "Status: Accepted",
      "Date: 2026-09-13",
      "Amends: ADR-0001 (seam 4)",
      "",
      "## Context",
      "",
      "This ADR also amends ADR-0030 in spirit and ADR-0022 in practice.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0030-tick-cadence.md", content);
    expect(parsed?.amends.sort()).toEqual(["0001", "0012", "0022", "0029"]);
  });

  it("returns null for a filename that does not match the NNNN- pattern", () => {
    expect(parseAdrFile("README.md", "# Decisions")).toBeNull();
  });
});

describe("readAdrEntries", () => {
  it("fills amendedBy as the inverse of amends across files", () => {
    write(
      "0001-first.md",
      ["# ADR-0001 — First", "", "Status: Accepted", "Date: 2026-09-01", "", "## Context", "", "Nothing here."].join(
        "\n",
      ),
    );
    write(
      "0002-second.md",
      [
        "# ADR-0002 — Second",
        "",
        "Status: Accepted",
        "Date: 2026-09-02",
        "Amends: ADR-0001",
        "",
        "## Context",
        "",
        "Nothing here.",
      ].join("\n"),
    );
    const entries = readAdrEntries(dir);
    const first = entries.find((e) => e.number === "0001");
    const second = entries.find((e) => e.number === "0002");
    expect(second?.amends).toEqual(["0001"]);
    expect(first?.amendedBy).toEqual(["0002"]);
    expect(first?.amends).toEqual([]);
    expect(second?.amendedBy).toEqual([]);
  });

  it("exits with code 2 and names both files on stderr when two files share a number", () => {
    write("0001-first.md", ["# ADR-0001 — First", "", "Status: Accepted"].join("\n"));
    write("0001-duplicate.md", ["# ADR-0001 — Duplicate", "", "Status: Accepted"].join("\n"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = run(["--check"], { dir, readmePath: join(dir, "README.md") });
    expect(code).toBe(2);
    const message = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toContain("0001-first.md");
    expect(message).toContain("0001-duplicate.md");
    errorSpy.mockRestore();
  });
});

describe("renderReadme", () => {
  it("links Amends and Amended by cells to the referenced files", () => {
    write(
      "0001-first.md",
      ["# ADR-0001 — First", "", "Status: Accepted", "Date: 2026-09-01", "", "## Context", "", "Nothing here."].join(
        "\n",
      ),
    );
    write(
      "0002-second.md",
      [
        "# ADR-0002 — Second",
        "",
        "Status: Accepted",
        "Date: 2026-09-02",
        "Amends: ADR-0001",
        "",
        "## Context",
        "",
        "Nothing here.",
      ].join("\n"),
    );
    const content = renderReadme(readAdrEntries(dir));
    expect(content).toContain("| [0001](0001-first.md) | First | Accepted | 2026-09-01 |  | [0002](0002-second.md) |");
    expect(content).toContain("| [0002](0002-second.md) | Second | Accepted | 2026-09-02 | [0001](0001-first.md) |  |");
  });
});

describe("run --check", () => {
  it("exits 1 when the file on disk is stale and 0 once regenerated", () => {
    write(
      "0001-first.md",
      ["# ADR-0001 — First", "", "Status: Accepted", "Date: 2026-09-01", "", "## Context", "", "Nothing here."].join(
        "\n",
      ),
    );
    const readmePath = join(dir, "README.md");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(run(["--check"], { dir, readmePath })).toBe(1);

    expect(run([], { dir, readmePath })).toBe(0);
    expect(run(["--check"], { dir, readmePath })).toBe(0);

    writeFileSync(readmePath, readFileSync(readmePath, "utf8") + "\nstray edit\n");
    expect(run(["--check"], { dir, readmePath })).toBe(1);

    errorSpy.mockRestore();
  });
});
