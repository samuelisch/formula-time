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
    const content = ["# ADR-0099 — No status field", "", "## Context", "", "No front matter here at all."].join("\n");
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

  it("does not take an Amends field mention that the field text explicitly says is untouched", () => {
    // Reproduces docs/decisions-adr/0033-session-row-refresh-publishes-once.md's
    // Amends field: it amends ADR-0014, and separately notes that ADR-0013's
    // rule is untouched -- untouched is not amended.
    const content = [
      "# ADR-0033 — A session row refresh publishes once, outside the tick cycle",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-13",
      "- **Owner:** Samuel Chan",
      "- **Supersedes:** nothing",
      "- **Amends:** ADR-0014 point 2 (the two named exceptions to a genuine new",
      "  tick that publish `events: []` — catch-up and rebuild — gain a third:",
      "  a session-row refresh outside either. ADR-0013 point 1's delta patch",
      '  "computed once per tick on the server" is untouched: a row refresh',
      "  carries no patch computation, only the session field of the pushed",
      '  state, so it does not conflict with "once per tick" for the delta',
      "  payload itself.)",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0033-session-row-refresh-publishes-once.md", content);
    expect(parsed?.amends).toEqual(["0014"]);
  });

  it("does not take an Amends field mention that is only a parenthetical cross-reference", () => {
    // Reproduces docs/decisions-adr/0004-prisma-and-db-package.md's Amends
    // field: it amends ADR-0002, and separately cites ADR-0001's seam
    // contract as a cross-reference for where migrations are applied.
    const content = [
      "# ADR-0004 — Prisma as the database client, in a Node-only `packages/db`",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-08",
      "- **Owner:** Samuel Chan",
      "- **Amends:** ADR-0002 (toolchain). Migrations stay numbered SQL files",
      "  applied by the deploy pipeline (ADR-0001 seam contract 1); Prisma Migrate",
      "  is what emits and applies them.",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0004-prisma-and-db-package.md", content);
    expect(parsed?.amends).toEqual(["0002"]);
  });

  it("does not mistake an ellipsis inside a quoted excerpt for a sentence break in the Amends field", () => {
    // Reproduces docs/decisions-adr/0036-ingest-runs-as-root-on-railway-so-the-volume-is-writable.md's
    // Amends field, which quotes another ADR's text containing "...": the
    // second target, ADR-0007, must not be cut off by that ellipsis.
    const content = [
      "# ADR-0036 — The ingest service runs as root on Railway so the volume is writable",
      "",
      "- **Status:** Accepted",
      "- **Date:** 2026-09-14",
      "- **Owner:** Samuel Chan",
      '- **Amends:** ADR-0034 (its "a rejected append is logged at error level ...',
      '  never allowed to block or stop the lane" stance is extended to the',
      "  startup probe this ADR adds, not changed); ADR-0007 §4 (names",
      "  `LIVE_LOG_DIR` as a config seam and is unchanged by this).",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0036-ingest-runs-as-root-on-railway-so-the-volume-is-writable.md", content);
    expect(parsed?.amends.sort()).toEqual(["0007", "0034"]);
  });

  it("does not let a negation word inside one target's parenthetical suppress the next target's bare mention", () => {
    // The negation check must not slice a raw character window across a
    // sentence boundary: "is unchanged" describes ADR-0011's own
    // parenthetical, not ADR-0022, which follows in its own sentence.
    const content = [
      "# ADR-0099 — Placeholder for a negation-bleed regression",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-23",
      "- **Owner:** Samuel Chan",
      "- **Amends:** ADR-0011 (this earlier decision is unchanged by the point",
      "  made here). ADR-0022 (a genuinely new target).",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0099-placeholder.md", content);
    expect(parsed?.amends.sort()).toEqual(["0011", "0022"]);
  });

  it("drops a bare mention with no parentheses when its own sentence says it is untouched or not amended", () => {
    const untouched = [
      "# ADR-0098 — Placeholder for a bare-sentence negation",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-23",
      "- **Owner:** Samuel Chan",
      "- **Amends:** ADR-0013 is untouched.",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    expect(parseAdrFile("0098-placeholder.md", untouched)?.amends).toEqual([]);

    const notAmended = [
      "# ADR-0097 — Placeholder for a bare-sentence negation",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-23",
      "- **Owner:** Samuel Chan",
      "- **Amends:** ADR-0013 is not amended.",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    expect(parseAdrFile("0097-placeholder.md", notAmended)?.amends).toEqual([]);
  });

  it("keeps a mention in a later sentence even when an earlier sentence in the same field is negated", () => {
    const content = [
      "# ADR-0096 — Placeholder for a negated sentence followed by a real target",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-23",
      "- **Owner:** Samuel Chan",
      "- **Amends:** ADR-0013 is untouched. ADR-0022 gains the new column.",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0096-placeholder.md", content);
    expect(parsed?.amends).toEqual(["0022"]);
  });

  it("takes both targets from an Amends field whose field text has two sentences, each a bare ADR mention", () => {
    // Reproduces docs/decisions-adr/0042-request-log-diet-poll-write-error-level-refresh-caught-up.md's
    // Amends field: two sentences, each "ADR-NNNN (explanation)." -- both
    // are targets, not just the first.
    const content = [
      "# ADR-0042 — Request log diet, poll write failures at error, a session-row refresh guarded by caught-up",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-23",
      "- **Owner:** Samuel Chan",
      "- **Amends:** ADR-0033 (`updateSession()`'s decision reads \"publishes once,",
      '  immediately, with `events: []`" with no precondition; it now publishes',
      "  only once the projector has finished its catch-up fold — before that,",
      "  the catch-up tick's own publish already carries the refreshed row).",
      "  ADR-0022 (`LOG_LEVEL` is introduced there as ingest's config name; the",
      "  api now reads the same name, the same way, for its own logger).",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0042-request-log-diet-poll-write-error-level-refresh-caught-up.md", content);
    expect(parsed?.amends.sort()).toEqual(["0022", "0033"]);
  });

  it("takes both targets from an Amends field with two bare-mention sentences quoting nested parens and negated prose", () => {
    // Reproduces docs/decisions-adr/0038-reconnect-resumes-from-head-seq.md's
    // Amends field: two sentences, each "ADR-NNNN (explanation)."; the
    // second explanation quotes a nested parenthetical and the word
    // "unaffected", neither of which should suppress either target.
    const content = [
      "# ADR-0038 — A reconnect resumes the browser timeline from the head seq",
      "",
      "- **Status:** Proposed (accepted when this PR merges)",
      "- **Date:** 2026-09-22",
      "- **Owner:** Samuel Chan",
      '- **Amends:** ADR-0014 (Decision point 3: "A client backfills',
      '  `GET /api/races/:key/events` pages from 0 until a short page"; the',
      "  starting seq now depends on why the backfill runs).",
      '  ADR-0032 (its context sentence "a reconnecting client (which always',
      '  re-backfills) was unaffected": a reconnecting client now resumes from',
      "  its head seq and still receives a skipped frame's rows through the",
      "  paged route, which reads the append-only table independently of the",
      "  projector's cursor; the claim that such a client is unaffected stands,",
      "  the mechanism changed).",
      "",
      "## Context",
      "",
      "Some context paragraph with no trigger word.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0038-reconnect-resumes-from-head-seq.md", content);
    expect(parsed?.amends.sort()).toEqual(["0014", "0032"]);
  });

  it("does not attribute an amendment described about a different ADR pair to this file", () => {
    // Reproduces docs/decisions-adr/0026-session-names-on-the-wire.md's Context
    // paragraph: it reports that ADR-0025 amends ADR-0004, which is a fact
    // about ADR-0025, not a statement that this file (ADR-0026) amends
    // ADR-0004. Only the explicit Amends field names what this file amends.
    const content = [
      "# ADR-0026 — The export document and the races index carry the session's naming fields",
      "",
      "Status: Accepted",
      "Date: 2026-09-12",
      "Amends: ADR-0009 (§1 the export document's `session` object, §4 the `GET /api/races` entry shape)",
      "",
      "## Context",
      "",
      "ADR-0009 §1 and §4 name the export document's `session` object and the `/api/races` entry shape verbatim.",
      "ADR-0025 added `meeting_name`, `circuit_short_name`, `location` to the stored `sessions` row so a race can be named by its Grand Prix and circuit, not just `country` and `circuit_key`.",
      "ADR-0025 amends only ADR-0004 and HLD §4 (the stored columns); it does not touch ADR-0009's wire shapes, which this ADR does.",
      "",
    ].join("\n");
    const parsed = parseAdrFile("0026-session-names-on-the-wire.md", content);
    expect(parsed?.amends).toEqual(["0009"]);
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
