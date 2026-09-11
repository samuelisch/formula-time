#!/usr/bin/env node
// Collect Summary / Friction / Agent lines from PRs merged during a period.
// Usage: node scripts/retro.mjs <YYYY-MM-DD> [YYYY-MM-DD]
//   first argument: period start (UTC, inclusive); defaults to today
//   second argument: period end (UTC, inclusive); open-ended (through now) when omitted
// Output: markdown to stdout; the /retro skill turns it into docs/retros/<date>.md
import { execFileSync } from "node:child_process";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {string} date a YYYY-MM-DD string
 * @returns {boolean}
 */
function isValidDate(date) {
  return DATE_RE.test(date);
}

/**
 * @param {string} date a YYYY-MM-DD string
 * @param {number} days offset to apply, positive or negative
 * @returns {string} the resulting date, as YYYY-MM-DD
 */
function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a PR's merge time falls within a period. The period starts at
 * `start` 00:00:00 UTC (inclusive) and, when `end` is given, runs through
 * the end of that calendar day in UTC (inclusive); with no `end` the
 * period is open, running through now.
 * @param {string} mergedAt an ISO 8601 timestamp
 * @param {string} start a YYYY-MM-DD string, period start
 * @param {string} [end] a YYYY-MM-DD string, period end
 * @returns {boolean}
 */
export function inPeriod(mergedAt, start, end) {
  if (mergedAt < `${start}T00:00:00Z`) return false;
  if (end === undefined) return true;
  return mergedAt < `${shiftDate(end, 1)}T00:00:00Z`;
}

function main() {
  const [startArg, endArg] = process.argv.slice(2);
  const start = startArg ?? new Date().toISOString().slice(0, 10);
  if (!isValidDate(start)) {
    console.error(`usage: retro.mjs <YYYY-MM-DD> [YYYY-MM-DD]; got ${JSON.stringify(start)}`);
    process.exit(2);
  }
  if (endArg !== undefined && !isValidDate(endArg)) {
    console.error(`usage: retro.mjs <YYYY-MM-DD> [YYYY-MM-DD]; got ${JSON.stringify(endArg)}`);
    process.exit(2);
  }

  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  // The search is a pre-filter only, widened a day earlier than the period
  // so the 200-PR cap isn't hit on a busy week; the real boundary is
  // applied locally below, since GitHub's search index handles the date
  // in its own timezone and can lag behind a same-day query.
  const raw = execFileSync("gh", [
    "pr", "list", "--state", "merged", "--limit", "200",
    "--search", `merged:>=${shiftDate(start, -1)}`,
    "--json", "number,title,body,mergedAt,url",
  ], { encoding: "utf8" });

  const line = (body, key) => {
    const m = body?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    const v = m?.[1]?.trim() ?? "";
    return v.startsWith("<") ? "" : v; // template placeholder left in place
  };

  const prs = JSON.parse(raw)
    .filter((p) => inPeriod(p.mergedAt, start, endArg))
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
    .map((p) => ({ ...p, summary: line(p.body, "Summary"), friction: line(p.body, "Friction"), agent: line(p.body, "Agent") }));

  const header = endArg
    ? `# Retro — PRs merged from ${start} to ${endArg}\n`
    : `# Retro — PRs merged since ${start}\n`;
  console.log(header);
  console.log(`| PR | Agent | Summary | Friction |\n|---|---|---|---|`);
  for (const p of prs) {
    console.log(`| [#${p.number}](${p.url}) | ${cell(p.agent || "?")} | ${cell(p.summary || `(missing) ${p.title}`)} | ${cell(p.friction || "(missing)")} |`);
  }
  const missing = prs.filter((p) => !p.summary || !p.friction);
  if (missing.length) console.log(`\nMissing lines: ${missing.map((p) => `#${p.number}`).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
