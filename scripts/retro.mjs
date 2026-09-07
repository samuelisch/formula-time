#!/usr/bin/env node
// Collect Summary / Friction / Agent lines from PRs merged since a date.
// Usage: node scripts/retro.mjs [YYYY-MM-DD]   (default: today, UTC)
// Output: markdown to stdout; the /retro skill turns it into retros/<date>.md
import { execFileSync } from "node:child_process";

const since = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const raw = execFileSync("gh", [
  "pr", "list", "--state", "merged", "--limit", "200",
  "--search", `merged:>=${since}`,
  "--json", "number,title,body,mergedAt,url",
], { encoding: "utf8" });

const line = (body, key) => {
  const m = body?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  const v = m?.[1]?.trim() ?? "";
  return v.startsWith("<") ? "" : v; // template placeholder left in place
};

const prs = JSON.parse(raw)
  .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
  .map((p) => ({ ...p, summary: line(p.body, "Summary"), friction: line(p.body, "Friction"), agent: line(p.body, "Agent") }));

console.log(`# Retro — PRs merged since ${since}\n`);
console.log(`| PR | Agent | Summary | Friction |\n|---|---|---|---|`);
for (const p of prs) {
  console.log(`| [#${p.number}](${p.url}) | ${p.agent || "?"} | ${p.summary || `(missing) ${p.title}`} | ${p.friction || "(missing)"} |`);
}
const missing = prs.filter((p) => !p.summary || !p.friction);
if (missing.length) console.log(`\nMissing lines: ${missing.map((p) => `#${p.number}`).join(", ")}`);
