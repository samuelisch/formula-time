#!/usr/bin/env node
// The body rules behind the PR-body PreToolUse hook. Reads a pull request
// body on stdin, takes `--mode create|edit|ready`, prints nothing and exits 0
// when the body passes, and prints one reason line and exits 1 when it does
// not. scripts/check-pr-body.sh turns that reason into the hook's deny
// decision; this file holds all of the parsing, so it can be tested directly.
//
// Two rules:
//
//   1. The four header lines (Summary, Friction, Agent, ADRs affected) carry
//      real text rather than the template's angle-bracket placeholders.
//      Checked while the body is being written — `gh pr create` and
//      `gh pr edit` — not on `gh pr ready`, which re-reads a body those two
//      modes have already passed.
//   2. The `## Verified` section holds a real result. Empty, a placeholder
//      word, or nothing but the template's HTML comment all fail: a review
//      round started on one of those is a wasted round, since the reviewer's
//      first finding is always the missing verification.
//
// No dependencies, so the hook costs nothing but a node start.

import { pathToFileURL } from "node:url";

const MODES = new Set(["create", "edit", "ready"]);

const HEADER_KEYS = ["Summary", "Friction", "Agent", "ADRs affected"];

// A line under "## Verified" that opens with one of these is a note to self,
// not a result. Anchored on a word boundary so prose that merely starts with
// a longer word ("Pendingly...") is left alone.
const PLACEHOLDER_OPENER = /^\s*(pending|tbd|todo|wip|placeholder|n\/a)\b/i;

const VERIFIED_REASON = "PR body: ## Verified must hold the real result, not a placeholder";

// The template's headers read "Summary: <one line: ...>", so a header whose
// value opens with "<" has not been filled in. Same test the bash entry point
// used to run, kept byte for byte so the reason text does not change.
function missingHeaders(body) {
  return HEADER_KEYS.filter((key) => !new RegExp(`^${key}: [^<]`, "m").test(body));
}

// The text under "## Verified", with leading and trailing blank lines
// trimmed, or null when the body has no such heading. The section ends at
// whichever comes first: the next "## " heading, the session link, or a
// "Closes #" / "Part of #" line — the three things that always follow the
// section in this repo's bodies.
function verifiedSection(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Verified\s*$/.test(line));
  if (start === -1) return null;
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (/^\s*https:\/\/claude\.ai\/code\/session_/.test(line)) break;
    if (/^\s*(Closes|Part of) #/i.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function withoutComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

// Returns null when the body may start a review round, or the single reason
// it may not. `mode` is one of "create", "edit", "ready".
export function checkBody(body, mode) {
  const text = typeof body === "string" ? body : "";

  if (mode === "create" || mode === "edit") {
    const missing = missingHeaders(text);
    if (missing.length > 0) {
      return `PR body needs real lines for: ${missing.join(" ")} (no template placeholders). See .github/pull_request_template.md`;
    }
  }

  const verified = verifiedSection(text);
  if (verified === null || verified === "") return VERIFIED_REASON;
  if (PLACEHOLDER_OPENER.test(verified)) return VERIFIED_REASON;
  if (withoutComments(verified).trim() === "") return VERIFIED_REASON;

  return null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// Run only as a command, not when the test file imports checkBody.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf("--mode");
  const mode = flag === -1 ? "" : (process.argv[flag + 1] ?? "");
  if (!MODES.has(mode)) {
    process.stderr.write(`check-pr-body: --mode must be one of ${[...MODES].join(", ")}\n`);
    // Not exit 1: only exit 1 denies, and a caller that passes a bad mode is
    // a broken hook, not a bad PR body.
    process.exit(2);
  }
  const reason = checkBody(await readStdin(), mode);
  if (reason !== null) {
    process.stdout.write(`${reason}\n`);
    process.exit(1);
  }
}
