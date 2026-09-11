import { describe, expect, it } from "vitest";

import { checkBody, inlineBody } from "./check-pr-body.mjs";

// The exact comment the template leaves under "## Verified". A body that
// still carries only this has not been verified.
const TEMPLATE_COMMENT =
  "<!-- CI runs typecheck, unit, integration, build, and the ADR check; do not paste their output. List only what you checked beyond CI (a curl, a manual run, a rehearsal) and what you could not check. -->";

const HEADERS = [
  "Summary: the hook refuses a placeholder Verified section",
  "Friction: none",
  "Agent: claude-local",
  "ADRs affected: none",
].join("\n");

// A body with the four real header lines and whatever the caller puts under
// "## Verified", shaped like the template: a "## What" section, then
// "## Verified", then the Closes line and the session link.
function body(verified: string): string {
  return `${HEADERS}

## What

Rewrote the hook.

## Verified

${verified}

Closes #1

https://claude.ai/code/session_test
`;
}

describe("checkBody: the Verified section", () => {
  it("passes a real result", () => {
    expect(checkBody(body("Ran the shell test from both checkouts; both pass."), "create")).toBeNull();
  });

  it("fails an empty section", () => {
    expect(checkBody(body(""), "create")).toBe(
      "PR body: ## Verified must hold the real result, not a placeholder",
    );
  });

  it("fails a section that is only blank lines", () => {
    expect(checkBody(body("\n   \n"), "create")).not.toBeNull();
  });

  it.each(["pending", "Pending — will fill in", "TBD", "tbd after CI", "todo", "WIP", "placeholder", "n/a", "N/A"])(
    "fails the placeholder word %j",
    (word) => {
      expect(checkBody(body(word), "create")).toBe(
        "PR body: ## Verified must hold the real result, not a placeholder",
      );
    },
  );

  it("passes prose that merely starts with a word containing a placeholder", () => {
    // "pendingly" is not the word "pending": the rule is anchored on a word
    // boundary so real prose is never mistaken for a placeholder.
    expect(checkBody(body("Pendingly checked the exporter by hand."), "create")).toBeNull();
  });

  it("fails the template comment on its own", () => {
    expect(checkBody(body(TEMPLATE_COMMENT), "create")).toBe(
      "PR body: ## Verified must hold the real result, not a placeholder",
    );
  });

  it("passes the template comment followed by real prose", () => {
    expect(checkBody(body(`${TEMPLATE_COMMENT}\n\nRan the shell test from both checkouts.`), "create")).toBeNull();
  });

  it("fails when there is no Verified section at all", () => {
    expect(checkBody(`${HEADERS}\n\n## What\n\nStuff.\n\nCloses #1\n`, "create")).toBe(
      "PR body: ## Verified must hold the real result, not a placeholder",
    );
  });
});

describe("checkBody: where the Verified section ends", () => {
  it("stops at the next heading", () => {
    const text = `${HEADERS}\n\n## Verified\n\npending\n\n## Needs owner\n\nReal prose.\n`;
    expect(checkBody(text, "create")).not.toBeNull();
  });

  it("reads the section that a later heading follows", () => {
    const text = `${HEADERS}\n\n## Verified\n\nRan the shell test.\n\n## Needs owner\n\nA question.\n`;
    expect(checkBody(text, "create")).toBeNull();
  });

  it("stops at the Closes line", () => {
    const text = `${HEADERS}\n\n## Verified\n\nCloses #1\n`;
    // Nothing between the heading and "Closes #1", so the section is empty.
    expect(checkBody(text, "create")).not.toBeNull();
  });

  it("stops at a Part of line", () => {
    const text = `${HEADERS}\n\n## Verified\n\nPart of #1\n`;
    expect(checkBody(text, "create")).not.toBeNull();
  });

  it("stops at the session link", () => {
    const text = `${HEADERS}\n\n## Verified\n\nhttps://claude.ai/code/session_abc123\n`;
    expect(checkBody(text, "create")).not.toBeNull();
  });

  it("does not treat the Closes line as the result", () => {
    const text = `${HEADERS}\n\n## Verified\n\nRan the test script.\n\nCloses #1\n\nhttps://claude.ai/code/session_abc123\n`;
    expect(checkBody(text, "create")).toBeNull();
  });
});

describe("checkBody: the header lines", () => {
  const REASON =
    "PR body needs real lines for: Summary Friction Agent ADRs affected (no template placeholders). See .github/pull_request_template.md";

  it("fails create mode when every header is a template placeholder", () => {
    const text = [
      "Summary: <one line: what changed and why>",
      'Friction: <one line: what slowed this down, or "none">',
      "Agent: <claude-local | claude-cloud | codex | human>",
      "ADRs affected: <none | 000N: what this changes that the ADR names>",
      "",
      "## Verified",
      "",
      "Ran the shell test.",
    ].join("\n");
    expect(checkBody(text, "create")).toBe(REASON);
  });

  it("names only the headers that are missing", () => {
    const text = `Summary: real\nAgent: claude-local\n\n## Verified\n\nRan the shell test.\n`;
    expect(checkBody(text, "create")).toBe(
      "PR body needs real lines for: Friction ADRs affected (no template placeholders). See .github/pull_request_template.md",
    );
  });

  it("fails edit mode on missing headers too", () => {
    expect(checkBody("## Verified\n\nRan the shell test.\n", "edit")).toContain("PR body needs real lines for:");
  });

  it("passes edit mode when the headers are present", () => {
    expect(checkBody(body("Ran the shell test."), "edit")).toBeNull();
  });

  it("reports the headers before the Verified section", () => {
    // Both are wrong; the caller sees the header reason first.
    expect(checkBody("## Verified\n\npending\n", "edit")).toContain("PR body needs real lines for:");
  });

  it("skips the header check in ready mode", () => {
    // `gh pr ready` re-reads a body that create or edit already checked; the
    // placeholder is the only thing that can have been left behind since.
    expect(checkBody("## Verified\n\nRan the shell test.\n", "ready")).toBeNull();
  });

  it("still checks Verified in ready mode", () => {
    expect(checkBody("## Verified\n\npending\n", "ready")).toBe(
      "PR body: ## Verified must hold the real result, not a placeholder",
    );
  });
});

describe("inlineBody: the body an inline flag carries", () => {
  it("returns the quoted argument after --body", () => {
    expect(inlineBody('gh pr edit 12 --body "Summary: real"')).toBe("Summary: real");
  });

  it("returns the quoted argument after -b", () => {
    expect(inlineBody("gh pr edit 12 -b 'Summary: real'")).toBe("Summary: real");
  });

  it("takes the first flag, not a flag name written inside the body", () => {
    // The body is one quoted argument, so the "--body" and "-b" in its prose
    // are text. Taking the last match instead would drop the Summary line.
    const command = 'gh pr create --body "Summary: cover --body and -b flags\nFriction: none"';
    expect(inlineBody(command)).toBe("Summary: cover --body and -b flags\nFriction: none");
  });

  it("is not fooled by a quoted argument written before the body", () => {
    expect(inlineBody('gh pr create --title "a title" --body "Summary: real"')).toBe("Summary: real");
  });

  it("reads the value out of --body=<text>", () => {
    expect(inlineBody('gh pr edit 12 --body="Summary: real"')).toBe("Summary: real");
  });

  it("keeps a multi-line body whole", () => {
    expect(inlineBody('gh pr create --body "Summary: real\n\n## Verified\n\nRan it." --draft')).toBe(
      "Summary: real\n\n## Verified\n\nRan it.",
    );
  });

  it("keeps an unterminated quote running to the end of the command", () => {
    // The shape a heredoc substitution takes: the opening quote of the body
    // closes only after the interpolation.
    const command = "gh pr create --body \"$(cat <<'EOF'\nSummary: real\nEOF\n)\"";
    expect(inlineBody(command)).toBe("$(cat <<'EOF'\nSummary: real\nEOF\n)");
  });

  it("ignores --body-file, which names a path rather than carrying a body", () => {
    expect(inlineBody("gh pr create --body-file /tmp/pr.md")).toBeNull();
  });

  it("ignores a flag name that is only mentioned inside another argument", () => {
    expect(inlineBody('gh pr edit 12 --title "cover the --body flag"')).toBeNull();
  });

  it("returns null when there is no inline body flag", () => {
    expect(inlineBody("gh pr edit 12 --add-label in-review")).toBeNull();
  });

  it("returns an empty body when the flag ends the command", () => {
    expect(inlineBody("gh pr edit 12 --body")).toBe("");
  });
});
